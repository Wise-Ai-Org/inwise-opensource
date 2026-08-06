param(
  [string]$ReleaseDirectory = (Join-Path $PSScriptRoot '..\release-v2')
)

$ErrorActionPreference = 'Stop'

$releasePath = (Resolve-Path -LiteralPath $ReleaseDirectory).Path
$packageJsonPath = Join-Path $PSScriptRoot '..\package.json'
$version = (Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json).version

$versionedInstaller = Join-Path $releasePath "Inwise-Setup-$version.exe"
$stableInstaller = Join-Path $releasePath 'Inwise-Setup-Windows.exe'
$appExecutable = Get-ChildItem -LiteralPath $releasePath -Recurse -Filter 'Inwise.exe' |
  Where-Object { $_.DirectoryName -match 'win(?:-[^\\]+)?-unpacked$' } |
  Select-Object -First 1

$filesToVerify = @(
  [pscustomobject]@{ Label = 'packaged app executable'; Path = $appExecutable.FullName }
  [pscustomobject]@{ Label = 'versioned installer'; Path = $versionedInstaller }
  [pscustomobject]@{ Label = 'stable installer'; Path = $stableInstaller }
)

foreach ($file in $filesToVerify) {
  $filePath = $file.Path
  if ([string]::IsNullOrWhiteSpace($filePath) -or -not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
    throw "Expected $($file.Label) was not found: $filePath"
  }

  $signature = Get-AuthenticodeSignature -LiteralPath $filePath
  if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) {
    throw "Invalid Authenticode signature on '$filePath': $($signature.Status) $($signature.StatusMessage)"
  }

  Write-Host "Verified $filePath"
  Write-Host "  Publisher: $($signature.SignerCertificate.Subject)"
  Write-Host "  Thumbprint: $($signature.SignerCertificate.Thumbprint)"
}
