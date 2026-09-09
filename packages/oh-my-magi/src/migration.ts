import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { applyEdits, modify } from "jsonc-parser"
import { parseJsonc } from "./config"
import { containsOmOSpec } from "./omo-bridge"
import { safeWriteFile } from "./fs"

export function openCodeConfigFiles(directory: string, env = process.env) {
  const home = env.OPENCODE_TEST_HOME || os.homedir()
  const global = path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode")
  const parents: string[] = []
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    parents.push(current, path.join(current, ".opencode"))
    if (current === path.dirname(current)) break
  }
  return [
    ...new Set([
      ...[
        global,
        ...(env.OPENCODE_DISABLE_PROJECT_CONFIG === "true" ? [] : parents),
        ...(env.OPENCODE_CONFIG_DIR ? [env.OPENCODE_CONFIG_DIR] : []),
      ].flatMap((folder) =>
        ["opencode.json", "opencode.jsonc", "tui.json", "tui.jsonc"].map((name) => path.join(folder, name)),
      ),
      ...(env.OPENCODE_CONFIG ? [path.resolve(env.OPENCODE_CONFIG)] : []),
    ]),
  ]
}

// Plan every edit before writing. Preserve unrelated settings, JSONC comments and
// plugin options; a backup in the project records each original config's path.
export async function migrateOmORegistrations(
  directory: string,
  specifier?: string,
  files = openCodeConfigFiles(directory),
) {
  const entries = await Promise.all(
    files.map(async (file) => {
      if (!(await Bun.file(file).exists())) return undefined
      const text = await Bun.file(file).text()
      const config = parseJsonc(text) as { plugin?: unknown[] }
      if (config.plugin !== undefined && !Array.isArray(config.plugin))
        throw new Error("plugin must be an array: " + file)
      return { file, text, plugins: config.plugin ?? [] }
    }),
  )
  const configs = entries.filter((item) => item !== undefined)
  const magi = configs
    .flatMap((item) =>
      item.plugins.map((entry) => ({ file: item.file, spec: Array.isArray(entry) ? entry[0] : entry })),
    )
    .find((item) => typeof item.spec === "string" && /(?:^|[/\\])oh-my-magi(?:@|[/\\]|$)/.test(item.spec))
  const selected = specifier || (typeof magi?.spec === "string" ? magi.spec : "oh-my-magi")
  const replacement = path.isAbsolute(selected)
    ? pathToFileURL(path.join(selected, "dist", "server.js")).href
    : selected.startsWith(".") && magi
      ? pathToFileURL(path.resolve(path.dirname(magi.file), selected)).href
      : selected
  const plans = configs
    .filter((item) => item.plugins.some(containsOmOSpec))
    .map((item) => {
      const target =
        /[/\\]tui\.jsonc?$/.test(item.file) && replacement.endsWith("/server.js")
          ? replacement.replace(/\/server\.js$/, "/tui.js")
          : replacement
      const seen = new Set<string>()
      const plugins = item.plugins.flatMap((entry) => {
        const spec = Array.isArray(entry) ? entry[0] : entry
        const isMagi = typeof spec === "string" && /(?:^|[/\\])oh-my-magi(?:@|[/\\]|$)/.test(spec)
        if (!containsOmOSpec(entry) && !isMagi) return [entry]
        if (seen.has(target)) return []
        seen.add(target)
        return [Array.isArray(entry) ? [target, ...entry.slice(1)] : target]
      })
      return {
        ...item,
        updated: applyEdits(
          item.text,
          modify(item.text, ["plugin"], plugins, { formattingOptions: { insertSpaces: true, tabSize: 2 } }),
        ),
      }
    })
  if (!plans.length) return []
  const ignoreFile = path.join(directory, ".magi", ".gitignore")
  const ignore = await Bun.file(ignoreFile)
    .text()
    .catch(() => "")
  if (!ignore.split(/\r?\n/).includes("/backups/")) await safeWriteFile(ignoreFile, ignore.trimEnd() + "\n/backups/\n")
  const backup = path.join(directory, ".magi", "backups", "migration-" + Date.now() + "-" + crypto.randomUUID())
  await safeWriteFile(
    path.join(backup, "manifest.json"),
    JSON.stringify(
      plans.map((item, i) => ({ source: item.file, backup: i + ".jsonc" })),
      null,
      2,
    ),
  )
  for (const [index, item] of plans.entries()) await safeWriteFile(path.join(backup, index + ".jsonc"), item.text)
  for (const item of plans) {
    if ((await Bun.file(item.file).text()) !== item.text)
      throw new Error("Configuration changed during migration; original backup preserved. Retry: " + item.file)
    await safeWriteFile(item.file, item.updated)
  }
  return plans.map((item) => item.file)
}
