import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { migrateOmORegistrations, openCodeConfigFiles } from "../src/migration"
import { parseJsonc } from "../src/config"
import { setAutonomousLoop, runMagiCycle } from "../src/continuation"
import { readMagiState, mutateMagiState } from "../src/state"
import { queueSteering } from "../src/steering"
import { readCouncilMemory } from "../src/memory"
import { createControllerLease } from "../src/controller"
import { createWorkforceWatchdog } from "../src/watchdog"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { openCodeFixture } from "./fixture"
import { executeResilientPrompt } from "../src/resilience"

test("migrates global and project OmO server/TUI entries with backups and preserved options", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "magi-migration-"))
  try {
    const files = [path.join(dir, "global/opencode.jsonc"), path.join(dir, "project/tui.json")]
    await Bun.write(
      files[0]!,
      '{// model setting stays\n"plugin":[["oh-my-opencode@4.19.4", {"custom":true}],"other-plugin"],"model":"local/model"}',
    )
    await Bun.write(files[1]!, '{"plugin":["oh-my-opencode/tui","oh-my-magi"]}')
    expect(await migrateOmORegistrations(dir, "oh-my-magi", files)).toEqual(files)
    const text = await Bun.file(files[0]!).text()
    expect(text).toContain("model setting stays")
    expect(parseJsonc(text)).toEqual({
      plugin: [["oh-my-magi", { custom: true }], "other-plugin"],
      model: "local/model",
    })
    expect((await Bun.file(files[1]!).json()).plugin).toEqual(["oh-my-magi"])
    expect(await migrateOmORegistrations(dir, "oh-my-magi", files)).toEqual([])
    const manifests = await Array.fromAsync(new Bun.Glob(".magi/backups/*/manifest.json").scan({ cwd: dir, dot: true }))
    expect(manifests).toHaveLength(1)
    const manifest = await Bun.file(path.join(dir, manifests[0]!)).json()
    expect(manifest[0].source).toBe(files[0])
    expect(await Bun.file(path.join(dir, path.dirname(manifests[0]!), "0.jsonc")).text()).toContain(
      "oh-my-opencode@4.19.4",
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("malformed migration input leaves every source unchanged", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "magi-migration-"))
  try {
    const first = path.join(dir, "a.json")
    const second = path.join(dir, "b.jsonc")
    const text = '{"plugin":["oh-my-opencode"]}'
    await Bun.write(first, text)
    await Bun.write(second, '{"plugin": [invalid}')
    await expect(migrateOmORegistrations(dir, "oh-my-magi", [first, second])).rejects.toThrow("Invalid JSONC")
    expect(await Bun.file(first).text()).toBe(text)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("config discovery honors disabled project configuration and explicit config", () => {
  const env = {
    OPENCODE_TEST_HOME: "D:/isolated",
    XDG_CONFIG_HOME: "D:/isolated/config",
    OPENCODE_CONFIG: "D:/isolated/custom.json",
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
  }
  const files = openCodeConfigFiles("D:/unrelated/project", env)
  expect(files).toContain(path.resolve(env.OPENCODE_CONFIG))
  expect(files.some((file) => file.includes("unrelated"))).toBe(false)
})

test("a meeting resumes beyond legacy limits and reads archived guidance after queue consumption", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "magi-meeting-"))
  let round = 0
  const fixture = openCodeFixture({
    reply: async (body) => {
      if (String(body.system).includes("proposal owner")) {
        round++
        return JSON.stringify({
          title: "Revision " + round,
          prompt: "Inspect source evidence " + round,
          rationale: "Address prior objection",
          memory: "Always prioritize reproducibility. Source: USER-GUIDANCE.md",
        })
      }
      return JSON.stringify({
        position: round < 9 ? "revise" : "approve",
        rationale: "Evidence round " + round,
        requiredChange: "Inspect reproducibility evidence",
        newEvidence: true,
      })
    },
  })
  try {
    await Bun.write(path.join(dir, ".magi/config.jsonc"), '{"council":{"maxDebateRounds":1}}')
    await setAutonomousLoop(dir, true, { sessionID: "owner", goal: "One goal" })
    await queueSteering(dir, "앞으로 항상 재현성을 우선해줘")
    for (let i = 1; i <= 8; i++) {
      expect((await runMagiCycle({ directory: dir, sessionID: "owner", client: fixture.client })).injected).toBe(false)
      const state = await readMagiState(dir)
      expect(state.currentCycle).toBe(1)
      expect(state.meeting?.round).toBe(i)
    }
    expect((await runMagiCycle({ directory: dir, sessionID: "owner", client: fixture.client })).injected).toBe(true)
    expect((await readMagiState(dir)).meeting).toBeUndefined()
    expect((await readMagiState(dir)).steeringQueue).toHaveLength(0)
    const memory = await readCouncilMemory(dir)
    expect(memory).toContain("앞으로 항상 재현성을 우선해줘")
    expect(memory).toContain("Always prioritize reproducibility")
    expect(memory).toContain("COUNCIL.md")
    await runMagiCycle({ directory: dir, sessionID: "owner", client: fixture.client })
    expect(JSON.stringify(fixture.requests.filter((request) => request.path.endsWith("/message")).at(-1))).toContain(
      "Always prioritize reproducibility",
    )
  } finally {
    fixture.stop()
    await rm(dir, { recursive: true, force: true })
  }
}, 30000)

