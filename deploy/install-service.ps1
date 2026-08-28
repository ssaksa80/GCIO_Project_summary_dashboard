<#
.SYNOPSIS
    Installs (or reinstalls) GCIO Project Intelligence as a Windows service.

.DESCRIPTION
    Wraps `node server/index.js` with NSSM so Windows owns the lifecycle:
    auto-start at boot, restart on failure, rotated stdout/stderr logs.

    Run from an ELEVATED PowerShell prompt in the repository root:

        .\deploy\install-service.ps1 -EnvFile C:\gcio\.env

    Re-running is safe: an existing service is stopped and removed first, so
    this doubles as the upgrade path.

.PARAMETER EnvFile
    Path to the environment file. Every NAME=VALUE line is passed to the
    service. Keep it outside the repository, ACL'd to the service account —
    it holds the database password.

.PARAMETER ServiceAccount
    Optional domain account to run as, e.g. "EXAMPLE\svc-gcio". Required if you
    want Windows Integrated authentication to SQL Server; read the driver
    caveat in server/db/pool.js first, because the mssql driver's default
    transport does not implement it from `trustedConnection` alone.

.PARAMETER Preflight
    Runs every check the elevated install would need — Node, NSSM, the env
    file, required variables, the port, the client build, VAULT_DIR/
    AUDIT_DIR, and database reachability — without elevation and without
    changing anything (no service is created, stopped, removed, or queried).
    Exits 0 if every check passed, 1 otherwise. Run this from an ordinary
    prompt before opening an elevated one, so the elevated run has no
    surprises left:

        .\deploy\install-service.ps1 -Preflight

