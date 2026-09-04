<#
.SYNOPSIS
  Store the LDAP service-account credential in .env with the password encrypted
  at rest, in four prompted steps.

.DESCRIPTION
  Step 1 confirms the base DN already in .env, step 2 asks for the service
  account username, step 3 for its password, and step 4 verifies the pair
  against the directory before anything is written. Seals the password with the
  application's own master key (AES-256-GCM, key held DPAPI-protected at
  LocalMachine scope), and writes both settings into .env:

      LDAP_BIND_DN=svc_app@example.local
      LDAP_BIND_PASSWORD=enc:v1:<base64>

  WHAT THIS PROTECTS AGAINST, precisely. A copy of .env taken off this host --
  a backup, a support bundle, a folder copied to a share, an accidental commit
  -- is useless without key.bin, and key.bin is useless off this machine
  because DPAPI will not unprotect it anywhere else. It does NOT protect
  against an attacker already running code on this host as the service account:
  the service decrypts unattended, so anything it can do, they can do. No
  unattended scheme does better than that, and pretending otherwise is worse
  than not encrypting at all.

  The password is read through Read-Host -AsSecureString. It is never echoed,
  never written to disk in the clear, never placed in the command line (argv is
  visible to any process listing on the box), and never logged.

.PARAMETER InstallDir
  Where .env lives. C:\gcio on a bundle install; the repo root in development.

.PARAMETER BindDN
  Skip the prompt for the non-secret half. The password is ALWAYS prompted for
  -- there is deliberately no parameter to pass it on the command line.

.EXAMPLE
  pwsh -File deploy\seal-secret.ps1 -InstallDir C:\gcio
