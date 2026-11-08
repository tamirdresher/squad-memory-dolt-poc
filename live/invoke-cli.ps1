param([Parameter(Mandatory=$true)][string]$ArgumentsFile)
$ErrorActionPreference = 'Stop'
$cliArgs = Get-Content -LiteralPath $ArgumentsFile -Raw | ConvertFrom-Json
& copilot @cliArgs
exit $LASTEXITCODE
