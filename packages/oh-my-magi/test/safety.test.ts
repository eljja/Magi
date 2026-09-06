import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { formatSafetyEnvelope, prepareBranchSafety } from "../src/safety"

describe("Branch Safety", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "magi-safety-test-"))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  test("skips branch creation gracefully outside git worktree", async () => {
    const safety = await prepareBranchSafety({
      directory: tempDir,
      title: "Add dark mode",
      prompt: "Implement dark mode in ui",
      enabled: true,
    })

    expect(safety.branch).toBeUndefined()
    expect(safety.warnings.length).toBeGreaterThan(0)
    expect(safety.warnings[0]).toContain("Git repository was not detected")
  })

  test("formats safety envelope with warnings and guidance", () => {
    const envelope = formatSafetyEnvelope({
      prompt: "Implement the feature",
      safety: {
        runID: "test-run",
        warnings: ["Working tree is not clean"],
      },
    })

    expect(envelope).toContain("Safety warnings: Working tree is not clean")
    expect(envelope).toContain("Implement the feature")
  })
})
