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
  selfImprovementExecutorPrompt,
  shouldStopSelfImprovement,
  type MagiCouncilMember,
  type MagiDebateRound,
  type MagiPosition,
} from "./council"
import {
  getCurrentMilestone,
  initializeRoadmap,
  isRoadmapCompleted,
  markMilestoneComplete,
  readRoadmap,
  type Milestone,
} from "./roadmap"
import { routeMagiRequest } from "./router"
import { formatSafetyEnvelope, prepareBranchSafety, writeRunDecision } from "./safety"
import { readMagiMemory, readMagiState, updateMagiState, writeMagiMemory, writeMagiState } from "./state"
import { runIndependentJudge, runMechanicalVerification } from "./verification"

export type CycleResult = {
  injected: boolean
  stopped: boolean
  stopReason?: "user" | "unanimous_council" | "max_cycles"
  title: string
  prompt: string
  finalPosition: MagiPosition
  cycle: number
  route?: "council" | "fast-track"
  branch?: string
  milestone?: Milestone
}

// In-memory guard to prevent multiple cycles firing concurrently for the same directory
const runningDirectories = new Set<string>()

export async function runMagiCycle(input: {
  directory: string
  sessionID: string
  client?: OpencodeClientInstance
  userPrompt?: string
}): Promise<CycleResult> {
  const config = await loadMagiConfig(input.directory)

  // 1. Fast-track routing check for explicit user directives
  if (input.userPrompt?.trim()) {
    const routeDecision = routeMagiRequest({
      arguments: input.userPrompt,
      fastTrack: true,
    })
    if (routeDecision.route === "fast-track") {
      await updateMagiState(
        input.directory,
        {
          time: Date.now(),
          type: "decision",
          title: routeDecision.title,
          text: routeDecision.reason,
        },
        {
          status: "decided",
          topic: routeDecision.title,
          selectedPrompt: routeDecision.prompt,
        },
        config.display.transcriptLimit,
      )
      return {
        injected: true,
        stopped: false,
        title: routeDecision.title,
        prompt: routeDecision.prompt ?? input.userPrompt,
        finalPosition: "approve",
        cycle: 0,
        route: "fast-track",
      }
    }
  }

  // 2. Project Roadmap & Milestone management
  let roadmap = await readRoadmap(input.directory)
  if (!roadmap && input.userPrompt?.trim()) {
    roadmap = await initializeRoadmap({
      directory: input.directory,
      goal: input.userPrompt.trim(),
    })
  }

  if (roadmap && isRoadmapCompleted(roadmap) && !input.userPrompt?.trim()) {
    const currentState = await readMagiState(input.directory)
    await updateMagiState(
      input.directory,
      {
        time: Date.now(),
        type: "decision",
        title: "All Roadmap Milestones Completed",
        text: "Every milestone in .magi/ROADMAP.md has been completed and verified. Autonomous loop stopped.",
        position: "approve",
      },
      {
        status: "decided",
        loopActive: false,
        topic: "Project completed",
      },
      config.display.transcriptLimit,
    )
    return {
      injected: false,
      stopped: true,
      stopReason: "unanimous_council",
      title: "All Milestones Completed",
      prompt: "All milestones in .magi/ROADMAP.md are completed and verified.",
      finalPosition: "approve",
      cycle: currentState.currentCycle,
      route: "council",
    }
  }

  const activeMilestone = roadmap ? getCurrentMilestone(roadmap) : undefined

  const memory = await readMagiMemory(input.directory)
  const state = await readMagiState(input.directory)
  const cycle = state.currentCycle + 1
  const proposer = memory.lastProposer ? nextCouncilProposer(MagiCouncilMembers, memory.lastProposer) : "melchior"

  await updateMagiState(
    input.directory,
    {
      time: Date.now(),
      type: "status",
      member: proposer,
      title: `Cycle #${cycle} started`,
      text: `${proposer.toUpperCase()} owns cycle #${cycle}. ${activeMilestone ? `Advancing Milestone #${activeMilestone.id}: ${activeMilestone.title}.` : "Deliberating project roadmap."}`,
    },
    {
      status: "running",
      currentCycle: cycle,
      topic: activeMilestone ? `[Milestone #${activeMilestone.id}] ${activeMilestone.title}` : `${proposer.toUpperCase()} drafting cycle #${cycle}`,
    },
    config.display.transcriptLimit,
  )

  // 3. Collect rich repository context (git status, branch, diff, scripts, with secret redaction)
  const contextPack = await collectMagiContext({
    directory: input.directory,
    enabled: true,
  })

  const recentContext = [
    `Project directory: ${input.directory}`,
    `Cycle: #${cycle}`,
    roadmap ? `Master Goal: ${roadmap.goal}` : undefined,
    activeMilestone ? `Target Milestone #${activeMilestone.id}: ${activeMilestone.title} (${activeMilestone.description})` : undefined,
    input.userPrompt?.trim() ? `Directive: ${input.userPrompt.trim()}` : undefined,
    contextPack.text,
    contextPack.truncated ? "[Context was truncated to preserve tokens]" : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n")

  // 4. Proposer drafts the proposal for Sisyphus and workforce
  const draft = await askCouncilDraft({
    bridge: { client: input.client, config, directory: input.directory },
    proposer,
    systemPrompt: buildSelfImprovementDraftPrompt({
      proposer,
      recentWork: recentContext,
      cycle,
      previousCompleted: memory.previousCompleted ?? true,
    }),
    userPrompt: activeMilestone
      ? `Advance Milestone #${activeMilestone.id}: ${activeMilestone.title}. Details: ${activeMilestone.description}`
      : input.userPrompt?.trim() || "Propose the next concrete step to advance and complete the software.",
  })

  await updateMagiState(
    input.directory,
    {
      time: Date.now(),
      type: "proposal",
      member: proposer,
      title: draft.title,
      text: `${draft.rationale}\n\n${draft.prompt}`,
    },
    {
      topic: draft.title,
    },
    config.display.transcriptLimit,
  )

  // 5. Council debate rounds (Melchior, Balthasar, Casper)
  const rounds: MagiDebateRound[] = []
  for (let round = 1; round <= config.council.maxDebateRounds; round++) {
    const results = await deliberateProposal({
      bridge: { client: input.client, config, directory: input.directory },
      proposer,
      draft,
      roundPromptBuilder: (member: MagiCouncilMember) =>
        buildDebateRoundPrompt({
          member,
          round,
          proposal: draft.prompt,
          evidence: draft.rationale,
          previousRounds: rounds,
        }),
    })

    const decisions = results.map((r) => decisionFromJudgment(r.member, r.judgment))

    for (const decision of decisions) {
      await updateMagiState(
        input.directory,
        {
          time: Date.now(),
          type: "vote",
          member: decision.member,
          title: `${decision.member.toUpperCase()} voted ${decision.position}`,
          text: decision.rationale,
          position: decision.position,
        },
        {
          votes: Object.fromEntries(decisions.map((d) => [d.member, d.position])),
        },
        config.display.transcriptLimit,
      )
    }

    rounds.push({
      round,
      decisions,
      newEvidence: decisions.some((d) => d.newEvidence),
    })
  }

  // 6. Check unanimous stop criteria
  if (shouldStopSelfImprovement(rounds)) {
    await updateMagiState(
      input.directory,
      {
        time: Date.now(),
        type: "decision",
        title: "Magi council unanimously concluded the project is complete",
        text: "Melchior, Balthasar, and Casper have all agreed that no further automated changes are required.",
        position: "reject",
      },
      {
        status: "decided",
        loopActive: false,
        topic: "Project completed (council consensus)",
      },
      config.display.transcriptLimit,
    )

    await writeMagiMemory(input.directory, {
      ...memory,
      stoppedBy: "unanimous_council",
      previousCompleted: true,
      cyclesCompleted: cycle,
    })

    return {
      injected: false,
      stopped: true,
      stopReason: "unanimous_council",
      title: "Magi council concluded project is complete",
      prompt: "Magi council unanimously agreed that the project is complete. Autonomous loop stopped.",
      finalPosition: "reject",
      cycle,
      route: "council",
      milestone: activeMilestone,
    }
  }

  // 7. Select executor prompt, format for Sisyphus, and prepare safety envelope
  const finalPosition = finalDebatePosition(rounds, config.council.vetoPolicy, config.council.votePolicy)
  const approvedPrompt = finalPosition === "reject" ? "" : (selfImprovementExecutorPrompt({ rounds, proposer, draft }) ?? draft.prompt)
  const injected = Boolean(approvedPrompt.trim())

  let safetyInfo
  if (injected) {
    safetyInfo = await prepareBranchSafety({
      directory: input.directory,
      title: draft.title,
      prompt: approvedPrompt,
      enabled: true,
    })
  }

  const basePrompt = injected ? formatInjectedPrompt(approvedPrompt, draft.title, cycle, activeMilestone) : ""
  const finalInjectedPrompt = injected ? formatSafetyEnvelope({ prompt: basePrompt, safety: safetyInfo }) : ""

  if (injected) {
    await writeRunDecision({
      safety: safetyInfo,
      decision: {
        draft,
        finalPosition,
        injected,
        rounds,
        selectedPrompt: finalInjectedPrompt,
      },
    })
  }

  await updateMagiState(
    input.directory,
    {
      time: Date.now(),
      type: injected ? "decision" : "error",
      title: injected ? `Cycle #${cycle} approved: ${draft.title}` : `Cycle #${cycle} rejected by council`,
      text: injected ? finalInjectedPrompt : "Council rejected the proposal.",
      position: finalPosition,
    },
    {
      status: injected ? "decided" : "error",
      topic: draft.title,
      selectedPrompt: injected ? finalInjectedPrompt : undefined,
    },
    config.display.transcriptLimit,
  )

  await writeMagiMemory(input.directory, {
    lastProposer: proposer,
    previousCompleted: injected,
    cyclesCompleted: cycle,
  })

  return {
    injected,
    stopped: false,
    title: draft.title,
    prompt: finalInjectedPrompt,
    finalPosition,
    cycle,
    route: "council",
    branch: safetyInfo?.branch,
    milestone: activeMilestone,
  }
}

export async function handleSessionIdleEvent(input: {
  directory: string
  sessionID: string
  client?: OpencodeClientInstance
}): Promise<void> {
  if (runningDirectories.has(input.directory)) return

  const state = await readMagiState(input.directory)
  if (!state.loopActive) return

  const config = await loadMagiConfig(input.directory)
  const maxCycles = state.maxCycles || config.selfImprovement.maxCycles || 50

  if (state.currentCycle >= maxCycles) {
    await updateMagiState(
      input.directory,
      {
        time: Date.now(),
        type: "status",
        title: "Autonomous loop stopped",
        text: `Reached maximum configured cycles (${maxCycles}).`,
      },
      {
        loopActive: false,
        status: "decided",
        topic: `Completed max cycles (${maxCycles})`,
      },
    )
    const memory = await readMagiMemory(input.directory)
    await writeMagiMemory(input.directory, { ...memory, stoppedBy: "max_cycles" })
    return
  }

  runningDirectories.add(input.directory)

  try {
    // 1. Run post-execution mechanical verification (test/lint gates)
    const verificationReport = await runMechanicalVerification(input.directory)
    await updateMagiState(
      input.directory,
      {
        time: Date.now(),
        type: "continuation",
        title: verificationReport.passed ? "Verification passed" : "Verification failed",
        text: verificationReport.summary,
      },
    )

    // 2. Independent judge evaluation
    const judgeVerdict = await runIndependentJudge({
      client: input.client,
      config,
      directory: input.directory,
      taskTitle: state.topic,
      taskPrompt: state.selectedPrompt ?? "",
      verificationReport,
    })

    // 3. Milestone Completion Check
    const roadmap = await readRoadmap(input.directory)
    const activeMilestone = roadmap ? getCurrentMilestone(roadmap) : undefined

    if (verificationReport.passed && judgeVerdict.approved && activeMilestone) {
      await markMilestoneComplete(input.directory, activeMilestone.id, verificationReport.summary)
      await updateMagiState(input.directory, {
        time: Date.now(),
        type: "decision",
        title: `Milestone #${activeMilestone.id} Verified & Completed`,
        text: `Council verified completion of '${activeMilestone.title}'. Progress recorded in .magi/ROADMAP.md.`,
        position: "approve",
      })

      const updatedRoadmap = await readRoadmap(input.directory)
      if (updatedRoadmap && isRoadmapCompleted(updatedRoadmap)) {
        await setAutonomousLoop(input.directory, false)
        await updateMagiState(
          input.directory,
          {
            time: Date.now(),
            type: "decision",
            title: "All Roadmap Milestones Completed & Verified",
            text: "All milestones in .magi/ROADMAP.md have passed verification. Autonomous loop concluded successfully with STOP_SELF_IMPROVEMENT.",
            position: "approve",
          },
          {
            status: "decided",
            loopActive: false,
            topic: "Project completed (all milestones verified)",
          },
        )
        return
      }
    }

    // If verification or judge failed, prompt Sisyphus for a targeted repair task
    const nextUserPrompt = !verificationReport.passed
      ? `[CORRECTIVE ORDER FOR SISYPHUS] Verification check failed: ${verificationReport.summary}. Repair broken tests or errors immediately before moving to next milestone.`
      : !judgeVerdict.approved
        ? `[CORRECTIVE ORDER FOR SISYPHUS] Independent judge noted concerns: ${judgeVerdict.critique}. Address these issues.`
        : undefined

    const result = await runMagiCycle({
      directory: input.directory,
      sessionID: input.sessionID,
      client: input.client,
      userPrompt: nextUserPrompt,
    })

    if (!result.stopped && result.injected && result.prompt && input.client) {
      await input.client.session
        .promptAsync({
          path: { id: input.sessionID },
          query: { directory: input.directory },
          body: {
            agent: "sisyphus", // routes directly to Sisyphus in OmO environments
            parts: [
              {
                type: "text",
                text: result.prompt,
              },
            ],
          },
        })
        .catch(() => undefined)
    }
  } finally {
    runningDirectories.delete(input.directory)
  }
}

export async function setAutonomousLoop(directory: string, active: boolean): Promise<void> {
  const current = await readMagiState(directory)
  await writeMagiState(directory, {
    ...current,
    loopActive: active,
    status: active ? "running" : "idle",
    topic: active ? "Magi autonomous loop active" : "Magi autonomous loop paused/stopped",
  })
  if (!active) {
    const memory = await readMagiMemory(directory)
    await writeMagiMemory(directory, { ...memory, stoppedBy: "user" })
  }
}

function formatInjectedPrompt(prompt: string, title: string, cycle: number, activeMilestone?: Milestone) {
  return [
    `[OH-MY-MAGI COUNCIL TASK — CYCLE #${cycle}]`,
    `Title: ${title}`,
    activeMilestone ? `Active Milestone #${activeMilestone.id}: ${activeMilestone.title}` : undefined,
    activeMilestone ? `Milestone Goal: ${activeMilestone.description}` : undefined,
    "",
    "### DIRECTIVE FOR SISYPHUS (OmO Lead PM) & SPECIALIST WORKFORCE:",
    prompt.trim(),
    "",
    "Instructions for Sisyphus & Workforce:",
    "1. Sisyphus: Deconstruct this milestone into subtasks and delegate to Librarian (research), Explore (grep), or Atlas/Hephaestus (implementation).",
    "2. Execute the required changes, generate scripts, or implement files cleanly.",
    "3. Run test/verification commands to ensure no regressions before concluding.",
    "4. Sisyphus: Output a concise execution report when the milestone sprint is complete.",
  ]
    .filter(Boolean)
    .join("\n")
}
