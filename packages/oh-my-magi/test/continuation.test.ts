import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { handleSessionIdleEvent, pauseMagi, runMagiCycle, setAutonomousLoop } from "../src/continuation"
import { mutateMagiState, readMagiState, writeMagiState } from "../src/state"
import { initializeRoadmap, readRoadmap } from "../src/roadmap"
import { openCodeFixture } from "./fixture"
import { queueSteering } from "../src/steering"
import { dispatchExecution } from "../src/execution"

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
  const completeMode = async () => {
    const file = Bun.file(path.join(directory, ".magi", "config.jsonc"))
    await Bun.write(file, JSON.stringify({ ...(await file.json()), selfImprovement: { mode: "complete" } }))
    await initializeRoadmap({
      directory,
      goal: "Research one goal",
      milestones: [
        { title: "First result", description: "Produce evidence" },
        { title: "Next result", description: "Extend evidence" },
      ],
    })
  }

  test("approved work uses an isolated OmO child and ignores conversation acknowledgements", async () => {
    await setAutonomousLoop(directory, true, { sessionID: "owner", goal: "Research one goal" })
    const result = await runMagiCycle(input())
    expect(result.prompt).toContain(process.execPath.replaceAll("\\", "\\\\"))
    expect(result.prompt).toContain("Configured verification commands")
    const approved = await readMagiState(directory)
    await dispatchExecution({ ...input(), runID: approved.runID!, prompt: result.prompt })
    const dispatched = await readMagiState(directory)
    expect(dispatched.executionSessionID).not.toBe("owner")
    expect(fixture.requests.some((request) => request.path === "/session" && request.body.parentID === "owner")).toBe(
      true,
    )
    expect(fixture.requests.find((request) => request.path.endsWith("/prompt_async"))?.body.agent).toBe("sisyphus")
    fixture.complete("I only acknowledge the goal", undefined, "owner")
    await handleSessionIdleEvent(input())
    expect((await readMagiState(directory)).currentCycle).toBe(1)
    fixture.complete("Produced the actual artifact", undefined, dispatched.executionSessionID)
    await handleSessionIdleEvent(input())
    expect((await readMagiState(directory)).currentCycle).toBe(2)
    expect(fixture.requests.some((request) => request.path === "/session/owner/prompt_async")).toBe(false)
  })

  test("a failed independent judge retries saved execution evidence without rerunning the workforce", async () => {
    await completeMode()
    fixture.stop()
    let reviews = 0
    fixture = openCodeFixture({
      reply: async (body) => {
        if (String(body.system).includes("proposal owner"))
          return JSON.stringify({ title: "Step", prompt: "Produce an artifact", rationale: "Goal evidence" })
        if (String(body.system).includes("independent milestone reviewer")) {
          reviews++
          if (reviews === 1) return undefined
          expect(JSON.stringify(body.parts)).toContain("Actual execution survived the reviewer outage")
          return JSON.stringify({ position: "approve", rationale: "Checks and evidence support this milestone" })
        }
        return JSON.stringify({ position: "approve", rationale: "Reviewed" })
      },
    })
    await setAutonomousLoop(directory, true, { sessionID: "owner", goal: "Research one goal" })
    await runMagiCycle(input())
    fixture.complete("Actual execution survived the reviewer outage")
    await handleSessionIdleEvent(input())
    const failed = await readMagiState(directory)
    expect(failed.awaitingExecution).toBe(true)
    expect(failed.pendingVerification?.executionReport).toContain("survived")
    expect(fixture.requests.filter((request) => request.path.endsWith("/prompt_async"))).toHaveLength(0)
    await handleSessionIdleEvent(input())
    expect(reviews).toBe(7)
    expect((await readMagiState(directory)).currentCycle).toBe(2)
    expect(fixture.requests.filter((request) => request.path.endsWith("/prompt_async"))).toHaveLength(1)
  })

  test("a late workforce reply invalidates review instead of completing a stale milestone", async () => {
    await completeMode()
    fixture.stop()
    let reviews = 0
    fixture = openCodeFixture({
      reply: async (body) => {
        if (String(body.system).includes("proposal owner"))
          return JSON.stringify({ title: "Step", prompt: "Produce an artifact", rationale: "Goal evidence" })
        if (String(body.system).includes("independent milestone reviewer")) {
          if (++reviews === 1) fixture.complete("Background task woke the worker during review")
          return JSON.stringify({ position: "approve", rationale: "Reviewed the submitted evidence" })
        }
        return JSON.stringify({ position: "approve", rationale: "Reviewed" })
      },
    })
    await setAutonomousLoop(directory, true, { sessionID: "owner", goal: "Research one goal" })
    await runMagiCycle(input())
    fixture.complete("Initial answer before the background wake")
    expect(await handleSessionIdleEvent(input())).toBe("waiting")
    const waiting = await readMagiState(directory)
    expect(waiting.currentCycle).toBe(1)
    expect(waiting.awaitingExecution).toBe(true)
    expect(waiting.pendingVerification).toBeUndefined()
    expect((await readRoadmap(directory))?.milestones[0]?.completed).toBe(false)
    expect(fixture.requests.filter((request) => request.path.endsWith("/prompt_async"))).toHaveLength(0)
    await handleSessionIdleEvent(input())
    expect(reviews).toBe(12)
    expect((await readMagiState(directory)).currentCycle).toBe(2)
  })

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

  test("partial independent opinions survive a failed member and resume without repeating completed votes", async () => {
    fixture.stop()
    const calls: { agent: string; stage: string; prompt: string }[] = []
    fixture = openCodeFixture({
      reply: async (body) => {
        const prompt = JSON.stringify(body.parts)
        const stage = String(body.system).includes("proposal owner")
          ? "proposal"
          : prompt.includes("Opening assessment")
            ? "opening"
            : "vote"
        calls.push({ agent: String(body.agent), stage, prompt })
        if (stage === "proposal")
          return JSON.stringify({
            title: "Inspect evidence",
            prompt: "Collect relevant facts",
            rationale: "Need baseline",
          })
        if (
          stage === "opening" &&
          body.agent === "magi-balthasar" &&
          calls.filter((call) => call.agent === body.agent && call.stage === stage).length === 1
        )
          return undefined
        return JSON.stringify({ position: "approve", rationale: String(body.agent) + " independent evidence" })
      },
    })
    await setAutonomousLoop(directory, true, { sessionID: "owner", goal: "Research one goal" })
    await expect(runMagiCycle(input())).rejects.toThrow("structured decision")
    const failed = await readMagiState(directory)
    expect(failed.currentCycle).toBe(1)
    expect(failed.awaitingExecution).toBe(false)
    expect(Object.keys(failed.meeting?.pending?.opening ?? {}).sort()).toEqual(["casper", "melchior"])
    expect(await Bun.file(path.join(directory, ".magi", "COUNCIL.md")).text()).toContain("CASPER · opening")
    expect((await runMagiCycle(input())).injected).toBe(true)
    expect((await readMagiState(directory)).currentCycle).toBe(1)
    expect(calls.filter((call) => call.stage === "proposal")).toHaveLength(1)
    expect(calls.filter((call) => call.stage === "opening")).toHaveLength(4)
    expect(calls.filter((call) => call.stage === "vote")).toHaveLength(3)
    for (const call of calls.filter((call) => call.stage === "vote")) {
      expect(call.prompt).toContain("magi-melchior independent evidence")
      expect(call.prompt).toContain("magi-balthasar independent evidence")
      expect(call.prompt).toContain("magi-casper independent evidence")
    }
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

  test("incomplete model proposals are rejected instead of inventing a rationale", async () => {
    fixture.stop()
    fixture = openCodeFixture({ reply: async () => JSON.stringify({ title: "Missing rationale", prompt: "Do work" }) })
    await setAutonomousLoop(directory, true, { sessionID: "owner", goal: "Research one goal" })
    await expect(runMagiCycle(input())).rejects.toThrow("Invalid council proposal")
    expect((await readMagiState(directory)).awaitingExecution).toBe(false)
    expect(fixture.requests.some((request) => request.path.endsWith("/prompt_async"))).toBe(false)
  })

  test("propagating one council failure preserves its backoff; a later failure counts again", async () => {
    await setAutonomousLoop(directory, true, { sessionID: "owner", goal: "Research one goal" })
    await expect(runMagiCycle({ directory, sessionID: "owner" })).rejects.toThrow("unavailable")
    const failed = await readMagiState(directory)
    await pauseMagi(directory, failed.error!, failed.runID)
    const propagated = await readMagiState(directory)
    expect(propagated.failureCount).toBe(1)
    expect(propagated.retryAt).toBe(failed.retryAt)
    expect(propagated.events.length).toBe(failed.events.length)
    await mutateMagiState(directory, (state) => ({ ...state, retryAt: Date.now() - 1 }))
    await pauseMagi(directory, failed.error!, failed.runID)
    expect((await readMagiState(directory)).failureCount).toBe(2)
  })

  test("continuous mode advances beyond old limits without submission or completion votes", async () => {
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
    expect((await readRoadmap(directory))?.milestones).toHaveLength(1)
    expect((await readRoadmap(directory))?.milestones[0]?.completed).toBe(false)
    expect(state.progress?.cycle).toBe(7)
    expect(state.reporting?.checkpointCount).toBe(7)
    expect(
      fixture.requests.some((request) => String(request.body.system).includes("independent milestone reviewer")),
    ).toBe(false)
    expect(await Bun.file(path.join(directory, ".magi", "COUNCIL.md")).text()).toContain("No completion vote")
    expect(fixture.requests.filter((item) => item.path.endsWith("/prompt_async")).length).toBe(7)
  })

  test("failed checks become next-meeting evidence without pretending completion or blocking the loop", async () => {
    await Bun.write(
      path.join(directory, ".magi", "config.jsonc"),
      JSON.stringify({
        verification: { commands: [{ name: "behavior", command: [process.execPath, "-e", "process.exit(1)"] }] },
      }),
    )
    await setAutonomousLoop(directory, true, { sessionID: "owner", goal: "Repair observed failures" })
    await runMagiCycle(input())
    fixture.complete("Partial change; failing behavior still needs repair")
    await handleSessionIdleEvent(input())
    const state = await readMagiState(directory)
    expect(state.loopActive).toBe(true)
    expect(state.currentCycle).toBe(2)
    expect(state.progress?.verification.passed).toBe(false)
    expect((await readRoadmap(directory))?.milestones[0]?.completed).toBe(false)
    expect(
      JSON.stringify(
        fixture.requests.filter((request) => String(request.body.system).includes("proposal owner")).at(-1)?.body,
      ),
    ).toContain("failing behavior")
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
