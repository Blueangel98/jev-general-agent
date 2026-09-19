$root = $PSScriptRoot
$proxyPidFile = Join-Path $root "proxy\proxy.pid"
$agentPidFile = Join-Path $root "runtime\agent.pid"

foreach ($file in @($proxyPidFile, $agentPidFile)) {
    if (Test-Path -LiteralPath $file) {
        try {
            $processId = [int](Get-Content -LiteralPath $file -Raw)
            Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
        } catch {}
        Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    }
}

foreach ($port in @(4014, 4012)) {
    $listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($listener in $listeners) {
        $process = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $listener.OwningProcess) -ErrorAction SilentlyContinue
        $commandLine = [string]$process.CommandLine
        $ownedByJev = ($port -eq 4014 -and $commandLine -match "cline-jev-router\.mjs") -or
            ($port -eq 4012 -and $commandLine -match "runtime[\\/]active-agent\.mjs")
        if ($ownedByJev) {
            Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
        }
    }
}

Write-Host "JEV STOPPED"
