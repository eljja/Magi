import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { collectMagiContext } from "../src/context"

describe("Magi context pack", () => {
  test("collects bounded project context from git and package scripts", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "magi-context-"))
    try {
      await git(dir, ["init"])
      await Bun.write(path.join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "bun typecheck" } }))
      await Bun.write(path.join(dir, "README.md"), "before\n")
      await git(dir, ["add", "package.json", "README.md"])
      await git(dir, ["-c", "user.email=magi@example.test", "-c", "user.name=Magi", "commit", "-m", "init"])
      await Bun.write(path.join(dir, "README.md"), "after\n")

      const context = await collectMagiContext({ directory: dir, enabled: true, maxChars: 4000 })
      expect(context.truncated).toBe(false)
      expect(context.text).toContain("Git status:")
      expect(context.text).toContain("README.md")
      expect(context.text).toContain("typecheck: bun typecheck")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("truncates context at the configured limit", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "magi-context-"))
    try {
      await Bun.write(path.join(dir, "package.json"), JSON.stringify({ scripts: { build: "x".repeat(500) } }))
      const context = await collectMagiContext({ directory: dir, enabled: true, maxChars: 120 })
      expect(context.truncated).toBe(true)
      expect(context.text.length).toBeLessThanOrEqual(120)
      expect(context.text).toContain("context truncated")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("redacts common secret shapes from context", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "magi-context-"))
    try {
      await Bun.write(
        path.join(dir, "package.json"),
        JSON.stringify({
          scripts: {
            leak: "deploy --api-key sk-abcdefghijklmnopqrstuvwxyz123456",
          },
        }),
      )
      const context = await collectMagiContext({ directory: dir, enabled: true, maxChars: 4000 })
      expect(context.text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456")
      expect(context.text).toContain("[REDACTED_OPENAI_API_KEY]")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

async function git(directory: string, args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" })
  expect(await proc.exited).toBe(0)
}
