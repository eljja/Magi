import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  formatRoadmapMarkdown,
  getCurrentMilestone,
  initializeRoadmap,
  isRoadmapCompleted,
  markMilestoneComplete,
  readRoadmap,
} from "../src/roadmap"

describe("Roadmap & Todo Ledger", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "magi-roadmap-test-"))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  test("initializes master roadmap with structured milestones", async () => {
    const roadmap = await initializeRoadmap({
      directory: tempDir,
      goal: "Develop transparent oxide thin-film transistor",
    })

    expect(roadmap.goal).toBe("Develop transparent oxide thin-film transistor")
    expect(roadmap.milestones.length).toBe(5)
    expect(roadmap.milestones[0]?.completed).toBe(false)
    expect(isRoadmapCompleted(roadmap)).toBe(false)

    const disk = await readRoadmap(tempDir)
    expect(disk).toBeDefined()
    expect(disk?.milestones.length).toBe(5)
  })

  test("tracks milestone completion and advances active milestone", async () => {
    const roadmap = await initializeRoadmap({
      directory: tempDir,
      goal: "Build authentication service",
    })

    let current = getCurrentMilestone(roadmap)
    expect(current?.id).toBe(1)

    const updated1 = await markMilestoneComplete(tempDir, 1, "Environment and scripts ready")
    expect(updated1?.milestones[0]?.completed).toBe(true)

    current = getCurrentMilestone(updated1!)
    expect(current?.id).toBe(2)

    // Complete all milestones
    await markMilestoneComplete(tempDir, 2)
    await markMilestoneComplete(tempDir, 3)
    await markMilestoneComplete(tempDir, 4)
    const finalRoadmap = await markMilestoneComplete(tempDir, 5)

    expect(isRoadmapCompleted(finalRoadmap!)).toBe(true)
    expect(getCurrentMilestone(finalRoadmap!)).toBeUndefined()
  })

  test("formats clean markdown view with progress", async () => {
    const roadmap = await initializeRoadmap({
      directory: tempDir,
      goal: "Thin film solar cell",
    })
    await markMilestoneComplete(tempDir, 1, "Literature collected")

    const current = (await readRoadmap(tempDir))!
    const md = formatRoadmapMarkdown(current)

    expect(md).toContain("# Project Master Roadmap: Thin film solar cell")
    expect(md).toContain("1/5 milestones completed (20%)")
    expect(md).toContain("[x] Milestone #1")
    expect(md).toContain("[ ] Milestone #2")
    expect(md).toContain("**Verified Evidence**: Literature collected")
  })
})