.NOTES
    NSSM is taken from <install>\runtime\nssm.exe when a full bundle has been
    deployed, and from PATH otherwise (https://nssm.cc/download).

    The layout is detected: a bundle install runs app\server\index.js with the
    bundled runtime, a repo install runs server\index.js. Both keep the service
    working directory at the install root, because .env is read from there.
#>
[CmdletBinding()]
param(
    [string]$ServiceName = "GCIOProjectIntelligence",
    [string]$DisplayName = "GCIO Project Intelligence",
    [string]$EnvFile = "$PSScriptRoot\..\.env",
    [string]$NodeExe,
    [string]$NssmExe,
    # Where GCIO is installed. Detected when omitted - see Resolve-GcioRoot.
    [string]$InstallDir,
    [string]$ServiceAccount,
    [securestring]$ServicePassword,
    [switch]$Preflight
)

$ErrorActionPreference = "Stop"

<#
  Work out which directory GCIO is installed in.

  This script can legitimately sit in three different places relative to the
  application, and getting it wrong is silent rather than loud:

    <install>\deploy\install-service.ps1   repo-shape install  -> root is ..
    <install>\install-service.ps1          bundle-installed     -> root is here
    <artifact>\install-service.ps1         unpacked artifact    -> root is here

  The old code always used "$PSScriptRoot\.." which is right for the first and
  resolves to C:\ for the second - the copy a bundle install now places at the
  install root. Detect by looking for the application instead of assuming.
#>
function Resolve-GcioRoot {
    param([string]$ScriptRoot, [string]$Explicit)
    if ($Explicit) { return (Resolve-Path $Explicit).Path }
    $here = $ScriptRoot
    $up = Split-Path $ScriptRoot -Parent
    foreach ($c in @($here, $up)) {
        if (-not $c) { continue }
        if ((Test-Path (Join-Path $c 'app\server\index.js')) -or (Test-Path (Join-Path $c 'server\index.js'))) {
            return (Resolve-Path $c).Path
        }
    }
    if ($up) { return (Resolve-Path $up).Path }
    return (Resolve-Path $here).Path
}

<#
  Bundle or repo? They differ in where the application lives, and therefore in
  what the service must be pointed at. A bundle install keeps the app under
  app\ so that a patch overlay can replace it wholesale without touching
  node_modules, the runtime, .env or the drop folder.

  NOTE both layouts can coexist in one directory: a bundle deployed over an
  older repo-shape install leaves the old files in place. Bundle is checked
  FIRST and wins, because that is the newer, deployed copy - pointing the
  service at the stale repo files would run code nobody deployed.
#>
function Get-GcioLayout {
    param([Parameter(Mandatory)][string]$Root)
    if (Test-Path (Join-Path $Root 'app\server\index.js')) {
        return [pscustomobject]@{
            Kind          = 'bundle'
            Entry         = (Join-Path $Root 'app\server\index.js')
            EntryRelative = 'app\server\index.js'
            ClientBundle  = (Join-Path $Root 'app\client\dist\index.html')
            BundledNode   = (Join-Path $Root 'runtime\node\node.exe')
            BundledNssm   = (Join-Path $Root 'runtime\nssm.exe')
        }
    }
    return [pscustomobject]@{
        Kind          = 'repo'
        Entry         = (Join-Path $Root 'server\index.js')
        EntryRelative = 'server\index.js'
        ClientBundle  = (Join-Path $Root 'client\dist\index.html')
        BundledNode   = $null
        BundledNssm   = $null
    }
}

# $PSScriptRoot is empty while parameter DEFAULT VALUES are being evaluated
# under Windows PowerShell 5.1 (fixed in 7) — which is what Windows Server
# ships. Left alone, an unelevated -Preflight run (or the elevated install
# path, which has the identical latent bug) would resolve $EnvFile to
# "\..\.env" and report six invented failures instead of the real ones.
# Re-resolving it here, in the script body rather than a parameter default,
# works under both shells. Resolved against the DETECTED root, not a fixed
# "..", so the copy a bundle places at the install root does not look for
# C:\.env.
if (-not $PSBoundParameters.ContainsKey('EnvFile')) {
    $EnvFile = Join-Path (Resolve-GcioRoot -ScriptRoot $PSScriptRoot -Explicit $InstallDir) '.env'
}

# ---------------------------------------------------------- shared helpers ---
# Read-EnvPairs / ConvertTo-EnvMap are used by both the install path and
# -Preflight, so the two cannot drift apart on what counts as a valid line.

function Read-EnvPairs {
    <#
    Reads NAME=VALUE lines from an env file, ignoring comments and blank
    lines. Does not validate that every remaining line is well-formed — the
    preflight checks that separately, since the install path has never
    needed to.
    #>
    param([Parameter(Mandatory)][string]$Path)

    Get-Content $Path |
        Where-Object { $_ -match '^\s*[A-Za-z_][A-Za-z0-9_]*\s*=' -and $_ -notmatch '^\s*#' } |
        ForEach-Object { $_.Trim() }
}

function ConvertTo-EnvMap {
    param([string[]]$Pairs)
    $map = @{}
    foreach ($line in $Pairs) {
        $name, $value = $line -split '=', 2
        $map[$name.Trim()] = $value
    }
    return $map
}

function Write-CheckResult {
    <#
    Records one preflight check result and prints it immediately, so an
    operator sees the whole list even if a later check throws.

    Status is one of:
      PASS - verified good.
      FAIL - verified bad; counts toward the failure total and exit code 1.
      SKIP - not applicable to this configuration (e.g. a database check
             when STORE is not mssql); different from a PASS, and does not
             count toward the failure total.
      WARN - the install path itself only warns about this, not a hard
             failure; does not count toward the failure total.
    #>
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$Results,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][ValidateSet('PASS', 'FAIL', 'SKIP', 'WARN')][string]$Status,
        [string]$Detail
    )
    $Results.Add([pscustomobject]@{ Name = $Name; Status = $Status; Detail = $Detail })
    $color = switch ($Status) {
        'PASS' { 'Green' }
        'FAIL' { 'Red' }
        'SKIP' { 'DarkYellow' }
        'WARN' { 'Yellow' }
    }
    $line = "  [{0}] {1}" -f $Status, $Name
    if ($Detail) { $line += " - $Detail" }
    Write-Host $line -ForegroundColor $color
}

