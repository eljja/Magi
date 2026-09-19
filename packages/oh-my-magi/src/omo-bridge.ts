import path from "node:path"
import os from "node:os"
import { applyEdits, modify, visit } from "jsonc-parser"
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
  const harness = isRecord(config["[opencode]"]) ? config["[opencode]"] : config
  const hooks = Array.isArray(harness.disabled_hooks) ? harness.disabled_hooks : []
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
    "/LATEST-REPORT.md",
    "/COUNCIL.md",
    "/members/",
    "/MEMORY.md",
    "/USER-GUIDANCE.md",
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
  const seed = canonicalConfig(Object.assign({}, ...legacyConfigs.reverse(), config))
  const layers = [...inherited, ...legacyConfigs, seed].flatMap((item) => [
    item,
    ...(isRecord(item.opencode) ? [item.opencode] : []),
    ...(isRecord(item["[opencode]"]) ? [item["[opencode]"]] : []),
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
      .filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(config[key]))
      .map(([key, value]): [string[], unknown] => [[key], value]),
    ...Object.keys(config)
      .filter((key) => !(key in seed))
      .map((key): [string[], unknown] => [[key], undefined]),
    [["[opencode]", "disabled_hooks"], disabled],
    ...categoryModelEdits(seed),
  ]
  // Prevent upstream self-healing from registering a second global TUI plugin.
  edits.push([["[opencode]", "tui", "sidebar", "enabled"], false])
  if (!isRecord(seed["[opencode]"]) || seed["[opencode]"].telemetry === undefined)
    edits.push([["[opencode]", "telemetry"], false])
  const profiles = layers.flatMap((layer) => (isRecord(layer.profiles) ? Object.entries(layer.profiles) : []))
  for (const name of new Set(profiles.map(([name]) => name))) {
    const extra = profiles
      .filter(([key]) => key === name)
      .flatMap(([, profile]) => {
        if (!isRecord(profile)) return []
        return [
          profile,
          ...(isRecord(profile.opencode) ? [profile.opencode] : []),
          ...(isRecord(profile["[opencode]"]) ? [profile["[opencode]"]] : []),
        ].flatMap((layer) => (Array.isArray(layer.disabled_hooks) ? layer.disabled_hooks : []))
      })
    const hooks = [...new Set([...disabled, ...extra])]
    edits.push(
      [["profiles", name, "[opencode]", "disabled_hooks"], hooks],
      [["profiles", name, "[opencode]", "tui", "sidebar", "enabled"], false],
    )
  }
  const edited = edits.reduce(
    (text, [keys, value]) =>
      applyEdits(text, modify(text, keys, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } })),
    original,
  )
  const comments: string[] = []
  visit(original, { onComment: (offset, length) => comments.push(original.slice(offset, offset + length)) })
  const updated = [...comments.filter((comment) => !edited.includes(comment)), edited].join("\n")
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

// OmO 4.19 uses the literal "[opencode]" key. Unknown legacy plugin fields at
// the root make its strict shared loader reject the whole file, including models.
function canonicalConfig(config: Record<string, unknown>): Record<string, unknown> {
  const shared = new Set([
    "$schema",
    "agents",
    "categories",
    "codegraph",
    "task",
    "teams",
    "models",
    "profiles",
    "_migrations",
    "legacy_migrations",
    "[opencode]",
    "[senpi]",
    "[codex]",
  ])
  const legacy = Object.fromEntries(Object.entries(config).filter(([key]) => !shared.has(key) && key !== "opencode"))
  return {
    ...Object.fromEntries(Object.entries(config).filter(([key]) => shared.has(key))),
    "[opencode]": mergeConfig(
      mergeConfig(legacy, isRecord(config.opencode) ? config.opencode : {}),
      isRecord(config["[opencode]"]) ? config["[opencode]"] : {},
    ),
    ...(isRecord(config.profiles)
      ? {
          profiles: Object.fromEntries(
            Object.entries(config.profiles).map(([name, profile]) => [
              name,
              isRecord(profile) ? canonicalConfig(profile) : profile,
            ]),
          ),
        }
      : {}),
  }
}

function mergeConfig(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  return {
    ...base,
    ...Object.fromEntries(
      Object.entries(override).map(([key, value]) => [
        key,
        isRecord(base[key]) && isRecord(value) ? mergeConfig(base[key], value) : value,
      ]),
    ),
  }
}

// Upstream's canonical default category chain can mask an explicit legacy
// `model` override. Normalize only explicit local settings; leave canonical
// chains and all unrelated agent/provider settings in the user's control.
function categoryModelEdits(config: Record<string, unknown>, prefix: string[] = []): [string[], unknown][] {
  return [
    ...Object.entries(isRecord(config.categories) ? config.categories : {}).flatMap(
      ([name, category]): [string[], unknown][] => {
        if (!isRecord(category) || typeof category.model !== "string" || category.models !== undefined) return []
        const fallbacks = Array.isArray(category.fallback_models)
          ? category.fallback_models
          : typeof category.fallback_models === "string"
            ? [category.fallback_models]
            : []
        return [
          [
            [...prefix, "categories", name, "models"],
            [category.model, ...fallbacks],
          ],
          [[...prefix, "categories", name, "model"], undefined],
          [[...prefix, "categories", name, "fallback_models"], undefined],
        ]
      },
    ),
    ...(isRecord(config["[opencode]"]) ? categoryModelEdits(config["[opencode]"], [...prefix, "[opencode]"]) : []),
    ...Object.entries(isRecord(config.profiles) ? config.profiles : {}).flatMap(([name, profile]) =>
      isRecord(profile) ? categoryModelEdits(profile, [...prefix, "profiles", name]) : [],
    ),
  ]
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
