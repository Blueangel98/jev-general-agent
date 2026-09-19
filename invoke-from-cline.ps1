param(
    [Parameter(Mandatory=$true)]
    [string]$Task,

    [string]$Workspace = "",

    [string]$Acceptance = "",

    [switch]$AllowSyntaxOnly
)

$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$workspaceFile = "$root\config\workspace.json"
$utf8 = New-Object System.Text.UTF8Encoding($false)

if (-not $Workspace) {
    $Workspace = (Get-Location).Path
}

$Workspace = [IO.Path]::GetFullPath($Workspace)

if (-not (Test-Path -LiteralPath $Workspace -PathType Container)) {
    throw "Workspace not found: $Workspace"
}

$current = $null

if (Test-Path -LiteralPath $workspaceFile) {
    try {
        $raw =
            [IO.File]::ReadAllText($workspaceFile) `
                -replace "^\uFEFF", ""

        $current =
            $raw |
            ConvertFrom-Json
    }
    catch {
        $current = $null
    }
}

$currentPath =
    if ($current -and $current.path) {
        [IO.Path]::GetFullPath([string]$current.path)
    }
    else {
        ""
    }

if ($currentPath -ne $Workspace) {
    $name =
        Split-Path -Leaf $Workspace

    $next = [ordered]@{}

    if ($current) {
        foreach ($property in $current.PSObject.Properties) {
            $next[$property.Name] =
                $property.Value
        }
    }

    $next["name"] = $name
    $next["path"] = $Workspace

    $json =
        $next |
        ConvertTo-Json -Depth 20

    [IO.File]::WriteAllText(
        $workspaceFile,
        $json,
        $utf8
    )

    Write-Host "[JEV_BRIDGE] workspace_changed=$Workspace"
    Write-Host "[JEV_BRIDGE] supervisor_hot_reload_expected=true"
}
else {
    Write-Host "[JEV_BRIDGE] workspace_already_active=$Workspace"
}

$runner =
    "$root\run-task.ps1"

if (-not (Test-Path -LiteralPath $runner)) {
    throw "General task runner missing: $runner"
}

$params = @{
    Task = $Task
}

if ($Acceptance) {
    $params["Acceptance"] =
        $Acceptance
}

if ($AllowSyntaxOnly) {
    $params["AllowSyntaxOnly"] =
        $true
}

Write-Host "[JEV_BRIDGE] invoking_autonomy=true"

& $runner @params

exit $LASTEXITCODE
