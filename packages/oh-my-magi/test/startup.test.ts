import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { Config } from "@opencode-ai/plugin"
import { createMagiSetupHooks } from "../src/omo-runtime"

test("migration/setup problems leave a selectable primary Magi with an actionable error", async () => {
  const hooks = createMagiSetupHooks("Restart OpenCode once to activate OMM")
  const config: Config = {}
  await hooks.config!(config)
  expect(config.agent?.magi?.mode).toBe("primary")
  expect(config.agent?.magi?.prompt).toContain("Restart OpenCode")
  expect(hooks.tool).toBeUndefined()
  expect(hooks.event).toBeUndefined()
})

test("missing Git executable does not prevent context or a recorded council directive", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "magi-without-git-"))
  try {
    const source = (name: string) =>
      JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../src/" + name)).href)
    const script = `import { collectMagiContext } from ${source("context.ts")};
      import { prepareBranchSafety, formatSafetyEnvelope } from ${source("safety.ts")};
      const context = await collectMagiContext({directory: process.cwd()});
      const safety = await prepareBranchSafety({directory: process.cwd(), title: "Research", prompt: "Inspect evidence"});
      console.log(JSON.stringify({git: Bun.which("git"), context, safety, prompt: formatSafetyEnvelope({prompt:"Inspect evidence", safety})}));`
    const proc = Bun.spawn([process.execPath, "-e", script], {
      cwd: directory,
      env: { ...process.env, PATH: "", Path: "" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [text, error, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(error).toBe("")
    expect(code).toBe(0)
    const result = JSON.parse(text)
    expect(result.git).toBeNull()
    expect(result.context.text).toContain("Git is optional")
    expect(result.safety.branch).toBeUndefined()
    expect(await Bun.file(result.safety.reportPath).exists()).toBe(true)
    expect(result.prompt).toContain("without installing or initializing")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
