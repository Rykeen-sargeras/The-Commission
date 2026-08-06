$ErrorActionPreference = 'Stop'
$node = if ($env:NODE_EXE) { $env:NODE_EXE } else { 'node' }
& $node tests/preemptive-ban.test.js
& $node tests/blueprint.test.js
& $node tests/economy.test.js
& $node tests/memberbridge.test.js
Write-Host 'All The Commission tests passed.'
