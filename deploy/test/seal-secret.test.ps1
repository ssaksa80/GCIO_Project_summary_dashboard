<#
  Sealing the LDAP bind password at rest.

  Two things are worth testing here and they need different tools.

  1. Set-GcioEnvSetting, the .env rewrite. install.ps1 leaves the service
     account settings as a COMMENTED placeholder block, so a naive appender
     produces a file with a commented LDAP_BIND_DN near the top and a live one
     at the bottom. dotenv takes the last, a human reads the first, and the two
     disagree forever. Every case below exists because it is a way that goes
     wrong quietly.

  2. The real DPAPI round-trip. test/crypto/master-key.test.js covers the logic
     with an injected stand-in for DPAPI, which proves the code calls protect
     before writing but says nothing about whether ProtectedData works on THIS
     machine, under THIS account, through the PowerShell shell-out. That is a
     property of the host, so it is tested here rather than in the unit suite.

  What is NOT tested: the interactive prompts. Read-Host -AsSecureString needs a
  console, and the only way to drive it from a test would be a parameter that
  accepts the password on the command line - which is precisely the thing the
  script refuses to have, because argv is readable by any process listing. The
  prompt block stays covered by review, and everything downstream of it is
  exercised directly.
#>
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../lib/common.ps1"

$script:fails = 0
function Check { param($Cond, [string]$What)
  if ($Cond) { Write-Host "[ok] $What" -ForegroundColor Green }
  else { Write-Host "[FAIL] $What" -ForegroundColor Red; $script:fails++ } }

