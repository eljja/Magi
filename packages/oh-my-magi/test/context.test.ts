import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { collectMagiContext, redact } from "../src/context"

describe("Context Collector", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "magi-context-test-"))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  test("redacts secret tokens and api keys", () => {
    const raw = "Here is my key: AIzaSyD3xP45Z9_exampleKey123 and sk-1234567890abcdef12345678 and secret: my_super_secret_token_value"
    const redacted = redact(raw)
    expect(redacted).not.toContain("AIzaSyD3xP45Z9_exampleKey123")
    expect(redacted).not.toContain("sk-1234567890abcdef12345678")
    expect(redacted).toContain("[REDACTED_GOOGLE_API_KEY]")
    expect(redacted).toContain("[REDACTED_OPENAI_API_KEY]")
  })

  test("collects context from package.json scripts", async () => {
    await Bun.write(
      path.join(tempDir, "package.json"),
      JSON.stringify({
        scripts: {
          test: "bun test",
          typecheck: "tsgo --noEmit",
        },
      }),
    )

    const pack = await collectMagiContext({ directory: tempDir, enabled: true })
    expect(pack.text).toContain("Package scripts:")
    expect(pack.text).toContain("test: bun test")
    expect(pack.text).toContain("typecheck: tsgo --noEmit")
    expect(pack.truncated).toBe(false)
  })

  test("truncates context when limit is exceeded", async () => {
    const pack = await collectMagiContext({ directory: tempDir, enabled: true, maxChars: 50 })
    expect(pack.truncated).toBe(true)
    expect(pack.text).toContain("[context truncated by Magi runtime]")
  })
})
