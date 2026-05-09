import { Config } from "@/config/config"
import * as InstanceState from "@/effect/instance-state"
import { Provider } from "@/provider/provider"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import {
  buildDebateRoundPrompt,
  buildSelfImprovementDraftPrompt,
  buildSelfImprovementQuestion,
  canExecuteImprovementTask,
  magiConfig,
  magiReviewResult,
  nextCouncilProposer,
  normalizeProposalDraft,
  normalizeJudgment,
  shouldContinueDebate,
  shouldStopSelfImprovement,
  selfImprovementExecutorPrompt,
  type MagiCouncilMember,
  type MagiDecision,
  type MagiDebateRound,
  type MagiPosition,
  type MagiProposalDraft,
  type MagiTaskKind,
} from "@magi/core"
import { Cause, Effect, Scope } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import path from "path"
import { InstanceHttpApi } from "../api"
import { MagiReviewPayload, MagiSelfImprovePayload } from "../groups/magi"

const JUDGMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["position", "rationale", "confidence", "evidence", "requiredChange", "newEvidence", "safetyCritical"],
  properties: {
    position: { type: "string", enum: ["approve", "revise", "reject"] },
    rationale: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    evidence: { type: "array", items: { type: "string" } },
    requiredChange: { type: "string" },
    newEvidence: { type: "boolean" },
    safetyCritical: { type: "boolean" },
  },
}

const DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "prompt", "rationale", "requiresCoreSelfEdit", "terminal"],
  properties: {
    title: { type: "string" },
    prompt: { type: "string" },
    rationale: { type: "string" },
    requiresCoreSelfEdit: { type: "boolean" },
    terminal: { type: "boolean" },
  },
}

const COUNCIL_MODEL_TIMEOUT = "45 seconds"

type MagiActivityVote = {
  member: MagiCouncilMember
  state: "pending" | MagiPosition | "error"
  model?: string
  rationale?: string
  detail?: string
  error?: string
}

type MagiActivity = {
  id: string
  state: "idle" | "debating" | "decided" | "executing" | "error"
  topic: string
  detail: string
  round: number
  startedAt: number
  updatedAt: number
  decidedAt?: number
  finalPosition?: MagiPosition
  votes: MagiActivityVote[]
}

type MagiCouncilResult = {
  sessionID: SessionID
  memberSessionIDs: Record<MagiCouncilMember, SessionID>
  rounds: MagiDebateRound[]
  finalPosition: MagiPosition
  approved: boolean
  executed: boolean
}

type MagiMemoryEntry = {
  cycle: number
  proposer: MagiCouncilMember
  title: string
  finalPosition: MagiPosition
  approved: boolean
  executed: boolean
  summary: string
  createdAt: number
}

type MagiMemory = {
  version: 1
  entries: MagiMemoryEntry[]
}

const uniqueModels = (models: string[]) => models.filter((model, index) => model && models.indexOf(model) === index)

const topicLine = (input: string) => input.trim().split("\n").find((line) => line.trim())?.trim().slice(0, 120) ?? "Magi"

const failedDecision = (member: MagiCouncilMember, rationale: string): MagiDecision => ({
  member,
  vote: "abstain",
  position: "revise",
  rationale,
  confidence: 0,
  evidence: [],
  newEvidence: false,
  safetyCritical: false,
})

const causeSummary = (cause: Cause.Cause<unknown>) => Cause.pretty(cause).split("\n").at(0) ?? "Unknown error"

const emptyMemory = (): MagiMemory => ({ version: 1, entries: [] })

const validMemory = (input: unknown): MagiMemory => {
  if (typeof input !== "object" || input === null || !("entries" in input) || !Array.isArray(input.entries))
    return emptyMemory()
  return {
    version: 1,
    entries: input.entries.filter((entry): entry is MagiMemoryEntry => {
      if (typeof entry !== "object" || entry === null) return false
      if (!("proposer" in entry) || !["melchior", "balthasar", "casper"].includes(String(entry.proposer))) return false
      return "summary" in entry && typeof entry.summary === "string"
    }),
  }
}

const memorySummary = (memory: MagiMemory) =>
  memory.entries
    .slice(-6)
    .map((entry) => `${entry.proposer.toUpperCase()} cycle ${entry.cycle}: ${entry.summary}`)
    .join("\n")