function Invoke-Preflight {
    <#
    Runs every check the elevated install would need, without elevation and
    without changing anything: no service is created, stopped, removed, or
    even queried into existence. Creating VAULT_DIR/AUDIT_DIR if absent is
    the one allowed exception, and it is reported when it happens. Continues
    past a failing or throwing check so the operator sees the whole list.
    #>
    param([Parameter(Mandatory)][string]$EnvFile)

    # Same detection the install path uses. Hardcoding "$PSScriptRoot\.." here
    # made the preflight check C:\client\dist when run from the copy a bundle
    # places at the install root - reporting an invented failure while the real
    # client sat in app\client\dist.
    $root = Resolve-GcioRoot -ScriptRoot $PSScriptRoot -Explicit $InstallDir
    $pfLayout = Get-GcioLayout -Root $root
    $results = [System.Collections.Generic.List[object]]::new()

    Write-Host "Preflight checks (unelevated, no changes) for $EnvFile`n"

    # 1. Node is on PATH and its version is 20 or newer.
    try {
        $node = Get-Command node -ErrorAction SilentlyContinue
        if (-not $node) {
            Write-CheckResult $results "Node on PATH, v20+" "FAIL" "node was not found on PATH"
        } else {
            $verRaw = (& node --version).Trim()
            if ($verRaw -match '^v(\d+)\.') {
                $major = [int]$Matches[1]
                if ($major -ge 20) {
                    Write-CheckResult $results "Node on PATH, v20+" "PASS" "$verRaw at $($node.Source)"
                } else {
                    Write-CheckResult $results "Node on PATH, v20+" "FAIL" "$verRaw is older than the required v20"
                }
            } else {
                Write-CheckResult $results "Node on PATH, v20+" "FAIL" "could not parse a version from '$verRaw'"
            }
        }
    } catch {
        Write-CheckResult $results "Node on PATH, v20+" "FAIL" "error checking node: $($_.Exception.Message)"
    }

    # 2. NSSM is on PATH. Expected to fail on a machine that never installed it.
    try {
        # Same resolution the install path uses: a full bundle ships nssm, so
        # "not on PATH" is not a failure when the bundled copy is present.
        $pfRoot = Resolve-GcioRoot -ScriptRoot $PSScriptRoot -Explicit $InstallDir
        $pfBundledNssm = Join-Path $pfRoot 'runtime\nssm.exe'
        $nssmCmd = Get-Command nssm -ErrorAction SilentlyContinue
        if (Test-Path $pfBundledNssm) {
            Write-CheckResult $results "NSSM available" "PASS" "$pfBundledNssm (shipped with the bundle)"
        } elseif ($nssmCmd) {
            Write-CheckResult $results "NSSM available" "PASS" "$($nssmCmd.Source) (on PATH)"
        } else {
            Write-CheckResult $results "NSSM available" "FAIL" "not shipped with this install and not on PATH - deploy a full bundle, or download from https://nssm.cc/download"
        }
    } catch {
        Write-CheckResult $results "NSSM available" "FAIL" "error checking nssm: $($_.Exception.Message)"
    }

    # 3. The env file exists, is readable, and every non-blank, non-comment
    #    line parses as NAME=VALUE.
    $envMap = @{}
    $envFileOk = $false
    try {
        if (-not (Test-Path $EnvFile)) {
            Write-CheckResult $results "Env file exists and parses" "FAIL" "not found: $EnvFile"
        } else {
            $rawLines = Get-Content $EnvFile -ErrorAction Stop
            $badLines = @($rawLines | ForEach-Object { $_.Trim() } | Where-Object {
                $_ -ne '' -and $_ -notmatch '^#' -and $_ -notmatch '^[A-Za-z_][A-Za-z0-9_]*\s*='
            })
            if ($badLines.Count -gt 0) {
                Write-CheckResult $results "Env file exists and parses" "FAIL" `
                    "$($badLines.Count) line(s) do not parse as NAME=VALUE, e.g. '$($badLines[0])'"
            } else {
                $pairs = Read-EnvPairs -Path $EnvFile
                if (-not $pairs) {
                    Write-CheckResult $results "Env file exists and parses" "FAIL" "no NAME=VALUE lines found"
                } else {
                    $envMap = ConvertTo-EnvMap -Pairs $pairs
                    $envFileOk = $true
                    Write-CheckResult $results "Env file exists and parses" "PASS" "$($pairs.Count) variable(s) found"
                }
            }
        }
    } catch {
        Write-CheckResult $results "Env file exists and parses" "FAIL" "error reading $($EnvFile): $($_.Exception.Message)"
    }

    # 4. STORE and AUTH_MODE are present; when STORE=mssql, the connection
    #    variables server/db/pool.js's buildConfig actually requires are
    #    present too (DB_USER/DB_PASSWORD, and only when DB_WINDOWS_AUTH is
    #    explicitly "false" — otherwise Windows auth is the default and
    #    DB_SERVER/DB_DATABASE fall back to localhost\SQLEXPRESS/GCIO).
    try {
        if (-not $envFileOk) {
            Write-CheckResult $results "STORE / AUTH_MODE / DB variables present" "FAIL" "skipped - env file did not parse"
        } else {
            $missing = @()
            if (-not $envMap['STORE']) { $missing += 'STORE' }
            if (-not $envMap['AUTH_MODE']) { $missing += 'AUTH_MODE' }
            if ($envMap['STORE'] -eq 'mssql') {
                # Mirrors pool.js exactly: String(env.DB_WINDOWS_AUTH || "true") === "true" -
                # an unset or empty value defaults to Windows auth; anything else is
                # compared case-sensitively.
                $windowsAuthRaw = $envMap['DB_WINDOWS_AUTH']
                $windowsAuth = if ([string]::IsNullOrEmpty($windowsAuthRaw)) { $true } else { $windowsAuthRaw -ceq 'true' }
                if (-not $windowsAuth) {
                    if (-not $envMap['DB_USER']) { $missing += 'DB_USER' }
                    if (-not $envMap['DB_PASSWORD']) { $missing += 'DB_PASSWORD' }
                }
            }
            if ($missing.Count -gt 0) {
                Write-CheckResult $results "STORE / AUTH_MODE / DB variables present" "FAIL" "missing: $($missing -join ', ')"
            } else {
                Write-CheckResult $results "STORE / AUTH_MODE / DB variables present" "PASS" "STORE=$($envMap['STORE']), AUTH_MODE=$($envMap['AUTH_MODE'])"
            }
        }
    } catch {
        Write-CheckResult $results "STORE / AUTH_MODE / DB variables present" "FAIL" "error: $($_.Exception.Message)"
    }

    # 5. AUTH_MODE is not dev - the install path already refuses this.
    try {
        if (-not $envFileOk) {
            Write-CheckResult $results "AUTH_MODE is not dev" "FAIL" "skipped - env file did not parse"
        } elseif (-not $envMap['AUTH_MODE']) {
            Write-CheckResult $results "AUTH_MODE is not dev" "FAIL" "AUTH_MODE is not set"
        } elseif ($envMap['AUTH_MODE'] -eq 'dev') {
            Write-CheckResult $results "AUTH_MODE is not dev" "FAIL" "AUTH_MODE=dev accepts any password; the install path refuses this"
        } else {
            Write-CheckResult $results "AUTH_MODE is not dev" "PASS" "AUTH_MODE=$($envMap['AUTH_MODE'])"
        }
    } catch {
        Write-CheckResult $results "AUTH_MODE is not dev" "FAIL" "error: $($_.Exception.Message)"
    }

    # NODE_ENV: the install path only Write-Warnings about this (further
    # below), it does not refuse to install. Mirrored here at the same
    # severity - a WARN, not a FAIL - rather than inventing a stricter rule
    # the install path itself does not enforce.
    try {
        if (-not $envFileOk) {
            Write-CheckResult $results "NODE_ENV is production" "SKIP" "skipped - env file did not parse"
        } elseif ($envMap['NODE_ENV'] -ne 'production') {
            Write-CheckResult $results "NODE_ENV is production" "WARN" `
                "NODE_ENV is '$($envMap['NODE_ENV'])'; the install path warns but does not refuse this"
        } else {
            Write-CheckResult $results "NODE_ENV is production" "PASS" "NODE_ENV=production"
        }
    } catch {
        Write-CheckResult $results "NODE_ENV is production" "FAIL" "error: $($_.Exception.Message)"
    }

    # 6. The configured PORT is free.
    try {
        $port = if ($envFileOk -and $envMap['PORT']) { $envMap['PORT'] } else { '8123' }
        $inUse = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
        if ($inUse) {
            $owners = ($inUse | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
                try { (Get-Process -Id $_ -ErrorAction Stop).ProcessName } catch { "pid $_" }
            }) -join ', '
            Write-CheckResult $results "Port $port is free" "FAIL" "already in use by: $owners"
        } else {
            Write-CheckResult $results "Port $port is free" "PASS" "no listener found"
        }
    } catch {
        Write-CheckResult $results "Port is free" "FAIL" "error checking the port: $($_.Exception.Message)"
    }

    # 7. The client is built - without it the service serves a 503 page.
    try {
        $clientBundle = $pfLayout.ClientBundle
        if (Test-Path $clientBundle) {
            Write-CheckResult $results "Client build present" "PASS" $clientBundle
        } else {
            Write-CheckResult $results "Client build present" "FAIL" "$clientBundle is missing - run: npm ci; npm run build"
        }
    } catch {
        Write-CheckResult $results "Client build present" "FAIL" "error: $($_.Exception.Message)"
    }

    # 8. VAULT_DIR and AUDIT_DIR are writable. Creating them if absent is
    #    acceptable; it is reported below when it happens. AUDIT_DIR is
    #    still checked even when STORE=mssql (server/index.js routes audit
    #    to dbo.AuditEvent in that case - createFileAudit(AUDIT_DIR) is only
    #    wired up for STORE=memory), but the detail line says so, so a pass
    #    or fail there is not mistaken for meaning anything about the mssql
    #    configuration actually used.
    foreach ($dirVar in @(
        @{ Name = 'VAULT_DIR'; Default = 'vault' },
        @{ Name = 'AUDIT_DIR'; Default = 'audit' }
    )) {
        try {
            $raw = if ($envFileOk -and $envMap[$dirVar.Name]) { $envMap[$dirVar.Name] } else { $dirVar.Default }
            $path = if ([IO.Path]::IsPathRooted($raw)) { $raw } else { Join-Path $root $raw }
            $created = $false
            if (-not (Test-Path $path)) {
                New-Item -ItemType Directory -Force -Path $path | Out-Null
                $created = $true
            }
            $probe = Join-Path $path (".preflight-write-test-{0}.tmp" -f ([guid]::NewGuid().ToString('N')))
            [IO.File]::WriteAllText($probe, "preflight")
            Remove-Item $probe -Force
            $detail = if ($created) { "writable (created $path)" } else { "writable ($path)" }
            if ($dirVar.Name -eq 'AUDIT_DIR' -and $envFileOk -and $envMap['STORE'] -eq 'mssql') {
                $detail += " (unused: STORE=mssql routes audit to dbo.AuditEvent, not the filesystem)"
            }
            Write-CheckResult $results "$($dirVar.Name) writable" "PASS" $detail
        } catch {
            Write-CheckResult $results "$($dirVar.Name) writable" "FAIL" "error: $($_.Exception.Message)"
        }
    }

    # 9. The database is reachable, checked by invoking the app's own
    #    scripts/db-check.mjs (which calls server/db/pool.js's buildConfig)
    #    rather than reimplementing the connection logic here. Only mssql
    #    ever touches SQL Server, so anything else is a SKIP, not a PASS -
    #    a pass would claim to have verified something it never contacted.
    try {
        if (-not $envFileOk) {
            Write-CheckResult $results "Database reachable (db-check.mjs)" "FAIL" "skipped - env file did not parse"
        } elseif ($envMap['STORE'] -ne 'mssql') {
            Write-CheckResult $results "Database reachable (db-check.mjs)" "SKIP" "STORE=$($envMap['STORE']) does not use SQL Server"
        } else {
            $node = Get-Command node -ErrorAction SilentlyContinue
            if (-not $node) {
                Write-CheckResult $results "Database reachable (db-check.mjs)" "FAIL" "cannot run - node is not on PATH (see check 1)"
            } else {
                foreach ($key in $envMap.Keys) {
                    [Environment]::SetEnvironmentVariable($key, $envMap[$key], 'Process')
                }
                Push-Location $root
                try {
                    $dbOutput = & node "scripts/db-check.mjs" 2>&1 | ForEach-Object { $_.ToString() }
                    $dbExit = $LASTEXITCODE
                } finally {
                    Pop-Location
                }
                foreach ($outLine in $dbOutput) { Write-Host "      $outLine" }
                if ($dbExit -eq 0) {
                    Write-CheckResult $results "Database reachable (db-check.mjs)" "PASS" "exit code 0"
                } else {
                    Write-CheckResult $results "Database reachable (db-check.mjs)" "FAIL" "exit code $dbExit"
                }
            }
        }
    } catch {
        Write-CheckResult $results "Database reachable (db-check.mjs)" "FAIL" "error: $($_.Exception.Message)"
    }

    $failed = @($results | Where-Object { $_.Status -eq 'FAIL' })
    Write-Host ""
    if ($failed.Count -eq 0) {
        Write-Host "Preflight: all $($results.Count) checks passed." -ForegroundColor Green
        exit 0
    } else {
        Write-Host "Preflight: $($failed.Count) of $($results.Count) check(s) failed." -ForegroundColor Red
        exit 1
    }
}

