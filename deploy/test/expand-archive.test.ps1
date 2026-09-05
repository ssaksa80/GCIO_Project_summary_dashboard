<#
  Archive expansion: fast by default, correct always.

  code-update.ps1 used Expand-Archive, which on a real bundle - 77.8 MB but
  17,571 entries, of which 15,312 are node_modules - took 730 seconds. Windows
  charges per file, not per megabyte. Measured against the same archive:

      Expand-Archive                     730.4s
      ZipFile::ExtractToDirectory        205.3s
      per-entry loop with a progress bar 462.6s   (DEDB's shape)

  So bulk extraction is 3.6x faster than what we had and 2.3x faster than
  DEDB's, whose own comment says it exists for PROGRESS rather than speed. The
  one genuinely good idea in DEDB's version is kept: any failure falls back to
  Expand-Archive, so an odd-but-valid archive can never brick an update that
  used to work.

  These tests are about correctness, not speed. A timing assertion here would
  be flaky on a loaded machine and would fail for reasons that have nothing to
  do with the code.
#>
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../lib/common.ps1"

$script:fails = 0
function Check { param($Cond, [string]$What)
  if ($Cond) { Write-Host "[ok] $What" -ForegroundColor Green }
  else { Write-Host "[FAIL] $What" -ForegroundColor Red; $script:fails++ } }

$root = Join-Path ([IO.Path]::GetTempPath()) ("gcio-xa-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $root | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem

function NewZip([hashtable]$Files, [string]$Name = 'a.zip') {
  $stage = Join-Path $root ([guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force $stage | Out-Null
  foreach ($k in $Files.Keys) {
    $p = Join-Path $stage $k
    New-Item -ItemType Directory -Force (Split-Path -Parent $p) | Out-Null
    [IO.File]::WriteAllText($p, $Files[$k])
  }
  $zip = Join-Path $root ([guid]::NewGuid().ToString('N') + '-' + $Name)
  [System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip)
  return $zip
}

try {
  # ---- the ordinary case ---------------------------------------------------
  $zip = NewZip @{ 'app/server/index.js' = 'SERVER'; 'VERSION' = '1.2.3' }
  $dest = Join-Path $root 'out1'
  Expand-GcioArchive -Zip $zip -Dest $dest
  Check (Test-Path (Join-Path $dest 'app/server/index.js')) 'a nested file is extracted'
  Check ((Get-Content (Join-Path $dest 'VERSION') -Raw).Trim() -eq '1.2.3') 'and its content is intact'

  # ---- overwrite, which is what Expand-Archive -Force gave us --------------
  # The call sites delete the destination first, but a function that silently
  # refuses to overwrite would fail only on the day someone stops doing that.
  $dest2 = Join-Path $root 'out2'
  New-Item -ItemType Directory -Force (Join-Path $dest2 'app/server') | Out-Null
  [IO.File]::WriteAllText((Join-Path $dest2 'VERSION'), 'STALE')
  Expand-GcioArchive -Zip $zip -Dest $dest2 -Force
  Check ((Get-Content (Join-Path $dest2 'VERSION') -Raw).Trim() -eq '1.2.3') 'an existing file is overwritten with -Force'

  # ---- the fast path must actually BE the path taken ----------------------
  # The gap that let a real defect through. Every other test here asserts the
  # FILES are right, and the fallback produces identical files - so a fast path
  # that always threw and always fell back passed the whole suite while the real
  # bundle took 402s instead of 207s. Assert the warning is absent, which is the
  # only externally visible difference between the two paths.
  $destFast = Join-Path $root 'fast'
  $warnings = @()
  Expand-GcioArchive -Zip $zip -Dest $destFast -Force -WarningVariable +warnings -WarningAction SilentlyContinue 3>$null
  $fellBack = @($warnings | Where-Object { "$_" -match 'falling back' }).Count
  Check ($fellBack -eq 0) "the fast path succeeds on a normal archive and does not fall back (saw $fellBack fallback warnings)"
  Check (Test-Path (Join-Path $destFast 'VERSION')) 'and it extracted the files'

  # ---- the fallback, which is the whole reason to keep DEDB's shape --------
  # Injected rather than simulated with a corrupt archive: a corrupt archive
  # would fail BOTH paths and prove nothing about the fallback.
  $dest3 = Join-Path $root 'out3'
  $calls = 0
  Expand-GcioArchive -Zip $zip -Dest $dest3 -FastExtractor { param($z, $d, $f) $script:calls++; throw 'simulated fast-path failure' }
  Check (Test-Path (Join-Path $dest3 'app/server/index.js')) 'a failing fast path still extracts, via Expand-Archive'
  Check ($calls -eq 1) 'and the fast path was genuinely attempted first'

  # ---- zip-slip ------------------------------------------------------------
  # DEDB rejects traversal entries by hand. The claim that ExtractToDirectory
  # does it for us is worth PROVING rather than repeating: if it were false,
  # switching to bulk extraction would silently drop a security property.
  $slipStage = Join-Path $root 'slip'
  New-Item -ItemType Directory -Force $slipStage | Out-Null
  $slipZip = Join-Path $root 'slip.zip'
  $fs = [IO.File]::Open($slipZip, 'Create')
  $za = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
  $entry = $za.CreateEntry('../escaped.txt')
  $sw = New-Object IO.StreamWriter($entry.Open()); $sw.Write('PWNED'); $sw.Dispose()
  $za.Dispose(); $fs.Dispose()

  $dest4 = Join-Path $root 'out4/inner'
  $escaped = Join-Path $root 'out4/escaped.txt'
  $threw = $false
  try { Expand-GcioArchive -Zip $slipZip -Dest $dest4 } catch { $threw = $true }
  Check (-not (Test-Path $escaped)) 'a zip-slip entry does not write outside the destination'
  Check $threw 'and the extraction fails loudly rather than quietly skipping it'

  # ---- the SAME guarantees, through the progress path ----------------------
  #
  # -ProgressActivity swaps in an extractor that walks entries by hand, which
  # opts out of the traversal check ExtractToDirectory does for free. That check
  # is restated in the extractor, so it needs its own test: the slip case above
  # exercises the default path and would keep passing with the guard deleted.
  $destP = Join-Path $root 'prog'
  Expand-GcioArchive -Zip $zip -Dest $destP -Force -ProgressActivity 'testing'
  Check (Test-Path (Join-Path $destP 'app/server/index.js')) 'the progress path extracts a nested file'
  Check ((Get-Content (Join-Path $destP 'app/server/index.js') -Raw).Trim() -eq 'SERVER') 'with its content intact'
  Check ((Get-ChildItem $destP -Recurse -File).Count -eq (Get-ChildItem $dest -Recurse -File).Count) 'and the same number of files as the default path'

  $destPS  = Join-Path $root 'out5/inner'
  $escaped5 = Join-Path $root 'out5/escaped.txt'
  $threwP = $false
  try { Expand-GcioArchive -Zip $slipZip -Dest $destPS -ProgressActivity 'testing' } catch { $threwP = $true }
  Check (-not (Test-Path $escaped5)) 'the progress path does not write outside the destination'
  Check $threwP 'and it fails loudly rather than skipping the entry quietly'

  # ---- a missing archive is an error, not a silent no-op -------------------
  $threw2 = $false
  try { Expand-GcioArchive -Zip (Join-Path $root 'nope.zip') -Dest (Join-Path $root 'out5') } catch { $threw2 = $true }
  Check $threw2 'a missing archive throws'

} finally {
  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}

if ($script:fails) { Write-Host "`n$($script:fails) failed" -ForegroundColor Red; exit 1 }
Write-Host "`nall passed" -ForegroundColor Green
