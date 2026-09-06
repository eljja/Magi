import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { runMagiCycle, setAutonomousLoop } from "../src/continuation"
import { readMagiState } from "../src/state"

describe("Continuation Loop Engine", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "magi-continuation-test-"))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  test("runs a single cycle producing injected prompt and state update", async () => {
    const result = await runMagiCycle({
      directory: tempDir,
      sessionID: "test-session-123",
      userPrompt: "Build unit tests for the auth module",
    })

    expect(result.cycle).toBe(1)
    expect(result.injected).toBe(true)
    expect(result.stopped).toBe(false)
    expect(result.prompt.length).toBeGreaterThan(0)
    expect(result.prompt).toContain("OH-MY-MAGI COUNCIL TASK — CYCLE #1")

    const state = await readMagiState(tempDir)
    expect(state.currentCycle).toBe(1)
    expect(state.status).toBe("decided")
    expect(state.selectedPrompt).toBeDefined()
  })

  test("toggles autonomous loop state", async () => {
    await setAutonomousLoop(tempDir, true)
    let state = await readMagiState(tempDir)
    expect(state.loopActive).toBe(true)
    expect(state.status).toBe("running")

    await setAutonomousLoop(tempDir, false)
    state = await readMagiState(tempDir)
    expect(state.loopActive).toBe(false)
    expect(state.status).toBe("idle")
  })
})