if ($Preflight) {
    Invoke-Preflight -EnvFile $EnvFile
}

# ---------------------------------------------------------------- checks ---

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    throw "This script must run from an elevated PowerShell prompt (Run as administrator)."
}

<#
  Find nssm. A full bundle SHIPS it at runtime\nssm.exe precisely so a host
  needs nothing pre-installed - requiring it on PATH as well would defeat that,
  and it is how this install first failed: the operator had a complete bundle
  containing nssm and was told to go and download nssm.
#>
if (-not $NssmExe) {
    $candidateRoot = Resolve-GcioRoot -ScriptRoot $PSScriptRoot -Explicit $InstallDir
    $bundled = Join-Path $candidateRoot 'runtime\nssm.exe'
    if (Test-Path $bundled) {
        $NssmExe = $bundled
    } else {
        $onPath = Get-Command nssm -ErrorAction SilentlyContinue
        if ($onPath) { $NssmExe = $onPath.Source }
    }
}
if (-not $NssmExe -or -not (Test-Path $NssmExe)) {
    throw "nssm was not found. A full bundle ships it at <install>\runtime\nssm.exe; this install has neither that nor nssm on PATH. Either deploy a full bundle, pass -NssmExe <path>, or download it from https://nssm.cc/download."
}
Write-Host "NSSM:              $NssmExe"

