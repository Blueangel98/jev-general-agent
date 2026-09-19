$root = $PSScriptRoot

Write-Host ""
Write-Host "JEV GENERAL AGENT STATUS" -ForegroundColor Cyan
Write-Host "========================"

Write-Host ""
Write-Host "Workspace:"
Get-Content (Join-Path $root "config\workspace.json")

Write-Host ""
Write-Host "Agent config:"
Get-Content (Join-Path $root "config\agent.json")

Write-Host ""
Write-Host "Runtime:"
Get-Item (Join-Path $root "runtime\active-agent.mjs") |
    Select-Object Name, Length, LastWriteTime

Write-Host ""
Write-Host "Health:"
foreach ($port in 4012, 4014) {
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 2
        $health | ConvertTo-Json -Compress
    } catch {
        Write-Host ("port {0}: DOWN" -f $port) -ForegroundColor Yellow
    }
}