#>
[CmdletBinding()]
param(
  # Two layouts, and the difference is not cosmetic. In the repo this script is
  # deploy/seal-secret.ps1, so the install dir is its parent. On a host a patch
  # copies it to the install root itself (C:\gcio\seal-secret.ps1), where the
  # parent is C:\ - which has no .env, and would send an operator to a confusing
  # "no .env at C:\.env". Decide by looking for the file rather than by guessing.
  [string]$InstallDir = $(
    if (Test-Path -LiteralPath (Join-Path $PSScriptRoot '.env')) { $PSScriptRoot }
    else { (Resolve-Path "$PSScriptRoot\..").Path }
  ),
  [string]$BindDN,

  # Store the credential without checking it against the directory first. For a
  # host that cannot reach a DC from where this is run, or a deliberate
  # pre-stage. The check exists because the alternative first test of a wrong
  # password is the service retrying it on every sign-in.
  [switch]$SkipBindTest
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/lib/common.ps1"

function Fail([string]$m) { Write-Host "[FAIL] $m" -ForegroundColor Red; exit 1 }
function Ok([string]$m)   { Write-Host "[ok] $m" -ForegroundColor Green }

# --- locate the pieces -------------------------------------------------------
# The sealing has to be done by the SAME code and the SAME key the service will
# later use to open it. Re-implementing AES in PowerShell would produce a token
# that looks right and cannot be opened, so this shells into the app's own
# secretBox instead.
$envFile = Join-Path $InstallDir '.env'
if (-not (Test-Path -LiteralPath $envFile)) { Fail "no .env at $envFile (is -InstallDir right?)" }

$appRoot = if (Test-Path -LiteralPath (Join-Path $InstallDir 'app\server\config.js')) {
  Join-Path $InstallDir 'app'          # bundle install
} elseif (Test-Path -LiteralPath (Join-Path $InstallDir 'server\config.js')) {
  $InstallDir                          # dev checkout
} else { Fail "cannot find server\config.js under $InstallDir" }

$node = Join-Path $InstallDir 'runtime\node\node.exe'
if (-not (Test-Path -LiteralPath $node)) {
  $node = (Get-Command node -ErrorAction SilentlyContinue)?.Source
  if (-not $node) { Fail 'no Node runtime found (looked for runtime\node\node.exe and node on PATH)' }
}
Ok "using $node"
Ok "sealing for $appRoot"

# --- collect the credential --------------------------------------------------
# Four numbered steps, each with an example.
#
# The previous version asked for a "Bind DN" in one prompt. An operator read
# that as the base DN and pasted DC=example,DC=local, which is a container and not
# an account - and the next prompt then said "Password for DC=example,DC=local",
# which looks perfectly reasonable right up until the bind fails as a
# credential error. The base DN is already in .env; it is shown, not asked for
# again, and the account name is collected on its own.
function Step { param([int]$N, [string]$Title, [string]$Example, [string]$Note)
  Write-Host ''
  Write-Host "Step $N of 4: $Title" -ForegroundColor Cyan
  if ($Example) { Write-Host "  example:  $Example" -ForegroundColor DarkGray }
  if ($Note)    { Write-Host "  $Note" -ForegroundColor DarkGray }
}

$baseDN    = Get-GcioEnvSetting -Path $envFile -Name 'LDAP_BASE_DN'
$domain    = Get-GcioEnvSetting -Path $envFile -Name 'LDAP_DOMAIN'
$upnSuffix = Get-GcioEnvSetting -Path $envFile -Name 'LDAP_UPN_SUFFIX'

# ---- 1. base DN -------------------------------------------------------------
Step 1 'Directory base DN' 'DC=example,DC=local' 'where the app searches for users'
if ($baseDN) {
  Write-Host "  from .env: $baseDN" -ForegroundColor Green
  $answer = Read-Host '  press Enter to keep it, or type a different base DN'
  if ($answer.Trim()) { $baseDN = $answer.Trim() }
} else {
  $baseDN = (Read-Host '  Base DN').Trim()
  if (-not $baseDN) { Fail 'a base DN is required; LDAP_BASE_DN is not set in .env either' }
}

# ---- 2. username ------------------------------------------------------------
if (-not $BindDN) {
  Step 2 'Service account username' 'svc_app' 'the account name ONLY - not a DN, not the base DN'
  Write-Host '  a fully-qualified value is accepted too, and used exactly as typed:' -ForegroundColor DarkGray
  Write-Host '      svc_app@example.local                      UPN' -ForegroundColor DarkGray
  Write-Host '      EXAMPLE\svc_app                            NetBIOS' -ForegroundColor DarkGray
  Write-Host '      CN=svc_app,OU=Service,DC=example,DC=local  full DN' -ForegroundColor DarkGray
  $username = Read-Host '  Username'
  try {
    $BindDN = Resolve-GcioBindIdentity -User $username -BaseDN $baseDN -Domain $domain -UpnSuffix $upnSuffix
  } catch { Fail $_.Exception.Message }
  if ($BindDN -ne $username.Trim()) {
    Write-Host "  will bind as: $BindDN" -ForegroundColor Green
  }
} else {
  Step 2 'Service account username' '' "supplied with -BindDN: $BindDN"
}
if (-not $BindDN.Trim()) { Fail 'a username is required; without one the app ignores the password entirely' }

# ---- 3. password ------------------------------------------------------------
Step 3 'Password' '' "for $BindDN - not shown as you type, and never written in the clear"
$secure = Read-Host '  Password' -AsSecureString
if ($secure.Length -eq 0) { Fail 'an empty password would bind anonymously; refusing' }

$confirm = Read-Host '  Confirm password' -AsSecureString
# Compared through the plaintext forms, which are released immediately below.
# A typo here is not a typo you find out about now -- it is a service account
# lockout at the next restart, when the directory sees repeated bad binds.
$bstr1 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$bstr2 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($confirm)
try {
  $p1 = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr1)
  $p2 = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr2)
  if ($p1 -ne $p2) { Fail 'the two entries do not match; nothing was written' }
  $plain = $p1
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr1)
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr2)
}