const redactSecrets = (input: string) =>
  input
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[REDACTED_GOOGLE_API_KEY]")
    .replace(/\bsk-[0-9A-Za-z_-]{20,}\b/g, "[REDACTED_OPENAI_API_KEY]")
    .replace(/\b[A-Za-z0-9_-]*api[_-]?key[A-Za-z0-9_:= -]{8,}/gi, "[REDACTED_API_KEY]")

const readMemory = (directory: string) =>
  Effect.promise(async () => {
    try {
      if (!(await Bun.file(path.join(directory, ".magi-memory.json")).exists())) return emptyMemory()
      return validMemory(await Bun.file(path.join(directory, ".magi-memory.json")).json())
    } catch {
      return emptyMemory()
    }
  })

const writeMemory = (directory: string, entry: MagiMemoryEntry) =>
  Effect.gen(function* () {
    const memory = yield* readMemory(directory)
    yield* Effect.promise(async () => {
      try {
        await Bun.write(
          path.join(directory, ".magi-memory.json"),
          `${JSON.stringify({ version: 1, entries: [...memory.entries, entry].slice(-50) }, null, 2)}\n`,
        )
      } catch {
      }
    })
  })

const gitStatus = (directory: string) =>
  Effect.promise(async () => {
    try {
      const proc = Bun.spawn(["git", "status", "--porcelain"], {
        cwd: directory,
        stdout: "pipe",
        stderr: "pipe",
      })
      const stdout = await new Response(proc.stdout).text()
      const exit = await proc.exited
      if (exit !== 0) return "GIT_STATUS_UNAVAILABLE"
      return stdout.trim()
    } catch {
      return "GIT_STATUS_UNAVAILABLE"
    }
  })

