import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { MagiServerPlugin } from "../src/server"
import { setAutonomousLoop } from "../src/continuation"
import { mutateMagiState, readMagiState } from "../src/state"
import { openCodeFixture } from "./fixture"

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
