import { mutateMagiState, type MagiCouncilObservation, type MagiRuntimeState } from "./state"
import type { MagiCouncilMember } from "./council"

export type ToolExecutionRecord = {
  tool: string
  sessionID: string
  callID: string
  args: unknown
  title?: string
  output?: string
}

/**
 * Records a tool execution by Sisyphus / workforce and generates a real-time Council observation.
 */
export async function recordToolExecution(
  directory: string,
  record: ToolExecutionRecord,
): Promise<MagiCouncilObservation | undefined> {
  const toolName = record.tool.toLowerCase()
  const argsStr = typeof record.args === "string" ? record.args : JSON.stringify(record.args ?? {})
  const targetPath = extractTargetFile(record.args)
  const isFailure = record.output ? isOutputFailure(record.output) : false

  let member: MagiCouncilMember = "casper"
  let perspective: "architecture" | "safety" | "progress" = "progress"
  let observationText = ""

  if (toolName.includes("write") || toolName.includes("edit") || toolName.includes("patch")) {
    member = "melchior"
    perspective = "architecture"
    observationText = targetPath
      ? `Observed file modification in '${targetPath}'. Melchior evaluating architectural fit.`
      : `Observed file edit via '${record.tool}'. Melchior tracking structural changes.`
  } else if (toolName.includes("bash") || toolName.includes("sh") || toolName.includes("terminal")) {
    member = "balthasar"
    perspective = "safety"
    if (isFailure) {
      observationText = `Command failure detected in '${record.tool}'. Balthasar logging regression risk.`
    } else {
      observationText = `Command completed cleanly in '${record.tool}'. Balthasar auditing execution evidence.`
    }
  } else if (toolName.includes("task") || toolName.includes("agent")) {
    member = "casper"
    perspective = "progress"
    observationText = `Subagent delegated via '${record.tool}'. Casper monitoring user intent alignment.`
  } else {
    member = "casper"
    perspective = "progress"
    observationText = `Sisyphus executed '${record.tool}'. Casper tracking milestone momentum.`
  }

  const observation: MagiCouncilObservation = {
    time: Date.now(),
    member,
    perspective,
    observation: observationText,
    tool: record.tool,
    target: targetPath,
  }

  await mutateMagiState(directory, (state: MagiRuntimeState) => {
    const currentTelemetry = state.telemetry ?? {
      toolCallCount: 0,
      modifiedFiles: [],
      lastActiveAt: Date.now(),
      stallCount: 0,
    }

    const modified = new Set(currentTelemetry.modifiedFiles)
    if (targetPath) modified.add(targetPath)

    const isRepeatedTool = currentTelemetry.lastTool === record.tool && currentTelemetry.lastToolArgs === argsStr
    const stallCount = isRepeatedTool ? currentTelemetry.stallCount + 1 : 0

    const updatedTelemetry = {
      toolCallCount: currentTelemetry.toolCallCount + 1,
      lastTool: record.tool,
      lastToolArgs: argsStr.slice(0, 200),
      lastToolOutput: (record.output ?? "").slice(0, 300),
      modifiedFiles: Array.from(modified).slice(-20),
      lastActiveAt: Date.now(),
      stallCount,
    }

    const observations = [...(state.observations ?? []), observation].slice(-12)

    return {
      ...state,
      telemetry: updatedTelemetry,
      observations,
    }
  })

  return observation
}

/**
 * Formats a live council observation and telemetry bulletin.
 */
export function formatCouncilObservationBulletin(state: MagiRuntimeState): string[] {
  const lines: string[] = []
  const tel = state.telemetry

  if (tel && tel.toolCallCount > 0) {
    lines.push(`**Workforce Telemetry:** ${tel.toolCallCount} operations performed`)
    if (tel.lastTool) {
      lines.push(`- Last Active Tool: \`${tel.lastTool}\``)
    }
    if (tel.modifiedFiles.length > 0) {
      lines.push(`- Modified Files (${tel.modifiedFiles.length}): ${tel.modifiedFiles.slice(-5).map((f) => `\`${f}\``).join(", ")}`)
    }
    if (tel.stallCount >= 3) {
      lines.push(`- ⚠️ **Balthasar Alert:** Detected ${tel.stallCount} repetitive tool invocations. Potential stall detected.`)
    }
  }

  if (state.observations && state.observations.length > 0) {
    lines.push("", "**Council Live Observations:**")
    for (const obs of state.observations.slice(-4)) {
      const tag = `[${obs.member.toUpperCase()} • ${obs.perspective.toUpperCase()}]`
      lines.push(`- ${tag} ${obs.observation}`)
    }
  }

  return lines
}

function extractTargetFile(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined
  const obj = args as Record<string, unknown>
  for (const key of ["path", "file", "targetFile", "filepath", "target", "filename"]) {
    if (typeof obj[key] === "string") return obj[key] as string
  }
  return undefined
}

function isOutputFailure(output: string): boolean {
  const lower = output.toLowerCase()
  return lower.includes("error:") || lower.includes("failed") || lower.includes("exit code 1") || lower.includes("exception")
}
