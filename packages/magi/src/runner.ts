import {
  buildDebateRoundPrompt,
  buildSelfImprovementDraftPrompt,
  decisionFromJudgment,
  finalDebatePosition,
  magiConfig,
  MagiCouncilMembers,
  MagiPrompts,
  nextCouncilProposer,
  normalizeCouncilJudgment,
  normalizeProposalDraft,
  selfImprovementExecutorPrompt,
  type MagiCouncilMember,
  type MagiDebateRound,
  type MagiHostConfig,
} from "./council"
import { callMagiJson } from "./llm"
import { loadMagiRuntimeConfig } from "./config"
import { collectMagiContext } from "./context"
import { routeMagiRequest } from "./router"
import { prepareSelfImprovementSafety, safetyPrompt, writeMagiRunDecision } from "./safety"
import { readMagiMemory, updateMagiState, writeMagiMemory, writeMagiState } from "./state"

export type MagiRunInput = {
  directory: string
  sessionID: string
  arguments?: string
}

export type MagiRunResult = {
  injected: boolean
  title: string
  prompt: string
  route: "council" | "fast-track"
  branch?: string
}

export async function runMagiOnce(input: MagiRunInput): Promise<MagiRunResult> {
  const config = await loadMagiRuntimeConfig(input.directory)
  const route = routeMagiRequest({
    arguments: input.arguments,
    fastTrack: config.router.fastTrack,
    maxFastTrackChars: config.router.maxFastTrackChars,
  })
  if (route.route === "fast-track") {
    await writeMagiState(input.directory, {
      status: "decided",
      topic: route.title,
      updatedAt: Date.now(),
      events: [
        {
          time: Date.now(),
          type: "decision",
          title: route.title,
          text: route.reason,
        },
      ],
      votes: {},
      selectedPrompt: route.prompt,
    })
    return {
      injected: true,
      title: route.title,
      prompt: formatInjectedPrompt(route.prompt ?? "", route.title),
      route: "fast-track",
    }
  }
  const memory = await readMagiMemory(input.directory)
  const context = await collectMagiContext({
    directory: input.directory,
    enabled: config.context.enabled,
    maxChars: config.context.maxChars,
  })
  const members = [...MagiCouncilMembers]
  const proposer = memory.lastProposer ? nextCouncilProposer(members, memory.lastProposer) : "melchior"
  const recentWork = [
    `Project directory: ${input.directory}`,
    `OpenCode session: ${input.sessionID}`,
    input.arguments?.trim() ? `User Magi arguments: ${input.arguments.trim()}` : undefined,
    context.text,
    context.truncated ? "Context pack was truncated. Prefer targeted inspection before broad edits." : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n")

  await writeMagiState(input.directory, {
    status: "running",
    topic: `${proposer.toUpperCase()} is drafting the next project improvement`,
    updatedAt: Date.now(),
    events: [],
    votes: {},
  })

  await updateMagiState(input.directory, {
    time: Date.now(),
    type: "status",
    member: proposer,
    title: "Magi started",
    text: `${proposer.toUpperCase()} owns this cycle. The council will debate and vote before OpenCode receives a task.`,
  })

  const draftResult = await callMagiJson({
    config,
    schema: "proposal",
    system: MagiPrompts[proposer],
    prompt: buildSelfImprovementDraftPrompt({
      proposer,
      recentWork,
      previousCompleted: memory.previousCompleted ?? true,
    }),
  })
  const draft = normalizeProposalDraft(proposer, draftResult.json)

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

  const hostConfig = {
    magi: {
      council: {
        members,
        votePolicy: "majority",
      },
      debate: {
        maxRounds: config.loop.maxRounds,
      },
    },
  } satisfies MagiHostConfig

  const rounds: MagiDebateRound[] = []
  for (let round = 1; round <= config.loop.maxRounds; round++) {
    const decisions = await Promise.all(
      members.map(async (member) => {
        const result = await callMagiJson({
          config,
          schema: "judgment",
          system: MagiPrompts[member],
          prompt: buildDebateRoundPrompt({
            kind: "self-improvement",
            proposal: draft.prompt,
            evidence: draft.rationale,
            member,
            round,
            previousRounds: rounds,
          }),
        })
        return decisionFromJudgment(member, normalizeCouncilJudgment(result.json))
      }),
    )
    for (const decision of decisions) {
      await updateMagiState(
        input.directory,
        {
          time: Date.now(),
          type: "vote",
          member: decision.member,
          title: `${decision.member.toUpperCase()} voted ${decision.position}`,
          text: [
            decision.rationale,
            decision.requiredChange ? `Required change: ${decision.requiredChange}` : undefined,
          ]
            .filter((line): line is string => line !== undefined)
            .join("\n"),
          position: decision.position,
        },
        {
          votes: Object.fromEntries(decisions.map((item) => [item.member, item.position])),
        },
        config.display.transcriptLimit,
      )
    }
    rounds.push({
      round,
      decisions,
      newEvidence: decisions.some((decision) => decision.newEvidence),
    })
  }

  const position = finalDebatePosition({ config: hostConfig, rounds })
  const prompt = position === "reject" ? "" : (selfImprovementExecutorPrompt({ rounds, proposer, draft }) ?? draft.prompt)
  const injected = Boolean(prompt.trim()) && config.loop.injectApprovedPrompt
  const safety = injected
    ? await prepareSelfImprovementSafety({
        directory: input.directory,
        title: draft.title,
        prompt,
        config,
      })
    : undefined
  const selectedPrompt = safetyPrompt({ prompt, safety })
  const title = injected ? `Magi selected: ${draft.title}` : `Magi did not inject: ${position}`
  await writeMagiRunDecision({
    directory: input.directory,
    safety,
    decision: {
      draft,
      finalPosition: position,
      injected,
      rounds,
      selectedPrompt: injected ? selectedPrompt : undefined,
    },
  })

  await updateMagiState(
    input.directory,
    {
      time: Date.now(),
      type: injected ? "decision" : "error",
      title,
      text: injected ? selectedPrompt : "The council did not produce an injectable task.",
      position,
    },
    {
      status: injected ? "decided" : "error",
      topic: title,
      selectedPrompt: injected ? selectedPrompt : undefined,
      error: injected ? undefined : "No approved or revisable prompt was selected.",
    },
    config.display.transcriptLimit,
  )
  await writeMagiMemory(input.directory, {
    lastProposer: proposer,
    previousCompleted: injected,
  })

  return {
    injected,
    title,
    prompt: injected ? formatInjectedPrompt(selectedPrompt, draft.title) : "Magi council did not approve an executable task.",
    route: "council",
    branch: safety?.branch,
  }
}

function formatInjectedPrompt(prompt: string, title: string) {
  return [`[MAGI SELECTED TASK] ${title}`, "", prompt.trim(), "", "Treat this exactly like a user-requested task."].join("\n")
}
