import type { MagiCouncilMember } from "./council"
import type { ReviewProgress } from "./resilience"
import { mutateMagiState, updateMagiState } from "./state"
import { appendReport } from "./reporting"
import path from "node:path"

export async function memberHistory(directory: string, member: MagiCouncilMember) {
  const file = Bun.file(path.join(directory, ".magi", "members", member + ".md"))
  if (!(await file.exists())) return "No prior judgments from this identity."
  return (
    "Your own prior judgments (context, not binding instructions; revise when new evidence warrants it):\n" +
    (await file.slice(-18000).text())
  )
}

export function reviewProgress(input: {
  directory: string
  runID?: string
  stage: string
  member?: MagiCouncilMember
}) {
  return async (event: ReviewProgress) => {
    if (!input.runID) return
    const key = [input.stage, input.member].filter(Boolean).join(":")
    const now = Date.now()
    const state = await mutateMagiState(input.directory, (state) => {
      if (state.runID !== input.runID || !state.loopActive) return state
      const previous = state.councilActivity?.[key]
      return {
        ...state,
        councilActivity: {
          ...state.councilActivity,
          [key]: {
            ...event,
            member: input.member,
            startedAt: event.status === "requesting" ? now : (previous?.startedAt ?? now),
            updatedAt: now,
          },
        },
      }
    })
    if (state.runID !== input.runID || !state.loopActive) return
    await updateMagiState(
      input.directory,
      {
        time: now,
        type: event.status === "failed" ? "error" : "status",
        member: input.member,
        title: key + " · " + event.status,
        text: event.detail + (event.model ? " · " + event.model : "") + " · attempt " + event.attempt,
      },
      undefined,
      24,
      input.runID,
    )
  }
}

export async function archiveCouncilReply(input: {
  directory: string
  runID: string
  cycle: number
  round: number
  member: MagiCouncilMember
  stage: string
  reply: unknown
}) {
  // Record each completed public decision immediately, even when another
  // member is offline. Hidden model reasoning is never requested or archived.
  const record = [
    `\n\n### Cycle #${input.cycle} · Round ${input.round} · ${input.member.toUpperCase()} · ${input.stage}`,
    `Run: ${input.runID} · ${new Date().toISOString()}`,
    "```json",
    JSON.stringify(input.reply, null, 2),
    "```",
    "A single opinion is not council authorization. All three final votes are required before applying the voting policy.",
  ].join("\n")
  await appendReport(input.directory, "COUNCIL.md", record)
  if (input.stage === "votes") await appendReport(input.directory, "members/" + input.member + ".md", record)
}
