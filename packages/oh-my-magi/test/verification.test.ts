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

  test("independent judge defaults to approval when mechanical verification passes", async () => {
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

    expect(verdict.approved).toBe(true)
    expect(verdict.confidence).toBeGreaterThan(0.5)
  })
})