$repoRoot = Resolve-Path "$PSScriptRoot/../.."
$root = Join-Path ([IO.Path]::GetTempPath()) ("gcio-seal-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $root | Out-Null

function NewEnv([string[]]$Lines) {
  $p = Join-Path $root ([guid]::NewGuid().ToString('N') + '.env')
  [IO.File]::WriteAllLines($p, $Lines)
  return $p
}
function Live([string]$Path, [string]$Name) {
  # What dotenv would actually load: uncommented occurrences, last one wins.
  #
  # The leading comma is load-bearing. PowerShell unrolls an array on the way
  # out of a function, so a single match would come back as a bare string and
  # every .Count assertion below would be testing a string's length instead of
  # the number of matches. Wrapping in a one-element array survives the unroll.
  , @([IO.File]::ReadAllLines($Path) | Where-Object { $_ -match ('^\s*' + [Regex]::Escape($Name) + '\s*=') })
}

try {
  # ---- 1. the .env rewrite -------------------------------------------------

  $p = NewEnv @('PORT=8130', '#LDAP_BIND_DN=placeholder@example.local', '#LDAP_BIND_PASSWORD=', 'DATA_DIR=C:\gcio\data')
  Set-GcioEnvSetting -Path $p -Name 'LDAP_BIND_DN' -Value 'svc@example.local'
  $hits = Live $p 'LDAP_BIND_DN'
  Check ($hits.Count -eq 1) "a commented placeholder is replaced, not duplicated (found $($hits.Count) live copies)"
  Check ($hits[0] -eq 'LDAP_BIND_DN=svc@example.local') 'and it carries the new value'
  Check ((Get-Content $p) -contains 'PORT=8130') 'unrelated settings survive'
  Check ((Get-Content $p) -contains 'DATA_DIR=C:\gcio\data') 'including ones after the replaced line'

  $p = NewEnv @('PORT=8130')
  Set-GcioEnvSetting -Path $p -Name 'LDAP_BIND_DN' -Value 'svc@example.local'
  Check ((Live $p 'LDAP_BIND_DN').Count -eq 1) 'an absent setting is appended'

  # Idempotence. The operator who runs this twice - or reruns it after a typo -
  # must not end up with two live copies whose values disagree.
  $p = NewEnv @('LDAP_BIND_DN=old@example.local')
  Set-GcioEnvSetting -Path $p -Name 'LDAP_BIND_DN' -Value 'new@example.local'
  Set-GcioEnvSetting -Path $p -Name 'LDAP_BIND_DN' -Value 'new@example.local'
  $hits = Live $p 'LDAP_BIND_DN'
  Check ($hits.Count -eq 1 -and $hits[0] -eq 'LDAP_BIND_DN=new@example.local') 'running it twice leaves exactly one line'

  # A file that already has BOTH a commented and a live copy - the state a
  # half-finished manual edit leaves behind.
  $p = NewEnv @('#LDAP_BIND_DN=commented@example.local', 'PORT=1', 'LDAP_BIND_DN=live@example.local')
  Set-GcioEnvSetting -Path $p -Name 'LDAP_BIND_DN' -Value 'svc@example.local'
  $hits = Live $p 'LDAP_BIND_DN'
  Check ($hits.Count -eq 1 -and $hits[0] -eq 'LDAP_BIND_DN=svc@example.local') 'a stale second copy is dropped, not left behind'

  # Prefix collision. LDAP_BIND_DN must not be matched when writing
  # LDAP_BIND_DN_EXTRA, or setting one silently destroys the other.
  $p = NewEnv @('LDAP_BIND_DN=keep@example.local')
  Set-GcioEnvSetting -Path $p -Name 'LDAP_BIND' -Value 'x'
  Check ((Live $p 'LDAP_BIND_DN').Count -eq 1) 'a setting whose name is a prefix of another does not clobber it'

  # A sealed token contains + / and = from base64. If the writer ever moved to
  # a regex replacement over the value, those would be interpreted.
  $p = NewEnv @('#LDAP_BIND_PASSWORD=')
  $tok = 'enc:v1:AbC+dEf/gHi=jKl$m'
  Set-GcioEnvSetting -Path $p -Name 'LDAP_BIND_PASSWORD' -Value $tok
  Check ((Live $p 'LDAP_BIND_PASSWORD')[0] -eq "LDAP_BIND_PASSWORD=$tok") 'a base64 token is written verbatim, metacharacters and all'

  # ---- 2. DPAPI, for real, on this host ------------------------------------
  # Seal in one process and open in a SECOND one. A single process could pass
  # by holding the key in memory the whole time; the service will not have that
  # luxury, so neither does this test.
  $keyFile = Join-Path $root 'key.bin'
  $secret  = 'not-a-real-password-' + [guid]::NewGuid().ToString('N')

  # The REAL template the script pipes into, not a copy of it. A copy would have
  # been "fixed" alongside the script and told us nothing; this rendered the
  # broken one and failed, which is how the ERR_UNSUPPORTED_ESM_URL_SCHEME bug
  # was found before it reached the host.
  $sealer = Get-GcioSealerScript -AppRoot $repoRoot.Path
  Check ($sealer -notmatch 'SEALER_') 'the rendered sealer has no unreplaced placeholders left in it'
  Check ($sealer -match 'from "file:///') 'its imports are file:// URLs, which the ESM loader requires for an absolute Windows path'

  $sealFile = Join-Path $root 'seal.mjs'; [IO.File]::WriteAllText($sealFile, $sealer)

  # Sealing: password in on STDIN, exactly as seal-secret.ps1 does it.
  $psi = [Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = 'node'; $psi.Arguments = '"' + $sealFile + '"'
  $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true; $psi.UseShellExecute = $false
  $psi.EnvironmentVariables['GCIO_KEY_FILE'] = $keyFile
  $proc = [Diagnostics.Process]::Start($psi)
  $proc.StandardInput.Write($secret); $proc.StandardInput.Close()
  $token = $proc.StandardOutput.ReadToEnd().Trim()
  $sealErr = $proc.StandardError.ReadToEnd().Trim()
  $proc.WaitForExit()

  Check ($proc.ExitCode -eq 0) "sealing succeeds against real DPAPI on this host ($sealErr)"
  Check ($token -like 'enc:v1:*') 'and produces an enc:v1: token'
  Check (Test-Path -LiteralPath $keyFile) 'the key file is created where GCIO_KEY_FILE pointed'

  $bytes = [IO.File]::ReadAllBytes($keyFile)
  Check ($bytes.Length -gt 32) "the key file holds a DPAPI blob, not 32 raw bytes (got $($bytes.Length))"
  Check (-not ([Text.Encoding]::UTF8.GetString($bytes) -like "*$secret*")) 'the secret does not appear in the key file'
  Check (-not ((Get-Content $sealFile -Raw) -like "*$secret*")) 'nor in the sealer script on disk'

  # Opening from a SEPARATE process. One process could pass by holding the key
  # in memory throughout; the service will not have that luxury.
  $srcUrl = 'file:///' + $repoRoot.Path.Replace('\', '/')
  $openJs = @"
import { makeSecretBox } from "$srcUrl/server/crypto/secretBox.js";
import { loadOrCreateKey } from "$srcUrl/server/crypto/masterKey.js";
process.stdout.write(makeSecretBox(loadOrCreateKey(process.argv[2])).open(process.argv[3]));
"@
  $openFile = Join-Path $root 'open.mjs'; [IO.File]::WriteAllText($openFile, $openJs)
  $opened = & node $openFile $keyFile $token
  Check ($opened -eq $secret) 'a SEPARATE process opens the token back to the original secret'

  # The property the whole design rests on: the ciphertext is worthless without
  # this machine's key. Approximated here by destroying the key - a different
  # host is the same situation from the blob's point of view.
  Remove-Item -LiteralPath $keyFile -Force
  & node $openFile $keyFile $token 2>$null | Out-Null
  Check ($LASTEXITCODE -ne 0) 'the token does not open once the key is gone'

} finally {
  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}

if ($script:fails) { Write-Host "`n$($script:fails) failed" -ForegroundColor Red; exit 1 }
Write-Host "`nall passed" -ForegroundColor Green
