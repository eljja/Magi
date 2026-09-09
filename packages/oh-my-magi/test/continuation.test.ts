import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { handleSessionIdleEvent, runMagiCycle, setAutonomousLoop } from "../src/continuation"
import { mutateMagiState, readMagiState, writeMagiState } from "../src/state"
import { readRoadmap } from "../src/roadmap"
import { openCodeFixture } from "./fixture"
import { queueSteering } from "../src/steering"

describe("Persistent goal controller", () => {
  let directory: string
  let fixture: ReturnType<typeof openCodeFixture>
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "magi-cycle-"))
    fixture = openCodeFixture()
    await Bun.write(
      path.join(directory, ".magi", "config.jsonc"),
      JSON.stringify({
        selfImprovement: { maxCycles: 1 },
        resilience: { maxRetries: 0 },
        verification: {
          commands: [{ name: "artifact", command: [process.execPath, "-e", "console.log('artifact verified')"] }],
        },
      }),
    )
  })
  afterEach(async () => {
    fixture.stop()
    await rm(directory, { recursive: true, force: true })
  })
  const input = () => ({ directory, sessionID: "owner", client: fixture.client })

  test("guidance arriving during a meeting survives acknowledgement of earlier guidance", async () => {
    await queueSteering(directory, "Earlier guidance")
    fixture.stop()
    fixture = openCodeFixture({
      reply: async (body) => {
        if (String(body.system).includes("proposal owner")) {
          await queueSteering(directory, "Arrived during meeting")
          return JSON.stringify({ title: "Step", prompt: "Work", rationale: "Evidence" })
        }
        return JSON.stringify({ position: "approve", rationale: "Reviewed" })
      },
    })
    await setAutonomousLoop(directory, true, { sessionID: "owner", goal: "Research one goal" })
    await runMagiCycle(input())
    expect((await readMagiState(directory)).steeringQueue?.map((item) => item.text)).toEqual(["Arrived during meeting"])
    expect(await Bun.file(path.join(directory, ".magi", "COUNCIL.md")).text()).toContain("Earlier guidance")
  })

  test("rejected meetings are archived and their guidance remains pending", async () => {
    await queueSteering(directory, "Keep this until approved")
    fixture.stop()
    fixture = openCodeFixture({
      reply: async (body) =>
        String(body.system).includes("proposal owner")
          ? JSON.stringify({ title: "Unsafe proposal", prompt: "Proposal", rationale: "Review me" })
          : JSON.stringify({ position: "reject", rationale: "Evidence insufficient", safetyCritical: true }),
    })
    await setAutonomousLoop(directory, true, { sessionID: "owner", goal: "Research one goal" })
    expect((await runMagiCycle(input())).injected).toBe(false)
    expect((await readMagiState(directory)).steeringQueue?.length).toBe(1)
    const ledger = await Bun.file(path.join(directory, ".magi", "COUNCIL.md")).text()
    expect(ledger).toContain("NOT authorized")
    expect(ledger).toContain("Evidence insufficient")
  })

  test("repeated start preserves the generation and pending execution", async () => {
    await setAutonomousLoop(directory, true, { sessionID: "owner", goal: "Research one goal" })
    await runMagiCycle(input())
    const original = await readMagiState(directory)
    await setAutonomousLoop(directory, true, { sessionID: "owner" })
    const current = await readMagiState(directory)
    expect(current.runID).toBe(original.runID)
    expect(current.awaitingExecution).toBe(true)
  })

  test("an offline stop remains effective even if another process writes stale active state", async () => {
    await setAutonomousLoop(directory, true, { sessionID: "owner", goal: "Research one goal" })
    const stale = await readMagiState(directory)
    await setAutonomousLoop(directory, false)
    await writeMagiState(directory, stale)
    expect((await readMagiState(directory)).loopActive).toBe(false)
    await setAutonomousLoop(directory, true, { sessionID: "owner" })
    expect((await readMagiState(directory)).loopActive).toBe(true)
  })

  test("cannot fabricate council approval without a client", async () => {
    await setAutonomousLoop(directory, true, { sessionID: "owner", goal: "Research one goal" })
    await expect(runMagiCycle({ directory, sessionID: "owner" })).rejects.toThrow("unavailable")
    const state = await readMagiState(directory)
    expect(state.awaitingExecution).toBe(false)
    expect(state.loopActive).toBe(true)
    expect(state.status).toBe("error")
  })

  test("continues beyond previous cycle limits and completed roadmap without changing goal", async () => {
    await setAutonomousLoop(directory, true, { sessionID: "owner", goal: "Research one goal" })
    expect((await runMagiCycle(input())).injected).toBe(true)
    for (let index = 0; index < 7; index++) {
      fixture.complete()
      await handleSessionIdleEvent(input())
    }
    const state = await readMagiState(directory)
    expect(state.currentCycle).toBe(8)
    expect(state.loopActive).toBe(true)
    expect(state.goal).toBe("Research one goal")
    expect(state.maxCycles).toBe(0)
    expect((await readRoadmap(directory))?.milestones.length).toBeGreaterThan(5)
    expect(fixture.requests.filter((item) => item.path.endsWith("/prompt_async")).length).toBe(7)
  })

  test("ignores other sessions and duplicate idle events", async () => {
    await setAutonomousLoop(directory, true, { sessionID: "owner", goal: "Research one goal" })
    await runMagiCycle(input())
    fixture.complete()
    await handleSessionIdleEvent({ ...input(), sessionID: "stranger" })
    expect((await readMagiState(directory)).currentCycle).toBe(1)
    await handleSessionIdleEvent(input())
    await Promise.all([handleSessionIdleEvent(input()), handleSessionIdleEvent(input())])
    expect((await readMagiState(directory)).currentCycle).toBe(2)
  })

  test("stop during council deliberation prevents injection and preserves the saved goal", async () => {
    fixture.stop()
    let entered = () => {}
    let release = () => {}
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve
    })
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve
    })
    fixture = openCodeFixture({
      reply: async () => {
        entered()
        await releasePromise
        return JSON.stringify({ title: "Late proposal", prompt: "Must never run" })
      },
    })
    await setAutonomousLoop(directory, true, { sessionID: "owner", goal: "Research one goal" })
    const pending = runMagiCycle(input())
    await enteredPromise
    await setAutonomousLoop(directory, false)
    release()
    expect((await pending).injected).toBe(false)
    expect((await readMagiState(directory)).loopActive).toBe(false)
    expect((await readMagiState(directory)).goal).toBe("Research one goal")
  })

  test("refuses silent goal replacement or ownership transfer", async () => {
    await setAutonomousLoop(directory, true, { sessionID: "owner", goal: "Original goal" })
    await expect(setAutonomousLoop(directory, true, { sessionID: "owner", goal: "Different goal" })).rejects.toThrow(
      "different goal",
    )
    await expect(setAutonomousLoop(directory, true, { sessionID: "stranger" })).rejects.toThrow("Another session")
    expect((await readRoadmap(directory))?.goal).toBe("Original goal")
  })

  test("persisted state is sufficient to resume without an in-memory session registry", async () => {
    await setAutonomousLoop(directory, true, { sessionID: "owner", goal: "Research one goal" })
    await runMagiCycle(input())
    fixture.complete()
    await mutateMagiState(directory, (state) => ({ ...state, currentCycle: 1000 }))
    await handleSessionIdleEvent(input())
    expect((await readMagiState(directory)).currentCycle).toBe(1001)
  })
})
