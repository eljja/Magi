param(
  [string]$CommandName = "magi",
  [string]$BinDir = (Join-Path $HOME ".magi/bin"),
  [switch]$NoPath,
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
$runner = Join-Path $repo "script/magi.ps1"
$bin = New-Item -ItemType Directory -Force -Path $BinDir
$cmdPath = Join-Path $bin.FullName "$CommandName.cmd"
$psPath = Join-Path $bin.FullName "$CommandName.ps1"
$existing = Get-Command $CommandName -ErrorAction SilentlyContinue

if ($existing -and -not $Force -and -not $existing.Source.StartsWith($bin.FullName, [StringComparison]::OrdinalIgnoreCase)) {
  Write-Error "Command '$CommandName' already resolves to '$($existing.Source)'. Re-run with -Force or choose -CommandName."
}

Set-Content -LiteralPath $cmdPath -Encoding ASCII -Value @"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$runner" %*
"@

Set-Content -LiteralPath $psPath -Encoding ASCII -Value @"
& "$runner" @args
exit `$LASTEXITCODE
"@

if (-not $NoPath) {
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($null -eq $userPath) {
    $userPath = ""
  }
  $parts = $userPath.Split([IO.Path]::PathSeparator, [StringSplitOptions]::RemoveEmptyEntries)
  if (-not ($parts | Where-Object { $_.TrimEnd("\") -ieq $bin.FullName.TrimEnd("\") })) {
    [Environment]::SetEnvironmentVariable(
      "Path",
      ($parts + $bin.FullName -join [IO.Path]::PathSeparator),
      "User"
    )
    $env:Path = "$($env:Path)$([IO.Path]::PathSeparator)$($bin.FullName)"
    Write-Host "Added $($bin.FullName) to the current user's PATH. Restart terminals to pick it up everywhere."
  }
}

Write-Host "Installed '$CommandName' shim:"
Write-Host "  $cmdPath"
Write-Host "  $psPath"
Write-Host ""
Write-Host "Usage:"
Write-Host "  $CommandName"
Write-Host "  $CommandName D:\path\to\project"
