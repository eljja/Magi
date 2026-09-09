import { ensureDirectory } from "./fs"
import { stat, rename } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { applyEdits, modify } from "jsonc-parser"
import { parseJsonc } from "./config"
import { readMagiState } from "./state"
import { detectOmO, containsOmOSpec, harmonizeOmOConfig, OMO_VERSION } from "./omo-bridge"
import { formatCouncilObservationBulletin } from "./observer"
import { migrateOmORegistrations } from "./migration"

export type InstallOptions = { projectDirectory: string; pluginSpecifier?: string; migrationFiles?: string[] }
export type DoctorReport = {
  ok: boolean
  projectDirectory: string
  pluginRegistered: boolean
  tuiRegistered: boolean
  opencodeDirExists: boolean
  configExists: boolean
  omoInstalled: boolean
  issues: string[]
  recommendations: string[]
}

export async function installOhMyMagi(options: InstallOptions) {
  const project = path.resolve(options.projectDirectory)
  const opencodeDir = path.join(project, ".opencode")
  const specifier = options.pluginSpecifier ?? "oh-my-magi"
  const local = path.isAbsolute(specifier)
  const relative = local ? path.relative(project, specifier) : undefined
  const inside = relative !== undefined && !relative.startsWith("..") && !path.isAbsolute(relative)
  const entry = (target: string) =>
    !local
      ? specifier
      : inside
        ? "./" + path.relative(opencodeDir, path.join(specifier, "dist", target + ".js")).replaceAll("\\", "/")
        : pathToFileURL(path.join(specifier, "dist", target + ".js")).href
  const server = entry("server")
  const tui = entry("tui")
  if (local && !(await Bun.file(path.join(specifier, "dist", "server.js")).exists()))
    throw new Error("Build the local package first: bun run build")
  await migrateOmORegistrations(project, specifier, options.migrationFiles)
  const configFile = await configPath(opencodeDir, "opencode")
  const tuiFile = await configPath(opencodeDir, "tui")
  // Parse both first: malformed user configuration must never be replaced with an empty object.
  const serverText = await patchedConfig(configFile, server)
  const tuiText = await patchedConfig(tuiFile, tui)
  await ensureDirectory(opencodeDir)
  const backup = path.join(opencodeDir, "magi-migration", String(Date.now()))
  for (const file of [configFile, tuiFile]) {
    if (!(await Bun.file(file).exists())) continue
    await ensureDirectory(backup)
    await Bun.write(path.join(backup, path.basename(file)), await Bun.file(file).text())
  }
  const ignoreFile = path.join(opencodeDir, ".gitignore")
  const ignore = (await Bun.file(ignoreFile).exists()) ? await Bun.file(ignoreFile).text() : ""
  if (!ignore.split(/\r?\n/).includes("/magi-migration/"))
    await Bun.write(ignoreFile, ignore.trimEnd() + "\n/magi-migration/\n")
  await Bun.write(configFile, serverText)
  await Bun.write(tuiFile, tuiText)
  await migrateLegacyFiles(opencodeDir)
  await harmonizeOmOConfig(project)
  return { opencodeDir, configFile, tuiFile }
}

async function configPath(directory: string, name: string) {
  const jsonc = path.join(directory, name + ".jsonc")
  return (await Bun.file(jsonc).exists()) ? jsonc : path.join(directory, name + ".json")
}

