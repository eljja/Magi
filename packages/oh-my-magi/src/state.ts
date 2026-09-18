import { ensureDirectory, atomicWriteFile } from "./fs"
import path from "node:path"
import { readFile, readdir, unlink } from "node:fs/promises"
import type {
  MagiCouncilMember,
  MagiPosition,
  MagiDebateRound,
  MagiProposalDraft,
  MagiCouncilJudgment,
} from "./council"
import type { ReviewProgress } from "./resilience"
import type { JudgeVerdict, VerificationReport } from "./verification"

export type PendingCouncilRound = {
  key: string
  proposer: MagiCouncilMember
  requirements: string
  draft?: MagiProposalDraft
  opening?: Partial<Record<MagiCouncilMember, MagiCouncilJudgment>>
  votes?: Partial<Record<MagiCouncilMember, MagiCouncilJudgment>>
}
import { appendReport } from "./reporting"

export type MagiRuntimeEvent = {
  time: number
  type: "status" | "proposal" | "vote" | "decision" | "error" | "continuation" | "observation"
  member?: MagiCouncilMember
  title: string
  text: string
  position?: MagiPosition
}

export type MagiCouncilObservation = {
  time: number
  member: MagiCouncilMember
  perspective: "architecture" | "safety" | "progress"
  observation: string
  tool?: string
  target?: string
}

export type MagiTelemetry = {
  toolCallCount: number
  lastTool?: string
  lastToolArgs?: string
  lastToolOutput?: string
  modifiedFiles: string[]
  lastActiveAt: number
  stallCount: number
}

export type MagiRuntimeState = {
  status: "idle" | "running" | "decided" | "error"
  loopActive: boolean
  currentCycle: number
  maxCycles: number
  topic: string
  updatedAt: number
  events: MagiRuntimeEvent[]
  votes: Partial<Record<MagiCouncilMember, MagiPosition>>
  selectedPrompt?: string
  error?: string
  goal?: string
  model?: string
  sessionID?: string
  runID?: string
  awaitingExecution?: boolean
  executionAfter?: number
  executionSessionID?: string
  executionMilestoneID?: number
  executionRecovery?: string
  pendingVerification?: {
    messageID: string
    executionReport: string
    toolEvidence: string
    report?: VerificationReport
    verdict?: JudgeVerdict
  }
  lastMessageID?: string
  stopReason?: "user" | "completed" | "max_cycles" | "error" | "council"
  telemetry?: MagiTelemetry
  observations?: MagiCouncilObservation[]
  pendingUserSteering?: string
  steeringQueue?: { id: string; time: number; text: string; source?: { sessionID: string; messageID: string } }[]
  ignoredMessageIDs?: string[]
  meeting?: { cycle: number; round: number; rounds: MagiDebateRound[]; pending?: PendingCouncilRound }
  councilActivity?: Record<
    string,
    ReviewProgress & { member?: MagiCouncilMember; startedAt: number; updatedAt: number }
  >
  failureCount?: number
  retryAt?: number
}

export type MagiRuntimeMemory = {
  lastProposer?: MagiCouncilMember
  previousCompleted?: boolean
  cyclesCompleted?: number
  stoppedBy?: "user" | "unanimous_council" | "max_cycles"
  pendingUserSteering?: string
}

export function magiRuntimeDir(directory: string) {
  return path.join(directory, ".magi", "runtime")
}

export function magiStatePath(directory: string) {
  return path.join(magiRuntimeDir(directory), "state.json")
}

export function magiMemoryPath(directory: string) {
  return path.join(magiRuntimeDir(directory), "memory.json")
}

export function emptyMagiState(): MagiRuntimeState {
  return {
    status: "idle",
    loopActive: false,
    currentCycle: 0,
    maxCycles: 0,
    topic: "Select the magi agent and describe one goal to start the council.",
    updatedAt: Date.now(),
    events: [],
    votes: {},
    telemetry: {
      toolCallCount: 0,
      modifiedFiles: [],
      lastActiveAt: Date.now(),
      stallCount: 0,
    },
    observations: [],
  }
}

