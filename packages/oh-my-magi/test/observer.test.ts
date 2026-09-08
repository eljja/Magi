import { describe, expect, it } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { recordToolExecution, formatCouncilObservationBulletin } from "../src/observer"
import { readMagiState } from "../src/state"

describe("Council Observer & Progress Telemetry", () => {
  it("records file write executions with Melchior architectural observation", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "magi-observer-test-"))

    const obs = await recordToolExecution(dir, {
      tool: "write",
      sessionID: "ses-1",
      callID: "call-1",
      args: { targetFile: "src/auth/jwt.ts", content: "..." },
      title: "Write file",
      output: "File written successfully",
    })

    expect(obs).toBeDefined()
    expect(obs?.member).toBe("melchior")
    expect(obs?.perspective).toBe("architecture")
    expect(obs?.observation).toContain("src/auth/jwt.ts")

    const state = await readMagiState(dir)
    expect(state.telemetry?.toolCallCount).toBe(1)
    expect(state.telemetry?.modifiedFiles).toContain("src/auth/jwt.ts")
  })

  it("records command/test executions with Balthasar safety observation", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "magi-observer-test-"))

    const obs = await recordToolExecution(dir, {
      tool: "bash",
      sessionID: "ses-1",
      callID: "call-2",
      args: { command: "bun test" },
      title: "Run tests",
      output: "54 pass, 0 fail",
    })

    expect(obs).toBeDefined()
    expect(obs?.member).toBe("balthasar")
    expect(obs?.perspective).toBe("safety")
    expect(obs?.observation).toContain("evidence")
  })

  it("formats council observation bulletin cleanly", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "magi-observer-test-"))

    await recordToolExecution(dir, {
      tool: "edit",
      sessionID: "ses-1",
      callID: "call-1",
      args: { targetFile: "src/api.ts" },
    })
    await recordToolExecution(dir, {
      tool: "task",
      sessionID: "ses-1",
      callID: "call-2",
      args: { agent: "explore" },
    })

    const state = await readMagiState(dir)
    const bulletin = formatCouncilObservationBulletin(state)

    expect(bulletin.length).toBeGreaterThan(0)
    expect(bulletin.some((line) => line.includes("Workforce Telemetry"))).toBe(true)
    expect(bulletin.some((line) => line.includes("MELCHIOR"))).toBe(true)
    expect(bulletin.some((line) => line.includes("CASPER"))).toBe(true)
  })
})
