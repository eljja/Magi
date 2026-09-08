import path from "node:path"
import { safeReadFile, safeWriteFile } from "./fs"
import type { MagiCouncilMember, MagiDebateRound, MagiPosition } from "./council"
import type { MagiTelemetry } from "./state"

export function magiCouncilLedgerPath(directory: string) {
  return path.join(directory, ".magi", "COUNCIL.md")
}

export type DeliberationRecordInput = {
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
  const file = magiCouncilLedgerPath(directory)
  const existing = await safeReadFile(file)
  if (existing && existing.includes("# 🏛️ MAGI SUPREME COUNCIL: Deliberation Ledger")) {
    return file
  }

  const header = [
    "# 🏛️ MAGI SUPREME COUNCIL: Deliberation Ledger & Minutes",
    "",
    "> **Master Goal**: " + goal,
    "> **Governance**: Melchior (Architecture) • Balthasar (Risk Veto) • Casper (Pragmatic Value)",
    "> **Workforce Engine**: oh-my-openagent (OmO Sisyphus & Specialists)",
    "> **Status**: Active Autonomous Development",
    "",
    "This document permanently records every council deliberation, debate transcript, safety veto audit, and milestone execution outcome.",
    "Users can monitor this ledger in real-time and intervene at any time using `/magi steer <directive>`.",
    "",
    "---",
    "",
  ].join("\n")

  await safeWriteFile(file, header)
  return file
}

/**
 * Appends a new deliberation record to .magi/COUNCIL.md.
 */
export async function recordCouncilDeliberation(directory: string, input: DeliberationRecordInput): Promise<void> {
  const file = magiCouncilLedgerPath(directory)
  await initializeCouncilLedger(directory, input.goal)

  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC"
  const statusEmoji = input.finalPosition === "approve" ? "✅ APPROVED" : input.finalPosition === "reject" ? "🛑 REJECTED / VETOED" : "⚠️ REVISION REQUIRED"

  const lines: string[] = [
    `## Cycle #${input.cycle}: ${input.proposalTitle}`,
    `* **Timestamp**: \`${timestamp}\``,
    `* **Target Milestone**: ${input.milestoneTitle ? `Milestone #${input.milestoneId ?? "?"}: ${input.milestoneTitle}` : "(Continuous Goal Increment)"}`,
    `* **Proposal Owner**: \`${input.proposer.toUpperCase()}\``,
    `* **Council Decision**: **${statusEmoji}** (${input.finalPosition.toUpperCase()})`,
    "",
  ]

  if (input.userSteering) {
    lines.push(
      "> 👤 **USER INTERVENTION / STEERING APPLIED**:",
      "> " + input.userSteering,
      "",
    )
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
        decision.position === "approve"
          ? "🟢 APPROVE"
          : decision.position === "reject"
            ? "🔴 REJECT"
            : "🟡 REVISE"

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
    "### 3. Executive Directive Issued to Sisyphus",
    "```text",
    input.directivePrompt.trim(),
    "```",
    "",
    "*(Awaiting workforce execution and mechanical verification...)*",
    "",
    "---",
    "",
  )

  const current = (await safeReadFile(file)) ?? ""
  await safeWriteFile(file, current + lines.join("\n"))
}

/**
 * Appends the execution and verification outcome to the current cycle in .magi/COUNCIL.md.
 */
export async function recordCycleOutcome(directory: string, input: CycleOutcomeRecordInput): Promise<void> {
  const file = magiCouncilLedgerPath(directory)
  const current = await safeReadFile(file)
  if (!current) return

  const marker = "*(Awaiting workforce execution and mechanical verification...)*"
  const outcomeEmoji = input.verificationPassed && input.judgeApproved ? "✅ VERIFIED & PASSED" : "❌ FAILED / REPAIR REQUIRED"

  const outcomeLines = [
    "### 4. Workforce Execution & Verification Outcome",
    `* **Overall Outcome**: **${outcomeEmoji}**`,
    input.telemetry
      ? `* **Telemetry**: ${input.telemetry.toolCallCount} tool operations performed (Files modified: ${input.telemetry.modifiedFiles.length > 0 ? input.telemetry.modifiedFiles.map((f) => `\`${f}\``).join(", ") : "none"})`
      : undefined,
    `* **Mechanical Verification Checks**: ${input.verificationPassed ? "✅ All checks passed" : "❌ Checks failed"}`,
    `  * *Details*: ${input.verificationSummary}`,
    `* **Independent Judge Verdict**: ${input.judgeApproved ? "Approved" : "Concerns raised"}`,
    `  * *Critique*: ${input.judgeCritique}`,
    input.milestoneCompleted
      ? `* 🏆 **Milestone Status**: Milestone #${input.cycle} (${input.milestoneTitle ?? "Current"}) marked **COMPLETED & VERIFIED**.`
      : `* 🔄 **Continuation**: Milestone requires follow-up increment or repair.`,
  ]
    .filter((l): l is string => l !== undefined)
    .join("\n")

  if (current.includes(marker)) {
    const updated = current.replace(marker, outcomeLines)
    await safeWriteFile(file, updated)
  } else {
    await safeWriteFile(file, current + "\n" + outcomeLines + "\n\n---\n\n")
  }
}
