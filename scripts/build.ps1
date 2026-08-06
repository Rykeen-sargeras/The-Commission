$ErrorActionPreference = 'Stop'
$node = if ($env:NODE_EXE) { $env:NODE_EXE } else { 'node' }
& $node --check discord_bot.js
& $node --check desktop/main.js
& $node --check desktop/preload.js
& $node --check desktop/renderer.js
Get-ChildItem memberbridge -Filter *.js | ForEach-Object { & $node --check $_.FullName }
Write-Host 'The Commission source checks passed.'
