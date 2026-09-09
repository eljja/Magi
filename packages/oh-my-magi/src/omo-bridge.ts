import path from "node:path"
import os from "node:os"
import { applyEdits, modify } from "jsonc-parser"
import type { PluginInput } from "@opencode-ai/plugin"
import { parseJsonc } from "./config"
import { isRecord, safeWriteFile } from "./fs"
import compatibility from "../compatibility.json"

export const OMO_VERSION = compatibility.omoTested
// OMM owns project-level autonomous scheduling. Upstream agents and tools remain enabled.
export const OMO_MANAGED_HOOKS = ["todo-continuation-enforcer", "goal", "atlas"] as const
const runtimes = new Map<string, { agent: string; tools: string[] }>()

export function containsOmOSpec(entry: unknown) {
  const spec = Array.isArray(entry) ? entry[0] : entry
  return typeof spec === "string" && /^(?:oh-my-opencode|oh-my-openagent)(?:@[^/]+)?(?:\/(?:server|tui))?$/.test(spec)
}

export function registerOmORuntime(directory: string, agent: string, tools: string[]) {
  runtimes.set(path.resolve(directory), { agent, tools })
}

export function forgetOmORuntime(directory: string) {
  runtimes.delete(path.resolve(directory))
}

export async function detectOmO(directory: string) {
  const runtime = runtimes.get(path.resolve(directory))
  const dependency = await import("oh-my-opencode").then(() => true).catch(() => false)
  const configPath = await omoConfigPath(directory)
  const config = await readConfig(configPath)
  const hooks = Array.isArray(config.disabled_hooks) ? config.disabled_hooks : []
  return {
    installed: dependency,
    loaded: Boolean(runtime),
    version: OMO_VERSION,
    executor: runtime?.agent,
    tools: runtime?.tools ?? [],
    configPath,
    todoEnforcerDisabled: OMO_MANAGED_HOOKS.every((hook) => hooks.includes(hook)),
    issues: dependency ? [] : ["Bundled OmO dependency is missing. Reinstall oh-my-magi."],
  }
}

async function omoConfigPath(directory: string) {
  const base = path.join(directory, ".omo", "omo")
  return !(await Bun.file(base + ".jsonc").exists()) && (await Bun.file(base + ".json").exists())
    ? base + ".json"
    : base + ".jsonc"
}

async function readConfig(file: string): Promise<Record<string, unknown>> {
  return (await Bun.file(file).exists()) ? (parseJsonc(await Bun.file(file).text()) as Record<string, unknown>) : {}
}

export async function harmonizeOmOConfig(directory: string) {
  const ignoreFile = path.join(directory, ".magi", ".gitignore")
  const ignore = (await Bun.file(ignoreFile).exists()) ? await Bun.file(ignoreFile).text() : ""
  const missing = [
    "/runtime/",
    "/runs/",
    "/backups/",
    "/reports/",
    "/events/",
    "/index.html",
    "/STATUS.md",
    "/COUNCIL.md",
  ].filter((line) => !ignore.split(/\r?\n/).includes(line))
  if (missing.length) await safeWriteFile(ignoreFile, ignore.trimEnd() + "\n" + missing.join("\n") + "\n")
  const target = await omoConfigPath(directory)
  const exists = await Bun.file(target).exists()
  const original = exists ? await Bun.file(target).text() : "{}\n"
  const config = parseJsonc(original) as Record<string, unknown>
  const legacy = ["oh-my-openagent.jsonc", "oh-my-openagent.json", "oh-my-opencode.jsonc", "oh-my-opencode.json"]
  const inherited: Record<string, unknown>[] = [
    await readConfig(await omoConfigPath(process.env.HOME ?? process.env.USERPROFILE ?? os.homedir())),
  ]
  for (let parent = path.dirname(path.resolve(directory)); ; parent = path.dirname(parent)) {
    inherited.push(await readConfig(await omoConfigPath(parent)))
    if (parent === path.dirname(parent)) break
  }
  const legacyConfigs = await Promise.all(
    legacy.flatMap((name) => [path.join(directory, ".opencode", name), path.join(directory, name)]).map(readConfig),
  )
  const seed = Object.assign({}, ...legacyConfigs.reverse(), config) as Record<string, unknown>
  const layers = [...inherited, ...legacyConfigs, seed].flatMap((item) => [
    item,
    ...(isRecord(item.opencode) ? [item.opencode] : []),
  ])
  const disabled = [
    ...new Set([
      ...layers.flatMap((item) =>
        Array.isArray(item.disabled_hooks)
          ? item.disabled_hooks.filter((value): value is string => typeof value === "string")
          : [],
      ),
      ...OMO_MANAGED_HOOKS,
    ]),
  ]
  const edits: [string[], unknown][] = [
    ...Object.entries(seed)
      .filter(([key]) => !(key in config))
      .map(([key, value]): [string[], unknown] => [[key], value]),
    [["disabled_hooks"], disabled],
    [["opencode", "disabled_hooks"], disabled],
  ]
  // Prevent upstream self-healing from registering a second global TUI plugin.
  edits.push([["tui", "sidebar", "enabled"], false], [["opencode", "tui", "sidebar", "enabled"], false])
  if (seed.telemetry === undefined) edits.push([["telemetry"], false])
  const profiles = layers.flatMap((layer) => (isRecord(layer.profiles) ? Object.entries(layer.profiles) : []))
  for (const name of new Set(profiles.map(([name]) => name))) {
    const extra = profiles
      .filter(([key]) => key === name)
      .flatMap(([, profile]) => {
        if (!isRecord(profile)) return []
        return [profile, ...(isRecord(profile.opencode) ? [profile.opencode] : [])].flatMap((layer) =>
          Array.isArray(layer.disabled_hooks) ? layer.disabled_hooks : [],
        )
      })
    const hooks = [...new Set([...disabled, ...extra])]
    edits.push(
      [["profiles", name, "disabled_hooks"], hooks],
      [["profiles", name, "opencode", "disabled_hooks"], hooks],
      [["profiles", name, "opencode", "tui", "sidebar", "enabled"], false],
    )
  }
  const updated = edits.reduce(
    (text, [keys, value]) =>
      applyEdits(text, modify(text, keys, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } })),
    original,
  )
  if (updated !== original) {
    if (exists)
      await safeWriteFile(
        path.join(directory, ".magi", "backups", `omo-${Date.now()}-${crypto.randomUUID()}.jsonc`),
        original,
      )
    await safeWriteFile(target, updated)
  }
  return { harmonized: true, configPath: target }
}

export async function resolveExecutorAgent(directory: string, client?: PluginInput["client"]) {
  if (!client) throw new Error("OpenCode client is required to verify the OmO executor")
  const result = await client.app.agents({ query: { directory } })
  if (result.error || !Array.isArray(result.data)) throw new Error("Cannot verify loaded OmO agents")
  const expected = runtimes.get(path.resolve(directory))?.agent
  const executor = result.data.find((agent) =>
    expected ? agent.name === expected : /^sisyphus(?:\s|$)/i.test(agent.name),
  )
  if (!executor || executor.mode === "subagent")
    throw new Error(
      "OmO primary executor is unavailable. Check OmO model/disabled_agents settings and restart OpenCode.",
    )
  return executor.name
}
