[CmdletBinding()]
param(
    [string]$Workspace = ""
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$logs = Join-Path $root "logs"
New-Item -ItemType Directory -Path $logs -Force | Out-Null

foreach ($name in @(
    "TYPESAFE_API_KEY", "JEV_URL", "JEV_MODEL",
    "JEV_WORKSPACE_ROOT", "JEV_DIRECT_AUTONOMY_TIMEOUT_MS",
    "JEV_BROWSER_CDP_URL", "JEV_BROWSER_ALLOW_TRANSMIT",
    "JEV_BROWSER_READY_TIMEOUT_MS", "JEV_BROWSER_RESPONSE_TIMEOUT_MS"
)) {
    $value = [Environment]::GetEnvironmentVariable($name, "User")
    if (-not [string]::IsNullOrWhiteSpace($value)) { Set-Item "Env:$name" $value }
}

if ($Workspace) {
    $resolved = [IO.Path]::GetFullPath($Workspace).TrimEnd('\')
    if (-not (Test-Path -LiteralPath $resolved -PathType Container)) { throw "Workspace does not exist: $resolved" }
    $env:JEV_WORKSPACE_ROOT = $resolved
    [IO.File]::WriteAllText(
        (Join-Path $root "config\workspace.json"),
        (@{ name = (Split-Path -Leaf $resolved); path = $resolved } | ConvertTo-Json),
        (New-Object System.Text.UTF8Encoding($false))
    )
}

$agentPidFile = Join-Path $root "runtime\agent.pid"
$proxyPidFile = Join-Path $root "proxy\proxy.pid"

function Test-Health([int]$Port) {
    try { return (Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2).ok -eq $true } catch { return $false }
}

if (-not (Test-Health 4012)) {
    $agent = Start-Process -FilePath "node" -WorkingDirectory $root -ArgumentList @("runtime\active-agent.mjs") -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs "agent.log") -RedirectStandardError (Join-Path $logs "agent.error.log") -PassThru
    [IO.File]::WriteAllText($agentPidFile, [string]$agent.Id)
}

if (-not (Test-Health 4014)) {
    $proxy = Start-Process -FilePath "powershell.exe" -WorkingDirectory $root -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "$root\proxy\start-proxy.ps1") -WindowStyle Hidden -PassThru
    Start-Sleep -Seconds 2
}

Write-Host "JEV READY" -ForegroundColor Green
Write-Host "4012 agent: $(Test-Health 4012)"
Write-Host "4014 proxy: $(Test-Health 4014)"
