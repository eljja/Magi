import { mutateMagiState, type MagiCouncilObservation, type MagiRuntimeState } from "./state"
import type { MagiCouncilMember } from "./council"
import { redact } from "./context"

export type ToolExecutionRecord = {
  tool: string
  sessionID: string
  callID: string
  args: unknown
  title?: string
  output?: string
  runID?: string
}

/**
 * Records a tool execution by Sisyphus / workforce and generates a real-time Council observation.
 */
export async function recordToolExecution(
  directory: string,
  record: ToolExecutionRecord,
): Promise<MagiCouncilObservation | undefined> {
  const toolName = record.tool.toLowerCase()
  const argsStr = new Bun.CryptoHasher("sha256")
    .update(typeof record.args === "string" ? record.args : JSON.stringify(record.args ?? {}))
    .digest("hex")
  const targetPath = extractTargetFile(record.args)
  const isFailure = record.output ? isOutputFailure(record.output) : false

  let member: MagiCouncilMember = "casper"
  let perspective: "architecture" | "safety" | "progress" = "progress"
  let observationText = ""

  if (toolName.includes("write") || toolName.includes("edit") || toolName.includes("patch")) {
    member = "melchior"
    perspective = "architecture"
    observationText = targetPath
      ? `Tool-reported file modification in '${targetPath}'. Queued as architectural evidence; not yet reviewed.`
      : `File edit tool '${record.tool}' completed. Structural evidence awaits council review.`
  } else if (toolName.includes("bash") || toolName.includes("sh") || toolName.includes("terminal")) {
    member = "balthasar"
    perspective = "safety"
    if (isFailure) {
      observationText = `Possible command failure in '${record.tool}' (output heuristic). Evidence awaits verification.`
    } else {
      observationText = `Command tool '${record.tool}' returned evidence. Success has not been independently verified.`
    }
  } else if (toolName.includes("task") || toolName.includes("agent")) {
    member = "casper"
    perspective = "progress"
    observationText = `Delegation tool '${record.tool}' returned. Inspect child results before claiming completion.`
  } else {
    member = "casper"
    perspective = "progress"
    observationText = `Workforce tool '${record.tool}' returned. Progress telemetry only.`
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
    if (record.runID && (!state.loopActive || state.runID !== record.runID)) return state
    const currentTelemetry = state.telemetry ?? {
      toolCallCount: 0,
      modifiedFiles: [],
      lastActiveAt: Date.now(),
      stallCount: 0,
    }

    const modified = new Set(currentTelemetry.modifiedFiles)
    if (targetPath && /write|edit|patch/.test(toolName)) modified.add(targetPath)

    const isRepeatedTool = currentTelemetry.lastTool === record.tool && currentTelemetry.lastToolArgs === argsStr
    const stallCount = isRepeatedTool ? currentTelemetry.stallCount + 1 : 0

    const updatedTelemetry = {
      toolCallCount: currentTelemetry.toolCallCount + 1,
      lastTool: record.tool,
      lastToolArgs: argsStr,
      lastToolOutput: redact(record.output ?? "").slice(0, 300),
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
      lines.push(
        `- Modified Files (${tel.modifiedFiles.length}): ${tel.modifiedFiles
          .slice(-5)
          .map((f) => `\`${f}\``)
          .join(", ")}`,
      )
    }
    if (tel.stallCount >= 3) {
      lines.push(
        `- ⚠️ **Balthasar Alert:** Detected ${tel.stallCount} repetitive tool invocations. Potential stall detected.`,
      )
    }
  }

  if (state.observations && state.observations.length > 0) {
    lines.push("", "**Automatic telemetry by council perspective (not LLM judgments):**")
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
  for (const key of ["filePath", "path", "file", "targetFile", "filepath", "target", "filename"]) {
    if (typeof obj[key] === "string") return obj[key] as string
  }
  return undefined
}

function isOutputFailure(output: string): boolean {
  const lower = output.toLowerCase()
  return (
    lower.includes("error:") || lower.includes("failed") || lower.includes("exit code 1") || lower.includes("exception")
  )
}
