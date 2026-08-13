param([int]$Port = 9333)

$projectRoot = Split-Path -Parent $PSScriptRoot
$env:EVERBEE_HOST_EXECUTOR_PORT = $Port
& node "--env-file=$projectRoot\.env" "$projectRoot\scripts\everbee-host-executor.mjs"
