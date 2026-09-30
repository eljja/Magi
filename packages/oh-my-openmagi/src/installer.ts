import path from "node:path"
import os from "node:os"
import { parse, modify, applyEdits, type ParseError } from "jsonc-parser"
import { atomic } from "./views"
import { Store } from "./store"
import metadata from "../package.json"
import { registrationName } from "./registrations"

export const version = metadata.version
export async function install(directory: string, global = false, spec = metadata.name + "@" + version) {
  const root = global
    ? process.env.OPENCODE_CONFIG_DIR ||
      path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opencode")
    : directory
  const names = global
    ? ["opencode.json", "opencode.jsonc", "tui.json", "tui.jsonc"]
    : [
        "opencode.json",
        "opencode.jsonc",
        ".opencode/opencode.json",
        ".opencode/opencode.jsonc",
        ".opencode/tui.json",
        ".opencode/tui.jsonc",
      ]
  const exists = await Promise.all(
    names.map(async (name) => ({
      name,
      file: path.join(root, name),
      exists: await Bun.file(path.join(root, name)).exists(),
    })),
  )
  const selected = exists.filter((file) => file.exists)
  if (!selected.some((file) => /opencode\.jsonc?$/.test(file.name)))
    selected.push({ name: "opencode.json", file: path.join(root, "opencode.json"), exists: false })
  const backup = path.join(directory, ".magi", "backups", "install-" + Date.now())
  const changes = await Promise.all(
    selected.map(async (file) => {
      const before = file.exists ? await Bun.file(file.file).text() : "{}\n"
      const errors: ParseError[] = []
      const value = parse(before, errors, { allowTrailingComma: true }) as { plugin?: unknown }
      if (
        errors.length ||
        !value ||
        Array.isArray(value) ||
        typeof value !== "object" ||
        (value.plugin !== undefined && !Array.isArray(value.plugin))
      )
        throw new Error("Invalid OpenCode configuration: " + file.file)
      const entries = (value.plugin || []) as (string | [string, unknown])[]
      const plugins = entries.filter((entry) => {
        const name = typeof entry === "string" ? entry : Array.isArray(entry) ? entry[0] : undefined
        if (typeof name !== "string") throw new Error("Invalid plugin registration: " + file.file)
        return !registrationName(name)
      })
      return { ...file, before, plugins }
    }),
  )
  const target = changes.find((file) => /opencode\.jsonc?$/.test(file.name))!
  const saved: typeof changes = []
  for (const change of changes) {
    const plugins = change === target ? [...change.plugins, spec] : change.plugins
    const after = applyEdits(
      change.before,
      modify(change.before, ["plugin"], plugins, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } }),
    )
    if (after === change.before) continue
    const current = change.exists ? await Bun.file(change.file).text() : "{}\n"
    if (current !== change.before) throw new Error("Configuration changed during installation; retry: " + change.file)
    await atomic(path.join(backup, change.name.replaceAll("/", "__")), change.before)
    await atomic(change.file, after)
    saved.push(change)
  }
  return { files: saved.map((file) => file.file), backup, spec }
}
export async function doctor(directory: string) {
  const store = new Store(directory)
  const state = store.read()
  const result = {
    package: metadata.name + "@" + version,
    project: store.directory,
    database: store.home,
    goal: state.goal,
    desiredState: state.desiredState,
    phase: state.phase,
    heartbeatAgeSeconds: state.heartbeatAt ? Math.round((Date.now() - state.heartbeatAt) / 1000) : null,
    reportIntervalMinutes: state.reporting.intervalMs / 60000,
    error: state.error,
    reportDeliveryError: state.reporting.deliveryError,
    supervisor: store.db.query("SELECT * FROM leases WHERE name='supervisor'").get(),
  }
  store.close()
  return result
}
