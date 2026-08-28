<#
  The four fail-closed gates that decide whether a patch overlay may be applied.

  Two properties are being pinned here, and the second is easy to lose in a
  later refactor:

    1. Each gate fires on exactly its own condition, with a distinct Code the
       caller can turn into operator guidance without re-parsing prose.
    2. A REFUSAL MUTATES NOTHING. The gates run before any stop, backup or
       overlay, so a refused patch leaves the install byte-identical and there
       is no rollback to perform. The last test asserts that directly.
#>
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../lib/common.ps1"

$script:fails = 0
function Assert-Code {
  param($Compat, [string]$Code, [string]$What)
  if ($Compat.Code -ne $Code) {
    Write-Host "[FAIL] $What" -ForegroundColor Red
    Write-Host "         got code '$($Compat.Code)' want '$Code'  (reason: $($Compat.Reason))"
    $script:fails++
  } else { Write-Host "[ok] $What" -ForegroundColor Green }
}
function Assert-True {
  param($Cond, [string]$What)
  if ($Cond) { Write-Host "[ok] $What" -ForegroundColor Green }
  else { Write-Host "[FAIL] $What" -ForegroundColor Red; $script:fails++ }
}

$root = Join-Path ([IO.Path]::GetTempPath()) ("gcio-g-" + [guid]::NewGuid().ToString('N'))

<#
  A minimal install + patch pair on disk. Defaults are a COMPATIBLE pair; each
  test varies exactly one thing so a failure names its own cause.
#>
function New-Fixture {
  param(
    [string]$InstVer = '1.5.0', [string]$MinBase = '1.5.0', [string]$PatchVer = '1.5.1',
    [int]$NodeMajor = 24,
    [string]$InstDeps = '2.0.0', [string]$PatchDeps = '2.0.0',
    [string]$InstMig  = "MIGRATIONS = [1]", [string]$PatchMig = "MIGRATIONS = [1]"
  )
  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
  $inst  = Join-Path $root 'install'
  $patch = Join-Path $root 'patch'
  New-Item -ItemType Directory -Force "$inst/app/server/db","$patch/app/server/db" | Out-Null

  [IO.File]::WriteAllText("$inst/app/package.json", '{"version":"' + $InstVer + '"}')
  [IO.File]::WriteAllText("$inst/app/package-lock.json",  '{"name":"g","version":"' + $InstVer  + '","packages":{"":{"version":"' + $InstVer  + '"},"node_modules/x":{"version":"' + $InstDeps  + '"}}}')
  [IO.File]::WriteAllText("$patch/app/package-lock.json", '{"name":"g","version":"' + $PatchVer + '","packages":{"":{"version":"' + $PatchVer + '"},"node_modules/x":{"version":"' + $PatchDeps + '"}}}')
  [IO.File]::WriteAllText("$inst/app/server/db/migrations.js",  $InstMig)
  [IO.File]::WriteAllText("$patch/app/server/db/migrations.js", $PatchMig)

  $meta = New-GcioPatchMeta -AppDir "$patch/app" -Version $PatchVer -NodeMajor $NodeMajor -MinBase $MinBase -BuiltFrom 'testfix'
  $meta | ConvertTo-Json -Depth 6 | Out-File -Encoding ascii "$patch/patch-meta.json"

  return @{ Install = $inst; Patch = $patch }
}

function Snapshot {
  param([string]$Dir)
  (Get-ChildItem -Recurse -File -LiteralPath $Dir | Sort-Object FullName |
    ForEach-Object { "$($_.FullName)|$(Get-GcioSha256 $_.FullName)" }) -join "`n"
}

