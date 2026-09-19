param(
  [Parameter(Mandatory=$true)]
  [string]$TaskB64
)

$ErrorActionPreference =
  "Continue"

$env:PYTHONDONTWRITEBYTECODE =
  "1"

$task =
  [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String(
      $TaskB64
    )
  )

$workspace =
  (Get-Location).Path

Write-Host "[JEV_READONLY_DIAGNOSTIC]"
Write-Host "workspace=$workspace"
Write-Host "task=$task"
Write-Host ""

function Run-Capture(
  [string]$Title,
  [scriptblock]$Command
) {
  Write-Host "===== $Title ====="

  try {
    $global:LASTEXITCODE =
      0

    $output =
      & $Command 2>&1 |
      Out-String

    $code =
      if (
        $null -eq
        $global:LASTEXITCODE
      ) {
        0
      }
      else {
        [int]$global:LASTEXITCODE
      }

    Write-Host "exit_code=$code"

    if (
      -not [string]::IsNullOrWhiteSpace(
        $output
      )
    ) {
      Write-Host (
        $output.TrimEnd()
      )
    }

    Write-Host ""

    return [pscustomobject]@{
      Code =
        $code

      Output =
        [string]$output
    }
  }
  catch {
    $message =
      $_ |
      Out-String

    Write-Host "exit_code=999"
    Write-Host $message
    Write-Host ""

    return [pscustomobject]@{
      Code =
        999

      Output =
        [string]$message
    }
  }
}

function Parse-Pytest(
  [string]$Output
) {
  $passed =
    0

  $failed =
    0

  if (
    $Output -match
      "(?m)(\d+)\s+passed"
  ) {
    $passed =
      [int]$Matches[1]
  }

  if (
    $Output -match
      "(?m)(\d+)\s+failed"
  ) {
    $failed =
      [int]$Matches[1]
  }

  $failures =
    @()

  $matches =
    [regex]::Matches(
      $Output,
      "(?m)^FAILED\s+([^\s]+)\s+-\s+(.+)$"
    )

  foreach (
    $m in
    $matches
  ) {
    $failures +=
      [pscustomobject]@{
        name =
          [string]$m.Groups[1].Value

        reason =
          [string]$m.Groups[2].Value.Trim()
      }
  }

  return [pscustomobject]@{
    passed =
      $passed

    failed =
      $failed

    failures =
      @($failures)
  }
}

function Compare-Failures(
  $Current,
  $Baseline
) {
  if (
    -not $Baseline.available
  ) {
    return [pscustomobject]@{
      status =
        "baseline_unavailable"

      shared =
        @()

      onlyCurrent =
        @()

      onlyBaseline =
        @()
    }
  }

  $currentNames =
    @(
      $Current.failures |
      ForEach-Object {
        [string]$_.name
      }
    )

  $baselineNames =
    @(
      $Baseline.failures |
      ForEach-Object {
        [string]$_.name
      }
    )

  $shared =
    @(
      $currentNames |
      Where-Object {
        $_ -in
        $baselineNames
      } |
      Sort-Object -Unique
    )

  $onlyCurrent =
    @(
      $currentNames |
      Where-Object {
        $_ -notin
        $baselineNames
      } |
      Sort-Object -Unique
    )

  $onlyBaseline =
    @(
      $baselineNames |
      Where-Object {
        $_ -notin
        $currentNames
      } |
      Sort-Object -Unique
    )

  $same =
    (
      $Current.failed -eq
      $Baseline.failed
    ) -and
    (
      $onlyCurrent.Count -eq
      0
    ) -and
    (
      $onlyBaseline.Count -eq
      0
    )

  return [pscustomobject]@{
    status =
      if ($same) {
        "same_failures"
      }
      else {
        "different_failures"
      }

    shared =
      @($shared)

    onlyCurrent =
      @($onlyCurrent)

    onlyBaseline =
      @($onlyBaseline)
  }
}

$gitAvailable =
  $false

$gitRoot =
  $null

