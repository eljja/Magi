import { mutateMagiState } from "./state"
import { appendReport } from "./reporting"
import { rememberConversation } from "./memory"

export async function queueSteering(
  directory: string,
  text: string,
  source?: { sessionID: string; messageID: string },
) {
  const directive = text.trim()
  if (!directive) throw new Error("Provide a non-empty steering directive")
  const item = { id: crypto.randomUUID(), time: Date.now(), text: directive, ...(source ? { source } : {}) }
  const saved = await mutateMagiState(directory, (state) => {
    if (
      source &&
      (!state.loopActive || state.sessionID !== source.sessionID || state.ignoredMessageIDs?.includes(source.messageID))
    )
      return state
    return {
      ...state,
      steeringQueue: [...(state.steeringQueue ?? []), item],
      ...(source ? { ignoredMessageIDs: [...(state.ignoredMessageIDs ?? []), source.messageID].slice(-100) } : {}),
    }
  })
  if (!saved.steeringQueue?.some((entry) => entry.id === item.id)) return
  await rememberConversation(directory, item)
  await appendReport(
    directory,
    "COUNCIL.md",
    `\n\n## User intervention · ${new Date(item.time).toISOString()}\n\n${directive}\n\nReceipt: ${item.id}.${source ? " Conversation message: " + source.messageID + "." : ""} Queued for council review; questions remain questions, not new work authorization.\n`,
  )
  return item
}
