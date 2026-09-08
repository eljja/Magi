import type { OpencodeClientInstance } from "./bridge"
import { askCouncilDraft, deliberateProposal } from "./bridge"
import { loadMagiConfig } from "./config"
import { collectMagiContext } from "./context"
import {
  buildDebateRoundPrompt,
  buildSelfImprovementDraftPrompt,
  decisionFromJudgment,
  finalDebatePosition,
  MagiCouncilMembers,
  nextCouncilProposer,
  shouldStopSelfImprovement,
  type MagiDebateRound,
  type MagiPosition,
} from "./council"
import {
  getCurrentMilestone,
  initializeRoadmap,
  isRoadmapCompleted,
  markMilestoneComplete,
  readRoadmap,
  writeRoadmap,
} from "./roadmap"
import { formatSafetyEnvelope, prepareBranchSafety, writeRunDecision } from "./safety"
import { mutateMagiState, readMagiMemory, readMagiState, updateMagiState, writeMagiMemory } from "./state"
import { runIndependentJudge, runMechanicalVerification } from "./verification"
import { resolveExecutorAgent } from "./omo-bridge"
import { recordCouncilDeliberation, recordCycleOutcome } from "./ledger"

export type CycleResult = {
  injected: boolean
  stopped: boolean
  title: string
  prompt: string
  finalPosition: MagiPosition
  cycle: number
}
type CycleInput = { directory: string; sessionID: string; client?: OpencodeClientInstance; userPrompt?: string }
const running = new Set<string>()
const stopped: CycleResult = {
  injected: false,
  stopped: true,
  title: "Magi paused",
  prompt: "Magi is paused. No task is authorized.",
  finalPosition: "reject",
  cycle: 0,
}

export async function setAutonomousLoop(
  directory: string,
  active: boolean,
  options?: { sessionID: string; goal?: string },
) {
  if (!active) {
    return mutateMagiState(directory, (state) => ({
      ...state,
      loopActive: false,
      awaitingExecution: false,
      runID: crypto.randomUUID(),
      status: "idle",
      stopReason: "user",
      topic: "Magi paused by user",
    }))
  }
  const config = await loadMagiConfig(directory)
  const roadmap = await readRoadmap(directory)
  const goal = options?.goal?.trim() || roadmap?.goal || (await readMagiState(directory)).goal
  if (!goal) throw new Error("Provide one goal: /magi start <goal>")
  if (!options?.sessionID) throw new Error("A session is required to start Magi")
  if (roadmap && roadmap.goal !== goal)
    throw new Error(
      "A different goal already exists. Archive .magi/roadmap.json and ROADMAP.md before starting a new goal.",
    )
  if (!roadmap) await initializeRoadmap({ directory, goal })
  return mutateMagiState(directory, (state) => {
    if (state.loopActive && state.sessionID !== options.sessionID)
      throw new Error("Another session owns this project goal. Stop it before transferring ownership.")
    return {
      ...state,
      goal,
      sessionID: options.sessionID,
      runID: crypto.randomUUID(),
      loopActive: true,
      awaitingExecution: false,
      maxCycles: config.selfImprovement.maxCycles,
      status: "running",
      stopReason: undefined,
      error: undefined,
      topic: goal,
    }
  })
}

async function active(input: CycleInput, runID: string) {
  const state = await readMagiState(input.directory)
  return state.loopActive && state.runID === runID && state.sessionID === input.sessionID
}

export async function pauseMagi(directory: string, reason: string, runID?: string) {
  await updateMagiState(
    directory,
    { time: Date.now(), type: "error", title: "Magi paused", text: reason },
    { awaitingExecution: false, status: "error", error: reason },
    24,
    runID,
  )
}

