<#
  What a patch leaves ON the host, so a later recovery has something to call.

  Install-GcioHostTooling copies host-side scripts out of the artifact and onto
  the install directory, so the tooling never lags the artifact that last
  touched it. That only works for files the artifact actually contains, and the
  two lists live in different files - the ship list in build-patch.ps1, the copy
  list in install.ps1. Nothing tied them together, and they had already drifted:

    - install-service.ps1 and versions.json are on the copy list but a patch
      does not ship them, so those copies silently did nothing on every patch;
    - code-update.ps1 and Update-GCIO.cmd were on neither list, so a host that
      had only ever been patched had no updater at all. The documented recovery
      command, `Update-GCIO.cmd -Rollback`, named a script that was not there.
      Found on the live host after deploying 1.5.1.

  The copy is guarded by `if (Test-Path $src)`, which is what made the drift
  silent rather than loud - a missing file is skipped, the deploy reports
  health=OK, and the host quietly never gains the script.

  This runs the REAL installer against a fixture rather than reading either
  list, because a test that greps two source files for matching strings passes
  whenever both are wrong in the same way.
#>
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../lib/common.ps1"

$script:fails = 0
function Check { param($Cond, [string]$What)
  if ($Cond) { Write-Host "[ok] $What" -ForegroundColor Green }
  else { Write-Host "[FAIL] $What" -ForegroundColor Red; $script:fails++ } }

$deploy = Resolve-Path "$PSScriptRoot/.."
$repoRoot = Resolve-Path "$PSScriptRoot/../.."
$root = Join-Path ([IO.Path]::GetTempPath()) ("gcio-ht-" + [guid]::NewGuid().ToString('N'))
$inst  = Join-Path $root 'install'
$patch = Join-Path $root 'patch'

# Everything Install-GcioHostTooling exists to put on the host. A patch must
# carry each of these, or the copy is a no-op and the host keeps a stale one.
$MustReachHost = @('install.ps1', 'uninstall.ps1', 'code-update.ps1', 'Update-GCIO.cmd', 'seal-secret.ps1')

