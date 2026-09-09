import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { containsMagiSpec, doctorOhMyMagi, getStatusReport, installOhMyMagi } from "../src/installer"
import { parseJsonc } from "../src/config"

describe("Installer & Doctor", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "magi-install-test-"))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  test("installs plugin files and registers command", async () => {
    const res = await installOhMyMagi({ projectDirectory: tempDir, migrationFiles: [] })
    expect(await Bun.file(res.configFile).exists()).toBe(true)
    expect(await Bun.file(res.tuiFile).exists()).toBe(true)

    const configContent = await Bun.file(res.configFile).json()
    expect(configContent.plugin).toContain("oh-my-magi")
  })

  test("doctor checks installation health accurately", async () => {
    const uninstalledReport = await doctorOhMyMagi(tempDir)
    expect(uninstalledReport.ok).toBe(false)
    expect(uninstalledReport.issues.length).toBeGreaterThan(0)

    await installOhMyMagi({ projectDirectory: tempDir, migrationFiles: [] })
    const installedReport = await doctorOhMyMagi(tempDir)
    expect(installedReport.ok).toBe(true)
    expect(installedReport.issues.length).toBe(0)
  })

  test("generates status report", async () => {
    const report = await getStatusReport(tempDir)
    expect(report).toContain("Oh-My-Magi Status")
    expect(report).toContain(tempDir)
    expect(report).toContain("Loop Active: false")
  })

  test("migrates legacy and duplicate registrations, preserving comments and unrelated plugins", async () => {
    const file = path.join(tempDir, ".opencode", "opencode.jsonc")
    await Bun.write(
      file,
      '{\n// Keep this comment\n"plugin": ["@magi/opencode-plugin", "oh-my-magi/tui", "some-magi-helper"], "model": "local/model",\n}',
    )
    await Bun.write(
      path.join(tempDir, ".opencode", "plugins", "magi-server.ts"),
      'export { default, MagiServerPlugin } from "../../packages/magi-opencode-plugin/src/server"',
    )
    await installOhMyMagi({ projectDirectory: tempDir, migrationFiles: [] })
    const text = await Bun.file(file).text()
    expect(text).toContain("Keep this comment")
    expect(parseJsonc(text)).toEqual({ plugin: ["oh-my-magi", "some-magi-helper"], model: "local/model" })
    expect(await Bun.file(path.join(tempDir, ".opencode", "plugins", "magi-server.ts")).exists()).toBe(false)
    expect(containsMagiSpec("some-magi-helper")).toBe(false)
    expect(containsMagiSpec(["oh-my-magi@0.1.0", {}])).toBe(true)
    expect((await Bun.file(path.join(tempDir, ".opencode", "tui.json")).json()).plugin).toEqual(["oh-my-magi"])
  })

  test("invalid JSONC is never overwritten by installation", async () => {
    const file = path.join(tempDir, ".opencode", "opencode.jsonc")
    const original = '{"plugin": [unclosed'
    await Bun.write(file, original)
    await expect(installOhMyMagi({ projectDirectory: tempDir, migrationFiles: [] })).rejects.toThrow("Invalid JSONC")
    expect(await Bun.file(file).text()).toBe(original)
  })
})
