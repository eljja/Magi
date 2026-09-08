import path from "node:path"
import { parseJsonc } from "./config"
import { isRecord, safeReadFile, safeWriteFile } from "./fs"

export type OmOStatus = {
  installed: boolean
  pluginSpec?: string
  configPath?: string
  todoEnforcerDisabled: boolean
  issues: string[]
}

const OMO_PLUGIN_NAMES = ["oh-my-openagent", "oh-my-opencode"]
const OMO_CONFIG_FILENAMES = ["oh-my-openagent.jsonc", "oh-my-openagent.json", "oh-my-opencode.jsonc", "oh-my-opencode.json"]

/**
 * Detects whether oh-my-openagent (OmO) is registered in the project's OpenCode configuration.
 */
export async function detectOmO(directory: string): Promise<OmOStatus> {
  const issues: string[] = []
  let installed = false
  let pluginSpec: string | undefined

  // 1. Check .opencode/opencode.json[c] for plugin registration
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const file = path.join(directory, ".opencode", name)
    const raw = await safeReadFile(file)
    if (!raw) continue

    const parsed = parseJsonc(raw)
    if (isRecord(parsed) && Array.isArray(parsed.plugin)) {
      for (const entry of parsed.plugin) {
        const spec = typeof entry === "string" ? entry : Array.isArray(entry) && typeof entry[0] === "string" ? entry[0] : ""
        if (OMO_PLUGIN_NAMES.some((omo) => spec === omo || spec.includes(omo))) {
          installed = true
          pluginSpec = spec
          break
        }
      }
    }
    if (installed) break
  }

  // 2. Check for OmO configuration files
  let configPath: string | undefined
  let todoEnforcerDisabled = false

  for (const name of OMO_CONFIG_FILENAMES) {
    const candidate = path.join(directory, name)
    const raw = await safeReadFile(candidate)
    if (!raw) continue

    configPath = candidate
    const parsed = parseJsonc(raw)
    if (isRecord(parsed) && Array.isArray(parsed.disabled_hooks)) {
      todoEnforcerDisabled = parsed.disabled_hooks.includes("todo-continuation-enforcer")
    }
    break
  }

  if (!installed) {
    issues.push("oh-my-openagent is not registered in .opencode/opencode.json[c]. Run 'opencode plugin oh-my-openagent'.")
  }

  if (installed && configPath && !todoEnforcerDisabled) {
    issues.push("OmO 'todo-continuation-enforcer' hook is not disabled, which may cause competing continuation loops.")
  }

  return {
    installed,
    pluginSpec,
    configPath,
    todoEnforcerDisabled,
    issues,
  }
}

/**
 * Harmonizes OmO configuration to prevent competing continuation loops on session.idle.
 * Disables 'todo-continuation-enforcer' so Magi Supreme Council retains exclusive macro-loop governance.
 */
export async function harmonizeOmOConfig(directory: string): Promise<{ harmonized: boolean; configPath: string }> {
  // Find or create oh-my-openagent.jsonc
  const targetPath = path.join(directory, "oh-my-openagent.jsonc")
  const raw = await safeReadFile(targetPath)
  const current = raw ? parseJsonc(raw) : {}
  const obj = isRecord(current) ? current : {}

  const disabledHooks = Array.isArray(obj.disabled_hooks)
    ? (obj.disabled_hooks.filter((h): h is string => typeof h === "string") as string[])
    : []

  if (!disabledHooks.includes("todo-continuation-enforcer")) {
    disabledHooks.push("todo-continuation-enforcer")
  }

  const updated = {
    ...obj,
    disabled_hooks: disabledHooks,
  }

  await safeWriteFile(targetPath, `${JSON.stringify(updated, null, 2)}\n`)
  return { harmonized: true, configPath: targetPath }
}

/**
 * Resolves the executor agent to dispatch tasks to.
 * Returns 'sisyphus' if OmO is registered/available, or undefined to use OpenCode's default agent.
 */
export async function resolveExecutorAgent(directory: string): Promise<string | undefined> {
  const omo = await detectOmO(directory)
  return omo.installed ? "sisyphus" : undefined
}

