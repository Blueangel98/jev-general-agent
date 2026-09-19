[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TaskB64,

    [string]$AcceptanceB64 = "",

    [switch]$AllowSyntaxOnly,

    [string]$Workspace = ""
)

$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$runner = "$root\control-plane\v3\supervisor-v3.mjs"
$workspaceFile = "$root\config\workspace.json"
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Decode-Utf8Base64([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) {
        return ""
    }

    $bytes = [Convert]::FromBase64String($Value)
    return [Text.Encoding]::UTF8.GetString($bytes)
}

if (-not (Test-Path -LiteralPath $runner)) {
    throw "General task runner missing: $runner"
}

$task = Decode-Utf8Base64 $TaskB64

if ([string]::IsNullOrWhiteSpace($task)) {
    throw "Decoded task is empty."
}

$acceptance = Decode-Utf8Base64 $AcceptanceB64

# Workspace resolution priority:
# explicit parameter -> selected workspace.json -> process/User environment
$resolved = ""

if (-not [string]::IsNullOrWhiteSpace($Workspace)) {
    $resolved = $Workspace
}

if (
    [string]::IsNullOrWhiteSpace($resolved) -and
    (Test-Path -LiteralPath $workspaceFile)
) {
    try {
        $state = Get-Content -LiteralPath $workspaceFile -Raw | ConvertFrom-Json
        if ($state -and $state.path) {
            $resolved = [string]$state.path
        }
    }
    catch {}
}

if ([string]::IsNullOrWhiteSpace($resolved)) {
    $resolved = $env:JEV_WORKSPACE_ROOT
}

if ([string]::IsNullOrWhiteSpace($resolved)) {
    $resolved = [Environment]::GetEnvironmentVariable("JEV_WORKSPACE_ROOT","User")
    }

if ([string]::IsNullOrWhiteSpace($resolved)) {
    throw "JEV workspace is not configured."
}

$resolved = [IO.Path]::GetFullPath($resolved).TrimEnd('\')
$agentRoot = [IO.Path]::GetFullPath($root).TrimEnd('\')

if (-not (Test-Path -LiteralPath $resolved)) {
    throw "JEV workspace does not exist: $resolved"
}

if (
    $resolved -ieq $agentRoot -and
    $env:JEV_ALLOW_AGENT_ROOT_WORKSPACE -ne "1"
) {
    throw "Refusing agent installation root as project workspace: $resolved"
}

# Keep config aligned with the workspace used by this task.
$current = $null

if (Test-Path -LiteralPath $workspaceFile) {
    try {
        $current = Get-Content -LiteralPath $workspaceFile -Raw | ConvertFrom-Json
    }
    catch {}
}

$currentPath = ""

if ($current -and $current.path) {
    try {
        $currentPath = [IO.Path]::GetFullPath([string]$current.path).TrimEnd('\')
    }
    catch {}
}

if ($currentPath -ine $resolved) {
    $next = [ordered]@{
        name = Split-Path -Leaf $resolved
        path = $resolved
    }

    [IO.File]::WriteAllText(
        $workspaceFile,
        ($next | ConvertTo-Json -Depth 10),
        $utf8
    )
}

$env:JEV_WORKSPACE_ROOT = $resolved

Write-Host "[JEV_BRIDGE] resolved_workspace=$resolved"
Write-Host "[JEV_BRIDGE] invoking_autonomy=true"
Write-Host "[JEV_SUPERVISOR_V3_BRIDGE] enabled=true"

$taskB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($task))
$acceptanceB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($acceptance))

$nodeArgs = @(
    $runner,
    "--task-b64", $taskB64,
    "--workspace", $resolved
)

if (-not [string]::IsNullOrWhiteSpace($acceptance)) {
    $nodeArgs += @("--acceptance-b64", $acceptanceB64)
}

if ($AllowSyntaxOnly) {
    $nodeArgs += "--allow-syntax-only"
}

& node @nodeArgs
$code = $LASTEXITCODE

if ($null -eq $code) {
    $code = 4
}

exit $code
