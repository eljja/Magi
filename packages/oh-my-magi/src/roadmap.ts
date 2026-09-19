import { atomicWriteFile } from "./fs"
import path from "node:path"

export type Milestone = {
  id: number
  title: string
  description: string
  completed: boolean
  evidence?: string
}

export type ProjectRoadmap = {
  goal: string
  milestones: Milestone[]
  updatedAt: number
  mode?: "continuous" | "complete"
}

export function magiRoadmapPath(directory: string) {
  return path.join(directory, ".magi", "ROADMAP.md")
}

export function magiRoadmapJsonPath(directory: string) {
  return path.join(directory, ".magi", "roadmap.json")
}

export async function readRoadmap(directory: string): Promise<ProjectRoadmap | undefined> {
  const file = magiRoadmapJsonPath(directory)
  if (!(await Bun.file(file).exists())) return undefined
  return (await Bun.file(file)
    .json()
    .catch(() => undefined)) as ProjectRoadmap | undefined
}

export async function writeRoadmap(directory: string, roadmap: ProjectRoadmap): Promise<void> {
  await atomicWriteFile(magiRoadmapJsonPath(directory), JSON.stringify(roadmap, null, 2))
  await atomicWriteFile(magiRoadmapPath(directory), formatRoadmapMarkdown(roadmap))
}

export async function initializeRoadmap(input: {
  directory: string
  goal: string
  milestones?: { title: string; description: string }[]
  mode?: "continuous" | "complete"
}): Promise<ProjectRoadmap> {
  const defaultMilestones: { title: string; description: string }[] = input.milestones ?? [
    {
      title:
        input.mode === "continuous" ? "Continuously advance the user's goal" : "Deliver and verify the user's goal",
      description: `Advance the requested outcome with reproducible evidence: ${input.goal}. The council chooses concrete increments toward this outcome. Inspect only what is needed, then implement or experiment and verify; a baseline report alone does not satisfy a request to fix or develop something. Preserve existing checks, repair failures, document results and limitations. ${input.mode === "continuous" ? "Keep improving this same goal at natural progress checkpoints. No separate completion vote is required." : "Completion requires evidence for the user's requested outcome, not merely one successful subtask."}`,
    },
  ]

  const roadmap: ProjectRoadmap = {
    goal: input.goal,
    milestones: defaultMilestones.map((m, index) => ({
      id: index + 1,
      title: m.title,
      description: m.description,
      completed: false,
    })),
    updatedAt: Date.now(),
    mode: input.mode,
  }

  await writeRoadmap(input.directory, roadmap)
  return roadmap
}

export async function markMilestoneComplete(
  directory: string,
  milestoneId: number,
  evidence?: string,
): Promise<ProjectRoadmap | undefined> {
  const current = await readRoadmap(directory)
  if (!current) return undefined

  const updatedMilestones = current.milestones.map((m) =>
    m.id === milestoneId ? { ...m, completed: true, evidence } : m,
  )

  const updated: ProjectRoadmap = {
    ...current,
    milestones: updatedMilestones,
    updatedAt: Date.now(),
  }

  await writeRoadmap(directory, updated)
  return updated
}

export function getCurrentMilestone(roadmap: ProjectRoadmap): Milestone | undefined {
  return roadmap.milestones.find((m) => !m.completed)
}

export function isRoadmapCompleted(roadmap: ProjectRoadmap): boolean {
  return roadmap.milestones.length > 0 && roadmap.milestones.every((m) => m.completed)
}

export function formatRoadmapMarkdown(roadmap: ProjectRoadmap): string {
  const completedCount = roadmap.milestones.filter((m) => m.completed).length
  const totalCount = roadmap.milestones.length
  const percent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0

  return [
    `# Project Master Roadmap: ${roadmap.goal}`,
    "",
    roadmap.mode === "continuous"
      ? "**운영**: 지속 모드 · 완료율 대신 .magi/COUNCIL.md와 LATEST-REPORT.md에서 실제 진행을 확인하세요."
      : `**Progress**: ${completedCount}/${totalCount} milestones completed (${percent}%)`,
    `**Last Updated**: ${new Date(roadmap.updatedAt).toISOString()}`,
    "",
    "## Milestones",
    ...roadmap.milestones.map((m) => {
      const check = m.completed ? "[x]" : "[ ]"
      const statusText = m.completed ? "*(Completed)*" : "*(In Progress / Pending)*"
      return [
        `### ${check} Milestone #${m.id}: ${m.title} ${statusText}`,
        m.description,
        m.evidence ? `> **Verified Evidence**: ${m.evidence}` : undefined,
        "",
      ]
        .filter((l): l is string => l !== undefined)
        .join("\n")
    }),
  ].join("\n")
}
