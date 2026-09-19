# JEV_CANONICAL_ENV_REFRESH
foreach ($name in @("JEV_WORKSPACE_ROOT", "JEV_DIRECT_AUTONOMY_TIMEOUT_MS", "TYPESAFE_API_KEY")) {
    $value = [Environment]::GetEnvironmentVariable($name, "User")
    if (-not [string]::IsNullOrWhiteSpace($value)) {
        Set-Item "Env:$name" $value
    }
}
# /JEV_CANONICAL_ENV_REFRESH
$ErrorActionPreference = "Stop"

$root = "C:\Users\Orhan\jev-general-agent"
$proxy = "$root\proxy\cline-jev-router.mjs"

$env:JEV_LIVE_CONSOLE = "1"

$workspace =
    [Environment]::GetEnvironmentVariable(
        "JEV_WORKSPACE_ROOT",
        "User"
    )

if ($workspace) {
    $env:JEV_WORKSPACE_ROOT = $workspace
}

$existing =
    Get-NetTCPConnection `
        -LocalPort 4014 `
        -State Listen `
        -ErrorAction SilentlyContinue |
    Select-Object -First 1

if ($existing) {
    try {
        Stop-Process `
            -Id $existing.OwningProcess `
            -Force `
            -ErrorAction Stop

        Start-Sleep -Milliseconds 500
    }
    catch {
        Write-Host "4014 process could not be stopped: $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
}

Write-Host ""
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "JEV 4014 LIVE CONSOLE" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "Cline mutation tasks will stream here."
Write-Host "Expected markers:"
Write-Host "[USER] [PROXY_ROUTE] [JEV_BRIDGE] [GENERAL_TASK]"
Write-Host "[AUTONOMY] [SYNTH] [VALIDATION] [ACCEPTANCE]"
Write-Host "[APPLIED / NEEDS_VERIFICATION / ROLLED_BACK]"
Write-Host ""
Write-Host "Keep this PowerShell window open." -ForegroundColor Yellow
Write-Host ""

node $proxy
