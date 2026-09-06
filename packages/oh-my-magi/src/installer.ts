import { mkdir } from "node:fs/promises"
import path from "node:path"
import { parseJsonc } from "./config"
import { readMagiState } from "./state"

export type InstallOptions = {
  projectDirectory: string
  pluginSpecifier?: string
}

export type DoctorReport = {
  ok: boolean
  projectDirectory: string
  opencodeDirExists: boolean
  commandInstalled: boolean
  agentInstalled: boolean
  pluginRegistered: boolean
  tuiRegistered: boolean
  configExists: boolean
  issues: string[]
}

export async function installOhMyMagi(options: InstallOptions): Promise<{
  opencodeDir: string
  commandFile: string
  agentFile: string
  configFile: string
  tuiFile: string
}> {
  const project = path.resolve(options.projectDirectory)
  const opencodeDir = path.join(project, ".opencode")
  const commandDir = path.join(opencodeDir, "command")
  const commandFile = path.join(commandDir, "magi.md")

  try {
    await mkdir(commandDir, { recursive: true })
  } catch (err: unknown) {
    if (isRecord(err) && err.code !== "EEXIST") throw err
  }

  // 1. Write the /magi command template
  const commandTemplate = [
    "---",
    "description: Run the Magi council to deliberate on tasks or manage autonomous self-improvement",
    "---",
    "",
    "Magi council is deliberating.",
    "",
    "The Magi plugin intercepts this command to convene Melchior, Balthasar, and Casper before injecting the approved task back into this session.",
    "",
    "$ARGUMENTS",
    "",
  ].join("\n")

  await Bun.write(commandFile, commandTemplate)

  // 2. Write the Primary Agent definition: .opencode/agent/magi.md
  const agentDir = path.join(opencodeDir, "agent")
  const agentFile = path.join(agentDir, "magi.md")
  try {
    await mkdir(agentDir, { recursive: true })
  } catch (err: unknown) {
    if (isRecord(err) && err.code !== "EEXIST") throw err
  }

  const agentTemplate = [
    "---",
    "description: Supreme 3-Member Council (Melchior, Balthasar, Casper) orchestrating Sisyphus and OmO specialist subagents",
    "mode: primary",
    "color: \"#7C3AED\"",
    "---",
    "",
    "You are the MAGI SUPREME COUNCIL: a triumvirate consisting of MELCHIOR (Architecture & Theory), BALTHASAR (Risk & Safety Veto), and CASPER (Product Value & User Intent).",
    "",
    "Your purpose:",
    "1. Deliberate on the user's high-level goal and maintain the master project roadmap (`.magi/ROADMAP.md`).",
    "2. Command and govern Sisyphus (OmO's Lead PM) by issuing structured, milestone-driven task directives.",
    "3. Rigorously audit the code, artifacts, and test results produced by Sisyphus and the subagent workforce.",
    "4. Issue corrective repair orders whenever Balthasar or Melchior identifies flaws, risks, or regressions.",
    "5. Only conclude when all milestones in the roadmap are verified and all three council members unanimously approve with STOP_SELF_IMPROVEMENT.",
    "",
  ].join("\n")

  await Bun.write(agentFile, agentTemplate)

  // 3. Register the server plugin in .opencode/opencode.json (or .opencode/opencode.jsonc)
  const jsoncFile = path.join(opencodeDir, "opencode.jsonc")
  const jsonFile = path.join(opencodeDir, "opencode.json")
  const configFile = (await Bun.file(jsoncFile).exists()) && !(await Bun.file(jsonFile).exists()) ? jsoncFile : jsonFile
  const specifier = options.pluginSpecifier ?? "oh-my-magi"
  await upsertPlugin(configFile, specifier)

  // 4. Register the TUI plugin in .opencode/tui.json
  const tuiFile = path.join(opencodeDir, "tui.json")
  await upsertPlugin(tuiFile, specifier)

  return {
    opencodeDir,
    commandFile,
    agentFile,
    configFile,
    tuiFile,
  }
}

export async function doctorOhMyMagi(projectDirectory: string): Promise<DoctorReport> {
  const project = path.resolve(projectDirectory)
  const opencodeDir = path.join(project, ".opencode")
  const commandFile = path.join(opencodeDir, "command", "magi.md")
  const agentFile = path.join(opencodeDir, "agent", "magi.md")
  const jsoncFile = path.join(opencodeDir, "opencode.jsonc")
  const jsonFile = path.join(opencodeDir, "opencode.json")
  const tuiFile = path.join(opencodeDir, "tui.json")
  const magiConfig = path.join(project, ".magi", "config.jsonc")

  const issues: string[] = []

  const opencodeDirExists = await Bun.file(opencodeDir).exists()
  const commandInstalled = await Bun.file(commandFile).exists()
  if (!commandInstalled) {
    issues.push("Slash command /magi is not installed at .opencode/command/magi.md")
  }

  const agentInstalled = await Bun.file(agentFile).exists()
  if (!agentInstalled) {
    issues.push("Primary agent is not installed at .opencode/agent/magi.md")
  }

  let pluginRegistered = false
  for (const candidate of [jsoncFile, jsonFile]) {
    if (await Bun.file(candidate).exists()) {
      const content = parseJsonc(await Bun.file(candidate).text())
      if (isRecord(content) && Array.isArray(content.plugin)) {
        if (content.plugin.some((p) => p === "oh-my-magi" || (typeof p === "string" && p.includes("magi")))) {
          pluginRegistered = true
          break
        }
      }
    }
  }
  if (!pluginRegistered) {
    issues.push("Server plugin is not registered in .opencode/opencode.json or .opencode/opencode.jsonc")
  }

  let tuiRegistered = false
  if (await Bun.file(tuiFile).exists()) {
    const content = parseJsonc(await Bun.file(tuiFile).text())
    if (isRecord(content) && Array.isArray(content.plugin)) {
      tuiRegistered = content.plugin.some((p) => p === "oh-my-magi" || (typeof p === "string" && p.includes("magi")))
    }
  }
  if (!tuiRegistered) {
    issues.push("TUI plugin is not registered in .opencode/tui.json")
  }

  const configExists = await Bun.file(magiConfig).exists()

  return {
    ok: issues.length === 0,
    projectDirectory: project,
    opencodeDirExists,
    commandInstalled,
    agentInstalled,
    pluginRegistered,
    tuiRegistered,
    configExists,
    issues,
  }
}

export async function getStatusReport(projectDirectory: string): Promise<string> {
  const state = await readMagiState(projectDirectory)
  return [
    "=== Oh-My-Magi Status ===",
    `Directory: ${projectDirectory}`,
    `Status: ${state.status}`,
    `Loop Active: ${state.loopActive}`,
    `Cycle: #${state.currentCycle} (max: ${state.maxCycles})`,
    `Topic: ${state.topic}`,
    state.votes.melchior ? `Melchior: ${state.votes.melchior}` : undefined,
    state.votes.balthasar ? `Balthasar: ${state.votes.balthasar}` : undefined,
    state.votes.casper ? `Casper: ${state.votes.casper}` : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
}

async function upsertPlugin(file: string, spec: string): Promise<void> {
  const current = (await Bun.file(file).exists()) ? parseJsonc(await Bun.file(file).text()) : {}
  const parsed = isRecord(current) ? current : {}
  const list = Array.isArray(parsed.plugin) ? parsed.plugin : []
  const filtered = list.filter((item) => item !== spec)
  await Bun.write(file, `${JSON.stringify({ ...parsed, plugin: [...filtered, spec] }, null, 2)}\n`)
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val)
}
