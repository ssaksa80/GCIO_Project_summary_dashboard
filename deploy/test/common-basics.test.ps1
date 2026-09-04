# Foundations of deploy/lib/common.ps1: hashing and dotted-key JSON reads.
#
# Every gate in the release system is built on Get-GcioSha256, so a known-vector
# check here is worth more than it looks: a hash function that is subtly wrong
# fails by ACCEPTING things, which no downstream test would notice.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../lib/common.ps1"

$script:fails = 0
function Assert-Eq {
  param($Actual, $Expected, [string]$What)
  if ("$Actual" -ne "$Expected") {
    Write-Host "[FAIL] $What" -ForegroundColor Red
    Write-Host "         got:  '$Actual'"
    Write-Host "         want: '$Expected'"
    $script:fails++
  } else { Write-Host "[ok] $What" -ForegroundColor Green }
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("gcio-t-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
  # ---- Get-GcioSha256 against published vectors ----
  $f = Join-Path $tmp 'a.txt'
  [IO.File]::WriteAllText($f, 'hello')
  Assert-Eq (Get-GcioSha256 $f) '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' 'sha256("hello") matches the published vector'

  $empty = Join-Path $tmp 'empty.txt'
  [IO.File]::WriteAllText($empty, '')
  Assert-Eq (Get-GcioSha256 $empty) 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' 'sha256("") matches the published vector'

  <#
    A node_modules fixture with wildcard metachars in its name.

    The content MUST differ from every other file in $tmp, and that is the whole
    point. '[brackets].txt' read as a glob is a character class -- one character
    from {b,r,a,c,k,e,t,s} followed by '.txt' -- which happily matches the
    'a.txt' fixture above. An earlier version of this test wrote 'hello' into
    both, so a positional -Path hashed the WRONG FILE and got the RIGHT ANSWER:
    the test passed with the guard removed. Distinct content is what makes it
    able to fail.
  #>
  $weirdText = 'bracketed-content-unique-to-this-file'
  $weird = Join-Path $tmp '[brackets].txt'
  [IO.File]::WriteAllText($weird, $weirdText)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $expectWeird = ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($weirdText)) | ForEach-Object { $_.ToString('x2') }) -join ''
  } finally { $sha.Dispose() }
  Assert-Eq (Get-GcioSha256 $weird) $expectWeird 'a filename containing [ ] hashes THAT file, not whatever the glob matched'

  # ---- Test-GcioSha256 ----
  $threw = $false
  try { Test-GcioSha256 $f '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' } catch { $threw = $true }
  Assert-Eq $threw $false 'a matching checksum passes quietly'

  # Mismatch must be fatal: this is the supply-chain check, and a warning that
  # scrolls past is not a check.
  # This child is SUPPOSED to fail, and it says so on stderr. Windows PowerShell
  # 5.1 turns native stderr into a TERMINATING NativeCommandError while
  # $ErrorActionPreference is 'Stop', and 2>$null does not prevent it - so the
  # suite used to die here, four checks in, with no verdict and exit 1.
  $prevEap = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $rc = & pwsh -NoProfile -Command ". '$PSScriptRoot/../lib/common.ps1'; Test-GcioSha256 '$($f -replace '\\','/')' 'deadbeef'" 2>$null
  } finally { $ErrorActionPreference = $prevEap }
  Assert-Eq $LASTEXITCODE 1 'a mismatched checksum exits non-zero rather than warning'

  # ---- Get-GcioJsonValue ----
  $j = Join-Path $tmp 'v.json'
  [IO.File]::WriteAllText($j, '{"node":{"version":"24.19.0","win-x64":{"url":"U","sha256":"S"}},"nssm":{"url":"N"}}')
  Assert-Eq (Get-GcioJsonValue $j 'node.win-x64.url')    'U'        'a dotted key walks nested objects'
  Assert-Eq (Get-GcioJsonValue $j 'node.version')        '24.19.0'  'a two-part key resolves'
  Assert-Eq (Get-GcioJsonValue $j 'nssm.url')            'N'        'a sibling branch resolves'
  Assert-Eq (Get-GcioJsonValue $j 'node.missing.deeper') ''         'a missing key returns empty, not an exception'

  # ---- the real versions.json, so the build scripts cannot be reading nothing ----
  $real = Join-Path $PSScriptRoot '../versions.json'
  Assert-Eq ((Get-GcioJsonValue $real 'node.win-x64.sha256').Length) 64 'the pinned node sha256 is a full-length hash'
  Assert-Eq ((Get-GcioJsonValue $real 'nssm.sha256').Length)         64 'the pinned nssm sha256 is a full-length hash'
  Assert-Eq (Get-GcioJsonValue $real 'node.version') '24.19.0' 'the pinned node version is the one the suite runs against'
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

if ($script:fails) { Write-Host "`n$($script:fails) failed" -ForegroundColor Red; exit 1 }
Write-Host "`nall passed" -ForegroundColor Green
