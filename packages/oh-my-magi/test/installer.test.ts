import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { doctorOhMyMagi, getStatusReport, installOhMyMagi } from "../src/installer"

describe("Installer & Doctor", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "magi-install-test-"))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  test("installs plugin files and registers command", async () => {
    const res = await installOhMyMagi({ projectDirectory: tempDir })
    expect(await Bun.file(res.commandFile).exists()).toBe(true)
    expect(await Bun.file(res.agentFile).exists()).toBe(true)
    expect(await Bun.file(res.configFile).exists()).toBe(true)
    expect(await Bun.file(res.tuiFile).exists()).toBe(true)

    const configContent = await Bun.file(res.configFile).json()
    expect(configContent.plugin).toContain("oh-my-magi")
  })

  test("doctor checks installation health accurately", async () => {
    const uninstalledReport = await doctorOhMyMagi(tempDir)
    expect(uninstalledReport.ok).toBe(false)
    expect(uninstalledReport.issues.length).toBeGreaterThan(0)

    await installOhMyMagi({ projectDirectory: tempDir })
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
})
