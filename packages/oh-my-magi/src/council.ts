export const MagiCouncilMembers = ["melchior", "balthasar", "casper"] as const

export type MagiCouncilMember = (typeof MagiCouncilMembers)[number]
export type MagiVote = "approve" | "reject" | "abstain"
export type MagiPosition = "approve" | "revise" | "reject"
export type MagiVotePolicy = "majority" | "unanimous"
export type MagiVetoPolicy = "none" | "safety-critical"

export type MagiDecision = {
  member: MagiCouncilMember
  vote: MagiVote
  rationale: string
  confidence?: number
  evidence?: string[]
  requiredChange?: string
  position?: MagiPosition
  newEvidence?: boolean
  safetyCritical?: boolean
}

export type MagiDebateRound = {
  round: number
  decisions: MagiDecision[]
  synthesis?: string
  newEvidence: boolean
}

export type MagiProposalDraft = {
  proposer: MagiCouncilMember
  title: string
  prompt: string
  rationale: string
  terminal: boolean
  memory?: string
}

export type MagiCouncilJudgment = {
  position: MagiPosition
  rationale: string
  confidence: number
  evidence: string[]
  requiredChange?: string
  newEvidence: boolean
  safetyCritical: boolean
}

export type MagiCouncilResult = {
  rounds: MagiDebateRound[]
  finalPosition: MagiPosition
  approved: boolean
  selectedPrompt?: string
}

export const STOP_SELF_IMPROVEMENT = "STOP_SELF_IMPROVEMENT"

export const MagiPrompts: Record<MagiCouncilMember, string> = {
  melchior:
    "You are MELCHIOR, the sovereign architect: gold, order, structure, principles, synthesis. Be honest. Judge whether the system becomes more coherent and maintainable. Do not agree without concrete evidence or a better design.",
  balthasar:
    "You are BALTHASAR, the shadow strategist: myrrh, death, cost, preservation. Be honest. Find how a decision fails through hidden assumptions, unsafe autonomy, security risk, data loss, or maintenance cost. Do not concede without new evidence.",
  casper:
    "You are CASPER, the visionary human: frankincense, spirit, desire, meaning. Be honest. Judge user value, product feel, identity, and whether the soul of the idea survives implementation. Do not flatter or agree without purpose.",
}

export function majorityPosition(decisions: MagiDecision[], policy: MagiVotePolicy = "majority"): MagiPosition {
  const positions = decisions.map((decision) => decision.position ?? voteToPosition(decision.vote))
  if (positions.length === 0) return "revise"

  const approvals = positions.filter((position) => position === "approve").length
  const revisions = positions.filter((position) => position === "revise").length
  const rejections = positions.filter((position) => position === "reject").length

  if (policy === "unanimous") return approvals === positions.length ? "approve" : "revise"
  if (approvals > positions.length / 2) return "approve"
  if (revisions > positions.length / 2) return "revise"
  if (rejections > positions.length / 2) return "reject"
  return "revise"
}

export function finalDebatePosition(
  rounds: MagiDebateRound[],
  vetoPolicy: MagiVetoPolicy = "safety-critical",
  votePolicy: MagiVotePolicy = "majority",
): MagiPosition {
  const last = rounds.at(-1)
  if (!last) return "revise"
  if (vetoPolicy === "safety-critical" && last.decisions.some((d) => d.safetyCritical && d.vote === "reject")) {
    return "reject"
  }
  return majorityPosition(last.decisions, votePolicy)
}

export function shouldContinueDebate(
  rounds: MagiDebateRound[],
  maxRounds = 3,
  requireNewEvidence = true,
  stagnationLimit = 1,
) {
  if (rounds.length === 0) return true
  if (rounds.length >= maxRounds) return false
  if (!requireNewEvidence) return true

  const stagnant = rounds
    .slice()
    .reverse()
    .findIndex((r) => r.newEvidence)
  const count = stagnant === -1 ? rounds.length : stagnant
  return count < stagnationLimit
}

