import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { appendReport, publishReport } from "../src/reporting"
import { emptyMagiState, readMagiState } from "../src/state"
import { queueSteering } from "../src/steering"
import { composeHooks } from "../src/omo-runtime"

test("concurrent report appends and interventions lose no entries", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "magi-report-"))
  await Promise.all(Array.from({ length: 30 }, (_, i) => appendReport(dir, "COUNCIL.md", `entry-${i}\n`)))
  const contents = await Bun.file(path.join(dir, ".magi", "COUNCIL.md")).text()
  expect(contents.trim().split("\n").length).toBe(30)
  await Promise.all([queueSteering(dir, "Keep goal"), queueSteering(dir, "Test first")])
  expect((await readMagiState(dir)).steeringQueue?.length).toBe(2)
})

test("monitor escapes untrusted content and archives timestamped reports", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "magi-report-"))
  await publishReport(dir, { ...emptyMagiState(), goal: '<script>alert("x")</script>' }, true)
  const page = await Bun.file(path.join(dir, ".magi", "index.html")).text()
  expect(page).not.toContain("<script>")
  expect(page).toContain("&lt;script&gt;")
  expect(page).toContain('http-equiv="refresh"')
  expect(
    await Bun.file(path.join(dir, ".magi", "reports", new Date().toISOString().slice(0, 10) + ".md")).exists(),
  ).toBe(true)
})

test("composition retains upstream hooks, runs both and disposes both on failure", async () => {
  const calls: string[] = []
  const hooks = composeHooks(
    {
      config: async () => {
        calls.push("omo")
      },
      dispose: async () => {
        calls.push("omo disposed")
        throw new Error("cleanup")
      },
      "chat.message": async () => {
        calls.push("native")
      },
    },
    {
      config: async () => {
        calls.push("magi")
      },
      dispose: async () => {
        calls.push("magi disposed")
      },
    },
  )
  await hooks.config!({})
  expect(calls).toEqual(["omo", "magi"])
  expect(hooks["chat.message"]).toBeDefined()
  await expect(hooks.dispose!()).rejects.toThrow("disposal")
  expect(calls).toContain("magi disposed")
})
