import type { OpencodeClientInstance } from "./bridge"
import { resolveExecutorAgent } from "./omo-bridge"
import { mutateMagiState, readMagiState } from "./state"

// A fresh child retains OpenCode ancestry and the full OmO harness without
// inheriting instructions meant only for the human-facing Magi conversation.
export async function dispatchExecution(input: {
  directory: string
  sessionID: string
  client: OpencodeClientInstance
  runID: string
  prompt: string
}) {
  const state = await readMagiState(input.directory)
  if (!state.loopActive || state.runID !== input.runID || state.sessionID !== input.sessionID) return
  const agent = await resolveExecutorAgent(input.directory, input.client)
  const response = await input.client.session.create({
    query: { directory: input.directory },
    body: { parentID: input.sessionID, title: "Magi workforce · cycle " + state.currentCycle },
  })
  if (response.error || !response.data?.id) throw new Error("Cannot create the approved OmO execution session")
  const sessionID = response.data.id
  await mutateMagiState(input.directory, (current) =>
    current.loopActive && current.runID === input.runID
      ? { ...current, executionSessionID: sessionID, executionAfter: Date.now() }
      : current,
  )
  const current = await readMagiState(input.directory)
  if (!current.loopActive || current.runID !== input.runID || current.executionSessionID !== sessionID) {
    await input.client.session.delete({ path: { id: sessionID }, query: { directory: input.directory } })
    return
  }
  const dispatched = await input.client.session.promptAsync({
    path: { id: sessionID },
    query: { directory: input.directory },
    body: {
      ...(agent ? { agent } : {}),
      parts: [{ type: "text", text: input.prompt, synthetic: true }],
    },
  })
  if (dispatched.error) throw new Error("Approved OmO execution could not be dispatched")
  const latest = await readMagiState(input.directory)
  if (!latest.loopActive || latest.runID !== input.runID)
    await input.client.session.abort({ path: { id: sessionID }, query: { directory: input.directory } })
}
