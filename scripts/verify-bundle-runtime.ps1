# Reproduces the "Verify the bundle carries the pinned runtime" CI step
# (windows-build.yml / release.yml) against a locally built output directory.
param([string]$OutDir = "release-0.6.3")

$ErrorActionPreference = 'Stop'

$manifest = Get-Content dsh-runtime.json -Raw | ConvertFrom-Json
$bundledPath = Join-Path $OutDir "win-unpacked/resources/app.asar.unpacked/node_modules/@deepseek-ai/dsh/package.json"

if (-not (Test-Path $bundledPath)) {
  throw "bundled runtime not found at $bundledPath"
}

$bundled = Get-Content $bundledPath -Raw | ConvertFrom-Json

if ($bundled.version -ne $manifest.version) {
  throw "packaged runtime is $($bundled.version), manifest pins $($manifest.version)"
}

Write-Output "OK: packaged dsh $($bundled.version) matches the manifest (channel=$($manifest.channel))"
