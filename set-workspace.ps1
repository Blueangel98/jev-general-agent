param(
    [Parameter(Mandatory=$true)]
    [string]$Path
)

$root = $PSScriptRoot

$resolved =
    [System.IO.Path]::GetFullPath(
        $Path
    )

if (-not (Test-Path $resolved)) {
    Write-Host "Workspace bulunamadi: $resolved" -ForegroundColor Red
    exit 1
}

$name =
    Split-Path `
        $resolved `
        -Leaf

$config = @{
    name = $name
    path = $resolved
}

$json =
    $config |
    ConvertTo-Json

$utf8NoBom =
    New-Object System.Text.UTF8Encoding($false)

[System.IO.File]::WriteAllText(
    "$root\config\workspace.json",
    $json,
    $utf8NoBom
)

[Environment]::SetEnvironmentVariable(
    "JEV_WORKSPACE_ROOT",
    $resolved,
    "User"
)

Write-Host ""
Write-Host "ACTIVE WORKSPACE:" -ForegroundColor Green
Write-Host $name
Write-Host $resolved