try {
  # ---------------------------------------------------------- the happy path
  $f = New-Fixture
  Assert-Code (Test-GcioPatchCompatible -PatchRoot $f.Patch -InstallDir $f.Install -InstalledNodeMajor 24) 'ok' 'a compatible patch passes every gate'

  # ---------------------------------------------------------- min-base
  $f = New-Fixture -InstVer '1.4.0' -MinBase '1.5.0'
  Assert-Code (Test-GcioPatchCompatible -PatchRoot $f.Patch -InstallDir $f.Install -InstalledNodeMajor 24) 'min-base' 'an install older than the patch minBase is refused'

  $f = New-Fixture -InstVer '1.6.0' -MinBase '1.5.0'
  Assert-Code (Test-GcioPatchCompatible -PatchRoot $f.Patch -InstallDir $f.Install -InstalledNodeMajor 24) 'ok' 'an install NEWER than minBase is fine (it is a floor, not an equality)'

  # ---------------------------------------------------------- node-major
  $f = New-Fixture
  Assert-Code (Test-GcioPatchCompatible -PatchRoot $f.Patch -InstallDir $f.Install -InstalledNodeMajor 20) 'node-major' 'a Node major mismatch is refused (a patch ships no runtime to bridge it)'

  # ---------------------------------------------------------- deps-changed
  $f = New-Fixture -InstDeps '2.0.0' -PatchDeps '3.0.0'
  Assert-Code (Test-GcioPatchCompatible -PatchRoot $f.Patch -InstallDir $f.Install -InstalledNodeMajor 24) 'deps-changed' 'changed dependencies are refused (a patch ships no node_modules)'

  # A version bump alone must NOT read as a dependency change.
  $f = New-Fixture -InstVer '1.5.0' -PatchVer '1.5.1'
  Assert-Code (Test-GcioPatchCompatible -PatchRoot $f.Patch -InstallDir $f.Install -InstalledNodeMajor 24) 'ok' 'a version bump alone does not trip the dependency gate'

  # ---------------------------------------------------------- schema-changed
  $f = New-Fixture -InstMig "MIGRATIONS = [1]" -PatchMig "MIGRATIONS = [1,2]"
  Assert-Code (Test-GcioPatchCompatible -PatchRoot $f.Patch -InstallDir $f.Install -InstalledNodeMajor 24) 'schema-changed' 'a changed schema is refused (GCIO migrates at boot, so an overlay would migrate unchosen)'

  # CRLF alone is not a schema change.
  $f = New-Fixture -InstMig "MIGRATIONS = [1]`n" -PatchMig "MIGRATIONS = [1]`r`n"
  Assert-Code (Test-GcioPatchCompatible -PatchRoot $f.Patch -InstallDir $f.Install -InstalledNodeMajor 24) 'ok' 'a CRLF/LF flip alone does not trip the schema gate'

  # ---------------------------------------------------------- malformed input
  $f = New-Fixture
  Remove-Item "$($f.Patch)/patch-meta.json"
  Assert-Code (Test-GcioPatchCompatible -PatchRoot $f.Patch -InstallDir $f.Install -InstalledNodeMajor 24) 'meta-missing' 'a patch with no meta is refused'

  $f = New-Fixture
  Remove-Item "$($f.Install)/app/package.json"
  Assert-Code (Test-GcioPatchCompatible -PatchRoot $f.Patch -InstallDir $f.Install -InstalledNodeMajor 24) 'no-install' 'patching a machine with no install is refused'

  $f = New-Fixture
  Remove-Item "$($f.Install)/app/package-lock.json"
  Assert-Code (Test-GcioPatchCompatible -PatchRoot $f.Patch -InstallDir $f.Install -InstalledNodeMajor 24) 'lockfile-missing' 'an install predating lockfile tracking is refused rather than assumed compatible'

  # ---------------------------------------------------------- the meta itself
  $f = New-Fixture
  $meta = Get-Content -Raw "$($f.Patch)/patch-meta.json" | ConvertFrom-Json
  Assert-True ($meta.kind -eq 'patch')                      'the meta declares its kind'
  Assert-True ($meta.nodeMajor -eq 24)                      'the meta records the target Node major'
  Assert-True ($meta.lockDepsHash.Length -eq 64)            'the meta records a full-length deps hash'
  Assert-True ($meta.migrationsFingerprint.Length -eq 64)   'the meta records a full-length schema fingerprint'
  Assert-True ($meta.builtFrom -eq 'testfix')               'the meta records what it was built from'

  # ---------------------------------------------------------- structural check
  Assert-True (-not (Test-GcioPatchComplete -Root $f.Patch)) 'a bare fixture is not a complete patch artifact'

  # ---------------------------------------------------------- THE INVARIANT
  #
  # Every refusal path, not just one: a gate that mutates on its way to saying
  # "no" is the difference between "nothing changed" and a half-applied patch
  # with no rollback taken.
  # NOTE the splat. An earlier version wrote `New-Fixture @($case.Args)[0]`,
  # which does NOT splat -- it hands the hashtable to $InstVer positionally, so
  # every case built the same fixture with a garbage version string and refused
  # via min-base rather than via the gate it named. All three passed for the
  # wrong reason, and only showed up when the min-base gate was mutated out and
  # the OTHER two cases went red with it. Assert the Code, not just Ok, so a
  # repeat of that cannot hide.
  foreach ($case in @(
    @{ Name = 'schema-changed'; Args = @{ InstMig = 'A'; PatchMig = 'B' } },
    @{ Name = 'deps-changed';   Args = @{ InstDeps = '2.0.0'; PatchDeps = '9.9.9' } },
    @{ Name = 'min-base';       Args = @{ InstVer = '1.0.0'; MinBase = '1.5.0' } }
  )) {
    $splat = $case.Args
    $f = New-Fixture @splat
    $before = Snapshot $f.Install
    $verdict = Test-GcioPatchCompatible -PatchRoot $f.Patch -InstallDir $f.Install -InstalledNodeMajor 24
    $after = Snapshot $f.Install
    Assert-Code $verdict $case.Name "$($case.Name): refused by the gate it is meant to exercise"
    Assert-True ($before -eq $after) "$($case.Name): the install is byte-identical after the refusal"
  }
} finally {
  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}

if ($script:fails) { Write-Host "`n$($script:fails) failed" -ForegroundColor Red; exit 1 }
Write-Host "`nall passed" -ForegroundColor Green