export async function runMagiCycle(input: CycleInput): Promise<CycleResult> {
  if (running.has(input.directory)) throw new Error("A Magi cycle is already running")
  running.add(input.directory)
  const state = await readMagiState(input.directory)
  try {
    if (!state.runID || !(await active(input, state.runID))) return stopped
    return await propose(input, state.runID)
  } catch (error) {
    await pauseMagi(input.directory, error instanceof Error ? error.message : String(error), state.runID)
    throw error
  } finally {
    running.delete(input.directory)
  }
}

async function propose(input: CycleInput, runID: string): Promise<CycleResult> {
  const config = await loadMagiConfig(input.directory)
  const state = await readMagiState(input.directory)
  const roadmap = await readRoadmap(input.directory)
  if (!roadmap) throw new Error("Goal roadmap is missing; refusing unrelated work")
  if (isRoadmapCompleted(roadmap)) {
    if (config.selfImprovement.mode === "complete") {
      await updateMagiState(
        input.directory,
        {
          time: Date.now(),
          type: "decision",
          title: "Goal completed",
          text: "All milestones passed independent review.",
        },
        { loopActive: false, awaitingExecution: false, status: "decided", stopReason: "completed" },
        24,
        runID,
      )
      return stopped
    }
    await writeRoadmap(input.directory, {
      ...roadmap,
      updatedAt: Date.now(),
      milestones: [
        ...roadmap.milestones,
        {
          id: Math.max(...roadmap.milestones.map((item) => item.id)) + 1,
          title: "Next research increment for the original goal",
          description:
            "Advance only this goal: " +
            roadmap.goal +
            ". Produce a new reproducible experiment, result, or documented limitation with evidence.",
          completed: false,
        },
      ],
    })
  }
  const milestone = getCurrentMilestone((await readRoadmap(input.directory))!)
  const memory = await readMagiMemory(input.directory)
  const userSteering = input.userPrompt || memory.pendingUserSteering
  const proposer = memory.lastProposer ? nextCouncilProposer(MagiCouncilMembers, memory.lastProposer) : "melchior"
  const cycle = state.currentCycle + 1
  const context = await collectMagiContext({ directory: input.directory })
  const requirements = [
    "Immutable master goal: " + roadmap.goal,
    "Current milestone: " + milestone?.title + "\n" + milestone?.description,
    userSteering ? "PRIORITY USER DIRECTIVE / STEERING: " + userSteering : "",
    state.error ? "Previous runtime failure to resolve: " + state.error : "",
    "Recent council feedback: " +
      state.events
        .filter((event) => event.type === "vote" || event.type === "continuation")
        .slice(-6)
        .map((event) => event.text)
        .join("\n"),
    context.text,
  ].join("\n\n")
  await updateMagiState(
    input.directory,
    { time: Date.now(), type: "status", title: "Cycle #" + cycle, text: requirements },
    { currentCycle: cycle, status: "running", votes: {}, awaitingExecution: false, pendingUserSteering: undefined },
    config.display.transcriptLimit,
    runID,
  )
  const draft = await askCouncilDraft({
    bridge: { client: input.client, config, directory: input.directory },
    proposer,
    systemPrompt: buildSelfImprovementDraftPrompt({
      proposer,
      recentWork: requirements,
      cycle,
      previousCompleted: memory.previousCompleted,
    }),
    userPrompt: "Propose one concrete step toward this milestone. Preserve the original goal.\n" + requirements,
  })
  if (!(await active(input, runID))) return stopped
  const rounds: MagiDebateRound[] = []
  for (let round = 1; round <= config.council.maxDebateRounds; round++) {
    const votes = await deliberateProposal({
      bridge: { client: input.client, config, directory: input.directory },
      proposer,
      draft,
      roundPromptBuilder: (member) =>
        buildDebateRoundPrompt({
          member,
          round,
          proposal: draft.prompt,
          evidence: requirements + "\n" + draft.rationale,
          previousRounds: rounds,
        }),
    })
    if (!(await active(input, runID))) return stopped
    const decisions = votes.map((item) => decisionFromJudgment(item.member, item.judgment))
    rounds.push({ round, decisions, newEvidence: decisions.some((item) => item.newEvidence) })
    for (const decision of decisions)
      await updateMagiState(
        input.directory,
        {
          time: Date.now(),
          type: "vote",
          member: decision.member,
          title: decision.member + ": " + decision.position,
          text: decision.rationale,
          position: decision.position,
        },
        { votes: Object.fromEntries(decisions.map((item) => [item.member, item.position])) },
        config.display.transcriptLimit,
        runID,
      )
  }
  const position = finalDebatePosition(rounds, config.council.vetoPolicy, config.council.votePolicy)
  if (shouldStopSelfImprovement(rounds) || position !== "approve" || draft.terminal) {
    await updateMagiState(
      input.directory,
      {
        time: Date.now(),
        type: "decision",
        title: "Council withheld authorization",
        text: "Council stop/revision is a pause, not proof of goal completion.",
      },
      { awaitingExecution: false, status: "idle", stopReason: "council" },
      24,
      runID,
    )
    return stopped
  }
  // A branch name is not a sandbox. Record the decision without silently switching the user's checkout.
  const safety = await prepareBranchSafety({
    directory: input.directory,
    title: draft.title,
    prompt: draft.prompt,
    enabled: false,
  })
  if (!(await active(input, runID))) return stopped
  const prompt = formatSafetyEnvelope({
    safety,
    prompt: [
      "[OH-MY-MAGI COUNCIL TASK — CYCLE #" + cycle + "]",
      "Master goal: " + roadmap.goal,
      "Milestone: " + milestone?.title + "\n" + milestone?.description,
      userSteering ? "User Priority Instruction: " + userSteering : "",
      draft.prompt,
      ...rounds
        .at(-1)!
        .decisions.flatMap((item) => (item.requiredChange ? ["Required council change: " + item.requiredChange] : [])),
      "OmO Workforce Instructions:",
      "- You are Sisyphus, OmO's Lead Execution PM.",
      "- Use the `task` tool to delegate specialized work to OmO specialist subagents (explore for code search, librarian for docs, hephaestus for refactoring, oracle for debugging).",
      "- Execute this step and report actual artifacts, commands, outputs, and remaining milestone gaps.",
      "Never edit .magi runtime state or mark roadmap milestones complete; the runtime records independently verified completion.",
    ]
      .filter(Boolean)
      .join("\n\n"),
  })
  await writeRunDecision({
    safety,
    decision: { draft, finalPosition: position, injected: true, rounds, selectedPrompt: prompt },
  })
  await recordCouncilDeliberation(input.directory, {
    cycle,
    goal: roadmap.goal,
    milestoneTitle: milestone?.title,
    milestoneId: milestone?.id,
    proposer,
    proposalTitle: draft.title,
    proposalRationale: draft.rationale,
    rounds,
    finalPosition: position,
    directivePrompt: prompt,
    userSteering,
  }).catch(() => undefined)
  await updateMagiState(
    input.directory,
    { time: Date.now(), type: "decision", title: draft.title, text: prompt, position },
    {
      status: "decided",
      topic: milestone?.title ?? draft.title,
      selectedPrompt: prompt,
      awaitingExecution: true,
      executionAfter: Date.now(),
      error: undefined,
      stopReason: undefined,
    },
    config.display.transcriptLimit,
    runID,
  )
  await writeMagiMemory(input.directory, {
    ...memory,
    lastProposer: proposer,
    previousCompleted: false,
    cyclesCompleted: cycle,
    pendingUserSteering: undefined,
  })
  return (await active(input, runID))
    ? { injected: true, stopped: false, title: draft.title, prompt, finalPosition: position, cycle }
    : stopped
}

