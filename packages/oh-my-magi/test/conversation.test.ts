import { expect, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MagiServerPlugin } from "../src/server"
import { composeHooks } from "../src/omo-runtime"
import { handleSessionIdleEvent, runMagiCycle, setAutonomousLoop } from "../src/continuation"
import { mutateMagiState, readMagiState } from "../src/state"
import { openCodeFixture } from "./fixture"

function message(text: string, sessionID = "owner", id = "msg_" + crypto.randomUUID()) {
  return {
    message: {
      id,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "sisyphus",
      model: { providerID: "local", modelID: "model" },
    },
    parts: [{ id: "prt_" + crypto.randomUUID(), messageID: id, sessionID, type: "text", text }],
  } satisfies Parameters<NonNullable<Hooks["chat.message"]>>[1]
}

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "magi-conversation-"))
  const fixture = openCodeFixture()
  const plugin = await MagiServerPlugin({ directory, client: fixture.client } as Parameters<typeof MagiServerPlugin>[0])
  return {
    directory,
    fixture,
    plugin,
    async close() {
      await plugin.dispose?.()
      fixture.stop()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test("ordinary conversation reaches the next council once, before upstream augmentation", async () => {
  const context = await setup()
  try {
    await setAutonomousLoop(context.directory, true, { sessionID: "owner", goal: "Original goal" })
    const output = message("새 기능보다 재현성 검증을 먼저 해줘")
    const hooks = composeHooks(
      {
        "chat.message": async (_, result) => {
          const part = result.parts[0]!
          if (part.type === "text") part.text += "\nUPSTREAM AUGMENTATION"
        },
      },
      context.plugin,
    )
    await hooks["chat.message"]!({ sessionID: "owner" }, output)
    await hooks["chat.message"]!({ sessionID: "owner" }, output)
    const state = await readMagiState(context.directory)
    expect(state.goal).toBe("Original goal")
    expect(state.loopActive).toBe(true)
    expect(state.steeringQueue).toHaveLength(1)
    expect(state.steeringQueue![0]!.text).toBe("새 기능보다 재현성 검증을 먼저 해줘")
    expect(state.ignoredMessageIDs).toContain(output.message.id)
    expect(output.parts).toHaveLength(2)
    const ledger = await Bun.file(path.join(context.directory, ".magi/COUNCIL.md")).text()
    expect(ledger.split("## User intervention")).toHaveLength(2)
    expect(ledger).toContain(output.message.id)
    await runMagiCycle({ directory: context.directory, sessionID: "owner", client: context.fixture.client })
    expect(JSON.stringify(context.fixture.requests)).toContain("새 기능보다 재현성 검증을 먼저 해줘")
    expect((await readMagiState(context.directory)).steeringQueue).toHaveLength(0)
    // A replay after consumption must not re-queue the same message.
    await hooks["chat.message"]!({ sessionID: "owner" }, output)
    expect((await readMagiState(context.directory)).steeringQueue).toHaveLength(0)
  } finally {
    await context.close()
  }
})

test("internal, child, unrelated, inactive and slash command messages are not steering", async () => {
  const context = await setup()
  try {
    await context.plugin["chat.message"]!({ sessionID: "owner" }, message("Inactive conversation"))
    expect(await Bun.file(path.join(context.directory, ".magi/runtime/state.json")).exists()).toBe(false)
    await setAutonomousLoop(context.directory, true, { sessionID: "owner", goal: "Original goal" })
    for (const sessionID of ["child", "unrelated", "internal-review"]) {
      await context.plugin["chat.message"]!({ sessionID }, message("Not the user", sessionID))
    }
    const synthetic = message("Scheduled council task")
    Object.assign(synthetic.parts[0]!, { synthetic: true })
    await context.plugin["chat.message"]!({ sessionID: "owner" }, synthetic)
    const ignored = message("Ignored text")
    Object.assign(ignored.parts[0]!, { ignored: true })
    await context.plugin["chat.message"]!({ sessionID: "owner" }, ignored)
    const command = message("Command template")
    await context.plugin["command.execute.before"]!({ command: "other", arguments: "", sessionID: "owner" }, command)
    await context.plugin["chat.message"]!({ sessionID: "owner" }, command)
    expect((await readMagiState(context.directory)).steeringQueue ?? []).toHaveLength(0)
    await setAutonomousLoop(context.directory, false)
    await context.plugin["chat.message"]!({ sessionID: "owner" }, message("Stopped conversation"))
    expect((await readMagiState(context.directory)).loopActive).toBe(false)
    expect((await readMagiState(context.directory)).steeringQueue ?? []).toHaveLength(0)
  } finally {
    await context.close()
  }
})

test("questions get conversational context and their replies cannot complete a milestone", async () => {
  const context = await setup()
  try {
    await setAutonomousLoop(context.directory, true, { sessionID: "owner", goal: "Original goal" })
    await mutateMagiState(context.directory, (state) => ({
      ...state,
      awaitingExecution: true,
      executionAfter: Date.now() - 1000,
    }))
    const output = message("왜 이 방식을 선택했어? 설명만 해줘.")
    await context.plugin["chat.message"]!({ sessionID: "owner" }, output)
    expect(output.parts[1]?.text).toContain("Answer questions as questions")
    expect(output.parts[1]?.text).toContain("Do not call magi_steer again")
    context.fixture.complete("Here is an explanation, not execution evidence", output.message.id)
    await handleSessionIdleEvent({ directory: context.directory, sessionID: "owner", client: context.fixture.client })
    expect((await readMagiState(context.directory)).awaitingExecution).toBe(true)
    expect(context.fixture.requests.some((request) => request.method === "POST")).toBe(false)
  } finally {
    await context.close()
  }
})

test("a concurrent command receipt cannot swallow an ordinary human message", async () => {
  const context = await setup()
  try {
    await setAutonomousLoop(context.directory, true, { sessionID: "owner", goal: "Original goal" })
    const command = message("status")
    await context.plugin["command.execute.before"]!(
      { command: "magi", arguments: "status", sessionID: "owner" },
      command,
    )
    const chat = message("테스트를 먼저 해줘")
    await context.plugin["chat.message"]!({ sessionID: "owner" }, chat)
    await context.plugin["chat.message"]!({ sessionID: "owner" }, command)
    const state = await readMagiState(context.directory)
    expect(state.steeringQueue?.map((item) => item.text)).toEqual(["테스트를 먼저 해줘"])
    expect(state.ignoredMessageIDs).toContain(command.message.id)
    expect(state.ignoredMessageIDs).toContain(chat.message.id)
  } finally {
    await context.close()
  }
})