if (-not $NodeExe) {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw "node was not found on PATH. Pass -NodeExe with the full path." }
    $NodeExe = $node.Source
}

$root = Resolve-GcioRoot -ScriptRoot $PSScriptRoot -Explicit $InstallDir
$layout = Get-GcioLayout -Root $root
$entry = $layout.Entry
$logDir = Join-Path $root "logs"

Write-Host "Install directory: $root"
Write-Host "Layout:            $($layout.Kind)  (entry: $($layout.EntryRelative))"

if (-not (Test-Path $entry)) { throw "$($layout.EntryRelative) not found under $root." }
if (-not (Test-Path $EnvFile)) { throw "Environment file not found: $EnvFile" }

if (-not (Test-Path $layout.ClientBundle)) {
    if ($layout.Kind -eq 'bundle') {
        throw "The bundled client is missing ($($layout.ClientBundle)). This install looks incomplete - re-run the bundle deploy."
    }
    throw "The client is not built ($($layout.ClientBundle) is missing). Run: npm ci; npm run build"
}

<#
  On a bundle install, prefer the runtime that SHIPPED WITH IT over whatever is
  on PATH. The bundle exists precisely so the host does not depend on a
  machine-wide Node, and the patch gate refuses an overlay whose Node major
  differs from the installed runtime - so a service running a different node
  than the gate is comparing against would make that check meaningless.
