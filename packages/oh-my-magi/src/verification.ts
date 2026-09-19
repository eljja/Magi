import path from "node:path"
import { realpath } from "node:fs/promises"
import type { OpencodeClientInstance } from "./bridge"
import { loadMagiConfig, type MagiConfig } from "./config"
import { collectMagiContext, redact } from "./context"
import { terminateProcessTree } from "./process"
import { archiveCouncilReply } from "./review"
import { deliberateProposal } from "./bridge"
import { decisionFromJudgment, finalDebatePosition } from "./council"
import { collectArtifactEvidence } from "./artifacts"
import { mutateMagiState, readMagiState } from "./state"

export type VerificationCheck = { name: string; command: string[]; passed: boolean; output: string; durationMs: number }
export type VerificationReport = { passed: boolean; checks: VerificationCheck[]; summary: string }
export type JudgeVerdict = { approved: boolean; critique: string; recommendations: string[]; confidence: number }

export async function runMechanicalVerification(directory: string): Promise<VerificationReport> {
  const config = await loadMagiConfig(directory)
  const commands = config.verification.commands.length
    ? config.verification.commands
    : await detectVerificationCommands(directory)
  const checks: VerificationCheck[] = []
  for (const item of commands) {
    const cwd = await realpath(path.resolve(directory, item.cwd ?? "."))
    const relative = path.relative(await realpath(directory), cwd)
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Verification cwd must stay inside the project")
    if (!Array.isArray(item.command) || !item.command.length || item.command.some((arg) => typeof arg !== "string"))
      throw new Error("Verification command must be a nonempty array of strings")
    const started = Date.now()
    const proc = Bun.spawn(item.command, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      detached: process.platform !== "win32",
    })
    const deadline = new AbortController()
    const cleanup: { task?: Promise<void> } = {}
    const timer = setTimeout(() => {
      deadline.abort()
      cleanup.task = terminateProcessTree(proc)
    }, config.verification.timeoutMs)
    try {
      const [stdout, stderr, code] = await Promise.all([
        readOutput(proc.stdout, deadline.signal),
        readOutput(proc.stderr, deadline.signal),
        proc.exited,
      ])
      checks.push({
        name: item.name,
        command: item.command,
        passed: code === 0 && !deadline.signal.aborted,
        output: redact(
          stdout +
            "\n" +
            stderr +
            (deadline.signal.aborted ? "\nVerification timed out; process tree termination requested." : ""),
        ),
        durationMs: Date.now() - started,
      })
    } finally {
      clearTimeout(timer)
      await cleanup.task
    }
    if (!checks.at(-1)?.passed) break
  }
  const passed = checks.length > 0 && checks.every((check) => check.passed)
  return {
    passed,
    checks,
    summary: !checks.length
      ? "No verification commands configured; completion is unverified. Configure verification.commands in .magi/config.jsonc."
      : passed
        ? "All " + checks.length + " verification checks passed cleanly."
        : "Verification failed at check '" + checks.find((check) => !check.passed)?.name + "'.",
  }
}

async function readOutput(stream: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ""
  const cancel = () => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener("abort", cancel, { once: true })
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      text = (text + decoder.decode(result.value, { stream: true })).slice(-16000)
    }
    return text
  } finally {
    signal.removeEventListener("abort", cancel)
    reader.releaseLock()
  }
}

export async function detectVerificationCommands(
  directory: string,
): Promise<{ name: string; command: string[]; cwd?: string }[]> {
  const file = Bun.file(path.join(directory, "package.json"))
  if (!(await file.exists())) return []
  const pkg = await file.json()
  // Monorepos can explicitly forbid running tests from the root.
  if (pkg.workspaces) return []
  return ["typecheck", "test", "lint"]
    .filter((name) => typeof pkg.scripts?.[name] === "string")
    .map((name) => ({ name, command: ["bun", "run", name] }))
}

export async function validateVerificationSetup(directory: string) {
  const config = await loadMagiConfig(directory)
  const commands = config.verification.commands.length
    ? config.verification.commands
    : await detectVerificationCommands(directory)
  // An empty folder can start. The first approved task establishes meaningful
  // checks; missing checks still never count as verified completion.
  for (const item of commands) {
    if (!Array.isArray(item.command) || !item.command.length || item.command.some((arg) => typeof arg !== "string"))
      throw new Error("Magi configuration required: verification commands must be nonempty arrays of strings")
    const relative = path.relative(await realpath(directory), await realpath(path.resolve(directory, item.cwd ?? ".")))
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Verification cwd must stay inside the project")
  }
  return commands.length > 0
}

