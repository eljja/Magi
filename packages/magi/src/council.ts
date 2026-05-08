export const MagiCouncilMembers = ["melchior", "balthasar", "casper"] as const

export type MagiCouncilMember = (typeof MagiCouncilMembers)[number]
export type MagiVote = "approve" | "reject" | "abstain"
export type MagiPosition = "approve" | "revise" | "reject"
export type MagiSelfImprovementState = "off" | "on" | "paused"
export type MagiVotePolicy = "majority" | "unanimous"
export type MagiVetoPolicy = "none" | "safety-critical"
export type MagiSelfImprovementMode = "suggest-only" | "suggest-and-execute"
export type MagiCoreSelfEditPolicy = "disabled" | "gated" | "allowed"

export type MagiHostConfig = {
  magi?: {
    models?: {
      executor?: string
      council?: string
      councilFallbacks?: string[]
    }
    council?: {
      members?: string[]
      votePolicy?: MagiVotePolicy
      externalAppeal?: boolean
    }
    debate?: {
      maxRounds?: number
      requireNewEvidence?: boolean
      stagnationLimit?: number
      synthesisAfterEachRound?: boolean
      finalVotePolicy?: MagiVotePolicy
      vetoPolicy?: MagiVetoPolicy
    }
    selfImprovement?: {
      enabled?: boolean
      state?: MagiSelfImprovementState
      mode?: MagiSelfImprovementMode
      coreSelfEdit?: MagiCoreSelfEditPolicy
      intervalMinutes?: number
    }
  }
}

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

export type MagiTaskKind = "review" | "self-improvement"

