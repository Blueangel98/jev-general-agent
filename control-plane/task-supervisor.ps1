[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Task,

    [string]$Acceptance = "",

    [switch]$AllowSyntaxOnly
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$runner = "$root\run-task.ps1"
$workspaceFile = "$root\config\workspace.json"
$stateDir = "$root\control-plane\state"
$logDir = "$root\control-plane\logs"
$lockDir = "$stateDir\task.lock"

New-Item -ItemType Directory -Force -Path $stateDir,$logDir | Out-Null

function Write-State(
    [string]$TaskId,
    [string]$Stage,
    [string]$Status,
    [int]$Attempt,
    [string]$Detail
) {
    $state = [ordered]@{
        taskId = $TaskId
        timestamp = (Get-Date).ToUniversalTime().ToString("o")
        stage = $Stage
        status = $Status
        attempt = $Attempt
        detail = $Detail
        pid = $PID
    }

    $path = Join-Path $stateDir "$TaskId.json"
    $json = $state | ConvertTo-Json -Depth 20

    [IO.File]::WriteAllText(
        $path,
        $json,
        (New-Object System.Text.UTF8Encoding($false))
    )
}

function Acquire-Lock([string]$TaskId) {
    if (Test-Path -LiteralPath $lockDir) {
        $ownerFile = Join-Path $lockDir "owner.json"
        $stale = $true

        if (Test-Path -LiteralPath $ownerFile) {
            try {
                $owner = Get-Content $ownerFile -Raw | ConvertFrom-Json
                if ($owner.pid) {
                    $proc = Get-Process -Id ([int]$owner.pid) -ErrorAction SilentlyContinue
                    if ($proc) {
                        $stale = $false
                    }
                }
            }
            catch {}
        }

        if ($stale) {
            Remove-Item $lockDir -Recurse -Force -ErrorAction SilentlyContinue
        }
        else {
            throw "Another supervised task is already active."
        }
    }

    New-Item -ItemType Directory -Path $lockDir -ErrorAction Stop | Out-Null

    @{
        taskId = $TaskId
        pid = $PID
        startedAt = (Get-Date).ToUniversalTime().ToString("o")
    } | ConvertTo-Json |
        Set-Content -LiteralPath (Join-Path $lockDir "owner.json") -Encoding UTF8
}

function Release-Lock {
    Remove-Item $lockDir -Recurse -Force -ErrorAction SilentlyContinue
}

function Read-Workspace {
    if (-not (Test-Path -LiteralPath $workspaceFile)) {
        throw "workspace.json missing."
    }

    $state = Get-Content $workspaceFile -Raw | ConvertFrom-Json

    if (-not $state.path) {
        throw "workspace.json has no path."
    }

    return [IO.Path]::GetFullPath([string]$state.path).TrimEnd('\')
}

$taskId = "TASK-" + (Get-Date -Format "yyyyMMdd-HHmmss") + "-" + $PID
$taskLog = Join-Path $logDir "$taskId.log"

try {
    Acquire-Lock $taskId

    $workspace = Read-Workspace

    Write-Host "[SUPERVISOR_V2] task_id=$taskId"
    Write-Host "[SUPERVISOR_V2] owner=true"
    Write-Host "[WORKER_SCOUT] workspace=$workspace"

    Write-State $taskId "SCOUT" "PASS" 0 "workspace_verified"

    $params = @{
        Task = $Task
        Workspace = $workspace
    }

    if (-not [string]::IsNullOrWhiteSpace($Acceptance)) {
        $params["Acceptance"] = $Acceptance
    }

    if ($AllowSyntaxOnly) {
        $params["AllowSyntaxOnly"] = $true
    }

    $maxSupervisorAttempts = 2

    for ($attempt = 1; $attempt -le $maxSupervisorAttempts; $attempt++) {
        Write-Host "[WORKER_BUILDER] attempt=$attempt/$maxSupervisorAttempts"
        Write-State $taskId "BUILDER" "RUNNING" $attempt "delegated_to_run_task"

        $attemptLog = Join-Path $logDir "$taskId-attempt-$attempt.log"

        # JEV_SUPERVISOR_STDERR_CAPTURE_V2
        # Native Node stderr must be captured as task output, not promoted
        # into a terminating PowerShell control-plane exception.
        $previousEap = $ErrorActionPreference
        $ErrorActionPreference = "Continue"

        $nativePreferenceExists =
            $null -ne (
                Get-Variable `
                    -Name PSNativeCommandUseErrorActionPreference `
                    -ErrorAction SilentlyContinue
            )

        if ($nativePreferenceExists) {
            $previousNativePreference =
                $PSNativeCommandUseErrorActionPreference

            $PSNativeCommandUseErrorActionPreference = $false
        }

        try {
            & $runner @params 2>&1 |
                Tee-Object -FilePath $attemptLog

            $code = $LASTEXITCODE
        }
        finally {
            if ($nativePreferenceExists) {
                $PSNativeCommandUseErrorActionPreference =
                    $previousNativePreference
            }

            $ErrorActionPreference = $previousEap
        }
        # /JEV_SUPERVISOR_STDERR_CAPTURE_V2
        if ($null -eq $code) {
            $code = 0
        }

        $text = ""
        if (Test-Path -LiteralPath $attemptLog) {
            $text = Get-Content $attemptLog -Raw -ErrorAction SilentlyContinue
        }

        $terminal =
            [regex]::Match(
                $text,
                '"status"\s*:\s*"(APPLIED|NEEDS_VERIFICATION|ROLLED_BACK|REJECTED|FAILED|ERROR)"',
                [Text.RegularExpressions.RegexOptions]::IgnoreCase
            )

        $status =
            if ($terminal.Success) {
                $terminal.Groups[1].Value.ToUpperInvariant()
            }
            elseif ($code -eq 0) {
                "APPLIED"
            }
            else {
                "NEEDS_VERIFICATION"
            }

        Write-Host "[WORKER_VALIDATOR] delegated=true terminal=$status exit=$code"

        if (-not $terminal.Success -and $code -ne 0) {
            Write-Host "[WORKER_REPORTER] unstructured_child_exit=$code"
            Write-Host "[WORKER_REPORTER] attempt_log=$attemptLog"
            Write-Host "[WORKER_REPORTER] last_child_lines_begin"

            Get-Content `
                -LiteralPath $attemptLog `
                -Tail 40 `
                -ErrorAction SilentlyContinue |
                ForEach-Object {
                    Write-Host $_
                }

            Write-Host "[WORKER_REPORTER] last_child_lines_end"

            $terminalJson = [ordered]@{
                status = "NEEDS_VERIFICATION"
                stage = "builder"
                retryable = $false
                reason = "Builder exited non-zero without its own structured terminal status. The full child stderr was preserved in the Supervisor attempt log."
                attemptLog = $attemptLog
            } | ConvertTo-Json -Compress

            Write-Output $terminalJson
            Write-State $taskId "REPORTER" "NEEDS_VERIFICATION" $attempt "unstructured_child_exit"
            Write-Host "[SUPERVISOR_V2] final=NEEDS_VERIFICATION"
            exit 4
        }

        if ($status -eq "APPLIED" -and $code -eq 0) {
            Write-State $taskId "REPORTER" "APPLIED" $attempt "task_completed"
            Write-Host "[SUPERVISOR_V2] final=APPLIED"
            exit 0
        }

        $retryableSynthesis =
            $text -match '"stage"\s*:\s*"synthesis"' -and
            $text -match '"retryable"\s*:\s*true' -and
            $text -match 'No live apply was performed'

        if ($retryableSynthesis -and $attempt -lt $maxSupervisorAttempts) {
            Write-State $taskId "RECOVERY" "RETRYING" $attempt "synthesis_transient_no_live_apply"
            Write-Host "[WORKER_RECOVERY] reason=synthesis_transient safe_retry=true wait_ms=3000"
            Start-Sleep -Milliseconds 3000
            continue
        }

        Write-State $taskId "REPORTER" $status $attempt "terminal"
        Write-Host "[SUPERVISOR_V2] final=$status"
        exit $code
    }

    Write-State $taskId "REPORTER" "NEEDS_VERIFICATION" 2 "attempt_budget_exhausted"
    Write-Host '[SUPERVISOR_V2] final=NEEDS_VERIFICATION'
    exit 4
}
catch {
    Write-State $taskId "CONTROL_PLANE" "ERROR" 0 $_.Exception.Message
    Write-Host "[SUPERVISOR_V2] control_plane_error=$($_.Exception.Message)"
    exit 4
}
finally {
    Release-Lock
}
