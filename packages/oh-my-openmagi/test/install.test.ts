import { test, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { install } from "../src/installer"
import { parse } from "jsonc-parser"
import { registrationName } from "../src/registrations"

test("nested package registrations identify the dependency rather than the ancestor checkout", () => {
  expect(registrationName("file:///D:/oh-my-openmagi/consumer/node_modules/oh-my-opencode")).toBe("opencode")
  expect(registrationName("C:\\oh-my-magi\\node_modules\\oh-my-openmagi\\dist\\server.js")).toBe("openmagi")
  expect(registrationName("/oh-my-openmagi/oh-my-magi/dist/index.js")).toBe("magi")
})

test("migration preserves comments, models and unrelated plugins, backs up originals, and is idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openmagi-install-"))
  await (async () => {
    const original =
      '{\n // keep this comment\n "model":"custom/model", "plugin":["oh-my-opencode@4.19.4",["another-plugin",{"keep":true}]],\n}\n'
    await Bun.write(path.join(root, "opencode.jsonc"), original)
    await Bun.write(path.join(root, ".opencode", "opencode.json"), '{"plugin":["oh-my-magi@0.1.1"]}')
    const result = await install(root, false)
    const content = await Bun.file(path.join(root, "opencode.jsonc")).text()
    expect(content).toContain("// keep this comment")
    expect(parse(content).model).toBe("custom/model")
    expect(parse(content).plugin).toEqual([["another-plugin", { keep: true }], "oh-my-magi@0.2.0"])
    expect(await Bun.file(path.join(result.backup, "opencode.jsonc")).text()).toBe(original)
    expect(parse(await Bun.file(path.join(root, ".opencode", "opencode.json")).text()).plugin).toEqual([])
    expect((await install(root)).files).toEqual([])
  })().finally(() => rm(root, { recursive: true, force: true }))
})
test("invalid config fails before writing another config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openmagi-invalid-"))
  await (async () => {
    await Bun.write(path.join(root, "opencode.json"), '{"plugin":["oh-my-opencode"]}')
    await Bun.write(path.join(root, ".opencode", "opencode.jsonc"), "not json")
    await expect(install(root)).rejects.toThrow("Invalid OpenCode configuration")
    expect(await Bun.file(path.join(root, "opencode.json")).text()).toBe('{"plugin":["oh-my-opencode"]}')
  })().finally(() => rm(root, { recursive: true, force: true }))
})

test("local file registrations are migrated and array roots are rejected before writes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openmagi-local-install-"))
  await (async () => {
    const old = JSON.stringify({
      model: "local/test",
      plugin: [
        "file:///D:/old/oh-my-opencode/dist/index.js",
        "C:/old/oh-my-magi",
        "oh-my-magi-not-related",
        ["unrelated", { keep: true }],
      ],
    })
    await Bun.write(path.join(root, "opencode.json"), old)
    await Bun.write(path.join(root, ".opencode", "tui.json"), "[]")
    await expect(install(root)).rejects.toThrow("Invalid OpenCode configuration")
    expect(await Bun.file(path.join(root, "opencode.json")).text()).toBe(old)
    await Bun.write(path.join(root, ".opencode", "tui.json"), "{}")
    await install(root)
    expect(parse(await Bun.file(path.join(root, "opencode.json")).text()).plugin).toEqual([
      "oh-my-magi-not-related",
      ["unrelated", { keep: true }],
      "oh-my-magi@0.2.0",
    ])
  })().finally(() => rm(root, { recursive: true, force: true }))
})