try {
  New-Item -ItemType Directory -Force `
    "$inst/app/server/db", "$inst/app/client/dist", "$inst/app/node_modules/dep", `
    "$patch/app/server/db", "$patch/app/client/dist", "$patch/lib" | Out-Null

  [IO.File]::WriteAllText("$inst/app/package.json", '{"version":"1.5.0"}')
  [IO.File]::WriteAllText("$inst/app/server/db/migrations.js", 'MIGRATIONS')
  [IO.File]::WriteAllText("$inst/app/node_modules/dep/index.js", 'KEEP')
  # A port nothing is listening on, and deliberately NOT 8130. install.ps1 reads
  # PORT from the fixture's .env and then waits for that port to go quiet before
  # it will overlay. Pointed at the live port, the probe sees production's
  # listener, concludes the service never released it, and refuses - a fixture
  # failing on the state of the real host. Same coupling as the service name
  # above, one layer down.
  [IO.File]::WriteAllText("$inst/.env", 'PORT=18130')

  # A patch payload shaped like the real one, carrying the host scripts the
  # builder is supposed to stage.
  # Test-GcioPatchComplete requires this exact shape before it will look at
  # versions at all, so the fixture has to satisfy it or the installer refuses
  # on structure and never reaches the host-tooling copy this test is about.
  [IO.File]::WriteAllText("$patch/app/package.json", '{"version":"1.5.1"}')
  [IO.File]::WriteAllText("$patch/app/server/index.js", 'SERVER')
  [IO.File]::WriteAllText("$patch/app/server/db/migrations.js", 'MIGRATIONS')
  [IO.File]::WriteAllText("$patch/app/client/dist/index.html", '<html></html>')
  [IO.File]::WriteAllText("$patch/VERSION", '1.5.1')
  Copy-Item "$repoRoot/package-lock.json" "$patch/app/package-lock.json" -Force
  Copy-Item "$repoRoot/package-lock.json" "$inst/app/package-lock.json" -Force
  $meta = @{
    # nodeMajor deliberately omitted: it defaults to -1, which is also what an
    # install with no bundled runtime reports, so the node gate is a no-op here.
    # This test is about what a patch leaves on the host; patch-gates.test.ps1
    # owns the node gate and exercises it against real values.
    kind = 'patch'; version = '1.5.1'; minBase = '1.5.0'
    lockDepsHash          = (Get-GcioLockDepsHash "$patch/app/package-lock.json")
    migrationsFingerprint = (Get-GcioMigrationsFingerprint "$patch/app/server/db/migrations.js")
  } | ConvertTo-Json
  [IO.File]::WriteAllText("$patch/patch-meta.json", $meta)
  [IO.File]::WriteAllText("$patch/checksums.txt", '')
  Copy-Item "$deploy/lib/common.ps1" "$patch/lib/common.ps1" -Force
  foreach ($f in $MustReachHost) {
    if (Test-Path "$deploy/$f") { Copy-Item "$deploy/$f" "$patch/$f" -Force }
  }

  # ---- 1. the REAL built artifact must carry them ---------------------------
  # Against the artifact rather than against build-patch.ps1's source: grepping
  # that script for a filename matches the copy it makes BESIDE the archive as
  # readily as the one it stages INSIDE it, so a source check passes while the
  # artifact is empty. That false positive was in this test's first draft.
  $newest = Get-ChildItem (Join-Path $repoRoot 'dist-bundle') -Directory -Filter 'gcio-patch-*' -EA SilentlyContinue |
            Sort-Object Name -Descending | Select-Object -First 1
  if ($newest) {
    foreach ($f in $MustReachHost) {
      Check (Test-Path (Join-Path $newest.FullName $f)) "the built patch $($newest.Name) carries $f"
    }
  } else {
    Check $false 'a built patch exists in dist-bundle/ to check (run build-patch.ps1)'
  }

  # ---- 2. and the installer must actually place them on the host -----------
  # install.ps1 resolves its payload from its OWN directory - it is meant to run
  # from inside an unpacked artifact, which is what code-update.ps1 arranges. So
  # the fixture runs the copy inside the fake artifact, not the one in deploy/.
  $inst2 = Join-Path $root 'install2'
  Copy-Item -Recurse -Force $inst $inst2
  # -ServiceName is NOT optional here, however unused it looks. It defaults to
  # 'GCIOProjectIntelligence', the live service, and install.ps1 stops and starts
  # whatever name it is given regardless of which directory it is patching. The
  # first version of this test omitted it and took the production service down
  # and back up on every run - the overlay went to the temp fixture while the
  # stop and start hit the real host. Point it at a name that cannot exist.
  $fakeSvc = 'GCIOTestFixture-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
  & pwsh -NoProfile -ExecutionPolicy Bypass -File "$patch/install.ps1" `
      -InstallDir $inst2 -ServiceName $fakeSvc -Patch -SkipHealthGate -SkipSqlPrecheck `
      *> "$root/install.log" 2>&1

  $before = $script:fails
  foreach ($f in $MustReachHost) {
    Check (Test-Path (Join-Path $inst2 $f)) "after a patch, the host has $f"
  }
  Check (Test-Path (Join-Path $inst2 'lib/common.ps1')) 'after a patch, the host has lib/common.ps1'

  # If the copy did not happen, the installer's own output is the only thing
  # that says why - and without it a reader sees six identical failures and no
  # cause. Printed only on failure so a passing run stays quiet.
  if ($script:fails -gt $before) {
    Write-Host '--- installer output ---' -ForegroundColor Yellow
    if (Test-Path "$root/install.log") { Get-Content "$root/install.log" | Select-Object -Last 20 | ForEach-Object { "    $_" } }
    else { '    (no install.log was written)' }
  }

  # ---- 3. the recovery command in the messages must exist on the host ------
  # code-update.ps1 tells operators to run `Update-GCIO.cmd -Rollback`. That
  # instruction is only true if a patch leaves that file behind.
  $updater = [IO.File]::ReadAllText("$deploy/code-update.ps1")
  if ($updater -match 'Update-GCIO\.cmd -Rollback') {
    Check (Test-Path (Join-Path $inst2 'Update-GCIO.cmd')) `
      'the rollback command the updater names is present on the host it names it to'
  }
} finally {
  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}

if ($script:fails) { Write-Host "`n$($script:fails) failed" -ForegroundColor Red; exit 1 }
Write-Host "`nall passed" -ForegroundColor Green
