import { expect, test } from "bun:test"
import { mkdtemp, readdir } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import {
  containsOmOSpec,
  detectOmO,
  harmonizeOmOConfig,
  OMO_MANAGED_HOOKS,
  resolveExecutorAgent,
} from "../src/omo-bridge"
import { parseJsonc } from "../src/config"
import { openCodeFixture } from "./fixture"

test("OmO is a real dependency, independent of a plugin-name string", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "magi-omo-"))
  const status = await detectOmO(dir)
  expect(status.installed).toBe(true)
  expect(status.loaded).toBe(false)
  const module = await import("oh-my-opencode")
  expect(typeof module.default.server).toBe("function")
  expect(containsOmOSpec("fake-oh-my-opencode-malware")).toBe(false)
  expect(containsOmOSpec(["oh-my-opencode@4.19.4", {}])).toBe(true)
})

test("canonical OmO config preserves comments, settings and disables all competing macro hooks idempotently", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "magi-omo-"))
  await Bun.write(
    path.join(dir, ".omo", "omo.jsonc"),
    '{\n// keep my configuration\n"disabled_hooks":["comment-checker"],"agents":{"oracle":{"model":"local/model"}},"profiles":{"local":{"disabled_hooks":[]}}\n}',
  )
  const result = await harmonizeOmOConfig(dir)
  const text = await Bun.file(result.configPath).text()
  expect(text).toContain("// keep my configuration")
  expect(text).toContain('"local/model"')
  const config = parseJsonc(text) as {
    "[opencode]": { disabled_hooks: string[] }
    profiles: { local: { "[opencode]": { disabled_hooks: string[] } } }
  }
  for (const hook of OMO_MANAGED_HOOKS) {
    expect(config["[opencode]"].disabled_hooks).toContain(hook)
    expect(config.profiles.local["[opencode]"].disabled_hooks).toContain(hook)
  }
  expect(config["[opencode]"].disabled_hooks).toContain("comment-checker")
  await harmonizeOmOConfig(dir)
  expect(await Bun.file(result.configPath).text()).toBe(text)
  expect((await readdir(path.join(dir, ".magi", "backups"))).length).toBe(1)
  const ignore = await Bun.file(path.join(dir, ".magi", ".gitignore")).text()
  for (const artifact of ["/members/", "/MEMORY.md", "/USER-GUIDANCE.md"]) expect(ignore).toContain(artifact)
})

test("executor resolution verifies real API agents and never falls back silently", async () => {
  const fixture = openCodeFixture()
  try {
    expect(await resolveExecutorAgent("project", fixture.client)).toBe("sisyphus")
    await expect(resolveExecutorAgent("project")).rejects.toThrow("client is required")
  } finally {
    fixture.stop()
  }
})

test("legacy category overrides become canonical model chains without losing fallbacks or profile settings", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "magi-omo-models-"))
  await Bun.write(
    path.join(dir, ".omo/omo.jsonc"),
    JSON.stringify({
      categories: {
        deep: { model: "local/primary", fallback_models: [{ model: "local/backup", variant: "low" }], variant: "high" },
        quick: { models: ["local/canonical"] },
      },
      opencode: { categories: { writing: { model: "local/writer" } } },
      profiles: { local: { opencode: { categories: { deep: { model: "local/profile" } } } } },
    }),
  )
  const result = await harmonizeOmOConfig(dir)
  const text = await Bun.file(result.configPath).text()
  const config = JSON.parse(text)
  expect(config.categories.deep.models).toEqual(["local/primary", { model: "local/backup", variant: "low" }])
  expect(config.categories.deep.model).toBeUndefined()
  expect(config.categories.deep.fallback_models).toBeUndefined()
  expect(config.categories.deep.variant).toBe("high")
  expect(config.categories.quick.models).toEqual(["local/canonical"])
  expect(config["[opencode]"].categories.writing.models).toEqual(["local/writer"])
  expect(config.profiles.local["[opencode]"].categories.deep.models).toEqual(["local/profile"])
  await harmonizeOmOConfig(dir)
  expect(await Bun.file(result.configPath).text()).toBe(text)
})
