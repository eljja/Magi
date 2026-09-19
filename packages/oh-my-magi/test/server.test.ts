import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { MagiServerPlugin } from "../src/server"
import { setAutonomousLoop } from "../src/continuation"
import { mutateMagiState, readMagiState } from "../src/state"
import { openCodeFixture } from "./fixture"
import { createOpencodeClient } from "@opencode-ai/sdk"

test("an offline stop is enforced against active children without aborting the human conversation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "magi-offline-stop-"))
  const aborted: string[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const route = new URL(request.url).pathname
      if (route === "/session/status")
        return Response.json({
          owner: { type: "busy" },
          worker: { type: "busy" },
          specialist: { type: "busy" },
          unrelated: { type: "busy" },
        })
      if (route === "/session/worker" || route === "/session/unrelated") return Response.json({ parentID: "owner" })
      if (route === "/session/specialist") return Response.json({ parentID: "worker" })
      if (route.endsWith("/abort")) {
        aborted.push(route)
        await Bun.sleep(200)
      }
      return Response.json({})
    },
  })
  const client = createOpencodeClient({ baseUrl: server.url.toString() })
  await setAutonomousLoop(directory, true, { sessionID: "owner", goal: "Original goal" })
  await mutateMagiState(directory, (state) => ({ ...state, executionSessionID: "worker" }))
  const plugin = await MagiServerPlugin({ directory, client } as Parameters<typeof MagiServerPlugin>[0])
  try {
    await setAutonomousLoop(directory, false)
    const deadline = Date.now() + 18000
    while (!aborted.length && Date.now() < deadline) await Bun.sleep(100)
    expect(aborted.sort()).toEqual(["/session/specialist/abort", "/session/worker/abort"])
    expect((await readMagiState(directory)).loopActive).toBe(false)
    await plugin.dispose?.()
    expect(await Bun.file(path.join(directory, ".magi", "STATUS.md")).exists()).toBe(true)
    expect(await Bun.file(path.join(directory, ".magi", "runtime", "controller.json")).exists()).toBe(false)
  } finally {
    await plugin.dispose?.()
    server.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
}, 20000)

test("autonomous workers cannot stop the goal or impersonate user steering", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "magi-controls-"))
  const fixture = openCodeFixture()
  const plugin = await MagiServerPlugin({ directory, client: fixture.client } as Parameters<typeof MagiServerPlugin>[0])
  try {
    await setAutonomousLoop(directory, true, { sessionID: "owner", goal: "Original goal" })
    const context = { sessionID: "worker" } as Parameters<NonNullable<typeof plugin.tool>[string]["execute"]>[1]
    await expect(plugin.tool!.magi_stop!.execute({}, context)).rejects.toThrow("user conversation")
    await expect(plugin.tool!.magi_steer!.execute({ directive: "Replace the user's goal" }, context)).rejects.toThrow(
      "not user steering",
    )
    expect((await readMagiState(directory)).loopActive).toBe(true)
    expect((await readMagiState(directory)).steeringQueue ?? []).toHaveLength(0)
  } finally {
    await plugin.dispose?.()
    fixture.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test("native OpenCode user abort stops the persisted goal", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "magi-server-"))
  const fixture = openCodeFixture()
  const plugin = await MagiServerPlugin({ directory, client: fixture.client } as Parameters<typeof MagiServerPlugin>[0])
  try {
    await setAutonomousLoop(directory, true, { sessionID: "owner", goal: "Original goal" })
    await plugin.event!({
      event: {
        type: "session.error",
        properties: {
          sessionID: "owner",
          error: { name: "MessageAbortedError", data: { message: "User interrupted" } },
        },
      },
    })
    expect((await readMagiState(directory)).loopActive).toBe(false)
    expect((await readMagiState(directory)).stopReason).toBe("user")
  } finally {
    await plugin.event!({ event: { type: "server.instance.disposed", properties: { directory } } })
    fixture.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test("server polling recovers an approved task persisted before a lost dispatch", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "magi-recovery-"))
  const fixture = openCodeFixture()
  await setAutonomousLoop(directory, true, { sessionID: "owner", goal: "Original goal" })
  await mutateMagiState(directory, (state) => ({
    ...state,
    awaitingExecution: true,
    executionAfter: Date.now() - 120000,
    selectedPrompt: "Approved goal step",
  }))
  const plugin = await MagiServerPlugin({ directory, client: fixture.client } as Parameters<typeof MagiServerPlugin>[0])
  try {
    const deadline = Date.now() + 18000
    while (!fixture.requests.some((request) => request.path.endsWith("/prompt_async")) && Date.now() < deadline)
      await Bun.sleep(100)
    const requests = fixture.requests.filter((request) => request.path.endsWith("/prompt_async"))
    expect(requests.length).toBe(1)
    expect(JSON.stringify(requests[0]?.body)).toContain("previous attempt may have partially completed")
    expect((await readMagiState(directory)).goal).toBe("Original goal")
  } finally {
    await plugin.event!({ event: { type: "server.instance.disposed", properties: { directory } } })
    fixture.stop()
    await rm(directory, { recursive: true, force: true })
  }
}, 20000)
