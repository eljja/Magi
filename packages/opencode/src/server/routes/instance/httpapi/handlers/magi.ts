import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import {
  buildDebateRoundPrompt,
  buildSelfImprovementQuestion,
  canExecuteImprovementTask,
  magiConfig,
  magiReviewResult,
  normalizeJudgment,
  shouldContinueDebate,
  shouldStopSelfImprovement,
  type MagiCouncilMember,
  type MagiDecision,
  type MagiDebateRound,
  type MagiPosition,
  type MagiTaskKind,
} from "@magi/core"
import { Cause, Effect, Scope } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
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

export const magiHandlers = HttpApiBuilder.group(InstanceHttpApi, "magi", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const session = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    const scope = yield* Scope.Scope
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

    const runCouncil = Effect.fn("MagiHttpApi.runCouncil")(function* (input: {
      sessionID?: SessionID
      proposal: string
      evidence?: string
      kind: MagiTaskKind
      execute: boolean
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
      const executed = input.execute && result.approved
      activity = activity && {
        ...activity,
        state: executed ? "executing" : "decided",
        finalPosition: result.finalPosition,
        decidedAt: Date.now(),
        updatedAt: Date.now(),
      }
      if (executed) {
        yield* prompt.prompt({
          sessionID: root.id,
          agent: "build",
          model: { providerID: executorModel.providerID, modelID: executorModel.modelID },
          parts: [
            {
              type: "text",
              text: [
                "Magi council approved this task. Execute it within the current repository constraints.",
                "",
                "Task:",
                input.proposal,
                input.evidence ? "" : undefined,
                input.evidence ? "Evidence:" : undefined,
                input.evidence,
                "",
                "Council result:",
                JSON.stringify(result, null, 2),
              ]
                .filter((line): line is string => line !== undefined)
                .join("\n"),
            },
          ],
        })
        activity = activity && { ...activity, state: "decided", updatedAt: Date.now() }
      }

      return {
        sessionID: root.id,
        memberSessionIDs: memberSessions,
        rounds: result.rounds,
        finalPosition: result.finalPosition,
        approved: result.approved,
        executed,
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
        while (magiConfig(yield* config.get()).selfImprovement.enabled) {
          const cfg = yield* config.get()
          const resolved = magiConfig(cfg)
          const proposal = buildSelfImprovementQuestion({
            recentWork: input.recentWork ?? "Magi is observing the current project for its next improvement.",
            constraints: input.constraints,
            cycle,
          })
          const execute = canExecuteImprovementTask(cfg, {
            kind: "self-improvement",
            title: `Magi self-improvement cycle ${cycle}`,
            prompt: proposal,
            requiresCoreSelfEdit: false,
          })
          const result = yield* runCouncil({
            sessionID: input.sessionID,
            proposal,
            kind: "self-improvement",
            execute,
          })
          if (shouldStopSelfImprovement(result.rounds)) return
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
