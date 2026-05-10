param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$MagiArgs
)

$ErrorActionPreference = "Stop"

$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
$runner = Join-Path $repo "script/magi.ts"

if (Get-Command bun -ErrorAction SilentlyContinue) {
  & bun $runner @MagiArgs
  exit $LASTEXITCODE
}

if (Get-Command npx -ErrorAction SilentlyContinue) {
  & npx --yes bun $runner @MagiArgs
  exit $LASTEXITCODE
}

Write-Error "Bun is required to run Magi. Install Bun or make npx available."
exit 127