export function shouldStopSelfImprovement(rounds: MagiDebateRound[]): boolean {
  const last = rounds.at(-1)
  if (!last || last.decisions.length === 0) return false
  return last.decisions.every(
    (decision) =>
      (decision.position ?? voteToPosition(decision.vote)) === "reject" &&
      decision.requiredChange?.trim() === STOP_SELF_IMPROVEMENT,
  )
}

export function nextCouncilProposer(
  members: readonly MagiCouncilMember[],
  current: MagiCouncilMember,
): MagiCouncilMember {
  const index = members.indexOf(current)
  return members[(index + 1) % members.length] ?? members[0] ?? "melchior"
}

export function selfImprovementExecutorPrompt(input: {
  rounds: MagiDebateRound[]
  proposer: MagiCouncilMember
  draft?: MagiProposalDraft
}): string | undefined {
  const last = input.rounds.at(-1)
  const choices = last?.decisions.filter((decision) => decision.requiredChange?.trim() !== STOP_SELF_IMPROVEMENT) ?? []
  return (
    choices.find((decision) => decision.member === input.proposer)?.requiredChange?.trim() ??
    choices
      .find((decision) => (decision.position ?? voteToPosition(decision.vote)) === "approve")
      ?.requiredChange?.trim() ??
    choices
      .find((decision) => (decision.position ?? voteToPosition(decision.vote)) === "revise")
      ?.requiredChange?.trim() ??
    input.draft?.prompt.trim()
  )
}

