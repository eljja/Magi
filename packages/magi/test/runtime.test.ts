import { describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { findMagiConfigPath, loadMagiRuntimeConfig } from "../src/config"
import { runMagiOnce } from "../src/runner"
import { routeMagiRequest } from "../src/router"
import { prepareSelfImprovementSafety } from "../src/safety"

describe("Magi runtime", () => {
  test("loads .magi config from parent project directories", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "magi-runtime-"))
    await mkdir(path.join(dir, ".magi"), { recursive: true })
    await mkdir(path.join(dir, "packages", "demo"), { recursive: true })
    await Bun.write(
      path.join(dir, ".magi", "config.jsonc"),
      JSON.stringify({
        council: {
          model: "gemini-test",
          dryRun: true,
        },
      }),
    )

    try {
      expect(await findMagiConfigPath(path.join(dir, "packages", "demo"))).toBe(
        path.join(dir, ".magi", "config.jsonc"),
      )
      expect((await loadMagiRuntimeConfig(path.join(dir, "packages", "demo"))).council.model).toBe("gemini-test")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("dry-run council produces an injectable OpenCode prompt and state", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "magi-runtime-"))
    await mkdir(path.join(dir, ".magi"), { recursive: true })
    await Bun.write(
      path.join(dir, ".magi", "config.jsonc"),
      JSON.stringify({
        council: {
          dryRun: true,
        },
      }),
    )

    try {
      const result = await runMagiOnce({ directory: dir, sessionID: "ses_test" })
      expect(result.injected).toBe(true)
      expect(result.route).toBe("council")
      expect(result.prompt).toContain("MAGI_PLUGIN_OK")
      expect(result.prompt).toContain("Magi safety did not create an isolated branch.")
      expect(await Bun.file(path.join(dir, ".magi", "runtime", "state.json")).exists()).toBe(true)
      const reportPath = result.prompt.match(/Run report: (.*plan\.json)/)?.[1]
      expect(reportPath).toBeDefined()
      const report = await Bun.file(reportPath ?? "").json()
      expect(report.decision.finalPosition).toBe("approve")
      expect(report.decision.rounds[0].decisions.map((decision: { member: string }) => decision.member).sort()).toEqual([
        "balthasar",
        "casper",
        "melchior",
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("router fast-tracks trivial requests but keeps architecture behind council", () => {
    expect(routeMagiRequest({ fastTrack: true, arguments: "fix typo in README" }).route).toBe("fast-track")
    expect(routeMagiRequest({ fastTrack: true, arguments: "refactor auth architecture" }).route).toBe("council")
    expect(routeMagiRequest({ fastTrack: false, arguments: "fix typo in README" }).route).toBe("council")
    expect(routeMagiRequest({ fastTrack: true, arguments: "fix typo\nand refactor config" }).route).toBe("council")
    expect(routeMagiRequest({ fastTrack: true, arguments: "--fast-track rename label" }).route).toBe("fast-track")
    expect(routeMagiRequest({ fastTrack: true, arguments: "--council fix typo" }).route).toBe("council")
    expect(routeMagiRequest({ fastTrack: true, maxFastTrackChars: 5, arguments: "fix typo in README" }).route).toBe(
      "council",
    )
  })

  test("self-improvement safety creates an isolated branch in a clean git worktree", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "magi-safety-"))
    try {
      await git(dir, ["init"])
      await Bun.write(path.join(dir, "README.md"), "demo\n")
      await git(dir, ["add", "README.md"])
      await git(dir, ["-c", "user.email=magi@example.test", "-c", "user.name=Magi", "commit", "-m", "init"])

      const result = await prepareSelfImprovementSafety({
        directory: dir,
        title: "Improve plugin onboarding",
        prompt: "Improve onboarding.",
        config: await loadMagiRuntimeConfig(dir),
      })

      const branch = result.branch
      expect(branch?.startsWith("magi/self-improve/improve-plugin-onboarding-")).toBe(true)
      if (!branch) throw new Error("Expected Magi safety to create a branch")
      expect(await gitText(dir, ["branch", "--show-current"])).toBe(branch)
      expect(await Bun.file(path.join(dir, ".magi", "runs", result.runID, "plan.json")).exists()).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("self-improvement safety does not switch branches when user work is dirty", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "magi-safety-"))
    try {
      await git(dir, ["init"])
      await Bun.write(path.join(dir, "README.md"), "dirty\n")

      const result = await prepareSelfImprovementSafety({
        directory: dir,
        title: "Improve plugin onboarding",
        prompt: "Improve onboarding.",
        config: await loadMagiRuntimeConfig(dir),
      })

      expect(result.branch).toBeUndefined()
      expect(result.warnings.some((warning) => warning.includes("Working tree is not clean"))).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("loads member-specific configurations", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "magi-runtime-"))
    await mkdir(path.join(dir, ".magi"), { recursive: true })
    await Bun.write(
      path.join(dir, ".magi", "config.jsonc"),
      JSON.stringify({
        council: {
          model: "gemini-global",
          melchior: {
            provider: "openai",
            model: "gpt-4o-test",
          },
          balthasar: {
            provider: "anthropic",
            model: "claude-test",
          }
        },
      }),
    )

    try {
      const config = await loadMagiRuntimeConfig(dir)
      expect(config.council.model).toBe("gemini-global")
      expect(config.council.melchior?.provider).toBe("openai")
      expect(config.council.melchior?.model).toBe("gpt-4o-test")
      expect(config.council.balthasar?.provider).toBe("anthropic")
      expect(config.council.balthasar?.model).toBe("claude-test")
      expect(config.council.casper).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

async function git(directory: string, args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" })
  expect(await proc.exited).toBe(0)
}

async function gitText(directory: string, args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" })
  const text = await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  return text.trim()
}
