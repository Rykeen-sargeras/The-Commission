$ErrorActionPreference = 'Stop'
$node = if ($env:NODE_EXE) { $env:NODE_EXE } else { 'node' }
& $node $PSScriptRoot/run-tests.js
