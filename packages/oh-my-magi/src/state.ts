import { ensureDirectory } from "./fs"
import path from "node:path"
import { rename } from "node:fs/promises"
import type { MagiCouncilMember, MagiPosition } from "./council"

export type MagiRuntimeEvent = {
  time: number
  type: "status" | "proposal" | "vote" | "decision" | "error" | "continuation"
  member?: MagiCouncilMember
  title: string
  text: string
  position?: MagiPosition
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
  sessionID?: string
  runID?: string
  awaitingExecution?: boolean
  executionAfter?: number
  lastMessageID?: string
  stopReason?: "user" | "completed" | "max_cycles" | "error" | "council"
}

export type MagiRuntimeMemory = {
  lastProposer?: MagiCouncilMember
  previousCompleted?: boolean
  cyclesCompleted?: number
  stoppedBy?: "user" | "unanimous_council" | "max_cycles"
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
    topic: "Magi is idle. Type /magi or /magi start to convene the council.",
    updatedAt: Date.now(),
    events: [],
    votes: {},
  }
}

export async function readMagiState(directory: string): Promise<MagiRuntimeState> {
  const file = magiStatePath(directory)
  if (!(await Bun.file(file).exists())) return emptyMagiState()
  const content: unknown = await Bun.file(file)
    .json()
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
      const temporary = `${magiStatePath(directory)}.${crypto.randomUUID()}.tmp`
      await Bun.write(temporary, JSON.stringify(state, null, 2))
      await rename(temporary, magiStatePath(directory))
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
  return mutateMagiState(directory, (current) =>
    runID && current.runID !== runID
      ? current
      : {
          ...current,
          ...patch,
          events: [...current.events, event].slice(-limit),
        },
  )
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
  const temporary = `${magiMemoryPath(directory)}.${crypto.randomUUID()}.tmp`
  await Bun.write(temporary, JSON.stringify(memory, null, 2))
  await rename(temporary, magiMemoryPath(directory))
}