test("corrupt lease metadata cannot block recovery or allow a second live controller", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "magi-lock-"))
  const first = createControllerLease(dir)
  const second = createControllerLease(dir)
  try {
    await Bun.write(path.join(dir, ".magi/runtime/controller.json"), "{")
    expect(await first.acquire()).toBe(true)
    await Bun.write(path.join(dir, ".magi/runtime/controller.json"), "corrupted while live")
    expect(await second.acquire()).toBe(false)
    await first.release()
    expect(await second.acquire()).toBe(true)
  } finally {
    await first.release()
    await second.release()
    await rm(dir, { recursive: true, force: true })
  }
})

test("watchdog aborts unchanged stalled work and preserves the approved goal", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "magi-watchdog-"))
  const calls: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      calls.push(url.pathname)
      if (url.pathname === "/session/status") return Response.json({ owner: { type: "busy" } })
      if (url.pathname.endsWith("/message"))
        return Response.json([{ info: { id: "msg_stalled", role: "user" }, parts: [] }])
      return Response.json(true)
    },
  })
  try {
    await Bun.write(path.join(dir, ".magi/config.jsonc"), '{"resilience":{"stallTimeoutMs":50}}')
    await setAutonomousLoop(dir, true, { sessionID: "owner", goal: "One goal" })
    await mutateMagiState(dir, (state) => ({ ...state, awaitingExecution: true, selectedPrompt: "Approved work" }))
    const watchdog = createWorkforceWatchdog(dir, createOpencodeClient({ baseUrl: server.url.toString() }))
    expect(await watchdog("owner", 100)).toBe(true)
    expect(calls).not.toContain("/session/owner/abort")
    expect(await watchdog("owner", 151)).toBe(true)
    expect(calls).toContain("/session/owner/abort")
    const state = await readMagiState(dir)
    expect(state.loopActive).toBe(true)
    expect(state.awaitingExecution).toBe(true)
    expect(state.goal).toBe("One goal")
    expect(state.ignoredMessageIDs).toContain("msg_stalled")
  } finally {
    server.stop(true)
    await rm(dir, { recursive: true, force: true })
  }
})

test("authentication failures produce an actionable error without repeated same-provider requests", async () => {
  const calls: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const route = new URL(request.url).pathname
      calls.push(route)
      if (route === "/session") return Response.json({ id: "review" })
      if (route.endsWith("/message"))
        return Response.json({
          info: { error: { name: "ProviderAuthError", data: { message: "unauthorized" } } },
          parts: [],
        })
      return Response.json(true)
    },
  })
  try {
    await expect(
      executeResilientPrompt({
        client: createOpencodeClient({ baseUrl: server.url.toString() }),
        directory: os.tmpdir(),
        system: "Review",
        prompt: "Evidence",
        maxRetries: 5,
      }),
    ).rejects.toThrow("provider authentication failed")
    expect(calls.filter((route) => route.endsWith("/message"))).toHaveLength(1)
  } finally {
    server.stop(true)
  }
})