#>
if (-not $NodeExe -and $layout.BundledNode -and (Test-Path $layout.BundledNode)) {
    $NodeExe = $layout.BundledNode
    Write-Host "Node:              $NodeExe  (bundled)"
}

# Read NAME=VALUE pairs, ignoring comments and blank lines. Shared with
# -Preflight via Read-EnvPairs so the two paths cannot drift apart.
$pairs = Read-EnvPairs -Path $EnvFile

if (-not $pairs) { throw "No NAME=VALUE lines found in $EnvFile." }

# Refuse the two configurations that must never reach a server.
$envMap = ConvertTo-EnvMap -Pairs $pairs
if ($envMap['NODE_ENV'] -ne 'production') {
    Write-Warning "NODE_ENV is '$($envMap['NODE_ENV'])'. A server install should set NODE_ENV=production."
}
if ($envMap['AUTH_MODE'] -eq 'dev') {
    throw "AUTH_MODE=dev accepts any password. Refusing to install it as a service."
}
if ($envMap['STORE'] -eq 'memory') {
    Write-Warning "STORE=memory keeps the portfolio in process memory only; it is lost on restart."
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# ------------------------------------------------------------- reinstall ---

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Existing service found — stopping and removing it first."
    if ($existing.Status -ne 'Stopped') {
        Stop-Service -Name $ServiceName -Force
        $existing.WaitForStatus('Stopped', '00:00:30')
    }
    & $NssmExe remove $ServiceName confirm | Out-Null
    Start-Sleep -Seconds 2
}

