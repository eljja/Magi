export type MagiContextPack = {
  text: string
  truncated: boolean
}

type CommandResult = {
  code: number
  stdout: string
}

export async function collectMagiContext(input: {
  directory: string
  enabled?: boolean
  maxChars?: number
}): Promise<MagiContextPack> {
  const enabled = input.enabled ?? true
  const maxChars = input.maxChars ?? 6000

  if (!enabled) return { text: "Context collection disabled.", truncated: false }

  const [status, branch, diffStat, changedFiles, scripts] = await Promise.all([
    git(input.directory, ["status", "--short"]),
    git(input.directory, ["branch", "--show-current"]),
    git(input.directory, ["diff", "--stat"]),
    git(input.directory, ["diff", "--name-only", "HEAD"]),
    packageScripts(input.directory),
  ])

  return truncate(
    redact(
      [
        "Magi context pack:",
        section("Git branch", branch.code === 0 ? branch.stdout.trim() || "(detached or unnamed)" : "unavailable"),
        section("Git status", status.code === 0 ? status.stdout.trim() || "clean" : "unavailable"),
        section("Changed files", changedFiles.code === 0 ? changedFiles.stdout.trim() || "none" : "unavailable"),
        section("Diff stat", diffStat.code === 0 ? diffStat.stdout.trim() || "none" : "unavailable"),
        section("Package scripts", scripts || "none"),
      ].join("\n"),
    ),
    maxChars,
  )
}

function section(title: string, body: string) {
  return [`\n${title}:`, body].join("\n")
}

function truncate(text: string, maxChars: number): MagiContextPack {
  if (text.length <= maxChars) return { text, truncated: false }
  return {
    text: `${text.slice(0, Math.max(0, maxChars - 38)).trimEnd()}\n[context truncated by Magi runtime]`,
    truncated: true,
  }
}

async function git(directory: string, args: string[]): Promise<CommandResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return { code, stdout }
}

async function packageScripts(directory: string) {
  const file = Bun.file(`${directory}/package.json`)
  if (!(await file.exists())) return ""
  const pkg = (await file.json()) as { scripts?: Record<string, string> }
  return Object.entries(pkg.scripts ?? {})
    .map(([name, command]) => `${name}: ${command}`)
    .join("\n")
}

export function redact(input: string) {
  return input
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[REDACTED_GOOGLE_API_KEY]")
    .replace(/\bsk-[0-9A-Za-z_-]{20,}\b/g, "[REDACTED_OPENAI_API_KEY]")
    .replace(/\b[A-Za-z0-9_-]*(?:api[_-]?key|token|secret)[A-Za-z0-9_:= -]{8,}/gi, "[REDACTED_SECRET]")
}
