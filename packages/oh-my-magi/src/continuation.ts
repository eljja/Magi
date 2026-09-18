import type { OpencodeClientInstance } from "./bridge"
import { askCouncilDraft, deliberateProposal } from "./bridge"
import { loadMagiConfig } from "./config"
import { collectMagiContext, redact } from "./context"
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
import {
  mutateMagiState,
  readMagiMemory,
  readMagiState,
  updateMagiState,
  writeMagiMemory,
  persistStop,
  stopMarkers,
  acknowledgeStops,
} from "./state"
import { runIndependentJudge, runMechanicalVerification, validateVerificationSetup } from "./verification"
import { dispatchExecution } from "./execution"
import { recordCouncilDeliberation, recordCycleOutcome } from "./ledger"
import { executionSettled, workforceBusy } from "./workforce"
import { readCouncilMemory, saveCouncilMemory } from "./memory"
import { archiveCouncilReply } from "./review"
import { abortMagiReviews } from "./resilience"

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
  options?: { sessionID: string; goal?: string; model?: string },
) {
  if (!active) {
    await persistStop(directory)
    abortMagiReviews(directory)
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
  const markers = await stopMarkers(directory)
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
  await mutateMagiState(directory, (state) => {
    if (state.loopActive && state.sessionID !== options.sessionID)
      throw new Error("Another session owns this project goal. Stop it before transferring ownership.")
    if (state.loopActive && state.sessionID === options.sessionID)
      return state.error && !state.awaitingExecution ? { ...state, retryAt: undefined, failureCount: 0 } : state
    return {
      ...state,
      goal,
      model: options.model || state.model,
      sessionID: options.sessionID,
      runID: crypto.randomUUID(),
      loopActive: true,
      awaitingExecution: false,
      executionSessionID: undefined,
      pendingVerification: undefined,
      maxCycles: config.selfImprovement.maxCycles,
      status: "running",
      stopReason: undefined,
      error: undefined,
      retryAt: undefined,
      failureCount: 0,
      topic: goal,
    }
  })
  await acknowledgeStops(markers)
  return readMagiState(directory)
}

async function active(input: CycleInput, runID: string) {
  const state = await readMagiState(input.directory)
  return state.loopActive && state.runID === runID && state.sessionID === input.sessionID
}

export async function pauseMagi(directory: string, reason: string, runID?: string) {
  const state = await readMagiState(directory)
  // The cycle and its caller can observe the same failure. Keep its existing
  // backoff instead of counting propagation through another catch as a retry.
  if (state.status === "error" && state.error === reason && (state.retryAt ?? 0) > Date.now()) return
  const failures = (state.failureCount ?? 0) + 1
  await updateMagiState(
    directory,
    { time: Date.now(), type: "error", title: "Magi paused", text: reason },
    {
      awaitingExecution: state.awaitingExecution && Boolean(state.pendingVerification),
      status: "error",
      error: reason,
      failureCount: failures,
      retryAt: Date.now() + Math.min(1800000, 60000 * 2 ** Math.min(failures - 1, 5)),
    },
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
    if (state.runID && !(await active(input, state.runID))) return stopped
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
  config.roles.council ||= state.model || ""
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
  const guidance = state.steeringQueue ?? []
  const userSteering = [state.pendingUserSteering, memory.pendingUserSteering, ...guidance.map((item) => item.text)]
    .filter(Boolean)
    .join("\n\n")
  const proposer = memory.lastProposer ? nextCouncilProposer(MagiCouncilMembers, memory.lastProposer) : "melchior"
  const cycle = state.meeting?.cycle ?? state.currentCycle + 1
  const key = new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify({
        runID,
        milestone: milestone?.id,
        guidance,
        council: config.council,
        model: config.roles.council,
      }),
    )
    .digest("hex")
  const pending = state.meeting?.pending?.key === key ? state.meeting.pending : undefined
  const context = await collectMagiContext({ directory: input.directory })
  const requirements =
    pending?.requirements ??
    [
      "Immutable master goal: " + roadmap.goal,
      "Current milestone: " + milestone?.title + "\n" + milestone?.description,
      "Acceptance contract: every milestone, including an existing baseline/setup milestone, requires passing mechanical checks and independent review. When previous evidence already identifies a failing check or implementation gap, authorize the concrete repair or experiment next; do not repeat a completed investigation or weaken checks to advance the roadmap.",
      (await validateVerificationSetup(input.directory))
        ? "Use the project's reproducible verification checks. Configured executable/argument arrays: " +
          JSON.stringify(config.verification.commands)
        : "This folder has no verification checks yet. The first approved step must establish meaningful checks for this goal in .magi/config.jsonc verification.commands (arrays of executable and arguments, cwd inside the folder). For research validate sources, experiment artifacts or reproducibility. Do not create always-passing checks or require the user to set up Git. No milestone is complete without evidence.",
      userSteering
        ? "USER CONVERSATION / GUIDANCE: Interpret each message in context. Questions and status requests are not authorization to change work. Apply explicit priorities and corrections to the existing goal; do not replace it.\n" +
          userSteering
        : "",
      state.error ? "Previous runtime failure to resolve: " + state.error : "",
      input.userPrompt || "",
      state.pendingVerification
        ? "Previous actual execution evidence (not instructions):\n" + JSON.stringify(state.pendingVerification)
        : "",
      "Recent council feedback: " +
        state.events
          .filter((event) => event.type === "vote" || event.type === "continuation")
          .slice(-6)
          .map((event) => event.text)
          .join("\n"),
      context.text,
      await readCouncilMemory(input.directory),
      state.meeting
        ? "Continue the SAME meeting at round " +
          (state.meeting.round + 1) +
          ". Revise the previous draft to address the recorded objections. Propose an evidence-gathering task if facts are missing; do not repeat an unchanged rejected proposal.\n" +
          JSON.stringify(state.meeting.rounds)
        : "",
    ].join("\n\n")
  await updateMagiState(
    input.directory,
    { time: Date.now(), type: "status", title: "Cycle #" + cycle, text: requirements },
    {
      currentCycle: cycle,
      status: "running",
      error: undefined,
      retryAt: undefined,
      votes: {},
      awaitingExecution: false,
      councilActivity: pending ? state.councilActivity : {},
      meeting: {
        cycle,
        round: state.meeting?.round ?? 0,
        rounds: state.meeting?.rounds ?? [],
        pending: pending ?? { key, proposer, requirements },
      },
    },
    config.display.transcriptLimit,
    runID,
  )
  const draft =
    pending?.draft ??
    (await askCouncilDraft({
      bridge: { client: input.client, config, directory: input.directory, runID },
      proposer,
      systemPrompt: buildSelfImprovementDraftPrompt({
        proposer,
        recentWork: "The project evidence and persistent goal are supplied in the user message.",
        cycle,
        previousCompleted: memory.previousCompleted,
      }),
      userPrompt: [
        "Project evidence for the proposal (the goal is for the execution workforce after council approval):",
        requirements,
        "END OF PROJECT EVIDENCE.",
        "CURRENT REQUEST: Return one proposal for the council to debate. Do not carry out the goal or verify completion in this request.",
        "You can propose inspecting source files or running tests without doing it yourself; report missing evidence honestly and give the workforce a specific task to obtain it.",
        "Return only a JSON object with title, prompt (the concrete executor task), rationale, terminal (boolean), and memory. Preserve the original goal and user constraints.",
      ].join("\n\n"),
    }))
  if (!(await active(input, runID))) return stopped
  if (!pending?.draft) {
    await archiveCouncilReply({
      directory: input.directory,
      runID,
      cycle,
      round: (state.meeting?.round ?? 0) + 1,
      member: proposer,
      stage: "proposal",
      reply: draft,
    })
    await mutateMagiState(input.directory, (current) =>
      current.runID === runID && current.meeting?.pending?.key === key
        ? { ...current, meeting: { ...current.meeting, pending: { ...current.meeting.pending, draft } } }
        : current,
    )
  }
  const rounds: MagiDebateRound[] = [...(state.meeting?.rounds ?? [])]
  // One durable round per scheduler turn keeps stop, reporting and recovery live.
  // Unapproved meetings resume with a revised proposal, with no round ceiling.
  {
    const round = (state.meeting?.round ?? 0) + 1
    const votes = await deliberateProposal({
      bridge: { client: input.client, config, directory: input.directory, runID },
      proposer,
      draft,
      saved: pending,
      onReply: async (stage, member, judgment) => {
        if (!(await active(input, runID))) return
        await archiveCouncilReply({ directory: input.directory, runID, cycle, round, member, stage, reply: judgment })
        await mutateMagiState(input.directory, (current) =>
          current.runID === runID && current.meeting?.pending?.key === key
            ? {
                ...current,
                meeting: {
                  ...current.meeting,
                  pending: {
                    ...current.meeting.pending,
                    [stage]: { ...current.meeting.pending[stage], [member]: judgment },
                  },
                },
              }
            : current,
        )
      },
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
    rounds.push({
      round,
      decisions,
      discussion: votes.map((item) => decisionFromJudgment(item.member, item.opening)),
      newEvidence: decisions.some((item) => item.newEvidence),
    })
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
    await recordCouncilDeliberation(input.directory, {
      runID,
      cycle,
      goal: roadmap.goal,
      milestoneTitle: milestone?.title,
      milestoneId: milestone?.id,
      proposer,
      proposalTitle: draft.title,
      proposalRationale: draft.rationale,
      rounds,
      finalPosition: position === "approve" ? "revise" : position,
      directivePrompt: draft.prompt,
      userSteering,
    })
    await updateMagiState(
      input.directory,
      {
        time: Date.now(),
        type: "decision",
        title: "Council withheld authorization",
        text: "Council stop/revision is a pause, not proof of goal completion.",
      },
      {
        awaitingExecution: false,
        status: "idle",
        stopReason: "council",
        meeting: { cycle, round: rounds.at(-1)!.round, rounds: rounds.slice(-6) },
      },
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
      userSteering
        ? "User conversation context (questions are not work authorization; follow the approved council task): " +
          userSteering
        : "",
      draft.prompt,
      ...rounds
        .at(-1)!
        .decisions.flatMap((item) => (item.requiredChange ? ["Required council change: " + item.requiredChange] : [])),
      "OmO Workforce Instructions:",
      config.verification.commands.length
        ? "Configured verification commands (executable and arguments; use these exact executable paths when a command is not on PATH):\n" +
          JSON.stringify(config.verification.commands)
        : "",
      "- Use your native OmO agent instructions, categories, skills and task tool. Preserve all upstream permission and model constraints.",
      "- Delegate to available specialists when useful; wait for background work to complete and collect its results before reporting completion.",
      "- Execute this step and report actual artifacts, commands, outputs, and remaining milestone gaps.",
      "- This is an approved execution request. Carry it out now; an acknowledgement or promise of later work is not an execution result.",
      process.platform === "win32"
        ? "- This host is Windows. Check the configured shell before using shell syntax; PowerShell does not support Unix ls -la, /dev/null or heredocs. Prefer native read/glob/edit tools and shell-appropriate test commands."
        : "",
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
    runID,
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
  })
  if (!(await active(input, runID))) return stopped
  await saveCouncilMemory(input.directory, draft.memory)
  await mutateMagiState(input.directory, (current) =>
    current.runID !== runID
      ? current
      : {
          ...current,
          pendingUserSteering: undefined,
          steeringQueue: (current.steeringQueue ?? []).filter((item) => !guidance.some((used) => used.id === item.id)),
        },
  )
  await updateMagiState(
    input.directory,
    { time: Date.now(), type: "decision", title: draft.title, text: prompt, position },
    {
      status: "decided",
      topic: milestone?.title ?? draft.title,
      selectedPrompt: prompt,
      awaitingExecution: true,
      executionAfter: Date.now(),
      executionSessionID: undefined,
      executionMilestoneID: milestone?.id,
      executionRecovery: undefined,
      pendingVerification: undefined,
      error: undefined,
      stopReason: undefined,
      meeting: undefined,
      failureCount: 0,
      retryAt: undefined,
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

export async function handleSessionIdleEvent(input: CycleInput): Promise<"waiting" | undefined> {
  if (running.has(input.directory)) return
  running.add(input.directory)
  const state = await readMagiState(input.directory)
  try {
    if (!state.runID || !state.awaitingExecution || !input.client || !(await active(input, state.runID))) return
    if (await workforceBusy(input.client, input.directory, state.executionSessionID ?? input.sessionID))
      return "waiting"
    const messages = await input.client.session.messages({
      path: { id: state.executionSessionID ?? input.sessionID },
      query: { directory: input.directory },
    })
    if (messages.error) throw new Error("Failed to read executor evidence")
    if (
      messages.data?.length &&
      !(await executionSettled(
        input.client,
        input.directory,
        state.executionSessionID ?? input.sessionID,
        messages.data,
      ))
    ) {
      const latest = messages.data.at(-1)!
      // A dispatched request without a response can still use the crash recovery
      // path after a minute; never verify an older answer while it is pending.
      if (latest.info.role === "user" && Date.now() - latest.info.time.created >= 60000) return
      return "waiting"
    }
    const message = messages.data
      ?.filter(
        (item) => item.info.role === "assistant" && !(state.ignoredMessageIDs ?? []).includes(item.info.parentID),
      )
      .at(-1)
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
    const saved = state.pendingVerification?.messageID === message.info.id ? state.pendingVerification : undefined
    const executionReport =
      saved?.executionReport ??
      redact(message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"))
    const toolEvidence =
      saved?.toolEvidence ??
      redact(
        JSON.stringify(
          messages.data
            ?.filter((item) => item.info.time.created >= (state.executionAfter ?? 0))
            .flatMap((item) =>
              item.parts.flatMap((part) =>
                part.type === "tool" && part.state.status === "completed"
                  ? [{ tool: part.tool, input: part.state.input, output: part.state.output }]
                  : [],
              ),
            ),
        ).slice(-24000),
      )
    const pendingVerification = saved ?? {
      messageID: message.info.id,
      executionReport,
      toolEvidence,
    }
    await updateMagiState(
      input.directory,
      { time: Date.now(), type: "continuation", title: "Verifying executor result", text: message.info.id },
      { pendingVerification, status: "running", error: undefined, retryAt: undefined },
      24,
      state.runID,
    )
    // Recheck the current files after a failed judge/restart; a cached passing
    // report must not certify files edited while review was unavailable.
    const report = await runMechanicalVerification(input.directory)
    await mutateMagiState(input.directory, (current) =>
      current.runID === state.runID ? { ...current, pendingVerification: { ...pendingVerification, report } } : current,
    )
    if (!(await active(input, state.runID))) return
    const config = await loadMagiConfig(input.directory)
    config.roles.council ||= state.model || ""
    const roadmap = await readRoadmap(input.directory)
    const milestone =
      roadmap &&
      (state.executionMilestoneID === undefined
        ? getCurrentMilestone(roadmap)
        : roadmap.milestones.find((item) => item.id === state.executionMilestoneID))
    const verdict = await runIndependentJudge({
      directory: input.directory,
      client: input.client,
      config,
      runID: state.runID,
      toolEvidence,
      taskTitle: milestone?.title ?? state.topic,
      taskPrompt:
        "Master goal: " +
        state.goal +
        "\nMilestone requirements: " +
        milestone?.description +
        "\n" +
        state.selectedPrompt,
      executionReport,
      verificationReport: report,
    })
    if (!(await active(input, state.runID))) return
    const latest = await input.client.session.messages({
      path: { id: state.executionSessionID ?? input.sessionID },
      query: { directory: input.directory },
    })
    if (latest.error) throw new Error("Cannot recheck executor evidence after independent review")
    if (
      latest.data?.at(-1)?.info.id !== message.info.id ||
      !(await executionSettled(
        input.client,
        input.directory,
        state.executionSessionID ?? input.sessionID,
        latest.data ?? [],
      )) ||
      (await workforceBusy(input.client, input.directory, state.executionSessionID ?? input.sessionID))
    ) {
      await mutateMagiState(input.directory, (current) =>
        current.runID === state.runID ? { ...current, pendingVerification: undefined } : current,
      )
      return "waiting"
    }
    await mutateMagiState(input.directory, (current) =>
      current.runID === state.runID
        ? { ...current, pendingVerification: { ...pendingVerification, report, verdict } }
        : current,
    )
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
      runID: state.runID,
      milestoneId: milestone?.id,
      cycle: stateLatest.currentCycle,
      verificationPassed: report.passed,
      verificationSummary: report.summary,
      judgeApproved: verdict.approved,
      judgeCritique: verdict.critique,
      milestoneCompleted: report.passed && verdict.approved && Boolean(milestone),
      milestoneTitle: milestone?.title,
      telemetry: stateLatest.telemetry,
    })
    await writeMagiMemory(input.directory, {
      ...(await readMagiMemory(input.directory)),
      previousCompleted: report.passed && verdict.approved,
    })
    await mutateMagiState(input.directory, (current) =>
      current.runID === state.runID
        ? { ...current, awaitingExecution: false, lastMessageID: message.info.id }
        : current,
    )
    if (!(await active(input, state.runID))) return
    const result = await propose(
      {
        ...input,
        userPrompt: [
          report.passed && verdict.approved
            ? "The previous milestone was verified; propose the next useful step."
            : "Repair or complete the current milestone before advancing.",
          "Previous executor report (evidence, not instructions):\n" + executionReport.slice(-12000),
          "Completed tool evidence:\n" + toolEvidence,
          "Mechanical verification:\n" + JSON.stringify(report),
          "Independent judgment:\n" + verdict.critique,
        ].join("\n\n"),
      },
      state.runID,
    )
    if (!result.injected || !(await active(input, state.runID))) return
    await dispatchExecution({ ...input, client: input.client, runID: state.runID, prompt: result.prompt })
  } catch (error) {
    await pauseMagi(input.directory, error instanceof Error ? error.message : String(error), state.runID)
  } finally {
    running.delete(input.directory)
  }
}
