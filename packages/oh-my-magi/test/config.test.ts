import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { loadMagiConfig, parseJsonc } from "../src/config"

describe("Config Management", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "magi-config-test-"))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  test("loads defaults when no config file exists", async () => {
    const config = await loadMagiConfig(tempDir)
    expect(config.council.votePolicy).toBe("majority")
    expect(config.council.vetoPolicy).toBe("safety-critical")
    expect(config.council.maxDebateRounds).toBe(0)
    expect(config.selfImprovement.enabled).toBe(false)
    expect(config.selfImprovement.maxCycles).toBe(0)
    expect(config.selfImprovement.mode).toBe("continuous")
  })

  test("parses jsonc with comments", () => {
    const raw = `
      {
        // Council settings
        "council": {
          /* Multiline comment */
          "votePolicy": "unanimous",
          "maxDebateRounds": 3,
        }
      }
    `
    const parsed = parseJsonc(raw) as { council: { votePolicy: string; maxDebateRounds: number } }
    expect(parsed.council.votePolicy).toBe("unanimous")
    expect(parsed.council.maxDebateRounds).toBe(3)
  })

  test("preserves punctuation inside strings and fails on malformed config", () => {
    expect(parseJsonc('{ "text": "literal ,} and ,]", }')).toEqual({ text: "literal ,} and ,]" })
    expect(() => parseJsonc('{ "plugin": [broken }')).toThrow("Invalid JSONC")
  })
})