$gitStatusBefore =
  ""

$gitStatusAfter =
  ""

$gitChangedFiles =
  @()

$gitDiffStat =
  ""

$gitProbe =
  Run-Capture `
    "GIT ROOT" `
    {
      git rev-parse --show-toplevel
    }

if (
  $gitProbe.Code -eq
  0
) {
  $gitAvailable =
    $true

  $gitRoot =
    $gitProbe.Output.Trim()

  $gitStatus =
    Run-Capture `
      "GIT STATUS BEFORE" `
      {
        git status --short --branch
      }

  $gitStatusBefore =
    $gitStatus.Output.Trim()

  $gitChanged =
    Run-Capture `
      "GIT CHANGED FILES" `
      {
        git diff --name-only
      }

  $gitChangedFiles =
    @(
      $gitChanged.Output `
        -split
        "\r?\n" |
      Where-Object {
        -not [string]::IsNullOrWhiteSpace(
          $_
        )
      } |
      ForEach-Object {
        $_.Trim()
      }
    )

  $gitStat =
    Run-Capture `
      "GIT DIFF STAT" `
      {
        git diff --stat
      }

  $gitDiffStat =
    $gitStat.Output.Trim()
}

$pythonDetected =
  (
    Test-Path "$workspace\pytest.ini"
  ) -or
  (
    Test-Path "$workspace\pyproject.toml"
  ) -or
  (
    Test-Path "$workspace\setup.cfg"
  ) -or
  (
    Test-Path "$workspace\tests"
  ) -or
  (
    $null -ne
    (
      Get-ChildItem `
        -LiteralPath $workspace `
        -Filter "test_*.py" `
        -File `
        -ErrorAction SilentlyContinue |
      Select-Object -First 1
    )
  )

$nodeDetected =
  Test-Path "$workspace\package.json"

$current =
  [ordered]@{
    available =
      $false

    exitCode =
      $null

    passed =
      0

    failed =
      0

    failures =
      @()
  }

$baseline =
  [ordered]@{
    available =
      $false

    exitCode =
      $null

    passed =
      0

    failed =
      0

    failures =
      @()

    reason =
      $null
  }

$testRunner =
  "none"

if (
  $pythonDetected
) {
  $testRunner =
    "pytest"

  Write-Host "detected_test_runner=pytest"
  Write-Host ""

  $currentRun =
    Run-Capture `
      "CURRENT WORKTREE PYTEST" `
      {
        python -m pytest -q -p no:cacheprovider
      }

  $currentParsed =
    Parse-Pytest `
      $currentRun.Output

  $current.available =
    $true

  $current.exitCode =
    $currentRun.Code

  $current.passed =
    $currentParsed.passed

  $current.failed =
    $currentParsed.failed

  $current.failures =
    @($currentParsed.failures)

  Write-Host "CURRENT_PYTEST_EXIT=$($current.exitCode)"
  Write-Host "CURRENT_PYTEST_PARSED passed=$($current.passed) failed=$($current.failed)"
  Write-Host ""

  if (
    $gitAvailable
  ) {
    $tmpRoot =
      Join-Path `
        ([IO.Path]::GetTempPath()) `
        (
          "jev-baseline-" +
          [guid]::NewGuid().ToString(
            "N"
          )
        )

    $zip =
      "$tmpRoot.zip"

    try {
      New-Item `
        -ItemType Directory `
        -Path $tmpRoot `
        -Force |
        Out-Null

      $archive =
        Run-Capture `
          "BASELINE GIT ARCHIVE" `
          {
            git archive `
              --format=zip `
              --output="$zip" `
              HEAD
          }

      if (
        $archive.Code -eq
        0 -and
        (Test-Path $zip)
      ) {
        Expand-Archive `
          -LiteralPath $zip `
          -DestinationPath $tmpRoot `
          -Force

        Push-Location $tmpRoot

        try {
          $baselineRun =
            Run-Capture `
              "HEAD BASELINE PYTEST" `
              {
                python -m pytest -q -p no:cacheprovider
              }

          $baselineParsed =
            Parse-Pytest `
              $baselineRun.Output

          $baseline.available =
            $true

          $baseline.exitCode =
            $baselineRun.Code

          $baseline.passed =
            $baselineParsed.passed

          $baseline.failed =
            $baselineParsed.failed

          $baseline.failures =
            @($baselineParsed.failures)

          Write-Host "BASELINE_PYTEST_EXIT=$($baseline.exitCode)"
          Write-Host "BASELINE_PYTEST_PARSED passed=$($baseline.passed) failed=$($baseline.failed)"
          Write-Host ""
        }
        finally {
          Pop-Location
        }
      }
      else {
        $baseline.reason =
          "git_archive_failed"

        Write-Host "BASELINE_COMPARISON=unavailable"
        Write-Host ""
      }
    }
    catch {
      $baseline.reason =
        "baseline_exception"

      Write-Host "BASELINE_COMPARISON=unavailable"
      Write-Host (
        $_ |
        Out-String
      )
      Write-Host ""
    }
    finally {
      Remove-Item `
        -LiteralPath $zip `
        -Force `
        -ErrorAction SilentlyContinue

      Remove-Item `
        -LiteralPath $tmpRoot `
        -Recurse `
        -Force `
        -ErrorAction SilentlyContinue
    }
  }
  else {
    $baseline.reason =
      "git_unavailable"
  }
}
elseif (
  $nodeDetected
) {
  $testRunner =
    "node"

  Write-Host "detected_test_runner=node"
  Write-Host ""

  try {
    $pkg =
      Get-Content `
        "$workspace\package.json" `
        -Raw |
      ConvertFrom-Json

    $testScript =
      $pkg.scripts.test

    if (
      $testScript -and
      $testScript -notmatch
      "no test specified"
    ) {
      $nodeRun =
        Run-Capture `
          "CURRENT WORKTREE NPM TEST" `
          {
            npm test
          }

      $current.available =
        $true

      $current.exitCode =
        $nodeRun.Code

      Write-Host "CURRENT_NPM_TEST_EXIT=$($current.exitCode)"
      Write-Host ""

      $baseline.reason =
        "node_baseline_not_enabled"
    }
    else {
      $baseline.reason =
        "npm_test_not_configured"

      Write-Host "npm_test=not_configured"
      Write-Host ""
    }
  }
  catch {
    $baseline.reason =
      "npm_probe_failed"

    Write-Host "npm_test=probe_failed"
    Write-Host (
      $_ |
      Out-String
    )
    Write-Host ""
  }
}
else {
  $baseline.reason =
    "no_test_runner"

  Write-Host "detected_test_runner=none"
  Write-Host ""
}

if (
  $gitAvailable
) {
  $gitAfter =
    Run-Capture `
      "GIT STATUS AFTER" `
      {
        git status --short --branch
      }

  $gitStatusAfter =
    $gitAfter.Output.Trim()
}

$comparison =
  Compare-Failures `
    ([pscustomobject]$current) `
    ([pscustomobject]$baseline)

$summary =
  [ordered]@{
    workspace =
      $workspace

    testRunner =
      $testRunner

    gitAvailable =
      $gitAvailable

    gitRoot =
      $gitRoot

    gitStatusBefore =
      $gitStatusBefore

    gitStatusAfter =
      $gitStatusAfter

    gitChangedFiles =
      @($gitChangedFiles)

    gitDiffStat =
      $gitDiffStat

    current =
      $current

    baseline =
      $baseline

    comparison =
      $comparison
  }

$json =
  $summary |
  ConvertTo-Json `
    -Depth 12 `
    -Compress

$resultB64 =
  [Convert]::ToBase64String(
    [Text.Encoding]::UTF8.GetBytes(
      $json
    )
  )

Write-Host "[JEV_DIAGNOSTIC_JSON_B64]$resultB64"
Write-Host "[JEV_READONLY_DIAGNOSTIC_DONE]"

exit 0