export async function judgeCycleOutcome(input: {
  directory: string
  client?: OpencodeClientInstance
  config: MagiConfig
  taskTitle: string
  taskPrompt: string
  executionReport?: string
  verificationReport?: VerificationReport
  toolEvidence?: string
  artifactPaths?: string[]
  runID?: string
}): Promise<JudgeVerdict> {
  const rejected = {
    approved: false,
    critique: "Independent review unavailable or invalid; completion is unverified.",
    recommendations: [],
    confidence: 0,
  }
  if (!input.verificationReport?.passed)
    return {
      ...rejected,
      critique: "Mechanical checks failed or are missing. Repair the recorded failures before independent approval.",
    }
  if (!input.client || !input.executionReport?.trim()) return rejected
  const context = await collectMagiContext({ directory: input.directory })
  const artifacts = await collectArtifactEvidence(input.directory, input.artifactPaths ?? [])
  const evidence = redact(
    [
      "Milestone: " + input.taskTitle,
      "Goal and requirements: " + input.taskPrompt,
      "Executor report (claims to verify):\n" + input.executionReport.slice(-16000),
      "Mechanical verification:\n" +
        JSON.stringify({
          ...input.verificationReport,
          checks: input.verificationReport.checks.map(({ durationMs, ...check }) => check),
        }).slice(-24000),
      "Actual completed OpenCode tool operations:\n" + (input.toolEvidence || "No tool evidence supplied"),
      "Fresh runtime file snapshots (hashes cover the full file; excerpts may be truncated):\n" +
        JSON.stringify(artifacts),
      context.text,
    ].join("\n\n"),
  )
  const state = input.runID ? await readMagiState(input.directory) : undefined
  const key = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify([evidence, input.config.council, input.config.roles.council]))
    .digest("hex")
  const saved = state?.pendingVerification?.review?.key === key ? state.pendingVerification.review : undefined
  if (input.runID)
    await mutateMagiState(input.directory, (current) =>
      current.runID === input.runID && current.pendingVerification
        ? {
            ...current,
            pendingVerification: {
              ...current.pendingVerification,
              review: saved ?? { key, cycle: current.currentCycle },
            },
          }
        : current,
    )
  const votes = await deliberateProposal({
    bridge: { client: input.client, directory: input.directory, config: input.config, runID: input.runID },
    proposer: "melchior",
    draft: {
      proposer: "melchior",
      title: input.taskTitle,
      prompt: input.taskPrompt,
      rationale: "Verify actual results",
      terminal: false,
    },
    purpose: "completion",
    saved,
    roundPromptBuilder: () =>
      [
        "Independent completion review. The workforce's work is finished for this increment; it has not been accepted yet.",
        evidence,
        "END OF EVIDENCE. Evaluate the ENTIRE CURRENT MILESTONE, not future milestones or an infinite lifetime of improvements. The master goal supplies constraints; do not invent new exit criteria.",
        "Use your own perspective and the evidence above. Approve only demonstrated results, never the promise of future work. Missing evidence means revise/reject with the exact missing check or artifact. A useful optional future improvement does not invalidate a satisfied current milestone.",
        "Return position, rationale, confidence, evidence, requiredChange, newEvidence and safetyCritical using StructuredOutput. safetyCritical is only for evidenced security/data-loss/regression risks. The runtime applies the configured majority/unanimity and veto policy after all three final votes.",
      ].join("\n\n"),
    onReply: async (stage, member, judgment) => {
      if (!input.runID) return
      const current = await readMagiState(input.directory)
      if (current.runID !== input.runID || !current.loopActive) return
      await archiveCouncilReply({
        directory: input.directory,
        runID: input.runID,
        cycle: current.currentCycle,
        round: 1,
        member,
        stage: "completion-" + stage,
        reply: judgment,
      })
      await mutateMagiState(input.directory, (latest) =>
        latest.runID === input.runID && latest.pendingVerification?.review?.key === key
          ? {
              ...latest,
              pendingVerification: {
                ...latest.pendingVerification,
                review: {
                  ...latest.pendingVerification.review,
                  [stage]: { ...latest.pendingVerification.review[stage], [member]: judgment },
                },
              },
            }
          : latest,
      )
    },
  })
  if (
    JSON.stringify(artifacts) !==
    JSON.stringify(await collectArtifactEvidence(input.directory, input.artifactPaths ?? []))
  )
    throw new Error("Artifacts changed during council completion review; rerun verification before acceptance")
  const decisions = votes.map((item) => decisionFromJudgment(item.member, item.judgment))
  return {
    approved:
      finalDebatePosition(
        [{ round: 1, decisions, newEvidence: true }],
        input.config.council.vetoPolicy,
        input.config.council.votePolicy,
      ) === "approve",
    critique: decisions
      .map((item) => item.member.toUpperCase() + ": " + item.position + " — " + item.rationale)
      .join("\n"),
    recommendations: [...new Set(decisions.flatMap((item) => (item.requiredChange ? [item.requiredChange] : [])))],
    confidence: Math.min(...votes.map((item) => item.judgment.confidence)),
  }
}

export const runIndependentJudge = judgeCycleOutcome
