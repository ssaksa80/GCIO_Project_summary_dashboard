<#
  Fast tree delete and copy.

  A bundle deploy makes four passes over ~17,000 files: delete the previous
  unpack, extract, checksum, copy into place. Two of those used PowerShell
  cmdlets that materialise an object per file. On a live host the delete
  measured 0.1 MB/s and printed "Removed 8820 of 17244 files" for long enough
  that it was indistinguishable from a hang — which is how it was reported.

  These tests are about correctness, not speed. A timing assertion would be
  flaky on a loaded machine and would fail for reasons unrelated to the code.
  What matters is that the fast paths do exactly what the slow ones did,
  including on the awkward inputs, and that a fallback exists.
#>
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../lib/common.ps1"

$script:fails = 0
function Check { param($Cond, [string]$What)
  if ($Cond) { Write-Host "[ok] $What" -ForegroundColor Green }
  else { Write-Host "[FAIL] $What" -ForegroundColor Red; $script:fails++ } }

$root = Join-Path ([IO.Path]::GetTempPath()) ("gcio-tree-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $root | Out-Null

function MakeTree([string]$at, [int]$depth = 3, [int]$perDir = 4) {
  New-Item -ItemType Directory -Force $at | Out-Null
  $cur = $at
  for ($d = 0; $d -lt $depth; $d++) {
    for ($f = 0; $f -lt $perDir; $f++) {
      [IO.File]::WriteAllText((Join-Path $cur "f$d-$f.txt"), "level $d file $f")
    }
    $cur = Join-Path $cur "sub$d"
    New-Item -ItemType Directory -Force $cur | Out-Null
  }
  return $at
}

try {
  # ---- delete --------------------------------------------------------------
  $t1 = MakeTree (Join-Path $root 'del1')
  $before = (Get-ChildItem $t1 -Recurse -File).Count
  Check ($before -gt 0) "the fixture has files to delete ($before)"
  Remove-GcioTree $t1
  Check (-not (Test-Path $t1)) 'a nested tree is removed entirely'

  # Absent is success. A deploy re-run must not fail because the thing it was
  # about to clear had already been cleared.
  $gone = Join-Path $root 'never-existed'
  $threw = $false
  try { Remove-GcioTree $gone } catch { $threw = $true }
  Check (-not $threw) 'removing a path that does not exist is not an error'

  # Read-only files: Remove-Item needs -Force for these, and any replacement
  # has to cope with them too or a deploy fails on an attribute.
  $t2 = MakeTree (Join-Path $root 'del2')
  Get-ChildItem $t2 -Recurse -File | ForEach-Object { $_.IsReadOnly = $true }
  Remove-GcioTree $t2
  Check (-not (Test-Path $t2)) 'read-only files do not stop the delete'

  # ---- copy ----------------------------------------------------------------
  $src = MakeTree (Join-Path $root 'src')
  [IO.File]::WriteAllText((Join-Path $src 'marker.txt'), 'COPIED')
  $dst = Join-Path $root 'dst'
  Copy-GcioTree -Source $src -Destination $dst
  Check (Test-Path (Join-Path $dst 'marker.txt')) 'a file is copied'
  Check ((Get-Content (Join-Path $dst 'marker.txt') -Raw).Trim() -eq 'COPIED') 'with its content'
  $srcCount = (Get-ChildItem $src -Recurse -File).Count
  $dstCount = (Get-ChildItem $dst -Recurse -File).Count
  Check ($srcCount -eq $dstCount) "every file arrives ($srcCount -> $dstCount)"

  # Nested structure, not just the top level.
  Check (Test-Path (Join-Path $dst 'sub0/sub1/f2-0.txt')) 'nested directories are copied'

  # Overlaying an existing destination is what an upgrade does.
  [IO.File]::WriteAllText((Join-Path $dst 'marker.txt'), 'STALE')
  Copy-GcioTree -Source $src -Destination $dst
  Check ((Get-Content (Join-Path $dst 'marker.txt') -Raw).Trim() -eq 'COPIED') 'an existing file is overwritten'

  # Without -Mirror, a file only in the destination survives. install.ps1
  # overlays onto a live install, so deleting what it did not bring would take
  # out anything an operator had put there.
  [IO.File]::WriteAllText((Join-Path $dst 'operator-put-this-here.txt'), 'keep')
  Copy-GcioTree -Source $src -Destination $dst
  Check (Test-Path (Join-Path $dst 'operator-put-this-here.txt')) 'an overlay does not delete what it did not bring'

  # With -Mirror it does, which is why it is opt-in.
  $mir = Join-Path $root 'mirror'
  Copy-GcioTree -Source $src -Destination $mir
  [IO.File]::WriteAllText((Join-Path $mir 'extra.txt'), 'x')
  Copy-GcioTree -Source $src -Destination $mir -Mirror
  Check (-not (Test-Path (Join-Path $mir 'extra.txt'))) '-Mirror removes what the source does not have'

  # A missing source is a mistake worth failing on, not an empty copy.
  $threw2 = $false
  try { Copy-GcioTree -Source (Join-Path $root 'nope') -Destination (Join-Path $root 'out') } catch { $threw2 = $true }
  Check $threw2 'copying a source that does not exist throws'

} finally {
  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}

if ($script:fails) { Write-Host "`n$($script:fails) failed" -ForegroundColor Red; exit 1 }
Write-Host "`nall passed" -ForegroundColor Green
