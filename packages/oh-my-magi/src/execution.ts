import type { OpencodeClientInstance } from "./bridge"
import { resolveExecutorAgent } from "./omo-bridge"
import { mutateMagiState, readMagiState } from "./state"
import { collectArtifactEvidence } from "./artifacts"
import { loadMagiConfig } from "./config"

export async function submitExecution(input: {
  directory: string
  sessionID: string
  summary: string
  artifacts: string[]
  unresolved: string[]
}) {
  const state = await readMagiState(input.directory)
  if (!state.loopActive || !state.awaitingExecution || state.executionSessionID !== input.sessionID)
    throw new Error("Only the currently approved OmO execution session can submit its result")
  if (!input.summary.trim()) throw new Error("Submit an evidence-based summary")
  const evidence = await collectArtifactEvidence(input.directory, input.artifacts)
  if (evidence.some((item) => item.error))
    throw new Error("Submitted artifacts must be readable files inside the project")
  const saved = await mutateMagiState(input.directory, (current) =>
    current.loopActive &&
    current.runID === state.runID &&
    current.executionSessionID === input.sessionID &&
    current.awaitingExecution
      ? {
          ...current,
          executionSubmission: {
            sessionID: input.sessionID,
            submittedAt: Date.now(),
            summary: input.summary,
            artifacts: input.artifacts,
            unresolved: input.unresolved,
          },
        }
      : current,
  )
  if (!saved.loopActive || saved.runID !== state.runID || saved.executionSubmission?.sessionID !== input.sessionID)
    throw new Error("Execution changed or stopped before submission")
  return (await loadMagiConfig(input.directory)).selfImprovement.mode === "continuous"
    ? "Progress checkpoint received. Collect outstanding background results, then end this response for the next planning meeting. The same goal continues automatically, without completion approval."
    : "Result received for independent council review, not approved or marked complete. Collect any outstanding background results, then end this response. Magi will run verification and all three identities will review the evidence and vote. Do not start another improvement in this execution session."
}

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
      ? { ...current, executionSessionID: sessionID, executionAfter: Date.now(), executionSubmission: undefined }
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
