[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$secure = Read-Host "JEV Typesafe API anahtarınızı girin" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    if ([string]::IsNullOrWhiteSpace($plain)) {
        throw "Boş API anahtarı kabul edilmedi."
    }
    [Environment]::SetEnvironmentVariable("TYPESAFE_API_KEY", $plain, "User")
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
}

Write-Host "TYPESAFE_API_KEY kullanıcı ortamına kaydedildi; Git'e yazılmadı." -ForegroundColor Green
