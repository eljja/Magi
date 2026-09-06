import path from "node:path"
import { mkdir } from "node:fs/promises"
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
    maxCycles: 50,
    topic: "Magi is idle. Type /magi or /magi start to convene the council.",
    updatedAt: Date.now(),
    events: [],
    votes: {},
  }
}

export async function readMagiState(directory: string): Promise<MagiRuntimeState> {
  const file = magiStatePath(directory)
  if (!(await Bun.file(file).exists())) return emptyMagiState()
  const content = await Bun.file(file).json().catch(() => ({}))
  return { ...emptyMagiState(), ...content }
}

export async function writeMagiState(directory: string, state: MagiRuntimeState) {
  await mkdir(magiRuntimeDir(directory), { recursive: true })
  await Bun.write(magiStatePath(directory), JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2))
}

export async function updateMagiState(
  directory: string,
  event: MagiRuntimeEvent,
  patch?: Partial<Omit<MagiRuntimeState, "events">>,
  limit = 24,
) {
  const current = await readMagiState(directory)
  await writeMagiState(directory, {
    ...current,
    ...patch,
    events: [...current.events, event].slice(-limit),
  })
}

export async function readMagiMemory(directory: string): Promise<MagiRuntimeMemory> {
  const file = magiMemoryPath(directory)
  if (!(await Bun.file(file).exists())) return {}
  return (await Bun.file(file).json().catch(() => ({}))) as MagiRuntimeMemory
}

export async function writeMagiMemory(directory: string, memory: MagiRuntimeMemory) {
  await mkdir(magiRuntimeDir(directory), { recursive: true })
  await Bun.write(magiMemoryPath(directory), JSON.stringify(memory, null, 2))
}
