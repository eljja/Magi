import { mkdir } from "node:fs/promises"
import path from "node:path"

export type MagiPluginInstallInput = {
  project: string
  plugin: string
}

export type MagiPluginInstallResult = {
  opencodeDir: string
  plugin: string
  command: string
}

export async function installMagiPlugin(input: MagiPluginInstallInput): Promise<MagiPluginInstallResult> {
  const project = path.resolve(input.project)
  const plugin = path.resolve(input.plugin)
  const opencodeDir = path.join(project, ".opencode")
  await mkdir(path.join(opencodeDir, "command"), { recursive: true })
  await Bun.write(path.join(opencodeDir, "command", "magi.md"), await Bun.file(path.join(plugin, "command", "magi.md")).text())
  await upsertPlugin(path.join(opencodeDir, "opencode.jsonc"), plugin)
  await upsertPlugin(path.join(opencodeDir, "tui.json"), plugin)
  return {
    opencodeDir,
    plugin,
    command: "/magi",
  }
}

async function upsertPlugin(file: string, spec: string) {
  const current = (await Bun.file(file).exists()) ? parseJsonc(await Bun.file(file).text()) : {}
  const plugins = Array.isArray(current.plugin)
    ? current.plugin.filter((item) => pluginID(item, path.dirname(file)) !== spec)
    : []
  await Bun.write(file, `${JSON.stringify({ ...current, plugin: [...plugins, spec] }, null, 2)}\n`)
}

function pluginID(item: unknown, directory: string) {
  if (typeof item === "string") return path.resolve(directory, item)
  if (Array.isArray(item) && typeof item[0] === "string") return path.resolve(directory, item[0])
  return ""
}

function parseJsonc(input: string) {
  return JSON.parse(
    input
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
      .replace(/,\s*([}\]])/g, "$1"),
  ) as { plugin?: unknown[] }
}