# --------------------------------------------------------------- install ---

& $NssmExe install $ServiceName $NodeExe $entry
& $NssmExe set $ServiceName DisplayName $DisplayName
& $NssmExe set $ServiceName Description "Executive portfolio dashboard: Excel ingestion, CIO sections, exports."
& $NssmExe set $ServiceName AppDirectory $root
& $NssmExe set $ServiceName AppStdout (Join-Path $logDir "service-out.log")
& $NssmExe set $ServiceName AppStderr (Join-Path $logDir "service-err.log")
& $NssmExe set $ServiceName AppRotateFiles 1
& $NssmExe set $ServiceName AppRotateOnline 1
& $NssmExe set $ServiceName AppRotateBytes 10485760
& $NssmExe set $ServiceName Start SERVICE_AUTO_START
& $NssmExe set $ServiceName AppExit Default Restart
& $NssmExe set $ServiceName AppRestartDelay 5000
& $NssmExe set $ServiceName AppStopMethodConsole 15000

# NSSM takes the environment as newline-separated NAME=VALUE pairs.
& $NssmExe set $ServiceName AppEnvironmentExtra ($pairs -join "`n")

if ($ServiceAccount) {
    if (-not $ServicePassword) { throw "-ServiceAccount also needs -ServicePassword." }
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ServicePassword))
    & $NssmExe set $ServiceName ObjectName $ServiceAccount $plain
    $plain = $null
    Write-Host "Service will run as $ServiceAccount."
}

Start-Service -Name $ServiceName
(Get-Service -Name $ServiceName) | Format-List Name, Status, StartType

# ---------------------------------------------------------------- verify ---

$port = if ($envMap['PORT']) { $envMap['PORT'] } else { '8123' }
Write-Host "`nWaiting for readiness on port $port ..."
$ready = $false
foreach ($attempt in 1..15) {
    Start-Sleep -Seconds 2
    try {
        $res = Invoke-WebRequest -Uri "http://127.0.0.1:$port/readyz" -UseBasicParsing -TimeoutSec 5
        if ($res.StatusCode -eq 200) { $ready = $true; break }
    } catch {
        # /readyz answers 503 until data is ingested, which is not a failure yet
        if ($_.Exception.Response.StatusCode.value__ -eq 503) { $ready = $true; break }
    }
}

if ($ready) {
    Write-Host "Service is answering on http://127.0.0.1:$port" -ForegroundColor Green
    Write-Host "Next: put IIS in front for TLS — see deploy\iis-site.md"
} else {
    Write-Warning "The service did not answer within 30 seconds. Check $logDir\service-err.log"
}
