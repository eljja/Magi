import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  emptyMagiState,
  readMagiMemory,
  readMagiState,
  updateMagiState,
  writeMagiMemory,
  writeMagiState,
} from "../src/state"

describe("State Management", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "magi-state-test-"))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  test("reads empty state when file does not exist", async () => {
    const state = await readMagiState(tempDir)
    expect(state.status).toBe("idle")
    expect(state.loopActive).toBe(false)
    expect(state.currentCycle).toBe(0)
    expect(state.events).toEqual([])
  })

  test("persists and updates state", async () => {
    const initial = emptyMagiState()
    initial.loopActive = true
    initial.currentCycle = 1
    initial.topic = "Refactoring auth system"

    await writeMagiState(tempDir, initial)
    const read = await readMagiState(tempDir)
    expect(read.loopActive).toBe(true)
    expect(read.currentCycle).toBe(1)
    expect(read.topic).toBe("Refactoring auth system")
  })

  test("records events with bounded limit", async () => {
    for (let i = 1; i <= 30; i++) {
      await updateMagiState(
        tempDir,
        {
          time: Date.now(),
          type: "status",
          title: `Event ${i}`,
          text: `Event body ${i}`,
        },
        {},
        10,
      )
    }

    const state = await readMagiState(tempDir)
    expect(state.events.length).toBe(10)
    expect(state.events[9]?.title).toBe("Event 30")
  })

  test("reads and writes runtime memory", async () => {
    await writeMagiMemory(tempDir, {
      lastProposer: "casper",
      previousCompleted: true,
      cyclesCompleted: 3,
    })

    const memory = await readMagiMemory(tempDir)
    expect(memory.lastProposer).toBe("casper")
    expect(memory.previousCompleted).toBe(true)
    expect(memory.cyclesCompleted).toBe(3)
  })
})
