$root = Split-Path -Parent $PSScriptRoot

$pidFile =
    "$root\proxy\proxy.pid"

if (
    Test-Path $pidFile
) {
    $proxyPid =
        [int](
            Get-Content $pidFile -Raw
        )

    Stop-Process `
        -Id $proxyPid `
        -Force `
        -ErrorAction SilentlyContinue

    Remove-Item `
        $pidFile `
        -Force `
        -ErrorAction SilentlyContinue
}

Write-Host "JEV CLINE ROUTER PROXY STOPPED"