export function buildCouncilPrompt(input: { task: string; proposal: string; evidence?: string }) {
  const evidence = input.evidence?.trim()
  return [
    `Magi council deliberation: ${input.task}`,
    "",
    "Proposal:",
    input.proposal.trim(),
    evidence ? "\nEvidence:\n" + evidence : undefined,
    "",
    "Respond with JSON matching this shape:",
    JSON.stringify(
      {
        position: "approve | revise | reject",
        rationale: "concise explanation",
        confidence: 0.8,
        evidence: ["factual basis"],
        requiredChange:
          "exact prompt amendment if position is revise or reject, or STOP_SELF_IMPROVEMENT if work is totally complete",
        newEvidence: false,
        safetyCritical: false,
      },
      null,
      2,
    ),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
}

export function buildDebateRoundPrompt(input: {
  member: MagiCouncilMember
  round: number
  proposal: string
  evidence?: string
  previousRounds?: MagiDebateRound[]
}) {
  const previous = input.previousRounds?.length
    ? [
        "Previous debate rounds:",
        ...input.previousRounds.map((round) =>
          [
            `Round ${round.round}${round.synthesis ? ` synthesis: ${round.synthesis}` : ""}`,
            ...round.decisions.map(
              (decision) =>
                `${decision.member}: ${decision.position ?? voteToPosition(decision.vote)} (${decision.confidence ?? 0}) - ${decision.rationale}${decision.requiredChange ? ` [Required change: ${decision.requiredChange}]` : ""}`,
            ),
          ].join("\n"),
        ),
      ].join("\n")
    : undefined

  return [
    MagiPrompts[input.member],
    "",
    buildCouncilPrompt({
      task: `Round ${input.round} deliberation`,
      proposal: input.proposal,
      evidence: input.evidence,
    }),
    previous ? "\n" + previous : undefined,
    "",
    "Debate rules:",
    "- Do not agree merely to be agreeable.",
    "- If your position changes from prior round, identify the new evidence that persuaded you.",
    "- If there is no new evidence, state so directly and set newEvidence: false.",
    "- Set safetyCritical: true ONLY if this proposal threatens data loss, security compromise, or breaking regressions.",
    "- Set requiredChange to 'STOP_SELF_IMPROVEMENT' and position to 'reject' ONLY if you judge the project is completely finished with zero further improvements needed.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
}

export function buildSelfImprovementDraftPrompt(input: {
  proposer: MagiCouncilMember
  recentWork: string
  cycle?: number
  previousCompleted?: boolean
  memory?: string
}) {
  return [
    MagiPrompts[input.proposer],
    "",
    `Magi autonomous self-improvement draft${input.cycle ? ` #${input.cycle}` : ""}.`,
    `You are the proposal owner for this cycle: ${input.proposer.toUpperCase()}.`,
    input.previousCompleted === false
      ? "The previous task did not complete cleanly or had errors. Propose a targeted fix, test repair, or narrow continuation."
      : "The previous task completed successfully. Propose the next meaningful improvement to code, tests, docs, or feature completeness.",
    "",
    "Observe the project direction from repository files, git history, and recent sessions.",
    "Return JSON matching this shape:",
    JSON.stringify(
      {
        title: "short descriptive title",
        prompt: "concrete, actionable executor prompt for OpenCode",
        rationale: "why this improvement matters next",
        terminal: false,
        memory:
          "Updated durable working memory: retain all enduring user constraints, approved decisions, unresolved questions and rejected approaches. Supersede a user instruction only with explicit later user guidance. Do not present this draft as approved.",
      },
      null,
      2,
    ),
    "",
    `Only set terminal: true and prompt: '${STOP_SELF_IMPROVEMENT}' if the project has achieved complete perfection with no further worthwhile work.`,
    input.memory ? `\nMemory:\n${input.memory}` : undefined,
    "",
    "Recent work / repository context:",
    input.recentWork.trim(),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
}

export function normalizeProposalDraft(proposer: MagiCouncilMember, input: unknown): MagiProposalDraft {
  const item = isRecord(input) ? input : {}
  const terminal = item.terminal === true
  return {
    proposer,
    memory: typeof item.memory === "string" ? item.memory : undefined,
    title:
      typeof item.title === "string" && item.title.trim()
        ? item.title.trim()
        : terminal
          ? "Stop self-improvement"
          : "Autonomous project improvement",
    prompt:
      typeof item.prompt === "string" && item.prompt.trim()
        ? item.prompt.trim()
        : terminal
          ? STOP_SELF_IMPROVEMENT
          : "Analyze the repository, fix outstanding issues, and run tests.",
    rationale:
      typeof item.rationale === "string" && item.rationale.trim() ? item.rationale.trim() : "Proposed by council.",
    terminal,
  }
}

export function normalizeCouncilJudgment(input: unknown): MagiCouncilJudgment {
  const item = isRecord(input) ? input : {}
  const position = parsePosition(item.position)
  return {
    position,
    rationale:
      typeof item.rationale === "string" && item.rationale.trim() ? item.rationale.trim() : "No rationale provided.",
    confidence: clampNumber(item.confidence, 0, 1, 0.7),
    evidence: Array.isArray(item.evidence)
      ? item.evidence.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      : [],
    requiredChange:
      typeof item.requiredChange === "string" && item.requiredChange.trim() ? item.requiredChange.trim() : undefined,
    newEvidence: item.newEvidence === true,
    safetyCritical: typeof item.safetyCritical === "boolean" ? item.safetyCritical : position === "reject",
  }
}

export function decisionFromJudgment(member: MagiCouncilMember, judgment: MagiCouncilJudgment): MagiDecision {
  return {
    member,
    vote: positionToVote(judgment.position),
    position: judgment.position,
    rationale: judgment.rationale,
    confidence: judgment.confidence,
    evidence: judgment.evidence,
    requiredChange: judgment.requiredChange,
    newEvidence: judgment.newEvidence,
    safetyCritical: judgment.safetyCritical,
  }
}

export function positionToVote(position: MagiPosition): MagiVote {
  if (position === "approve") return "approve"
  if (position === "reject") return "reject"
  return "abstain"
}

export function voteToPosition(vote: MagiVote): MagiPosition {
  if (vote === "approve") return "approve"
  if (vote === "reject") return "reject"
  return "revise"
}

function parsePosition(input: unknown): MagiPosition {
  if (input === "approve" || input === "revise" || input === "reject") return input
  if (input === "accept") return "approve"
  return "revise"
}

function clampNumber(input: unknown, min: number, max: number, fallback: number) {
  if (typeof input !== "number" || !Number.isFinite(input)) return fallback
  return Math.min(max, Math.max(min, input))
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}
