<#
  Backup, overlay, restore -- the pieces the health gate needs before it can
  roll anything back.

  The behaviour that matters is what an overlay must NOT destroy. A patch
  replaces code and built assets; node_modules, the runtime, .env and any
  runtime state must survive it untouched. Getting that wrong turns a routine
  patch into a reinstall, and the operator finds out when the app will not
  start.
#>
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../lib/common.ps1"

$script:fails = 0
function Check { param($Cond, [string]$What)
  if ($Cond) { Write-Host "[ok] $What" -ForegroundColor Green }
  else { Write-Host "[FAIL] $What" -ForegroundColor Red; $script:fails++ } }
function Text { param([string]$P) if (Test-Path -LiteralPath $P) { ([IO.File]::ReadAllText($P)).Trim() } else { '<missing>' } }

$root = Join-Path ([IO.Path]::GetTempPath()) ("gcio-o-" + [guid]::NewGuid().ToString('N'))
$inst  = Join-Path $root 'install'
$patch = Join-Path $root 'patch'

try {
  New-Item -ItemType Directory -Force `
    "$inst/app/server/db", "$inst/app/shared", "$inst/app/node_modules/dep", "$inst/app/client/dist", `
    "$inst/runtime/node", "$patch/app/server/db", "$patch/app/shared", "$patch/app/client/dist" | Out-Null

  # the installed app
  [IO.File]::WriteAllText("$inst/app/server/index.js", 'OLD-SERVER')
  [IO.File]::WriteAllText("$inst/app/server/db/migrations.js", 'OLD-MIGRATIONS')
  [IO.File]::WriteAllText("$inst/app/shared/util.js", 'OLD-SHARED')
  [IO.File]::WriteAllText("$inst/app/client/dist/index.html", 'OLD-CLIENT')
  [IO.File]::WriteAllText("$inst/app/package.json", '{"version":"1.5.0"}')
  # things an overlay must NOT touch
  [IO.File]::WriteAllText("$inst/app/node_modules/dep/index.js", 'KEEP-DEP')
  [IO.File]::WriteAllText("$inst/app/.env", 'SECRET=keep-me')
  [IO.File]::WriteAllText("$inst/runtime/node/node.exe", 'KEEP-RUNTIME')

  # the patch payload
  [IO.File]::WriteAllText("$patch/app/server/index.js", 'NEW-SERVER')
  [IO.File]::WriteAllText("$patch/app/server/db/migrations.js", 'OLD-MIGRATIONS')
  [IO.File]::WriteAllText("$patch/app/shared/util.js", 'NEW-SHARED')
  [IO.File]::WriteAllText("$patch/app/client/dist/index.html", 'NEW-CLIENT')
  [IO.File]::WriteAllText("$patch/app/package.json", '{"version":"1.5.1"}')

  # ---------------------------------------------------------- copy-backup
  $ts = '20260828-120000'
  Backup-GcioAppCopy -InstallDir $inst -Ts $ts
  Check (Test-Path "$inst/app.bak-$ts/server/index.js") 'a copy-backup was taken'
  Check ((Text "$inst/app.bak-$ts/server/index.js") -eq 'OLD-SERVER') 'the backup holds the old code'
  # COPY, not move: the app must keep serving while this runs, which is what
  # puts the backup off the downtime clock.
  Check ((Text "$inst/app/server/index.js") -eq 'OLD-SERVER') 'the LIVE app is still in place after the backup (copy, not move)'

  # ---------------------------------------------------------- overlay
  Copy-GcioPatchOverlay -PatchApp "$patch/app" -InstallApp "$inst/app"
  Check ((Text "$inst/app/server/index.js") -eq 'NEW-SERVER')       'server code was overlaid'
  Check ((Text "$inst/app/shared/util.js") -eq 'NEW-SHARED')        'shared code was overlaid'
  Check ((Text "$inst/app/client/dist/index.html") -eq 'NEW-CLIENT') 'the client dist was overlaid'
  Check ((Get-Content -Raw "$inst/app/package.json") -match '1\.5\.1') 'the version manifest was overlaid'

  # the whole point
  Check ((Text "$inst/app/node_modules/dep/index.js") -eq 'KEEP-DEP')  'node_modules SURVIVED the overlay'
  Check ((Text "$inst/app/.env") -eq 'SECRET=keep-me')                 '.env SURVIVED the overlay'
  Check ((Text "$inst/runtime/node/node.exe") -eq 'KEEP-RUNTIME')      'the runtime SURVIVED the overlay'

  <#
    The three checks above are weaker than they look, and it is worth saying
    why. A patch payload contains no node_modules, so the overlay's
    `if (Test-Path $source)` guard skips it regardless -- adding 'node_modules'
    to the replaced-directory list is a no-op and leaves them all green. They
    document intent; they do not defend it.

    THIS is the guarantee: the overlay touches the known subset and nothing
    else. It fails for any broadening of scope, including one whose source
    directory happens not to exist.
  #>
  $protectedBefore = @{}
  foreach ($rel in 'app/node_modules/dep/index.js', 'app/.env', 'runtime/node/node.exe') {
    $protectedBefore[$rel] = Get-GcioSha256 (Join-Path $inst $rel)
  }
  # A leftover the patch knows nothing about, sitting inside app/ where a
  # careless "clean the app directory first" would take it.
  New-Item -ItemType Directory -Force "$inst/app/local-state" | Out-Null
  [IO.File]::WriteAllText("$inst/app/local-state/keep.json", '{"operator":"put this here"}')
  $protectedBefore['app/local-state/keep.json'] = Get-GcioSha256 "$inst/app/local-state/keep.json"

  Copy-GcioPatchOverlay -PatchApp "$patch/app" -InstallApp "$inst/app"

  foreach ($rel in $protectedBefore.Keys) {
    $p = Join-Path $inst $rel
    Check ((Test-Path -LiteralPath $p) -and ((Get-GcioSha256 $p) -eq $protectedBefore[$rel])) `
      "an overlay leaves $rel byte-identical"
  }

  # A stale file in a replaced directory must be GONE, not merged around.
  # Copy-Item -Force merges directories, so remove-then-copy is deliberate.
  [IO.File]::WriteAllText("$patch/app/server/newfile.js", 'ADDED')
  New-Item -ItemType Directory -Force "$inst/app/server/stale" | Out-Null
  [IO.File]::WriteAllText("$inst/app/server/stale/gone.js", 'SHOULD-VANISH')
  Copy-GcioPatchOverlay -PatchApp "$patch/app" -InstallApp "$inst/app"
  Check (-not (Test-Path "$inst/app/server/stale/gone.js")) 'a file removed in the new release does not survive the overlay'
  Check (Test-Path "$inst/app/server/newfile.js")           'a file added in the new release arrives'

  # ---------------------------------------------------------- restore
  Restore-GcioApp -InstallDir $inst -Ts $ts
  Check ((Text "$inst/app/server/index.js") -eq 'OLD-SERVER')  'restore put the old code back'
  Check ((Text "$inst/app/node_modules/dep/index.js") -eq 'KEEP-DEP') 'restore kept node_modules'
  Check (-not (Test-Path "$inst/app.bak-$ts")) 'the backup was consumed by the restore (moved, not left behind)'

  # ---------------------------------------------------------- backup pruning
  foreach ($n in 1..5) {
    New-Item -ItemType Directory -Force "$inst/app.bak-2026082$n-000000" | Out-Null
    [IO.File]::WriteAllText("$inst/app.bak-2026082$n-000000/marker", "$n")
  }
  Check ((@(Get-GcioBackups -InstallDir $inst)).Count -eq 5) 'all five backups are listed'
  Remove-OldGcioBackups -InstallDir $inst -Keep 3
  $left = @(Get-GcioBackups -InstallDir $inst)
  Check ($left.Count -eq 3) 'pruning keeps exactly three backups'
  Check ($left -contains '20260825-000000') 'pruning keeps the NEWEST, not the oldest'
  Check (-not ($left -contains '20260821-000000')) 'pruning removed the oldest'

  # ---------------------------------------------------------- deploy log
  Write-GcioDeployLog -InstallDir $inst -Kind 'PATCH' -From '1.5.0' -To '1.5.1' -Extra 'health=OK'
  Write-GcioDeployLog -InstallDir $inst -Kind 'BUNDLE' -From '1.5.1' -To '1.6.0'
  $log = Get-Content "$inst/logs/deploy.log"
  Check ($log.Count -eq 2) 'the deploy log appends rather than overwriting'
  Check ($log[0] -match 'PATCH\s+1\.5\.0 -> 1\.5\.1\s+health=OK') 'a deploy line records kind, transition and outcome'
  Check ($log[1] -match 'BUNDLE\s+1\.5\.1 -> 1\.6\.0') 'a line with no extra still records the transition'
  Check ($log[0] -match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}') 'each line is timestamped'
} finally {
  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}

if ($script:fails) { Write-Host "`n$($script:fails) failed" -ForegroundColor Red; exit 1 }
Write-Host "`nall passed" -ForegroundColor Green