# ---- 4. verify, then write --------------------------------------------------
# Try the credential against the directory BEFORE writing it.
#
# Without this the first thing that ever tests the password is the service, and
# it does so on every sign-in attempt by every user. A typo therefore does not
# surface as "wrong password" - it surfaces as repeated bad binds from the
# application, which is how a service account gets locked out. One deliberate
# attempt here is far cheaper than that.
Step 4 'Verify and write' '' 'one bind against the directory, then seal and save'
$ldapUrl = Get-GcioEnvSetting -Path $envFile -Name 'LDAP_URL'
if ($SkipBindTest) {
  Write-Host '  skipped (-SkipBindTest)' -ForegroundColor Yellow
} elseif (-not $ldapUrl) {
  Write-Host '  skipped: LDAP_URL is not set in .env, so there is nothing to test against' -ForegroundColor Yellow
} else {
  $uri = [Uri]$ldapUrl
  $ldapPort = if ($uri.Port -gt 0) { $uri.Port } elseif ($uri.Scheme -eq 'ldaps') { 636 } else { 389 }
  Write-Host "  binding to $($uri.Host):$ldapPort as $BindDN ..." -ForegroundColor DarkGray
  try {
    Add-Type -AssemblyName System.DirectoryServices.Protocols
    $id = New-Object DirectoryServices.Protocols.LdapDirectoryIdentifier($uri.Host, $ldapPort)
    $conn = New-Object DirectoryServices.Protocols.LdapConnection($id)
    $conn.SessionOptions.SecureSocketLayer = ($uri.Scheme -eq 'ldaps')
    $conn.SessionOptions.ProtocolVersion = 3
    $conn.AuthType = [DirectoryServices.Protocols.AuthType]::Basic   # simple bind, as the app does
    $conn.Credential = New-Object Net.NetworkCredential($BindDN, $plain)
    $conn.Bind()
    $conn.Dispose()
    Ok 'the directory accepted this credential'
  } catch [DirectoryServices.Protocols.LdapException] {
    # The AD "data" code carries the real reason; 52e is a wrong password and
    # 525 an unknown account, and the two need different corrections.
    $detail = $_.Exception.Message
    if ($_.Exception.ServerErrorMessage) { $detail += " | $($_.Exception.ServerErrorMessage)" }
    Write-Host "[FAIL] the directory REJECTED this credential: $detail" -ForegroundColor Red
    Write-Host '       52e wrong password   525 no such user   532 password expired' -ForegroundColor DarkGray
    Write-Host '       533 account disabled  775 locked out    530/531 not permitted here' -ForegroundColor DarkGray
    Write-Host '       Nothing was written. Re-run and correct the username or password,' -ForegroundColor DarkGray
    Write-Host '       or pass -SkipBindTest to store it anyway.' -ForegroundColor DarkGray
    exit 1
  } catch {
    # Reachability, TLS, DNS - not a credential problem, and not a reason to
    # refuse to store a password the operator may well have right.
    Write-Host "  could not reach the directory to check: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host '  continuing - this is a connectivity problem, not a credential one.' -ForegroundColor Yellow
  }
}

# --- seal it -----------------------------------------------------------------
# The password reaches Node on STDIN. Not as an argument: argv is readable by
# any process listing, any EDR agent, and Windows command-line auditing, which
# is itself shipped off the box. Same rule masterKey.js follows for the key.
$sealer = Get-GcioSealerScript -AppRoot $appRoot

$sealerFile = Join-Path ([IO.Path]::GetTempPath()) ("gcio-seal-" + [guid]::NewGuid().ToString('N') + ".mjs")
[IO.File]::WriteAllText($sealerFile, $sealer)
try {
  $psi = [Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $node
  $psi.Arguments = '"' + $sealerFile + '"'
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $proc = [Diagnostics.Process]::Start($psi)
  $proc.StandardInput.Write($plain)
  $proc.StandardInput.Close()
  $token = $proc.StandardOutput.ReadToEnd().Trim()
  $errText = $proc.StandardError.ReadToEnd().Trim()
  $proc.WaitForExit()
  if ($proc.ExitCode -ne 0) { Fail "sealing failed (exit $($proc.ExitCode)): $errText" }
} finally {
  # The plaintext dies here whatever happened above.
  $plain = $null; $p1 = $null; $p2 = $null
  [GC]::Collect()
  Remove-Item -LiteralPath $sealerFile -Force -ErrorAction SilentlyContinue
}

if (-not $token.StartsWith('enc:v1:')) { Fail "unexpected output from the sealer; nothing was written" }
Ok "sealed ($($token.Length) chars)"
if ($errText) { Write-Host "     $errText" -ForegroundColor DarkGray }

# --- write it into .env ------------------------------------------------------
# Backed up first, and rewritten in place so surrounding comments and ordering
# survive. A commented-out key is treated as absent and replaced, which is what
# makes this idempotent against the placeholder block install leaves behind.
$backup = "$envFile.bak-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
Copy-Item -LiteralPath $envFile $backup -Force
Ok "backed up to $backup"

Set-GcioEnvSetting -Path $envFile -Name 'LDAP_BIND_DN'       -Value $BindDN
Set-GcioEnvSetting -Path $envFile -Name 'LDAP_BIND_PASSWORD' -Value $token
Ok "wrote LDAP_BIND_DN and a sealed LDAP_BIND_PASSWORD to $envFile"

Write-Host ''
Write-Host 'Next: re-register the service so it picks the new values up.' -ForegroundColor Cyan
Write-Host 'NSSM freezes the environment at install time, so a restart is NOT enough:'
Write-Host "    pwsh -NoProfile -ExecutionPolicy Bypass -File $InstallDir\install-service.ps1"
Write-Host ''
Write-Host 'key.bin is machine-bound. Backing up .env without it, or restoring both' -ForegroundColor Yellow
Write-Host 'onto a different host, means re-running this script there.' -ForegroundColor Yellow
