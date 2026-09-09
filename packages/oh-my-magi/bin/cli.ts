#!/usr/bin/env bun
import path from "node:path"
import { doctorOhMyMagi, getStatusReport, installOhMyMagi } from "../src/installer"
import { setAutonomousLoop } from "../src/continuation"
import { repairWindowsRuntime } from "../src/windows"

const args = process.argv.slice(2)
const command = args[0] ?? "status"

function getOption(name: string, fallback: string): string {
  const exact = args.indexOf(name)
  if (exact >= 0 && args[exact + 1]) return args[exact + 1]!
  const prefix = `${name}=`
  const matching = args.find((a) => a.startsWith(prefix))
  return matching ? matching.slice(prefix.length) : fallback
}

const positionalDir = args[1] && !args[1].startsWith("-") ? args[1] : undefined
const targetDir = path.resolve(getOption("--project", getOption("--dir", positionalDir ?? process.cwd())))
const useLocal = args.includes("--local")
const localPkgPath = path.resolve(import.meta.dirname, "..")

if (args.includes("--help") || args.includes("-h") || command === "help") {
  console.log(
    [
      "Oh-My-Magi (OMM) CLI",
      "",
      "Usage:",
      "  oh-my-magi install [<dir>] [--project <dir>] [--local]",
      "  oh-my-magi doctor  [<dir>] [--project <dir>]",
      "  oh-my-magi status  [<dir>] [--project <dir>]",
      "  oh-my-magi stop    [<dir>] [--project <dir>]",
      "",
      "Options:",
      "  --project <dir>   Target project directory (default: current directory)",
      "  --local           Use local repository path instead of npm package name",
      "  --repair-windows  Repair Windows runtime directory attributes before doctor checks",
      "",
      "Commands:",
      "  install   Registers oh-my-magi and migrates recognized legacy Magi files",
      "  doctor    Checks installation health and configuration",
      "  status    Displays current council debate status and active cycle",
      "  stop      Disables continuation without requiring a running server",
    ].join("\n"),
  )
  process.exit(0)
}

if (command === "install") {
  const specifier = useLocal ? localPkgPath : undefined
  console.log(`Installing oh-my-magi into: ${targetDir}...`)
  if (specifier) {
    console.log(`Using local package path: ${specifier}`)
  }
  const result = await installOhMyMagi({
    projectDirectory: targetDir,
    pluginSpecifier: specifier,
  })
  console.log(`✓ Server plugin registered: ${result.configFile}`)
  console.log(`✓ TUI plugin registered: ${result.tuiFile}`)
  console.log("\nInstallation complete! You can now select 'magi' as your agent or use /magi in OpenCode.")
  process.exit(0)
}

if (command === "doctor") {
  if (args.includes("--repair-windows"))
    console.log("Runtime directories prepared: " + (await repairWindowsRuntime(targetDir, process.env, true)).join(", "))
  console.log(`Checking oh-my-magi health for: ${targetDir}...`)
  const report = await doctorOhMyMagi(targetDir)
  for (const recommendation of report.recommendations) console.log("  - " + recommendation)
  if (report.ok) {
    console.log(
      "✓ Project registration checks passed. Restart OpenCode to load the plugin; this check does not test providers or runtime compatibility.",
    )
  } else {
    console.log("⚠ Issues found:")
    for (const issue of report.issues) {
      console.log(`  - ${issue}`)
    }
  }
  process.exit(report.ok ? 0 : 1)
}

if (command === "status") {
  const report = await getStatusReport(targetDir)
  console.log(report)
  process.exit(0)
}

if (command === "stop") {
  await setAutonomousLoop(targetDir, false)
  console.log("Magi continuation stopped. Use OpenCode's interrupt control to abort any currently executing tool.")
  process.exit(0)
}

console.error(`Unknown command: ${command}. Run 'oh-my-magi --help' for usage.`)
process.exit(1)