export async function stopMarkers(directory: string) {
  const folder = path.join(magiRuntimeDir(directory), "stops")
  return (
    await readdir(folder).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []
      throw error
    })
  )
    .filter((name) => /^[0-9a-f-]+\.json$/.test(name))
    .map((name) => path.join(folder, name))
}

export async function persistStop(directory: string) {
  const folder = path.join(magiRuntimeDir(directory), "stops")
  await ensureDirectory(folder)
  await Bun.write(path.join(folder, crypto.randomUUID() + ".json"), JSON.stringify({ time: Date.now() }))
}

export async function acknowledgeStops(markers: string[]) {
  // Remove only markers observed BEFORE starting; a concurrent later stop wins.
  await Promise.all(
    markers.map((file) =>
      unlink(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
      }),
    ),
  )
}

export async function readMagiState(directory: string): Promise<MagiRuntimeState> {
  const state = await readSavedMagiState(directory)
  const markers = await stopMarkers(directory)
  return markers.length
    ? { ...state, loopActive: false, awaitingExecution: false, status: "idle", stopReason: "user" }
    : state
}

async function readSavedMagiState(directory: string): Promise<MagiRuntimeState> {
  const file = magiStatePath(directory)
  const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (text === undefined) return emptyMagiState()
  const content: unknown = await Promise.resolve()
    .then(() => JSON.parse(text))
    .catch(() => undefined)
  if (!content || typeof content !== "object" || Array.isArray(content))
    return {
      ...emptyMagiState(),
      status: "error",
      error: "Saved Magi state is malformed; restore it or resume explicitly from the roadmap.",
    }
  const saved = content as Partial<MagiRuntimeState>
  if (
    (saved.loopActive !== undefined && typeof saved.loopActive !== "boolean") ||
    (saved.events !== undefined && !Array.isArray(saved.events)) ||
    (saved.currentCycle !== undefined && (!Number.isInteger(saved.currentCycle) || saved.currentCycle < 0))
  )
    return {
      ...emptyMagiState(),
      status: "error",
      error: "Saved Magi state has invalid fields; automatic execution was disabled.",
    }
  return { ...emptyMagiState(), ...saved, maxCycles: 0 }
}

export async function writeMagiState(directory: string, state: MagiRuntimeState) {
  return mutateMagiState(directory, () => state)
}

const writes = new Map<string, Promise<unknown>>()

// Serialize read/modify/write and rename atomically so stop cannot be overwritten by a stale cycle.
export async function mutateMagiState(directory: string, change: (state: MagiRuntimeState) => MagiRuntimeState) {
  const key = path.resolve(directory)
  const pending = (writes.get(key) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      await ensureDirectory(magiRuntimeDir(directory))
      const state = { ...change(await readMagiState(directory)), updatedAt: Date.now() }
      await atomicWriteFile(magiStatePath(directory), JSON.stringify(state, null, 2))
      return state
    })
  writes.set(key, pending)
  try {
    return await pending
  } finally {
    if (writes.get(key) === pending) writes.delete(key)
  }
}

export async function updateMagiState(
  directory: string,
  event: MagiRuntimeEvent,
  patch?: Partial<Omit<MagiRuntimeState, "events">>,
  limit = 24,
  runID?: string,
) {
  const state = await mutateMagiState(directory, (current) =>
    runID && current.runID !== runID
      ? current
      : {
          ...current,
          ...patch,
          events: [...current.events, event].slice(-limit),
        },
  )
  if ((!runID || state.runID === runID) && state.events.at(-1)?.time === event.time)
    await appendReport(
      directory,
      "events/" + new Date(event.time).toISOString().slice(0, 10) + ".jsonl",
      JSON.stringify({ runID: state.runID, cycle: state.currentCycle, ...event }) + "\n",
    )
  return state
}

export async function readMagiMemory(directory: string): Promise<MagiRuntimeMemory> {
  const file = magiMemoryPath(directory)
  if (!(await Bun.file(file).exists())) return {}
  return (await Bun.file(file)
    .json()
    .catch(() => ({}))) as MagiRuntimeMemory
}

export async function writeMagiMemory(directory: string, memory: MagiRuntimeMemory) {
  await ensureDirectory(magiRuntimeDir(directory))
  await atomicWriteFile(magiMemoryPath(directory), JSON.stringify(memory, null, 2))
}
