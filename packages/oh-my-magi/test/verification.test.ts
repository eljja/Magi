import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { runIndependentJudge, runMechanicalVerification } from "../src/verification"
import { MagiConfigDefault } from "../src/config"

describe("Verification Harness", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "magi-verification-test-"))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  test("runs mechanical verification checks", async () => {
    await Bun.write(
      path.join(tempDir, "package.json"),
      JSON.stringify({
        scripts: {
          test: "echo test-ok",
        },
      }),
    )

    const report = await runMechanicalVerification(tempDir)
    expect(report.checks.length).toBeGreaterThan(0)
    expect(report.passed).toBe(true)
    expect(report.summary).toContain("passed cleanly")
  })

  test("independent judge cannot approve without a client and execution evidence", async () => {
    const verdict = await runIndependentJudge({
      config: MagiConfigDefault,
      directory: tempDir,
      taskTitle: "Refactor router",
      taskPrompt: "Clean up route checks",
      verificationReport: {
        passed: true,
        checks: [],
        summary: "All checks passed",
      },
    })

    expect(verdict.approved).toBe(false)
    expect(verdict.confidence).toBe(0)
  })

  test("missing tests are unverified, including monorepos with root test guards", async () => {
    expect((await runMechanicalVerification(tempDir)).passed).toBe(false)
    await Bun.write(
      path.join(tempDir, "package.json"),
      JSON.stringify({ workspaces: ["packages/*"], scripts: { test: "exit 42" } }),
    )
    expect((await runMechanicalVerification(tempDir)).checks).toEqual([])
  })

  test("verification timeout terminates a hung direct process", async () => {
    await Bun.write(
      path.join(tempDir, ".magi", "config.jsonc"),
      JSON.stringify({
        verification: {
          timeoutMs: 50,
          commands: [{ name: "hang", command: [process.execPath, "-e", "setInterval(() => {}, 1000)"] }],
        },
      }),
    )
    const report = await runMechanicalVerification(tempDir)
    expect(report.passed).toBe(false)
    expect(report.checks[0]?.durationMs).toBeLessThan(2000)
  })

  test("verification deadline also terminates a spawned child holding output open", async () => {
    await Bun.write(
      path.join(tempDir, ".magi/config.jsonc"),
      JSON.stringify({
        verification: {
          timeoutMs: 600,
          commands: [
            {
              name: "tree",
              command: [
                process.execPath,
                "-e",
                "Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {stdout:'inherit',stderr:'inherit'}); setInterval(() => {}, 1000)",
              ],
            },
          ],
        },
      }),
    )
    const report = await runMechanicalVerification(tempDir)
    expect(report.passed).toBe(false)
    expect(report.checks[0]?.output).toContain("timed out")
    expect(report.checks[0]?.durationMs).toBeLessThan(7000)
  })
})