export type MagiImprovementTask = {
  kind: MagiTaskKind
  title: string
  prompt: string
  requiresCoreSelfEdit: boolean
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

export type MagiReviewResult = {
  rounds: MagiDebateRound[]
  finalPosition: MagiPosition
  approved: boolean
}

export const MagiDefault = {
  executorModel: "openai/gpt-5.2",
  councilModel: "lmstudio/qwen/qwen3-coder-local",
  councilFallbackModels: [] as string[],
  votePolicy: "majority" as const,
  debateMaxRounds: 3,
  debateRequireNewEvidence: true,
  debateStagnationLimit: 1,
  debateSynthesisAfterEachRound: true,
  debateVetoPolicy: "safety-critical" as const,
  selfImprovementIntervalMinutes: 30,
  selfImprovementMode: "suggest-and-execute" as const,
  coreSelfEdit: "gated" as const,
}

export const MagiPrompts: Record<MagiCouncilMember, string> = {
  melchior:
    "You are MELCHIOR, the sovereign architect: gold, order, structure, principles, synthesis. Be honest. Judge whether the system becomes more coherent and maintainable. Do not agree without concrete evidence or a better design.",
  balthasar:
    "You are BALTHASAR, the shadow strategist: myrrh, death, cost, preservation. Be honest. Find how a decision fails through hidden assumptions, unsafe autonomy, security risk, data loss, or maintenance cost. Do not concede without new evidence.",
  casper:
    "You are CASPER, the visionary human: frankincense, spirit, desire, meaning. Be honest. Judge user value, product feel, identity, and whether the soul of the idea survives implementation. Do not flatter or agree without purpose.",
}

export function magiConfig(config: MagiHostConfig) {
  const magi = config.magi ?? {}
  return {
    executorModel: magi.models?.executor ?? MagiDefault.executorModel,
    councilModel: magi.models?.council ?? MagiDefault.councilModel,
    councilFallbackModels: magi.models?.councilFallbacks ?? MagiDefault.councilFallbackModels,
    members: normalizeMembers(magi.council?.members),
    votePolicy: magi.council?.votePolicy ?? MagiDefault.votePolicy,
    externalAppeal: magi.council?.externalAppeal ?? false,
    debate: {
      maxRounds: positiveInt(magi.debate?.maxRounds, MagiDefault.debateMaxRounds),
      requireNewEvidence: magi.debate?.requireNewEvidence ?? MagiDefault.debateRequireNewEvidence,
      stagnationLimit: nonNegativeInt(magi.debate?.stagnationLimit, MagiDefault.debateStagnationLimit),
      synthesisAfterEachRound: magi.debate?.synthesisAfterEachRound ?? MagiDefault.debateSynthesisAfterEachRound,
      finalVotePolicy: magi.debate?.finalVotePolicy ?? magi.council?.votePolicy ?? MagiDefault.votePolicy,
      vetoPolicy: magi.debate?.vetoPolicy ?? MagiDefault.debateVetoPolicy,
    },
    selfImprovement: {
      enabled: selfImprovementEnabled(config),
      state: selfImprovementState(config),
      mode: magi.selfImprovement?.mode ?? MagiDefault.selfImprovementMode,
      coreSelfEdit: magi.selfImprovement?.coreSelfEdit ?? MagiDefault.coreSelfEdit,
      intervalMinutes: positiveInt(
        magi.selfImprovement?.intervalMinutes,
        MagiDefault.selfImprovementIntervalMinutes,
      ),
    },
  }
}

function positiveInt(value: number | undefined, fallback: number) {
  return Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback
}

function nonNegativeInt(value: number | undefined, fallback: number) {
  return Number.isInteger(value) && value !== undefined && value >= 0 ? value : fallback
}

export function normalizeMembers(input: string[] | undefined): MagiCouncilMember[] {
  const allowed = new Set<string>(MagiCouncilMembers)
  const members = (input ?? MagiCouncilMembers).filter((member): member is MagiCouncilMember => allowed.has(member))
  return members.length > 0 ? members : [...MagiCouncilMembers]
}

export function selfImprovementState(config: MagiHostConfig): MagiSelfImprovementState {
  const self = config.magi?.selfImprovement
  if (self?.state) return self.state
  return self?.enabled ? "on" : "off"
}

export function selfImprovementEnabled(config: MagiHostConfig) {
  return selfImprovementState(config) === "on"
}

export function shouldCreateImprovementTask(config: MagiHostConfig) {
  const self = magiConfig(config).selfImprovement
  return self.enabled && self.state === "on"
}

export function canExecuteImprovementTask(config: MagiHostConfig, task: MagiImprovementTask) {
  const self = magiConfig(config).selfImprovement
  if (!self.enabled) return false
  if (!task.requiresCoreSelfEdit) return self.mode === "suggest-and-execute"
  return self.mode === "suggest-and-execute" && self.coreSelfEdit !== "disabled"
}

export function majorityApproved(decisions: MagiDecision[], policy: MagiVotePolicy = MagiDefault.votePolicy) {
  return majorityPosition(decisions, policy) === "approve"
}

export function majorityPosition(
  decisions: MagiDecision[],
  policy: MagiVotePolicy = MagiDefault.votePolicy,
): MagiPosition {
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

export function shouldContinueDebate(input: { config: MagiHostConfig; rounds: MagiDebateRound[] }) {
  const debate = magiConfig(input.config).debate
  if (input.rounds.length === 0) return true
  if (input.rounds.length >= debate.maxRounds) return false
  if (!debate.requireNewEvidence) return true

  let stagnant = 0
  for (let i = input.rounds.length - 1; i >= 0; i--) {
    if (input.rounds[i]?.newEvidence) break
    stagnant++
  }
  return stagnant < debate.stagnationLimit
}

export function finalDebatePosition(input: { config: MagiHostConfig; rounds: MagiDebateRound[] }) {
  const last = input.rounds.at(-1)
  if (!last) return "revise" satisfies MagiPosition
  if (magiConfig(input.config).debate.vetoPolicy === "safety-critical") {
    if (last.decisions.some((decision) => decision.safetyCritical && decision.vote === "reject")) return "reject"
  }
  return majorityPosition(last.decisions, magiConfig(input.config).debate.finalVotePolicy)
}

export function buildCouncilPrompt(input: { kind: MagiTaskKind; proposal: string; evidence?: string }) {
  const evidence = input.evidence?.trim()
  return [
    `Magi council task: ${input.kind}`,
    "",
    "Proposal:",
    input.proposal.trim(),
    evidence ? "" : undefined,
    evidence ? "Evidence:" : undefined,
    evidence,
    "",
    "Respond with one position: approve, revise, or reject. Include a short rationale and any required changes.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
}

export function buildDebateRoundPrompt(input: {
  kind: MagiTaskKind
  proposal: string
  evidence?: string
  member: MagiCouncilMember
  round: number
  previousRounds?: MagiDebateRound[]
}) {
  const previous = input.previousRounds?.length
    ? [
        "Previous debate rounds:",
        ...input.previousRounds.map((round) =>
          [
            `Round ${round.round}${round.synthesis ? ` synthesis: ${round.synthesis}` : ""}`,
            ...round.decisions.map((decision) =>
              [
                `${decision.member}: ${decision.position ?? voteToPosition(decision.vote)} (${decision.confidence ?? 0})`,
                decision.rationale,
                decision.requiredChange ? `Required change: ${decision.requiredChange}` : undefined,
              ]
                .filter((line): line is string => line !== undefined)
                .join(" - "),
            ),
          ].join("\n"),
        ),
      ].join("\n")
    : undefined

  return [
    MagiPrompts[input.member],
    "",
    buildCouncilPrompt({
      kind: input.kind,
      proposal: input.proposal,
      evidence: input.evidence,
    }),
    previous ? "" : undefined,
    previous,
    "",
    "Debate rules:",
    "- Do not agree just to be agreeable.",
    "- If your position changes, name the new evidence that changed it.",
    "- If there is no new evidence, say so directly.",
    "- Mark safetyCritical true only for security, data loss, destructive autonomy, or rollback-blocking risk.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
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

export function normalizeJudgment(member: MagiCouncilMember, input: unknown): MagiDecision {
  return decisionFromJudgment(member, normalizeCouncilJudgment(input))
}

export function normalizeCouncilJudgment(input: unknown): MagiCouncilJudgment {
  const item = isRecord(input) ? input : {}
  const position = parsePosition(item.position)
  return {
    position,
    rationale: typeof item.rationale === "string" && item.rationale.trim() ? item.rationale.trim() : "No rationale.",
    confidence: clampNumber(item.confidence, 0, 1, 0.5),
    evidence: Array.isArray(item.evidence)
      ? item.evidence.filter((value): value is string => typeof value === "string" && value.trim() !== "")
      : [],
    requiredChange:
      typeof item.requiredChange === "string" && item.requiredChange.trim() ? item.requiredChange.trim() : undefined,
    newEvidence: typeof item.newEvidence === "boolean" ? item.newEvidence : false,
    safetyCritical: typeof item.safetyCritical === "boolean" ? item.safetyCritical : position === "reject",
  }
}

export function magiReviewResult(input: { config: MagiHostConfig; rounds: MagiDebateRound[] }): MagiReviewResult {
  const finalPosition = finalDebatePosition(input)
  return {
    rounds: input.rounds,
    finalPosition,
    approved: finalPosition === "approve",
  }
}

export function positionToVote(position: MagiPosition): MagiVote {
  if (position === "approve") return "approve"
  if (position === "reject") return "reject"
  return "abstain"
}

function voteToPosition(vote: MagiVote): MagiPosition {
  if (vote === "approve") return "approve"
  if (vote === "reject") return "reject"
  return "revise"
}

function parsePosition(input: unknown): MagiPosition {
  if (input === "approve" || input === "revise" || input === "reject") return input
  if (input === "accept") return "approve"
  if (input === "abstain") return "revise"
  return "revise"
}

function clampNumber(input: unknown, min: number, max: number, fallback: number) {
  if (typeof input !== "number" || !Number.isFinite(input)) return fallback
  return Math.min(max, Math.max(min, input))
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

export function buildSelfImprovementQuestion(input: { recentWork: string; constraints?: string }) {
  return buildCouncilPrompt({
    kind: "self-improvement",
    proposal: [
      "Identify the next self-improvement task Magi should perform.",
      "Prefer prompt/config/workflow improvements before core code self-editing.",
      input.constraints ? `Constraints: ${input.constraints}` : undefined,
      "",
      "Recent work:",
      input.recentWork.trim(),
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n"),
  })
}
