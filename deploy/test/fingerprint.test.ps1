<#
  The two fingerprints the patch gate is built on.

  Both must be immune to changes that do not alter meaning, and sensitive to
  changes that do. Getting that backwards in either direction is bad in a
  different way:

    - too sensitive  -> the gate refuses valid patches, someone switches it off;
    - not sensitive  -> a schema or dependency change rides in on an overlay,
                        which is the failure the whole system exists to prevent.

  The second is worse, so where there is doubt these lean toward refusing.
#>
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../lib/common.ps1"

$script:fails = 0
function Assert-Eq { param($A, $B, [string]$What)
  if ("$A" -ne "$B") { Write-Host "[FAIL] $What" -ForegroundColor Red; Write-Host "         '$A' != '$B'"; $script:fails++ }
  else { Write-Host "[ok] $What" -ForegroundColor Green } }
function Assert-Ne { param($A, $B, [string]$What)
  if ("$A" -eq "$B") { Write-Host "[FAIL] $What" -ForegroundColor Red; Write-Host "         both were '$A'"; $script:fails++ }
  else { Write-Host "[ok] $What" -ForegroundColor Green } }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("gcio-fp-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
  # ------------------------------------------------ schema fingerprint

  $lf   = Join-Path $tmp 'm-lf.js'
  $crlf = Join-Path $tmp 'm-crlf.js'
  $diff = Join-Path $tmp 'm-diff.js'
  [IO.File]::WriteAllText($lf,   "export const MIGRATIONS = [`n  { id: 1, sql: 'A' },`n];`n")
  [IO.File]::WriteAllText($crlf, "export const MIGRATIONS = [`r`n  { id: 1, sql: 'A' },`r`n];`r`n")
  [IO.File]::WriteAllText($diff, "export const MIGRATIONS = [`n  { id: 1, sql: 'B' },`n];`n")

  Assert-Eq (Get-GcioMigrationsFingerprint $lf) (Get-GcioMigrationsFingerprint $crlf) 'CRLF and LF fingerprint the same (a Windows checkout must not force a bundle)'
  Assert-Ne (Get-GcioMigrationsFingerprint $lf) (Get-GcioMigrationsFingerprint $diff) 'a changed migration changes the fingerprint'
  Assert-Eq (Get-GcioMigrationsFingerprint (Join-Path $tmp 'nope.js')) '' 'a missing file fingerprints as empty rather than throwing'
  Assert-Eq ((Get-GcioMigrationsFingerprint $lf).Length) 64 'the fingerprint is a full-length sha256'

  # Whole-file hashing is the documented trade: this SHOULD change the
  # fingerprint even though no schema changed. Pinned so nobody "fixes" it
  # later without reading why.
  $comment = Join-Path $tmp 'm-comment.js'
  [IO.File]::WriteAllText($comment, "// a new comment`nexport const MIGRATIONS = [`n  { id: 1, sql: 'A' },`n];`n")
  Assert-Ne (Get-GcioMigrationsFingerprint $lf) (Get-GcioMigrationsFingerprint $comment) 'a comment-only edit DOES change it - over-triggering is the deliberate, safe direction'

  # ------------------------------------------------ dependency hash

  $l1 = Join-Path $tmp 'l1.json'
  $l2 = Join-Path $tmp 'l2.json'
  $l3 = Join-Path $tmp 'l3.json'
  [IO.File]::WriteAllText($l1, '{"name":"g","version":"1.5.0","packages":{"":{"version":"1.5.0"},"node_modules/x":{"version":"2.0.0"}}}')
  [IO.File]::WriteAllText($l2, '{"name":"g","version":"1.6.0","packages":{"":{"version":"1.6.0"},"node_modules/x":{"version":"2.0.0"}}}')
  [IO.File]::WriteAllText($l3, '{"name":"g","version":"1.5.0","packages":{"":{"version":"1.5.0"},"node_modules/x":{"version":"3.0.0"}}}')

  Assert-Eq (Get-GcioLockDepsHash $l1) (Get-GcioLockDepsHash $l2) 'an npm version bump alone does NOT change the deps hash'
  Assert-Ne (Get-GcioLockDepsHash $l1) (Get-GcioLockDepsHash $l3) 'a real dependency change DOES change the deps hash'
  Assert-Eq (Get-GcioLockDepsHash (Join-Path $tmp 'nope.json')) '' 'a missing lockfile hashes as empty rather than throwing'

  $none = Join-Path $tmp 'l-none.json'
  [IO.File]::WriteAllText($none, '{"name":"g","version":"1.5.0","packages":{"":{"version":"1.5.0"}}}')
  $none2 = Join-Path $tmp 'l-none2.json'
  [IO.File]::WriteAllText($none2, '{"name":"g","version":"9.9.9","packages":{"":{"version":"9.9.9"}}}')
  Assert-Eq (Get-GcioLockDepsHash $none) (Get-GcioLockDepsHash $none2) 'a lockfile with no dependencies is version-independent too'

  # ------------------------------------------------ against the REAL files
  #
  # Fixtures are one line; the repo's lockfile is 5,000 pretty-printed ones, and
  # an approach can pass the first and fail the second. Both are checked.

  $repo     = Resolve-Path "$PSScriptRoot/../.."
  $realLock = Join-Path $repo 'package-lock.json'
  $realMig  = Join-Path $repo 'server/db/migrations.js'

  Assert-Eq ((Get-GcioLockDepsHash $realLock).Length) 64 "the repo's real lockfile hashes"
  Assert-Eq ((Get-GcioMigrationsFingerprint $realMig).Length) 64 "the repo's real migrations.js fingerprints"

  $bumped = Join-Path $tmp 'real-bumped.json'
  $orig = [IO.File]::ReadAllText($realLock)
  $pkgVer = (Get-Content -Raw (Join-Path $repo 'package.json') | ConvertFrom-Json).version
  # Bump ONLY the app's own version, which lives in the header before the first
  # "node_modules/" entry. A whole-file replace looks equivalent and is not: the
  # app's version string is not unique in a lockfile, and any dependency pinned
  # at the same version would be rewritten too. Those sit inside the deps-hash
  # window, so the fixture would change the very thing the assertion says it
  # leaves alone, and the test would fail while the code under test was correct.
  # Found for real at 1.5.1, which @napi-rs/lzma-linux-x64-gnu and base64-js
  # both happen to be pinned to.
  $nmAt = $orig.IndexOf('"node_modules/')
  if ($nmAt -lt 0) { throw 'lockfile has no node_modules/ entries - fixture assumption broken' }
  $head = $orig.Substring(0, $nmAt)
  $tail = $orig.Substring($nmAt)
  $head = $head -replace [regex]::Escape("`"version`": `"$pkgVer`""), '"version": "9.9.9"'
  [IO.File]::WriteAllText($bumped, ($head + $tail))
  Assert-Eq (Get-GcioLockDepsHash $realLock) (Get-GcioLockDepsHash $bumped) 'bumping only the app version in the REAL lockfile leaves the deps hash unchanged'

  $depTouched = Join-Path $tmp 'real-dep.json'
  [IO.File]::WriteAllText($depTouched, ($orig -replace '"integrity": "sha512-', '"integrity": "sha512-X'))
  Assert-Ne (Get-GcioLockDepsHash $realLock) (Get-GcioLockDepsHash $depTouched) 'altering a dependency in the REAL lockfile DOES change the deps hash'
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

if ($script:fails) { Write-Host "`n$($script:fails) failed" -ForegroundColor Red; exit 1 }
Write-Host "`nall passed" -ForegroundColor Green