async function patchedConfig(file: string, spec: string) {
  const text = (await Bun.file(file).exists()) ? await Bun.file(file).text() : "{}\n"
  const config = parseJsonc(text) as Record<string, unknown>
  if (config.plugin !== undefined && !Array.isArray(config.plugin)) throw new Error("plugin must be an array: " + file)
  const list: unknown[] = Array.isArray(config.plugin) ? config.plugin.filter((item) => !containsOmOSpec(item)) : []
  const index = list.findIndex((entry) => containsMagiSpec(entry) || containsLegacyMagiSpec(entry))
  const entry = index >= 0 ? list[index] : undefined
  const replacement = Array.isArray(entry) ? [spec, ...entry.slice(1)] : spec
  const plugins =
    index < 0
      ? [...list, spec]
      : list.flatMap((item, i) =>
          i === index ? [replacement] : containsMagiSpec(item) || containsLegacyMagiSpec(item) ? [] : [item],
        )
  return applyEdits(text, modify(text, ["plugin"], plugins, { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
}

export function containsMagiSpec(entry: unknown): boolean {
  const spec = Array.isArray(entry) ? entry[0] : entry
  if (typeof spec !== "string") return false
  return (
    /^oh-my-magi(?:@[^/]+)?(?:\/(?:server|tui))?$/.test(spec) ||
    /(?:^|[/\\])oh-my-magi(?:[/\\](?:dist[/\\](?:server|tui)\.js|src[/\\](?:server\.ts|tui\.tsx)))?$/.test(spec)
  )
}

function containsLegacyMagiSpec(entry: unknown): boolean {
  const spec = Array.isArray(entry) ? entry[0] : entry
  return (
    typeof spec === "string" &&
    (/^@magi\/opencode-plugin(?:@[^/]+)?$/.test(spec) ||
      /(?:^|[/\\])magi-opencode-plugin(?:@[^/]+|[/\\](?:server|tui))?$/.test(spec))
  )
}

async function migrateLegacyFiles(directory: string) {
  const backup = path.join(directory, "magi-migration", String(Date.now()))
  const templates: Record<string, string> = {
    "agent/magi.md": "6f82524274df1cb29512709612916112203e9a2d4743afd665b9023d1f6db2a5",
    "command/magi.md": "bb5887bdaf31fc80ef8245d93199ce3083b6288c45c69b20a9ab215d1f45fcb6",
  }
  for (const name of ["plugins/magi-server.ts", "plugins/magi-tui.tsx", ...Object.keys(templates)]) {
    const file = path.join(directory, name)
    if (!(await Bun.file(file).exists())) continue
    const text = (await Bun.file(file).text()).replaceAll("\r\n", "\n").trim()
    const template = templates[name] && new Bun.CryptoHasher("sha256").update(text).digest("hex") === templates[name]
    if (
      !template &&
      !/^export \{ default(?:, MagiServerPlugin)? \} from ["']\.\.\/\.\.\/packages\/magi-opencode-plugin\/src\/(?:server|tui)["'];?$/.test(
        text,
      )
    )
      continue
    const destination = path.join(backup, name)
    await ensureDirectory(path.dirname(destination))
    await rename(file, destination)
  }
}

export async function doctorOhMyMagi(projectDirectory: string): Promise<DoctorReport> {
  const project = path.resolve(projectDirectory)
  const opencodeDir = path.join(project, ".opencode")
  const issues: string[] = []
  for (const name of ["plugins/magi-server.ts", "plugins/magi-tui.tsx"]) {
    if (await Bun.file(path.join(opencodeDir, name)).exists())
      issues.push(
        "Inspect legacy auto-loaded wrapper .opencode/" + name + "; it can duplicate or conflict with the package",
      )
  }
  const registered = async (name: string) => {
    const files = [project, opencodeDir].flatMap((dir) =>
      ["json", "jsonc"].map((ext) => path.join(dir, name + "." + ext)),
    )
    const found = await Promise.all(
      files.map(async (file) => {
        if (!(await Bun.file(file).exists())) return false
        try {
          const config = parseJsonc(await Bun.file(file).text()) as Record<string, unknown>
          if (Array.isArray(config.plugin) && config.plugin.some(containsLegacyMagiSpec))
            issues.push("Conflicting legacy Magi plugin in " + file + "; rerun oh-my-magi install to migrate")
          return Array.isArray(config.plugin) && config.plugin.some(containsMagiSpec)
        } catch (error) {
          issues.push(file + ": " + (error instanceof Error ? error.message : String(error)))
          return false
        }
      }),
    )
    return found.some(Boolean)
  }
  const [pluginRegistered, tuiRegistered, omoStatus] = await Promise.all([
    registered("opencode"),
    registered("tui"),
    detectOmO(project),
  ])
  const recommendations: string[] = []
  if (!pluginRegistered) issues.push("Server plugin not registered in project configuration")
  if (!tuiRegistered) issues.push("Optional TUI panel not registered in project configuration")
  if (!omoStatus.installed) {
    issues.push("Bundled OmO dependency missing; reinstall oh-my-magi.")
  } else if (!omoStatus.todoEnforcerDisabled) {
    recommendations.push("OpenCode will prepare .omo/omo.jsonc on startup so Magi owns project continuation.")
  }
  return {
    ok: issues.length === 0,
    projectDirectory: project,
    pluginRegistered,
    tuiRegistered,
    opencodeDirExists: await stat(opencodeDir)
      .then((item) => item.isDirectory())
      .catch(() => false),
    configExists: await Bun.file(path.join(project, ".magi", "config.jsonc")).exists(),
    omoInstalled: omoStatus.installed,
    issues,
    recommendations,
  }
}

export async function getStatusReport(projectDirectory: string) {
  const state = await readMagiState(projectDirectory)
  const lines = [
    "=== Oh-My-Magi Status ===",
    "Directory: " + projectDirectory,
    "OmO engine: oh-my-opencode@" +
      OMO_VERSION +
      " (bundled dependency; doctor checks installation, startup verifies runtime)",
    "Status: " + state.status,
    "Loop Active: " + state.loopActive,
    "Cycle: #" + state.currentCycle + " (unlimited)",
    "Goal: " + (state.goal ?? "(not set)"),
    "Session: " + (state.sessionID ?? "(not set)"),
    "Topic: " + state.topic,
    "Votes: " +
      Object.entries(state.votes)
        .map(([member, vote]) => member + "=" + vote)
        .join(", "),
    state.pendingUserSteering ? "Pending User Steering: " + state.pendingUserSteering : "",
    "Minutes & Ledger: .magi/COUNCIL.md",
    state.error ? "Last error: " + state.error : "",
    state.meeting ? "Meeting round: " + state.meeting.round + " (unlimited)" : "",
    state.retryAt ? "Next retry: " + new Date(state.retryAt).toISOString() : "",
    "Pending guidance: " + (state.steeringQueue ?? []).map((item) => item.text).join(" | "),
    "Monitor: .magi/index.html | Minutes: .magi/COUNCIL.md | Reports: .magi/reports/",
  ]

  const bulletin = formatCouncilObservationBulletin(state)
  if (bulletin.length > 0) {
    lines.push("", ...bulletin)
  }

  lines.push(
    "",
    "User intervention: talk normally in the OpenCode session running this goal to guide the next deliberation.",
  )
  return lines.filter(Boolean).join("\n")
}
