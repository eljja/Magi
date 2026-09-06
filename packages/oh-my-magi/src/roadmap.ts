import path from "node:path"
import { mkdir } from "node:fs/promises"

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
  return (await Bun.file(file).json().catch(() => undefined)) as ProjectRoadmap | undefined
}

export async function writeRoadmap(directory: string, roadmap: ProjectRoadmap): Promise<void> {
  await mkdir(path.join(directory, ".magi"), { recursive: true })
  await Bun.write(magiRoadmapJsonPath(directory), JSON.stringify(roadmap, null, 2))
  await Bun.write(magiRoadmapPath(directory), formatRoadmapMarkdown(roadmap))
}

export async function initializeRoadmap(input: {
  directory: string
  goal: string
  milestones?: { title: string; description: string }[]
}): Promise<ProjectRoadmap> {
  const defaultMilestones: { title: string; description: string }[] = input.milestones ?? [
    {
      title: "Environment, Tooling & Baseline Setup",
      description: "Set up required dependencies, research/fetch tools, and automated verification scripts.",
    },
    {
      title: "Core Domain Research & Architecture Design",
      description: "Perform literature review, screen material candidates, and design component architecture.",
    },
    {
      title: "Detailed Implementation & Device Modeling",
      description: "Implement core modules, layer stacking specifications, or code components.",
    },
    {
      title: "Mechanical Verification & Flaw Audit",
      description: "Execute test scripts, verify constraints, and eliminate regression risks or physical flaws.",
    },
    {
      title: "Final Integration & Documentation",
      description: "Complete final synthesis, verify all deliverables, and produce executive summary report.",
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
    `**Progress**: ${completedCount}/${totalCount} milestones completed (${percent}%)`,
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
