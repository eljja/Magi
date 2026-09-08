import { describe, expect, it } from "bun:test"
import { mkdtemp, mkdir } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { detectOmO, harmonizeOmOConfig } from "../src/omo-bridge"

describe("OmO Bridge & Harmonization", () => {
  it("detects when OmO is not installed and reports instructions", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "magi-omo-test-"))
    await mkdir(path.join(dir, ".opencode"), { recursive: true })
    await Bun.write(path.join(dir, ".opencode", "opencode.json"), JSON.stringify({ plugin: ["oh-my-magi"] }))

    const status = await detectOmO(dir)
    expect(status.installed).toBe(false)
    expect(status.issues.some((issue) => issue.includes("oh-my-openagent"))).toBe(true)
  })

  it("detects when OmO is registered in opencode.json", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "magi-omo-test-"))
    await mkdir(path.join(dir, ".opencode"), { recursive: true })
    await Bun.write(
      path.join(dir, ".opencode", "opencode.json"),
      JSON.stringify({ plugin: ["oh-my-openagent", "oh-my-magi"] }),
    )

    const status = await detectOmO(dir)
    expect(status.installed).toBe(true)
    expect(status.pluginSpec).toBe("oh-my-openagent")
  })

  it("harmonizes OmO config by disabling competing continuation hooks", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "magi-omo-test-"))
    await Bun.write(path.join(dir, "oh-my-openagent.jsonc"), JSON.stringify({ disabled_hooks: [] }))

    const res = await harmonizeOmOConfig(dir)
    expect(res.harmonized).toBe(true)

    const updated = (await Bun.file(res.configPath).json()) as { disabled_hooks: string[] }
    expect(updated.disabled_hooks).toContain("todo-continuation-enforcer")
  })
})
