<#
  The release-time policy: does this version bump match what actually changed?

  These helpers are shared with the host gate on purpose, so preflight and the
  runtime can never disagree about what a patch may carry. The rules:

    - a Z bump may NOT carry a migration, a dependency change, a Node-major
      change, or new functionality (those need a MINOR and a bundle);
    - a Y bump may NOT carry a breaking change (that needs a MAJOR).
#>
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../lib/common.ps1"

$script:fails = 0
function Check { param($Cond, [string]$What)
  if ($Cond) { Write-Host "[ok] $What" -ForegroundColor Green }
  else { Write-Host "[FAIL] $What" -ForegroundColor Red; $script:fails++ } }

# Every call spelled out, so a failure names the exact combination.
function Bump {
  param([string]$B, [bool]$Mig = $false, [bool]$Deps = $false, [bool]$Node = $false,
        [bool]$Breaking = $false, [bool]$Feature = $false)
  Test-GcioReleaseBump -Bump $B -MigrationsChanged $Mig -DepsChanged $Deps -NodeChanged $Node -Breaking $Breaking -FeatureAdded $Feature
}

# ---------------------------------------------------------------- bump type
Check ((Get-GcioBumpType -BaseVersion '1.5.0' -HeadVersion '1.5.1') -eq 'patch') 'Z bump reads as patch'
Check ((Get-GcioBumpType -BaseVersion '1.5.1' -HeadVersion '1.6.0') -eq 'minor') 'Y bump reads as minor'
Check ((Get-GcioBumpType -BaseVersion '1.6.0' -HeadVersion '2.0.0') -eq 'major') 'X bump reads as major'
Check ((Get-GcioBumpType -BaseVersion '1.5.0' -HeadVersion '1.5.0') -eq 'none')  'no change reads as none'
Check ((Get-GcioBumpType -BaseVersion '1.6.0' -HeadVersion '1.5.0') -eq 'downgrade') 'going backwards reads as a downgrade, not a bump'
Check ((Get-GcioBumpType -BaseVersion '' -HeadVersion '1.5.0') -eq 'unknown') 'a missing base version is unknown rather than a guess'
# 1.5.9 -> 1.6.0 is a MINOR even though Z went down: Y increased.
Check ((Get-GcioBumpType -BaseVersion '1.5.9' -HeadVersion '1.6.0') -eq 'minor') 'a minor that resets Z is still a minor'

# ---------------------------------------------------------------- patch limits
Check (-not (Bump 'patch' -Mig     $true).Ok) 'a patch carrying a migration is refused'
Check (-not (Bump 'patch' -Deps    $true).Ok) 'a patch carrying a dependency change is refused'
Check (-not (Bump 'patch' -Node    $true).Ok) 'a patch carrying a Node-major change is refused'
Check (-not (Bump 'patch' -Feature $true).Ok) 'a patch carrying new functionality is refused'
Check      (Bump 'patch').Ok                  'a clean patch passes'
Check ((Bump 'patch').Artifact -eq 'patch')   'a clean patch asks for the patch artifact'

# Each refusal must say what to do, not merely no.
Check ((Bump 'patch' -Mig $true).Reason -match 'MINOR')  'the migration refusal names the bump to use'
Check ((Bump 'patch' -Mig $true).Artifact -eq 'bundle')  'and asks for a bundle'
Check ((Bump 'patch' -Node $true).Reason -match 'MAJOR') 'a Node-major change is routed to a MAJOR, not a MINOR'

# ---------------------------------------------------------------- minor / major
Check      (Bump 'minor').Ok                            'a minor passes'
Check ((Bump 'minor').Artifact -eq 'bundle')            'a minor requires a bundle'
Check      (Bump 'minor' -Mig $true -Deps $true -Feature $true).Ok 'a minor may carry a migration, dependencies and a feature'
Check (-not (Bump 'minor' -Breaking $true).Ok)          'a minor carrying a breaking change is refused'
Check      (Bump 'major' -Breaking $true).Ok            'a major may carry a breaking change'
Check ((Bump 'major').Artifact -eq 'bundle')            'a major requires a bundle'
Check ((Bump 'major' -Breaking $true).Reason -match 'back|notes') 'the major verdict reminds the releaser to back up and write notes'

