import type { OpencodeClientInstance } from "./bridge"
import type { MagiConfig } from "./config"
import { executeResilientPrompt } from "./resilience"

export type VerificationCheck = {
  name: string
  command: string[]
  passed: boolean
  output: string
  durationMs: number
}

export type VerificationReport = {
  passed: boolean
  checks: VerificationCheck[]
  summary: string
}

export type JudgeVerdict = {
  approved: boolean
  critique: string
  recommendations: string[]
  confidence: number
}

export async function runMechanicalVerification(directory: string): Promise<VerificationReport> {
  const scripts = await detectVerificationCommands(directory)
  const checks: VerificationCheck[] = []

  for (const item of scripts) {
    const start = Date.now()
    const proc = Bun.spawn(item.command, {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const durationMs = Date.now() - start
    const passed = code === 0
    const output = (stdout + "\n" + stderr).trim()

    checks.push({
      name: item.name,
      command: item.command,
      passed,
      output,
      durationMs,
    })

    // If a critical verification step fails, early stop
    if (!passed) break
  }

  const passed = checks.every((c) => c.passed)
  const summary = passed
    ? `All ${checks.length} verification checks passed cleanly.`
    : `Verification failed at check '${checks.find((c) => !c.passed)?.name}'.`

  return {
    passed,
    checks,
    summary,
  }
}

async function detectVerificationCommands(directory: string): Promise<{ name: string; command: string[] }[]> {
  const pkgFile = Bun.file(`${directory}/package.json`)
  if (!(await pkgFile.exists())) return []

  const pkg = (await pkgFile.json().catch(() => ({}))) as Record<string, unknown>
  const scripts = typeof pkg.scripts === "object" && pkg.scripts !== null ? (pkg.scripts as Record<string, string>) : {}

  const commands: { name: string; command: string[] }[] = []

  if (scripts.typecheck) {
    commands.push({ name: "typecheck", command: ["bun", "run", "typecheck"] })
  }
  if (scripts.test) {
    commands.push({ name: "test", command: ["bun", "run", "test"] })
  }
  if (scripts.lint) {
    commands.push({ name: "lint", command: ["bun", "run", "lint"] })
  }

  return commands
}

export async function judgeCycleOutcome(input: {
  directory: string
  client?: OpencodeClientInstance
  config: MagiConfig
  taskTitle: string
  taskPrompt: string
  verificationReport?: VerificationReport
}): Promise<JudgeVerdict> {
  if (!input.client) {
    return {
      approved: input.verificationReport?.passed ?? true,
      critique: "Mechanical verification served as sole evaluation gate (no client instance).",
      recommendations: [],
      confidence: 0.8,
    }
  }

  const system = [
    "You are an impartial judge evaluating whether an autonomous coding cycle successfully accomplished its goal.",
    "Respond in STRICT JSON:",
    JSON.stringify({
      approved: true,
      critique: "Concrete review of whether requirements are met and tests pass",
      recommendations: ["Next steps or fixes if rejected"],
      confidence: 0.9,
    }),
  ].join("\n")

  const prompt = [
    `Task: ${input.taskTitle}`,
    `Directive: ${input.taskPrompt}`,
    input.verificationReport ? `\nMechanical Verification Results:\n${input.verificationReport.summary}` : undefined,
    "",
    "Evaluate if the implementation is verified and complete.",
  ]
    .filter((l): l is string => Boolean(l))
    .join("\n")

  const text = await executeResilientPrompt({
    client: input.client as unknown as Parameters<typeof executeResilientPrompt>[0]["client"],
    system,
    prompt,
    directory: input.directory,
    primaryModel: input.config.roles.council,
    fallbackChain: input.config.resilience.fallbackChain,
    timeoutMs: Math.min(input.config.resilience.timeoutMs, 45000),
    maxRetries: 2,
  })

  const parsed = text ? parseJsonSafe(text) : undefined
  return {
    approved: typeof parsed?.approved === "boolean" ? parsed.approved : (input.verificationReport?.passed ?? true),
    critique: typeof parsed?.critique === "string" ? parsed.critique : "Judge completed evaluation.",
    recommendations: Array.isArray(parsed?.recommendations)
      ? parsed.recommendations.filter((r): r is string => typeof r === "string")
      : [],
    confidence: typeof parsed?.confidence === "number" ? parsed.confidence : 0.8,
  }
}

export const runIndependentJudge = judgeCycleOutcome

function parseJsonSafe(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim()
  try {
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) return JSON.parse(trimmed)
    const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (codeBlockMatch?.[1]) return JSON.parse(codeBlockMatch[1].trim())
    const braceMatch = trimmed.match(/\{[\s\S]*\}/)
    if (braceMatch) return JSON.parse(braceMatch[0])
    return undefined
  } catch {
    return undefined
  }
}
