export const members = ["melchior", "balthasar", "casper"] as const
export type Member = (typeof members)[number]
export const executors = ["sisyphus", "hephaestus", "prometheus", "atlas"] as const
export type Executor = (typeof executors)[number]
export type Phase =
  | "planning"
  | "opening"
  | "voting"
  | "executing"
  | "verifying"
  | "retry_wait"
  | "dependency_wait"
  | "scheduled_review"
  | "stopped"
export type Vote = {
  position: "approve" | "reject" | "revise"
  summary: string
  rationale: string
  evidence: string[]
  risk?: { kind: "security" | "data_loss"; evidence: string; mitigation: string }
}
export type Proposal = {
  action: "work" | "wait"
  title: string
  instruction: string
  rationale: string
  executor: Executor
  acceptance: string[]
  reviewAfterSeconds?: number
}
export type Check = { name: string; passed: boolean; output: string; exitCode: number | null }
export type State = {
  schema: 1
  revision: number
  desiredState: "running" | "stopped"
  phase: Phase
  generation: string
  goal: string
  owner?: string
  model?: string
  cycle: number
  round: number
  topic: string
  proposal?: Proposal
  opening: Partial<Record<Member, Vote>>
  votes: Partial<Record<Member, Vote>>
  decision?: "approved" | "revise"
  guidance: { id: string; text: string; time: number }[]
  progress: { time: number; cycle: number; summary: string; checks: Check[] }[]
  failures: number
  retryAt?: number
  resumePhase?: Phase
  error?: string
  presentationError?: string
  heartbeatAt: number
  updatedAt: number
  reporting: {
    intervalMs: number
    nextAt?: number
    lastAt?: number
    manual: boolean
    deliveryError?: string
    fileError?: string
  }
}
export type Job = {
  id: string
  generation: string
  cycle: number
  round: number
  kind: "proposal" | "opening" | "vote" | "execution"
  member?: Member
  agent: string
  model?: string
  attempt: number
  session?: string
  message: string
  prompt: string
  startedAt: number
  status: "prepared" | "running" | "done" | "failed"
  result?: string
  error?: string
  activity?: string
  activityAt?: number
}
export type Report = {
  id: string
  time: number
  text: string
  delivered: boolean
  owner?: string
  generation?: string
  manual?: boolean
  projected?: boolean
  superseded?: boolean
}
export type Snapshot = {
  busy: boolean
  answered: boolean
  text: string
  evidence: string
  activity: string
  error?: string
  waiting?: boolean
  settleMs?: number
}
export type Host = {
  create(title: string, parent?: string): Promise<string>
  find(title: string): Promise<string | undefined>
  hasMessage(session: string, message: string): Promise<boolean>
  send(job: Job): Promise<void>
  inspect(job: Job): Promise<Snapshot>
  abort(session: string): Promise<void>
  agents(): Promise<{ name: string; mode?: string; model?: string }[]>
  report(owner: string, report: Report): Promise<void>
}
