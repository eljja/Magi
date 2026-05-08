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
  type MagiCouncilMember,
  type MagiDebateRound,
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

export const magiHandlers = HttpApiBuilder.group(InstanceHttpApi, "magi", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const session = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    const scope = yield* Scope.Scope

    const status = Effect.fn("MagiHttpApi.status")(function* () {
      const resolved = magiConfig(yield* config.get())
      return {
        executorModel: resolved.executorModel,
        councilModel: resolved.councilModel,
        selfImprovement: resolved.selfImprovement,
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
      const councilModel = Provider.parseModel(resolved.councilModel)
      const executorModel = Provider.parseModel(resolved.executorModel)
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
        const decisions = yield* Effect.all(
          resolved.members.map((member) =>
            prompt
              .prompt({
                sessionID: memberSessions[member],
                agent: "plan",
                model: { providerID: councilModel.providerID, modelID: councilModel.modelID },
                format: { type: "json_schema", schema: JUDGMENT_SCHEMA },
                parts: [
                  {
                    type: "text",
                    text: buildDebateRoundPrompt({
                      kind: input.kind,
                      proposal: input.proposal,
                      evidence: input.evidence,
                      member,
                      round,
                      previousRounds: rounds,
                    }),
                  },
                ],
              })
              .pipe(
                Effect.map((message) =>
                  normalizeJudgment(member, message.info.role === "assistant" ? message.info.structured : undefined),
                ),
              ),
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

    const selfImproveAsync = Effect.fn("MagiHttpApi.selfImproveAsync")(function* (ctx: {
      payload: typeof MagiSelfImprovePayload.Type
    }) {
      const cfg = yield* config.get()
      const resolved = magiConfig(cfg)
      if (!resolved.selfImprovement.enabled) return HttpApiSchema.NoContent.make()

      const proposal = buildSelfImprovementQuestion({
        recentWork: ctx.payload.recentWork ?? "No recent work summary was provided.",
        constraints: ctx.payload.constraints,
      })
      const execute = canExecuteImprovementTask(cfg, {
        kind: "self-improvement",
        title: "Magi self-improvement cycle",
        prompt: proposal,
        requiresCoreSelfEdit: false,
      })

      yield* runCouncil({
        sessionID: ctx.payload.sessionID,
        proposal,
        kind: "self-improvement",
        execute,
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
