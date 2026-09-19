[CmdletBinding()]
param(
    [string]$RepositoryUrl = "",
    [string]$Message = "Prepare JEV general-purpose agent",
    [switch]$Push
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "git bulunamadı."
}

if (-not (Test-Path (Join-Path $root ".git"))) {
    git init -b main
}

if ($RepositoryUrl) {
    $origin = git remote get-url origin 2>$null
    if ($LASTEXITCODE -eq 0) {
        git remote set-url origin $RepositoryUrl
    } else {
        git remote add origin $RepositoryUrl
    }
}

git add -A
$pending = git status --porcelain
if ($pending) {
    git commit -m $Message
}

if ($Push) {
    $origin = git remote get-url origin 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($origin)) {
        throw "Push için -RepositoryUrl veya mevcut origin gerekli."
    }
    git push -u origin main
}

git status --short --branch
