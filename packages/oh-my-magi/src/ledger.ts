import path from "node:path"
import { safeReadFile, safeWriteFile } from "./fs"
import type { MagiCouncilMember, MagiDebateRound, MagiPosition } from "./council"
import type { MagiTelemetry } from "./state"
import { appendReport, serializeReport } from "./reporting"

export function magiCouncilLedgerPath(directory: string) {
  return path.join(directory, ".magi", "COUNCIL.md")
}

export type DeliberationRecordInput = {
  runID?: string
  cycle: number
  goal: string
  milestoneTitle?: string
  milestoneId?: number
  proposer: MagiCouncilMember
  proposalTitle: string
  proposalRationale: string
  rounds: MagiDebateRound[]
  finalPosition: MagiPosition
  directivePrompt: string
  userSteering?: string
}

export type CycleOutcomeRecordInput = {
  runID?: string
  milestoneId?: number
  cycle: number
  verificationPassed: boolean
  verificationSummary: string
  judgeApproved: boolean
  judgeCritique: string
  milestoneCompleted?: boolean
  milestoneTitle?: string
  telemetry?: MagiTelemetry
}

/**
 * Ensures the .magi/COUNCIL.md ledger exists with an executive header.
 */
export async function initializeCouncilLedger(directory: string, goal: string): Promise<string> {
  return serializeReport(directory, async () => {
    const file = magiCouncilLedgerPath(directory)
    if (await Bun.file(file).exists()) return file

    const header = [
      "# 🏛️ MAGI SUPREME COUNCIL: Deliberation Ledger & Minutes",
      "",
      "> **Master Goal**: " + goal,
      "> **Governance**: Melchior (Architecture) • Balthasar (Risk Veto) • Casper (Pragmatic Value)",
      "> **Workforce Engine**: oh-my-openagent (OmO Sisyphus & Specialists)",
      "> **Live status**: [STATUS.md](STATUS.md) · [Monitor page](index.html)",
      "",
      "This document permanently records every council deliberation, debate transcript, safety veto audit, and milestone execution outcome.",
      "Monitor this ledger and guide Magi by talking normally in the OpenCode session running the goal. No steering command is required.",
      "",
      "---",
      "",
    ].join("\n")

    await safeWriteFile(file, header)
    return file
  })
}

/**
 * Appends a new deliberation record to .magi/COUNCIL.md.
 */
export async function recordCouncilDeliberation(directory: string, input: DeliberationRecordInput): Promise<void> {
  const file = magiCouncilLedgerPath(directory)
  await initializeCouncilLedger(directory, input.goal)

  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC"
  const statusEmoji =
    input.finalPosition === "approve"
      ? "✅ APPROVED"
      : input.finalPosition === "reject"
        ? "🛑 REJECTED / VETOED"
        : "⚠️ REVISION REQUIRED"

  const lines: string[] = [
    `## Cycle #${input.cycle}: ${input.proposalTitle}`,
    `* **Run**: ${input.runID ?? "legacy"}`,
    `* **Goal**: ${input.goal}`,
    `* **Timestamp**: \`${timestamp}\``,
    `* **Target Milestone**: ${input.milestoneTitle ? `Milestone #${input.milestoneId ?? "?"}: ${input.milestoneTitle}` : "(Continuous Goal Increment)"}`,
    `* **Proposal Owner**: \`${input.proposer.toUpperCase()}\``,
    `* **Council Decision**: **${statusEmoji}** (${input.finalPosition.toUpperCase()})`,
    "",
  ]

  if (input.userSteering) {
    lines.push("> 👤 **USER INTERVENTION / STEERING APPLIED**:", "> " + input.userSteering, "")
  }

  lines.push(
    "### 1. Proposal Draft",
    `* **Directive Title**: ${input.proposalTitle}`,
    `* **Rationale**: ${input.proposalRationale}`,
    "",
    "### 2. Tripartite Council Debate",
  )

  for (const round of input.rounds) {
    if (input.rounds.length > 1) {
      lines.push(`#### Debate Round ${round.round}`)
    }
    for (const decision of round.decisions) {
      const memberName = decision.member.toUpperCase()
      const roleDescription =
        decision.member === "melchior"
          ? "Architecture & Modularity"
          : decision.member === "balthasar"
            ? "Risk & Safety Veto"
            : "Product Value & User Intent"

      const posBadge =
        decision.position === "approve" ? "🟢 APPROVE" : decision.position === "reject" ? "🔴 REJECT" : "🟡 REVISE"

      lines.push(
        `* **${memberName}** (*${roleDescription}*) — ${posBadge} (Confidence: ${decision.confidence ?? 0.8}):`,
        `  * ${decision.rationale}`,
      )
      if (decision.requiredChange) {
        lines.push(`  * *Required Amendment*: \`${decision.requiredChange}\``)
      }
      if (decision.safetyCritical) {
        lines.push(`  * ⚠️ *Safety-Critical Flag Activated*`)
      }
    }
    lines.push("")
  }

  lines.push(
    input.finalPosition === "approve"
      ? "### 3. Authorized workforce directive"
      : "### 3. Withheld proposal (NOT authorized for execution)",
    "``````text",
    input.directivePrompt.trim(),
    "``````",
    "",
    input.finalPosition === "approve"
      ? `*(Cycle #${input.cycle} awaits execution and verification; outcomes are appended below.)*`
      : "*(Council will reconsider. No execution authorized.)*",
    "",
    "---",
    "",
  )

  await appendReport(directory, "COUNCIL.md", lines.join("\n"))
}

/**
 * Appends the execution and verification outcome to the current cycle in .magi/COUNCIL.md.
 */
export async function recordCycleOutcome(directory: string, input: CycleOutcomeRecordInput): Promise<void> {
  const outcomeEmoji =
    input.verificationPassed && input.judgeApproved ? "✅ VERIFIED & PASSED" : "❌ FAILED / REPAIR REQUIRED"

  const outcomeLines = [
    `## Cycle #${input.cycle} · Workforce Execution & Verification Outcome`,
    `* **Run**: ${input.runID ?? "legacy"} · ${new Date().toISOString()}`,
    `* **Overall Outcome**: **${outcomeEmoji}**`,
    input.telemetry
      ? `* **Telemetry**: ${input.telemetry.toolCallCount} tool operations performed (Files modified: ${input.telemetry.modifiedFiles.length > 0 ? input.telemetry.modifiedFiles.map((f) => `\`${f}\``).join(", ") : "none"})`
      : undefined,
    `* **Mechanical Verification Checks**: ${input.verificationPassed ? "✅ All checks passed" : "❌ Checks failed"}`,
    `  * *Details*: ${input.verificationSummary}`,
    `* **Independent Judge Verdict**: ${input.judgeApproved ? "Approved" : "Concerns raised"}`,
    `  * *Critique*: ${input.judgeCritique}`,
    input.milestoneCompleted
      ? `* 🏆 **Milestone Status**: Milestone #${input.milestoneId ?? input.cycle} (${input.milestoneTitle ?? "Current"}) marked **COMPLETED & VERIFIED**.`
      : `* 🔄 **Continuation**: Milestone requires follow-up increment or repair.`,
  ]
    .filter((l): l is string => l !== undefined)
    .join("\n")

  await appendReport(directory, "COUNCIL.md", "\n" + outcomeLines + "\n\n---\n\n")
}
