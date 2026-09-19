$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot

$proxy =
    "$root\proxy\cline-jev-router.mjs"

$log =
    "$root\logs\cline-router-proxy.log"

$err =
    "$root\logs\cline-router-proxy.error.log"

$pidFile =
    "$root\proxy\proxy.pid"

$env:TYPESAFE_API_KEY =
    [Environment]::GetEnvironmentVariable(
        "TYPESAFE_API_KEY",
        "User"
    )

$env:JEV_CLINE_PROXY_PORT =
    "4014"

$env:JEV_CLINE_UPSTREAM =
    "http://127.0.0.1:4012"

try {
    $health =
        Invoke-RestMethod `
            -Uri "http://127.0.0.1:4014/health" `
            -TimeoutSec 2

    if ($health.ok) {
        Write-Host "JEV CLINE ROUTER PROXY ALREADY RUNNING" -ForegroundColor Green
        $health |
            ConvertTo-Json -Depth 5
        exit 0
    }
}
catch {
}

$process =
    Start-Process `
        -FilePath "node" `
        -ArgumentList @(
            $proxy
        ) `
        -WindowStyle Hidden `
        -RedirectStandardOutput $log `
        -RedirectStandardError $err `
        -PassThru

[IO.File]::WriteAllText(
    $pidFile,
    [string]$process.Id,
    (New-Object System.Text.UTF8Encoding($false))
)

Start-Sleep -Seconds 2

$health =
    Invoke-RestMethod `
        -Uri "http://127.0.0.1:4014/health" `
        -TimeoutSec 5

Write-Host ""
Write-Host "JEV CLINE ROUTER PROXY READY" -ForegroundColor Green
$health |
    ConvertTo-Json -Depth 5