export const magiHandlers = HttpApiBuilder.group(InstanceHttpApi, "magi", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const session = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    const scope = yield* Scope.Scope
    const instance = yield* InstanceState.context
    let activity: MagiActivity | undefined
    let selfImprovementRunning = false

    const status = Effect.fn("MagiHttpApi.status")(function* () {
      const resolved = magiConfig(yield* config.get())
      return {
        executorModel: resolved.executorModel,
        councilModel: resolved.councilModel,
        councilModels: uniqueModels([resolved.councilModel, ...resolved.councilFallbackModels]),
        selfImprovement: resolved.selfImprovement,
        activity,
      }
    })

    const askProposalDraft = Effect.fn("MagiHttpApi.askProposalDraft")(function* (input: {
      sessionID?: SessionID
      proposer: MagiCouncilMember
      cycle: number
      previousCompleted: boolean
      recentWork: string
      constraints?: string
      memory?: string
    }) {
      const resolved = magiConfig(yield* config.get())
      const councilModels = uniqueModels([resolved.councilModel, ...resolved.councilFallbackModels])
      const councilModel = Provider.parseModel(councilModels[0] ?? resolved.councilModel)
      const draftSession = yield* session.create({
        parentID: input.sessionID,
        title: `Magi ${input.proposer.toUpperCase()} Draft`,
        agent: "plan",
        model: { id: councilModel.modelID, providerID: councilModel.providerID },
      })
      const askWithModels: (models: string[]) => Effect.Effect<MagiProposalDraft> = (models) => {
        const model = models[0]
        const remaining = models.slice(1)
        if (!model) return Effect.succeed(normalizeProposalDraft(input.proposer, undefined))

        const parsed = Provider.parseModel(model)
        return prompt
          .prompt({
            sessionID: draftSession.id,
            agent: "plan",
            model: { providerID: parsed.providerID, modelID: parsed.modelID },
            format: { type: "json_schema", schema: DRAFT_SCHEMA },
            parts: [
              {
                type: "text",
                text: buildSelfImprovementDraftPrompt({
                  recentWork: input.recentWork,
                  constraints: input.constraints,
                  cycle: input.cycle,
                  proposer: input.proposer,
                  previousCompleted: input.previousCompleted,
                  memory: input.memory,
                }),
              },
            ],
          })
          .pipe(
            Effect.timeout(COUNCIL_MODEL_TIMEOUT),
            Effect.flatMap((message) => {
              if (message.info.role !== "assistant")
                return Effect.fail(new Error("Magi draft prompt did not return an assistant message."))
              if (message.info.error) return Effect.fail(new Error(JSON.stringify(message.info.error)))
              return Effect.succeed(normalizeProposalDraft(input.proposer, message.info.structured))
            }),
            Effect.catchCause(() => (remaining.length > 0 ? askWithModels(remaining) : Effect.succeed(normalizeProposalDraft(input.proposer, undefined)))),
          )
      }
      return yield* askWithModels(councilModels)
    })

    const runCouncil = Effect.fn("MagiHttpApi.runCouncil")(function* (input: {
      sessionID?: SessionID
      proposal: string
      evidence?: string
      kind: MagiTaskKind
      execute: boolean
      proposer?: MagiCouncilMember
      draft?: MagiProposalDraft
    }) {
      const cfg = yield* config.get()
      const resolved = magiConfig(cfg)
      const councilModels = uniqueModels([resolved.councilModel, ...resolved.councilFallbackModels])
      const councilModel = Provider.parseModel(councilModels[0] ?? resolved.councilModel)
      const executorModel = Provider.parseModel(resolved.executorModel)
      const startedAt = Date.now()
      activity = {
        id: crypto.randomUUID(),
        state: "debating",
        topic: topicLine(input.proposal),
        detail: input.proposal,
        round: 1,
        startedAt,
        updatedAt: startedAt,
        votes: resolved.members.map((member) => ({ member, state: "pending" })),
      }

      const updateVote = (member: MagiCouncilMember, vote: Partial<MagiActivityVote>) => {
        if (!activity) return
        activity = {
          ...activity,
          updatedAt: Date.now(),
          votes: activity.votes.map((item) => (item.member === member ? { ...item, ...vote } : item)),
        }
      }

      const askMember = Effect.fn("MagiHttpApi.askMember")(function* (memberInput: {
        member: MagiCouncilMember
        sessionID: SessionID
        round: number
        previousRounds: MagiDebateRound[]
      }) {
        const askWithModels: (models: string[]) => Effect.Effect<MagiDecision> = (models) => {
          const model = models[0]
          const remaining = models.slice(1)
          if (!model) {
            const rationale = "All configured Magi council models failed before producing a structured judgment."
            return Effect.sync(() => {
              updateVote(memberInput.member, { state: "error", rationale, detail: rationale, error: rationale })
              return failedDecision(memberInput.member, rationale)
            })
          }

          const parsed = Provider.parseModel(model)
          updateVote(memberInput.member, {
            state: "pending",
            model,
            detail: `Waiting for ${model}`,
          })
          return prompt
            .prompt({
              sessionID: memberInput.sessionID,
              agent: "plan",
              model: { providerID: parsed.providerID, modelID: parsed.modelID },
              format: { type: "json_schema", schema: JUDGMENT_SCHEMA },
              parts: [
                {
                  type: "text",
                  text: buildDebateRoundPrompt({
                    kind: input.kind,
                    proposal: input.proposal,
                    evidence: input.evidence,
                    member: memberInput.member,
                    round: memberInput.round,
                    previousRounds: memberInput.previousRounds,
                  }),
                },
              ],
            })
            .pipe(
              Effect.timeout(COUNCIL_MODEL_TIMEOUT),
              Effect.flatMap((message) => {
                if (message.info.role !== "assistant")
                  return Effect.fail(new Error("Magi council prompt did not return an assistant message."))
                if (message.info.error)
                  return Effect.fail(new Error(JSON.stringify(message.info.error)))
                return Effect.succeed(normalizeJudgment(memberInput.member, message.info.structured))
              }),
              Effect.tap((decision) =>
                Effect.sync(() =>
                  updateVote(memberInput.member, {
                    state: decision.position ?? "revise",
                    model,
                    rationale: decision.rationale,
                    detail: [
                      decision.rationale,
                      decision.requiredChange ? `Required change: ${decision.requiredChange}` : undefined,
                      decision.evidence?.length ? `Evidence: ${decision.evidence.join("; ")}` : undefined,
                    ]
                      .filter((line): line is string => line !== undefined)
                      .join("\n"),
                  }),
                ),
              ),
              Effect.catchCause((cause) =>
                remaining.length > 0
                  ? askWithModels(remaining)
                  : Effect.sync(() => {
                      const rationale = `Magi council model failed after all fallbacks: ${causeSummary(cause)}`
                      updateVote(memberInput.member, { state: "error", model, rationale, detail: rationale, error: rationale })
                      return failedDecision(memberInput.member, rationale)
                    }),
              ),
            )
        }

        return yield* askWithModels(councilModels)
      })

      const root = yield* session.create({
        parentID: input.sessionID,
        title: input.kind === "self-improvement" ? "Magi Self Improvement" : "Magi Council Review",
        agent: "plan",
        model: { id: councilModel.modelID, providerID: councilModel.providerID },
      })
      const memberSessions = Object.fromEntries(
        yield* Effect.all(
          resolved.members.map((member) =>
            session
              .create({
                parentID: root.id,
                title: `Magi ${member.toUpperCase()}`,
                agent: "plan",
                model: { id: councilModel.modelID, providerID: councilModel.providerID },
              })
              .pipe(Effect.map((created) => [member, created.id] as const)),
          ),
          { concurrency: "unbounded" },
        ),
      ) as Record<MagiCouncilMember, SessionID>
      const rounds: MagiDebateRound[] = []

      while (shouldContinueDebate({ config: cfg, rounds })) {
        const round = rounds.length + 1
        activity = activity && {
          ...activity,
          state: "debating",
          round,
          updatedAt: Date.now(),
          votes: resolved.members.map((member) => ({ member, state: "pending" })),
        }
        const decisions = yield* Effect.all(
          resolved.members.map((member) =>
            askMember({
              member,
              sessionID: memberSessions[member],
              round,
              previousRounds: rounds,
            }),
          ),
          { concurrency: "unbounded" },
        )
        rounds.push({
          round,
          decisions,
          newEvidence: decisions.some((decision) => decision.newEvidence === true),
          synthesis: resolved.debate.synthesisAfterEachRound
            ? decisions
                .map((decision) => `${decision.member}: ${decision.position ?? decision.vote} - ${decision.rationale}`)
                .join("\n")
            : undefined,
        })
      }

      const result = magiReviewResult({ config: cfg, rounds })
      const executorTask =
        input.kind === "self-improvement" && input.proposer
          ? selfImprovementExecutorPrompt({ rounds: result.rounds, proposer: input.proposer, draft: input.draft })
          : input.proposal
      const shouldExecute = input.execute && result.approved && executorTask !== undefined
      activity = activity && {
        ...activity,
        state: shouldExecute ? "executing" : "decided",
        finalPosition: result.finalPosition,
        decidedAt: Date.now(),
        updatedAt: Date.now(),
      }
      const execution = shouldExecute
        ? yield* Effect.gen(function* () {
            const before = yield* gitStatus(instance.directory)
            const message = yield* prompt.prompt({
              sessionID: root.id,
              agent: "build",
              model: { providerID: executorModel.providerID, modelID: executorModel.modelID },
              parts: [
                {
                  type: "text",
                  text: [
                    "Magi council approved this task. Execute it within the current repository constraints.",
                    "Do not claim completion unless code/config/docs were actually changed or a concrete verification result proves no change is needed.",
                    "",
                    "Task:",
                    executorTask,
                    input.evidence ? "" : undefined,
                    input.evidence ? "Evidence:" : undefined,
                    input.evidence,
                    input.kind === "self-improvement" ? "" : undefined,
                    input.kind === "self-improvement" ? "Council question:" : undefined,
                    input.kind === "self-improvement" ? input.proposal : undefined,
                    "",
                    "Council result:",
                    JSON.stringify(result, null, 2),
                  ]
                    .filter((line): line is string => line !== undefined)
                    .join("\n"),
                },
              ],
            })
            const after = yield* gitStatus(instance.directory)
            const errored = message.info.role !== "assistant" || message.info.error !== undefined
            return {
              executed: !errored && before !== after,
              summary: errored
                ? "Executor returned an error."
                : before !== after
                  ? "Executor changed the worktree."
                  : "Executor finished without observable worktree changes.",
            }
          })
        : {
            executed: false,
            summary: result.approved ? "No executor task was available." : `Council final position was ${result.finalPosition}.`,
          }
      activity = activity && { ...activity, state: "decided", updatedAt: Date.now() }

      return {
        sessionID: root.id,
        memberSessionIDs: memberSessions,
        rounds: result.rounds,
        finalPosition: result.finalPosition,
        approved: result.approved,
        executed: execution.executed,
      }
    })

    const review = Effect.fn("MagiHttpApi.review")(function* (ctx: { payload: typeof MagiReviewPayload.Type }) {
      return yield* runCouncil({
        sessionID: ctx.payload.sessionID,
        proposal: ctx.payload.proposal,
        evidence: ctx.payload.evidence,
        kind: ctx.payload.kind ?? "review",
        execute: ctx.payload.execute ?? false,
      })
    })

    const waitForNextSelfImprovementCycle = Effect.fn("MagiHttpApi.waitForNextSelfImprovementCycle")(function* (
      intervalMinutes: number,
    ) {
      const deadline = Date.now() + Math.max(1, intervalMinutes) * 60_000
      while (Date.now() < deadline) {
        if (!magiConfig(yield* config.get()).selfImprovement.enabled) return
        yield* Effect.sleep("5 seconds")
      }
    })

    const runSelfImprovementLoop = Effect.fn("MagiHttpApi.runSelfImprovementLoop")(function* (input: {
      sessionID?: SessionID
      recentWork?: string
      constraints?: string
    }) {
      if (selfImprovementRunning) return
      selfImprovementRunning = true

      yield* Effect.gen(function* () {
        let cycle = 1
        let proposer: MagiCouncilMember = "melchior"
        let previousCompleted = true
        let recentWork = input.recentWork ?? "Magi is observing the current project for its next improvement."
        while (magiConfig(yield* config.get()).selfImprovement.enabled) {
          const cfg = yield* config.get()
          const resolved = magiConfig(cfg)
          if (cycle > resolved.selfImprovement.maxCycles) return
          const currentProposer: MagiCouncilMember = resolved.members.includes(proposer)
            ? proposer
            : (resolved.members[0] ?? "melchior")
          const memory = yield* readMemory(instance.directory)
          const memoryText = memorySummary(memory)
          const draft = yield* askProposalDraft({
            sessionID: input.sessionID,
            proposer: currentProposer,
            cycle,
            previousCompleted,
            recentWork: redactSecrets(recentWork),
            constraints: input.constraints,
            memory: memoryText,
          })
          const proposal = buildSelfImprovementQuestion({
            recentWork: redactSecrets(recentWork),
            constraints: input.constraints,
            cycle,
            proposer: currentProposer,
            previousCompleted,
            draft,
            memory: memoryText,
          })
          const execute =
            !draft.terminal &&
            canExecuteImprovementTask(cfg, {
              kind: "self-improvement",
              title: draft.title,
              prompt: draft.prompt,
              requiresCoreSelfEdit: draft.requiresCoreSelfEdit,
            })
          const result: MagiCouncilResult = yield* runCouncil({
            sessionID: input.sessionID,
            proposal,
            kind: "self-improvement",
            execute,
            proposer: currentProposer,
            draft,
          })
          if (shouldStopSelfImprovement(result.rounds)) return
          yield* writeMemory(instance.directory, {
            cycle,
            proposer: currentProposer,
            title: draft.title,
            finalPosition: result.finalPosition,
            approved: result.approved,
            executed: result.executed,
            summary: redactSecrets(`${draft.title} -> ${result.finalPosition}; executed=${result.executed}`),
            createdAt: Date.now(),
          })
          previousCompleted = result.executed
          recentWork = result.executed
            ? `${currentProposer.toUpperCase()}'s previous improvement was approved and executed. Continue with the next project-specific improvement.`
            : `${currentProposer.toUpperCase()}'s previous improvement did not complete execution. Keep that owner priority and propose a narrower continuation, repair, or validation task.`
          proposer = result.executed ? nextCouncilProposer(resolved.members, currentProposer) : currentProposer
          yield* waitForNextSelfImprovementCycle(resolved.selfImprovement.intervalMinutes)
          cycle++
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            selfImprovementRunning = false
          }),
        ),
      )
    })

    const selfImproveAsync = Effect.fn("MagiHttpApi.selfImproveAsync")(function* (ctx: {
      payload: typeof MagiSelfImprovePayload.Type
    }) {
      const cfg = yield* config.get()
      const resolved = magiConfig(cfg)
      if (!resolved.selfImprovement.enabled) return HttpApiSchema.NoContent.make()

      yield* runSelfImprovementLoop({
        sessionID: ctx.payload.sessionID,
        recentWork: ctx.payload.recentWork,
        constraints: ctx.payload.constraints,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("magi self_improve_async failed", {
            cause: Cause.pretty(cause),
          }),
        ),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      return HttpApiSchema.NoContent.make()
    })

    return handlers.handle("status", status).handle("review", review).handle("selfImproveAsync", selfImproveAsync)
  }),
)
