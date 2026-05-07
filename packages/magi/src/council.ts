export const MagiCouncilMembers = ["melchior", "balthasar", "casper"] as const

export type MagiCouncilMember = (typeof MagiCouncilMembers)[number]
export type MagiVote = "approve" | "reject" | "abstain"
export type MagiSelfImprovementState = "off" | "on" | "paused"
export type MagiVotePolicy = "majority" | "unanimous"
export type MagiSelfImprovementMode = "suggest-only" | "suggest-and-execute"
export type MagiCoreSelfEditPolicy = "disabled" | "gated" | "allowed"

export type MagiHostConfig = {
  magi?: {
    models?: {
      executor?: string
      council?: string
    }
    council?: {
      members?: string[]
      votePolicy?: MagiVotePolicy
      externalAppeal?: boolean
    }
    selfImprovement?: {
      enabled?: boolean
      state?: MagiSelfImprovementState
      mode?: MagiSelfImprovementMode
      coreSelfEdit?: MagiCoreSelfEditPolicy
    }
  }
}

export type MagiDecision = {
  member: MagiCouncilMember
  vote: MagiVote
  rationale: string
}

export type MagiTaskKind = "review" | "self-improvement"

export type MagiImprovementTask = {
  kind: MagiTaskKind
  title: string
  prompt: string
  requiresCoreSelfEdit: boolean
}

export const MagiDefault = {
  executorModel: "openai/gpt-5.2",
  councilModel: "lmstudio/qwen/qwen3-coder-local",
  votePolicy: "majority" as const,
  selfImprovementMode: "suggest-and-execute" as const,
  coreSelfEdit: "gated" as const,
}

export const MagiPrompts: Record<MagiCouncilMember, string> = {
  melchior:
    "You are MELCHIOR, Magi's generative architect. Create synthesis from competing arguments, propose smaller and cleaner designs, and preserve long-term evolvability without drifting into speculative rewrites.",
  balthasar:
    "You are BALTHASAR, Magi's adversarial strategist. Challenge proposals with concrete failure paths, hidden assumptions, abuse cases, and maintenance risks. Do not concede without new evidence.",
  casper:
    "You are CASPER, Magi's empirical judge. Decide by requirements, tests, diffs, logs, security, cost, and rollback evidence. Reject unsupported claims and unsafe changes.",
}

export function magiConfig(config: MagiHostConfig) {
  const magi = config.magi ?? {}
  return {
    executorModel: magi.models?.executor ?? MagiDefault.executorModel,
    councilModel: magi.models?.council ?? MagiDefault.councilModel,
    members: normalizeMembers(magi.council?.members),
    votePolicy: magi.council?.votePolicy ?? MagiDefault.votePolicy,
    externalAppeal: magi.council?.externalAppeal ?? false,
    selfImprovement: {
      enabled: selfImprovementEnabled(config),
      state: selfImprovementState(config),
      mode: magi.selfImprovement?.mode ?? MagiDefault.selfImprovementMode,
      coreSelfEdit: magi.selfImprovement?.coreSelfEdit ?? MagiDefault.coreSelfEdit,
    },
  }
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
  const votes = decisions.filter((decision) => decision.vote !== "abstain")
  if (votes.length === 0) return false
  const approvals = votes.filter((decision) => decision.vote === "approve").length
  if (policy === "unanimous") return approvals === votes.length
  return approvals > votes.length / 2
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
    "Respond with one vote: approve, reject, or abstain. Include a short rationale and any required changes.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
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
