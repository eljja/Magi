import type { PluginInput } from "@opencode-ai/plugin"
import { isWorkforceSession } from "./workforce"
import { readMagiState, updateMagiState } from "./state"
import { loadMagiConfig } from "./config"
import { redact } from "./context"

const aborting = new Set<string>()
export const isRecoveryAbort = (directory: string, sessionID: string) => aborting.has(directory + "\n" + sessionID)

export function createWorkforceWatchdog(directory: string, client: PluginInput["client"]) {
  const activity = new Map<
    string,
    {
      signature: string
      since: number
      evidenceAt: number
      repeated: boolean
      calls: Set<string>
      evidence: Set<string>
    }
  >()
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
        const progress = activity.get(id) ?? {
          signature,
          since: now,
          evidenceAt: now,
          repeated: false,
          calls: new Set<string>(),
          evidence: new Set<string>(),
        }
        if (progress.signature !== signature) {
          progress.signature = signature
          progress.since = now
        }
        for (const part of messages.data.flatMap((message) => message.parts)) {
          if (part.type !== "tool" || part.state.status !== "completed" || progress.calls.has(part.id)) continue
          progress.calls.add(part.id)
          const fingerprint = new Bun.CryptoHasher("sha256")
            .update(JSON.stringify([part.tool, part.state.input, part.state.output]))
            .digest("hex")
          progress.repeated = progress.evidence.has(fingerprint)
          if (!progress.repeated) progress.evidenceAt = now
          progress.evidence.add(fingerprint)
          // Bound in-memory history without imposing a tool or goal iteration limit.
          if (progress.calls.size > 512) progress.calls.delete(progress.calls.values().next().value!)
          if (progress.evidence.size > 512) progress.evidence.delete(progress.evidence.values().next().value!)
        }
        activity.set(id, progress)
        return { id, messages: messages.data }
      }),
    )
    const settings = await loadMagiConfig(directory)
    if (
      sessions.some((id) => {
        const progress = activity.get(id)!
        const timeout = settings.resilience.stallTimeoutMs ?? 1800000
        return now - progress.since < timeout && (!progress.repeated || now - progress.evidenceAt < timeout)
      })
    )
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
    if (!state.loopActive || (state.executionSessionID ?? state.sessionID) !== owner || !state.awaitingExecution)
      return true
    await updateMagiState(
      directory,
      {
        time: now,
        type: "continuation",
        title: "Recovering stalled workforce",
        text: "No new message or tool evidence within the configured stall timeout. Repeated identical tool results do not count as progress. Abort this attempt and reuse its evidence before continuing.",
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
            executionRecovery: redact(
              "Previous attempt stalled. These are its completed tool results; do not repeat the same investigation. Use the collected facts to finish the approved task.\n" +
                JSON.stringify(
                  snapshots.flatMap(({ messages }) =>
                    messages.flatMap((message) =>
                      message.parts.flatMap((part) =>
                        part.type === "tool" && part.state.status === "completed"
                          ? [{ tool: part.tool, input: part.state.input, output: part.state.output }]
                          : [],
                      ),
                    ),
                  ),
                ).slice(-20000),
            ),
            executionAfter: Date.now() - 60001,
            ignoredMessageIDs: [
              ...new Set([
                ...(latest.ignoredMessageIDs ?? []),
                ...snapshots.flatMap(({ messages }) =>
                  messages.flatMap((message) =>
                    message.info.role === "user"
                      ? [message.info.id]
                      : message.info.role === "assistant"
                        ? [message.info.parentID]
                        : [],
                  ),
                ),
              ]),
            ].slice(-100),
          },
          24,
          state.runID,
        )
    } finally {
      sessions.forEach((id) => {
        // OpenCode can deliver the abort event after its HTTP response.
        setTimeout(() => aborting.delete(directory + "\n" + id), 30000).unref()
        activity.delete(id)
      })
    }
    return true
  }
}
