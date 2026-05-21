import path from "node:path"
import { installMagiPlugin } from "../packages/magi/src/plugin-installer"

const repo = path.resolve(import.meta.dirname, "..")
const args = process.argv.slice(2)

const value = (name: string, fallback: string) => {
  const exact = args.indexOf(name)
  if (exact >= 0) return args[exact + 1] ?? fallback
  const prefix = `${name}=`
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? fallback
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(
    [
      "Usage:",
      "  magi install-plugin [project] [--plugin <path>]",
      "  bun run magi:install-plugin -- --project <path>",
      "",
      "Installs the Magi server plugin, TUI plugin, and /magi command into a project's .opencode directory.",
    ].join("\n"),
  )
  process.exit(0)
}

const result = await installMagiPlugin({
  project: path.resolve(value("--project", value("--directory", positionals()[0] ?? process.cwd()))),
  plugin: path.resolve(value("--plugin", path.join(repo, "packages", "magi-opencode-plugin"))),
})

console.log(`Installed Magi OpenCode plugin into ${result.opencodeDir}`)
console.log(`Plugin: ${result.plugin}`)
console.log(`Command: ${result.command}`)

function positionals() {
  const result: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg.startsWith("--")) {
      if (!arg.includes("=") && ["--project", "--directory", "--plugin"].includes(arg)) index++
      continue
    }
    result.push(arg)
  }
  return result
}
