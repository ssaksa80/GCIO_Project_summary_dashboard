<#
.SYNOPSIS
  Store the LDAP service-account credential in .env with the password encrypted
  at rest.

.DESCRIPTION
  Prompts for the bind DN and password, seals the password with the
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
  [string]$BindDN
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
if (-not $BindDN) {
  Write-Host ''
  Write-Host 'Bind DN for the LDAP service account. Any form the directory accepts'
  Write-Host 'for a simple bind -- whichever one ldap-bind-test.ps1 succeeded with:'
  Write-Host '    svc@example.local                        UPN'
  Write-Host '    EXAMPLE\svc                              NetBIOS'
  Write-Host '    CN=svc,OU=Service,DC=example,DC=local     full DN'
  $BindDN = Read-Host 'Bind DN'
}
if (-not $BindDN.Trim()) { Fail 'a bind DN is required; without one the app ignores the password entirely' }

$secure = Read-Host "Password for $BindDN" -AsSecureString
if ($secure.Length -eq 0) { Fail 'an empty password would bind anonymously; refusing' }

$confirm = Read-Host 'Confirm password' -AsSecureString
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
