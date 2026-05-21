import path from "node:path"
import { mkdir } from "node:fs/promises"
import type { MagiCouncilMember, MagiPosition } from "./council"

export type MagiRuntimeEvent = {
  time: number
  type: "status" | "proposal" | "vote" | "decision" | "error"
  member?: MagiCouncilMember
  title: string
  text: string
  position?: MagiPosition
}

export type MagiRuntimeState = {
  status: "idle" | "running" | "decided" | "error"
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
    topic: "Magi is idle. Type /magi to start council debate.",
    updatedAt: Date.now(),
    events: [],
    votes: {},
  }
}

export async function readMagiState(directory: string) {
  if (!(await Bun.file(magiStatePath(directory)).exists())) return emptyMagiState()
  return (await Bun.file(magiStatePath(directory)).json()) as MagiRuntimeState
}

export async function writeMagiState(directory: string, state: MagiRuntimeState) {
  await ensureRuntimeDir(directory)
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
  if (!(await Bun.file(magiMemoryPath(directory)).exists())) return {}
  return (await Bun.file(magiMemoryPath(directory)).json()) as MagiRuntimeMemory
}

export async function writeMagiMemory(directory: string, memory: MagiRuntimeMemory) {
  await ensureRuntimeDir(directory)
  await Bun.write(magiMemoryPath(directory), JSON.stringify(memory, null, 2))
}

async function ensureRuntimeDir(directory: string) {
  await mkdir(magiRuntimeDir(directory), { recursive: true })
}
