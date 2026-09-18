import { ensureDirectory } from "./fs"
import path from "node:path"
import { optionalGit as git } from "./git"
import type { MagiDebateRound, MagiPosition, MagiProposalDraft } from "./council"

export type MagiSafetyPreparation = {
  runID: string
  reportPath?: string
  baseBranch?: string
  branch?: string
  warnings: string[]
}

export type MagiRunDecisionReport = {
  draft: MagiProposalDraft
  finalPosition: MagiPosition
  injected: boolean
  rounds: MagiDebateRound[]
  selectedPrompt?: string
}

export async function prepareBranchSafety(input: {
  directory: string
  title: string
  prompt: string
  enabled?: boolean
  branchPrefix?: string
  writeRunReport?: boolean
}): Promise<MagiSafetyPreparation> {
  const enabled = input.enabled ?? true
  const prefix = input.branchPrefix ?? "magi/self-improve/"
  const writeReport = input.writeRunReport ?? true

  const runID = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`
  const inside = await git(input.directory, ["rev-parse", "--is-inside-work-tree"])
  const base = inside.code === 0 ? await git(input.directory, ["branch", "--show-current"]) : undefined
  const status = inside.code === 0 ? await git(input.directory, ["status", "--porcelain"]) : undefined
  const clean = status?.code === 0 && status.stdout.trim() === ""

  const branch = enabled && inside.code === 0 && clean ? branchName(prefix, input.title, runID) : undefined
  const switched = branch ? await git(input.directory, ["switch", "-c", branch]) : undefined

  const warnings = [
    inside.code === 0
      ? undefined
      : "Git repository was not detected; branch isolation was skipped. Git is optional: continue in the current folder without installing or initializing it.",
    enabled && inside.code === 0 && !clean
      ? "Working tree is not clean; branch isolation was skipped to avoid moving user work."
      : undefined,
    branch && switched?.code !== 0 ? `Failed to create branch ${branch}: ${switched?.stderr.trim()}` : undefined,
  ].filter((warning): warning is string => warning !== undefined)

  const prepared = {
    runID,
    baseBranch: base?.stdout.trim() || undefined,
    branch: switched?.code === 0 ? branch : undefined,
    warnings,
  }

  const reportPath = writeReport
    ? await writeRunReportFile(input.directory, {
        ...prepared,
        title: input.title,
        prompt: input.prompt,
        createdAt: Date.now(),
      })
    : undefined

  return { ...prepared, reportPath }
}

export function formatSafetyEnvelope(input: { prompt: string; safety?: MagiSafetyPreparation }) {
  if (!input.safety) return input.prompt
  return [
    input.safety.branch
      ? `Magi safety created branch ${input.safety.branch} from ${input.safety.baseBranch ?? "the current HEAD"}.`
      : "Magi safety did not create an isolated branch.",
    input.safety.reportPath ? `Run report: ${input.safety.reportPath}` : undefined,
    input.safety.warnings.length ? `Safety warnings: ${input.safety.warnings.join(" ")}` : undefined,
    input.safety.branch
      ? "Keep all self-improvement work on this branch. Do not commit unless explicitly asked; leave a PR-ready summary with verification."
      : "Work in the current folder, including when it is not a Git repository. Preserve unrelated user files, keep changes focused on the goal, and verify results. Do not require Git, create a repository, commit or publish unless the task specifically calls for it.",
    "",
    input.prompt,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
}

export async function writeRunDecision(input: { safety?: MagiSafetyPreparation; decision: MagiRunDecisionReport }) {
  if (!input.safety?.reportPath) return
  const current = (await Bun.file(input.safety.reportPath).exists())
    ? ((await Bun.file(input.safety.reportPath).json()) as Record<string, unknown>)
    : {}
  await Bun.write(
    input.safety.reportPath,
    `${JSON.stringify(
      {
        ...current,
        decision: {
          ...input.decision,
          decidedAt: Date.now(),
        },
      },
      null,
      2,
    )}\n`,
  )
}

function branchName(prefix: string, title: string, runID: string) {
  return `${prefix}${
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "task"
  }-${runID}`
}

async function writeRunReportFile(directory: string, report: Record<string, unknown>) {
  const file = path.join(directory, ".magi", "runs", String(report.runID), "plan.json")
  await ensureDirectory(path.dirname(file))
  await Bun.write(file, `${JSON.stringify(report, null, 2)}\n`)
  return file
}