export async function handleSessionIdleEvent(input: CycleInput): Promise<void> {
  if (running.has(input.directory)) return
  running.add(input.directory)
  const state = await readMagiState(input.directory)
  try {
    if (!state.runID || !state.awaitingExecution || !input.client || !(await active(input, state.runID))) return
    const messages = await input.client.session.messages({
      path: { id: input.sessionID },
      query: { directory: input.directory },
    })
    if (messages.error) throw new Error("Failed to read executor evidence")
    const message = messages.data?.filter((item) => item.info.role === "assistant").at(-1)
    if (
      !message ||
      message.info.role !== "assistant" ||
      !message.info.time.completed ||
      message.info.time.created < (state.executionAfter ?? 0) ||
      message.info.id === state.lastMessageID
    )
      return
    if (message.info.error?.name === "MessageAbortedError") {
      await setAutonomousLoop(input.directory, false)
      return
    }
    if (message.info.error) throw new Error("Executor failed: " + JSON.stringify(message.info.error))
    await updateMagiState(
      input.directory,
      { time: Date.now(), type: "continuation", title: "Verifying executor result", text: message.info.id },
      { awaitingExecution: false, lastMessageID: message.info.id },
      24,
      state.runID,
    )
    const report = await runMechanicalVerification(input.directory)
    if (!(await active(input, state.runID))) return
    // Missing verification is a configuration blocker; retrying it would spend tokens without new evidence.
    if (!report.checks.length) throw new Error(report.summary)
    const config = await loadMagiConfig(input.directory)
    const roadmap = await readRoadmap(input.directory)
    const milestone = roadmap && getCurrentMilestone(roadmap)
    const verdict = await runIndependentJudge({
      directory: input.directory,
      client: input.client,
      config,
      taskTitle: milestone?.title ?? state.topic,
      taskPrompt:
        "Master goal: " +
        state.goal +
        "\nMilestone requirements: " +
        milestone?.description +
        "\n" +
        state.selectedPrompt,
      executionReport: message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
      verificationReport: report,
    })
    if (!(await active(input, state.runID))) return
    await updateMagiState(
      input.directory,
      {
        time: Date.now(),
        type: "continuation",
        title: verdict.approved ? "Milestone verified" : "Repair required",
        text: report.summary + "\n" + verdict.critique,
      },
      undefined,
      24,
      state.runID,
    )
    if (report.passed && verdict.approved && milestone)
      await markMilestoneComplete(input.directory, milestone.id, report.summary + "\n" + verdict.critique)
    const stateLatest = await readMagiState(input.directory)
    await recordCycleOutcome(input.directory, {
      cycle: stateLatest.currentCycle,
      verificationPassed: report.passed,
      verificationSummary: report.summary,
      judgeApproved: verdict.approved,
      judgeCritique: verdict.critique,
      milestoneCompleted: report.passed && verdict.approved && Boolean(milestone),
      milestoneTitle: milestone?.title,
      telemetry: stateLatest.telemetry,
    }).catch(() => undefined)
    await writeMagiMemory(input.directory, {
      ...(await readMagiMemory(input.directory)),
      previousCompleted: report.passed && verdict.approved,
    })
    if (!(await active(input, state.runID))) return
    const result = await propose(
      {
        ...input,
        userPrompt:
          report.passed && verdict.approved
            ? undefined
            : "Repair or complete the current milestone before advancing.\n" +
              JSON.stringify(report) +
              "\n" +
              verdict.critique,
      },
      state.runID,
    )
    if (!result.injected || !(await active(input, state.runID))) return
    const executorAgent = await resolveExecutorAgent(input.directory)
    const response = await input.client.session.promptAsync({
      path: { id: input.sessionID },
      query: { directory: input.directory },
      body: { ...(executorAgent ? { agent: executorAgent } : {}), parts: [{ type: "text", text: result.prompt }] },
    })
    if (response.error) throw new Error("Executor dispatch failed: " + JSON.stringify(response.error))
  } catch (error) {
    await pauseMagi(input.directory, error instanceof Error ? error.message : String(error), state.runID)
  } finally {
    running.delete(input.directory)
  }
}
