import type { PluginInput } from "@opencode-ai/plugin"
import { isWorkforceSession } from "./workforce"
import { readMagiState, updateMagiState } from "./state"
import { loadMagiConfig } from "./config"

const aborting = new Set<string>()
export const isRecoveryAbort = (directory: string, sessionID: string) => aborting.has(directory + "\n" + sessionID)

export function createWorkforceWatchdog(directory: string, client: PluginInput["client"]) {
  const activity = new Map<string, { signature: string; since: number }>()
  return async (owner: string, now = Date.now()) => {
    const response = await client.session.status({ query: { directory }, signal: AbortSignal.timeout(10000) })
    if (response.error) throw new Error("Cannot determine workforce activity")
    const sessions = (
      await Promise.all(
        Object.entries(response.data ?? {})
          .filter(([, status]) => status.type !== "idle")
          .map(async ([id]) => ((await isWorkforceSession(client, directory, id, owner)) ? id : undefined)),
      )
    ).filter((id) => id !== undefined)
    for (const id of activity.keys()) if (!sessions.includes(id)) activity.delete(id)
    if (!sessions.length) return false
    const snapshots = await Promise.all(
      sessions.map(async (id) => {
        const messages = await client.session.messages({
          path: { id },
          query: { directory, limit: 8 },
          signal: AbortSignal.timeout(10000),
        })
        if (messages.error || !messages.data) throw new Error("Cannot inspect workforce progress")
        const signature = new Bun.CryptoHasher("sha256").update(JSON.stringify(messages.data)).digest("hex")
        if (activity.get(id)?.signature !== signature) activity.set(id, { signature, since: now })
        return { id, messages: messages.data }
      }),
    )
    const settings = await loadMagiConfig(directory)
    if (sessions.some((id) => now - activity.get(id)!.since < (settings.resilience.stallTimeoutMs ?? 1800000)))
      return true
    // A question awaiting the user is not a stalled executor.
    if (
      snapshots.some(({ messages }) =>
        messages.some((message) =>
          message.parts.some(
            (part) => part.type === "tool" && part.tool === "question" && part.state.status !== "completed",
          ),
        ),
      )
    )
      return true
    const state = await readMagiState(directory)
    if (!state.loopActive || state.sessionID !== owner || !state.awaitingExecution) return true
    await updateMagiState(
      directory,
      {
        time: now,
        type: "continuation",
        title: "Recovering stalled workforce",
        text: "No message or tool progress within the configured stall timeout. Abort the stalled attempt, then inspect artifacts before retrying the approved task.",
      },
      { awaitingExecution: false },
      24,
      state.runID,
    )
    sessions.forEach((id) => aborting.add(directory + "\n" + id))
    try {
      const results = await Promise.all(
        sessions.map((id) =>
          client.session.abort({ path: { id }, query: { directory }, signal: AbortSignal.timeout(10000) }),
        ),
      )
      if (results.some((result) => result.error))
        throw new Error("Stalled workforce could not be aborted; no replacement dispatched")
      const latest = await readMagiState(directory)
      if (latest.loopActive && latest.runID === state.runID)
        await updateMagiState(
          directory,
          {
            time: now,
            type: "continuation",
            title: "Stalled attempt aborted",
            text: "The next idle check will resume the approved step after checking existing evidence.",
          },
          {
            awaitingExecution: true,
            executionAfter: Date.now() - 60001,
            ignoredMessageIDs: [
              ...new Set([
                ...(latest.ignoredMessageIDs ?? []),
                ...snapshots.flatMap(({ messages }) =>
                  messages.filter((message) => message.info.role === "user").map((message) => message.info.id),
                ),
              ]),
            ].slice(-100),
          },
          24,
          state.runID,
        )
    } finally {
      sessions.forEach((id) => {
        aborting.delete(directory + "\n" + id)
        activity.delete(id)
      })
    }
    return true
  }
}
