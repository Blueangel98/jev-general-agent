param(
    [Parameter(Mandatory=$true)]
    [string]$Task,

    [string]$Acceptance = "",

    [string]$Workspace = "",

    [switch]$AllowSyntaxOnly
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

$env:TYPESAFE_API_KEY =
    [Environment]::GetEnvironmentVariable("TYPESAFE_API_KEY","User")
$env:JEV_URL =
    [Environment]::GetEnvironmentVariable("JEV_URL","User")
$env:JEV_MODEL =
    [Environment]::GetEnvironmentVariable("JEV_MODEL","User")

function To-Base64Utf8 {
    param([Parameter(Mandatory=$true)][string]$Value)
    [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Value))
}

$taskB64 = To-Base64Utf8 $Task

$argsList = @(
    "$root\autonomy\general-task.mjs",
    "--task-b64",
    $taskB64
)

if ($Workspace) {
    $argsList += "--workspace"
    $argsList += $Workspace
}

if ($Acceptance) {
    $acceptanceB64 = To-Base64Utf8 $Acceptance
    $argsList += "--acceptance-b64"
    $argsList += $acceptanceB64
}

if ($AllowSyntaxOnly) {
    $argsList += "--allow-syntax-only"
}

& node @argsList
exit $LASTEXITCODE