# ---------------------------------------------------------------- no bump
Check (-not (Bump 'none').Ok)      'no version bump is not a release'
Check (-not (Bump 'downgrade').Ok) 'a downgrade is refused'
Check (-not (Bump 'unknown').Ok)   'an unknown bump is refused rather than assumed safe'

# ---------------------------------------------------------------- markers
Check      (Test-GcioBreakingMarker 'feat!: drop the old endpoint')     'a bang marks breaking'
Check      (Test-GcioBreakingMarker "subject`n`nBREAKING CHANGE: gone")  'a BREAKING CHANGE footer marks breaking'
Check      (Test-GcioBreakingMarker "subject`n`nBREAKING-CHANGE: gone")  'the hyphenated spelling also marks breaking'
Check      (Test-GcioBreakingMarker 'fix(api)!: change the shape')      'a scoped bang marks breaking'
Check (-not (Test-GcioBreakingMarker 'fix: mention breaking news'))     'prose mentioning breaking does not'
Check (-not (Test-GcioBreakingMarker ''))                              'an empty log is not breaking'

Check      (Test-GcioFeatureMarker 'feat: add a thing')          'a feat subject is detected'
Check      (Test-GcioFeatureMarker 'feat(ingest): add a thing')  'a scoped feat is detected'
Check      (Test-GcioFeatureMarker "fix: x`nfeat: y")            'a feat anywhere in the list is detected'
Check (-not (Test-GcioFeatureMarker 'fix: this is a great feat')) 'prose mentioning feat does not trip it'
Check (-not (Test-GcioFeatureMarker 'refactor: feature flags'))   'the word feature does not trip it'
Check (-not (Test-GcioFeatureMarker ''))                          'an empty subject list is not a feature'

# ---------------------------------------------------------------- notes gate
Check      (Test-GcioReleaseNotes -Notes "## GCIO 1.6.0`nwhat changed" -Version '1.6.0').Ok 'a version with a notes section passes'
Check (-not (Test-GcioReleaseNotes -Notes "## GCIO 1.5.0`nold" -Version '1.6.0').Ok)        'a version with no section fails'
Check (-not (Test-GcioReleaseNotes -Notes '' -Version '1.6.0').Ok)                          'an empty notes file fails'
# 1.6.0 must not be satisfied by a heading for 1.6.0.1 or GCIO 1.6.01.
Check (-not (Test-GcioReleaseNotes -Notes "## GCIO 1.6.01`nx" -Version '1.6.0').Ok) 'a near-miss heading does not satisfy the gate'
Check ((Test-GcioReleaseNotes -Notes '' -Version '1.6.0').Reason -match 'RELEASE-NOTES') 'the failure names the file to edit'

# ---------------------------------------------------------------- base ref detection
$log = @(
  "aaa1`tfix(ingest): something",
  "bbb2`trelease 1.5.0 - the previous release",
  "ccc3`trelease 1.4.0 - older still"
)
Check ((Get-GcioReleaseCommitSha -LogLines $log) -eq 'bbb2') 'the most recent release commit is found'
Check ((Get-GcioReleaseCommitSha -LogLines @("aaa1`tfix: nothing here")) -eq '') 'no release commit yields empty rather than a wrong answer'
# A subject merely mentioning the word must not be mistaken for a release.
Check ((Get-GcioReleaseCommitSha -LogLines @("aaa1`tdocs: describe the release 1.5.0 process")) -eq '') 'prose mentioning a release is not treated as one'
Check ((Get-GcioReleaseCommitSha -LogLines @("aaa1`trelease 1.5.0 (#312)")) -eq 'aaa1') 'a squash-merge suffix does not break detection'

Check $false 'MUTATION A: a deliberately failing assertion'

if ($script:fails) { Write-Host "`n$($script:fails) failed" -ForegroundColor Red; exit 1 }
Write-Host "`nall passed" -ForegroundColor Green
