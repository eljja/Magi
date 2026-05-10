#!/usr/bin/env bun

import fs from "fs"
import os from "os"
import path from "path"

const repo = path.resolve(import.meta.dirname, "..")
const args = process.argv.slice(2)
const value = (name: string, fallback: string) => {
  const exact = args.indexOf(name)
  if (exact >= 0) return args[exact + 1] ?? fallback
  const prefix = `${name}=`
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? fallback
}
const flag = (name: string) => args.includes(name)
const command = value("--command", value("--command-name", "magi"))
const binDir = path.resolve(value("--bin-dir", path.join(os.homedir(), ".magi", "bin")))
const noPath = flag("--no-path")
const force = flag("--force")
const runner = path.join(repo, "script", "magi.ts")
const powershellRunner = path.join(repo, "script", "magi.ps1")

if (flag("--help") || flag("-h")) {
  console.log([
    "Usage: bun script/install-magi.ts [options]",
    "",
    "Options:",
    "  --command <name>       Command name to install. Default: magi",
    "  --bin-dir <path>       Install directory. Default: ~/.magi/bin",
    "  --no-path              Do not modify or print PATH setup.",
    "  --force                Replace an existing command in another location.",
  ].join("\n"))
  process.exit(0)
}

function existingCommand(command: string) {
  const paths = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  const extensions = process.platform === "win32" ? ["", ".cmd", ".exe", ".bat", ".ps1"] : [""]
  return paths
    .flatMap((entry) => extensions.map((ext) => path.join(entry, `${command}${ext}`)))
    .find((candidate) => fs.existsSync(candidate))
}

const existing = existingCommand(command)
const outsideBinDir = (candidate: string) => {
  const relative = path.relative(binDir, path.resolve(candidate))
  return relative.startsWith("..") || path.isAbsolute(relative)
}
if (existing && !force && outsideBinDir(existing)) {
  console.error(`Command '${command}' already resolves to '${existing}'. Re-run with --force or --command <name>.`)
  process.exit(1)
}

fs.mkdirSync(binDir, { recursive: true })

if (process.platform === "win32") {
  fs.writeFileSync(
    path.join(binDir, `${command}.cmd`),
    `@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "${powershellRunner}" %*\r\n`,
  )
  fs.writeFileSync(
    path.join(binDir, `${command}.ps1`),
    `& "${powershellRunner}" @args\r\nexit $LASTEXITCODE\r\n`,
  )
} else {
  const target = path.join(binDir, command)
  fs.writeFileSync(
    target,
    [
      "#!/usr/bin/env sh",
      "set -eu",
      'if command -v bun >/dev/null 2>&1; then',
      `  exec bun "${runner}" "$@"`,
      'elif command -v npx >/dev/null 2>&1; then',
      `  exec npx --yes bun "${runner}" "$@"`,
      "fi",
      'echo "Bun is required to run Magi. Install Bun or make npx available." >&2',
      "exit 127",
      "",
    ].join("\n"),
  )
  fs.chmodSync(target, 0o755)
}

console.log(`Installed '${command}' shim in ${binDir}`)
if (!noPath) {
  if (process.platform === "win32") {
    const readPath = Bun.spawnSync({
      cmd: [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Environment]::GetEnvironmentVariable('Path', 'User')",
      ],
      stdout: "pipe",
      stderr: "pipe",
    })
    const current = new TextDecoder().decode(readPath.stdout).trim()
    const parts = current.split(path.delimiter).filter(Boolean)
    const exists = parts.some((entry) => path.resolve(entry).toLowerCase() === binDir.toLowerCase())
    if (!exists) {
      const next = [...parts, binDir].join(path.delimiter)
      const update = Bun.spawnSync({
        cmd: [
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `[Environment]::SetEnvironmentVariable('Path', ${JSON.stringify(next)}, 'User')`,
        ],
        stdout: "pipe",
        stderr: "pipe",
      })
      if (update.exitCode !== 0) {
        console.log("")
        console.log("Could not update the user PATH automatically. Add this directory manually:")
        console.log(`  ${binDir}`)
      } else {
        console.log("")
        console.log("Added the shim directory to the current user's PATH. Restart terminals to pick it up everywhere.")
      }
    }
  }
  console.log("")
  if (process.platform !== "win32") {
    console.log("Add this directory to PATH if it is not already available:")
    console.log(`  ${binDir}`)
    console.log("")
    console.log("For bash/zsh, add this to your shell profile:")
    console.log(`  export PATH="${binDir}:$PATH"`)
  }
}
console.log("")
console.log("Usage:")
console.log(`  ${command}`)
console.log(`  ${command} /path/to/project`)
