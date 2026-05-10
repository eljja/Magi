param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$MagiArgs
)

$ErrorActionPreference = "Stop"

$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
$opencode = Join-Path $repo "packages/opencode"
$targetArgs = if ($MagiArgs.Count -eq 0) { @((Get-Location).Path) } else { $MagiArgs }

if (Get-Command bun -ErrorAction SilentlyContinue) {
  & bun run --cwd $opencode --conditions=browser src/index.ts @targetArgs
  exit $LASTEXITCODE
}

if (Get-Command npx -ErrorAction SilentlyContinue) {
  & npx --yes bun run --cwd $opencode --conditions=browser src/index.ts @targetArgs
  exit $LASTEXITCODE
}

Write-Error "Bun is required to run Magi. Install Bun or make npx available."
exit 127
