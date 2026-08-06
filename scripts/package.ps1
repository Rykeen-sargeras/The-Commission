$ErrorActionPreference = 'Stop'
$node = if ($env:NODE_EXE) { $env:NODE_EXE } else { 'node' }
& $PSScriptRoot/build.ps1
& $PSScriptRoot/test.ps1
& $node node_modules/electron-builder/out/cli/cli.js --win nsis portable
Write-Host 'Installer and portable executable are in dist.'
