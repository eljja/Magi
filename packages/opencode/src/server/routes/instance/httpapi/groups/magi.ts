import { SessionID } from "@/session/schema"
import { PositiveInt } from "@/util/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/magi"

const MagiMember = Schema.Literals(["melchior", "balthasar", "casper"])
const MagiVote = Schema.Literals(["approve", "reject", "abstain"])
const MagiPosition = Schema.Literals(["approve", "revise", "reject"])
const MagiTaskKind = Schema.Literals(["review", "self-improvement"])

const MagiDecision = Schema.Struct({
  member: MagiMember,
  vote: MagiVote,
  position: Schema.optional(MagiPosition),
  rationale: Schema.String,
  confidence: Schema.optional(Schema.Number),
  evidence: Schema.optional(Schema.Array(Schema.String)),
  requiredChange: Schema.optional(Schema.String),
  newEvidence: Schema.optional(Schema.Boolean),
  safetyCritical: Schema.optional(Schema.Boolean),
})

const MagiDebateRound = Schema.Struct({
  round: PositiveInt,
  decisions: Schema.Array(MagiDecision),
  synthesis: Schema.optional(Schema.String),
  newEvidence: Schema.Boolean,
})

export const MagiReviewPayload = Schema.Struct({
  sessionID: Schema.optional(SessionID).annotate({
    description: "Optional parent session for the Magi council run.",
  }),
  proposal: Schema.String.annotate({
    description: "Proposal or task that the Magi council should debate.",
  }),
  evidence: Schema.optional(Schema.String).annotate({
    description: "Relevant context, diffs, test output, or constraints.",
  }),
  kind: Schema.optional(MagiTaskKind),
  execute: Schema.optional(Schema.Boolean).annotate({
    description: "Execute approved work with the configured executor model.",
  }),
})

export const MagiSelfImprovePayload = Schema.Struct({
  sessionID: Schema.optional(SessionID).annotate({
    description: "Optional parent session for the self-improvement cycle.",
  }),
  recentWork: Schema.optional(Schema.String).annotate({
    description: "Recent work summary used to generate a self-improvement question.",
  }),
  constraints: Schema.optional(Schema.String).annotate({
    description: "Constraints for the self-improvement cycle.",
  }),
})

export const MagiReviewResponse = Schema.Struct({
  sessionID: SessionID,
  memberSessionIDs: Schema.Record(Schema.String, SessionID),
  rounds: Schema.Array(MagiDebateRound),
  finalPosition: MagiPosition,
  approved: Schema.Boolean,
  executed: Schema.Boolean,
})

export const MagiStatusResponse = Schema.Struct({
  executorModel: Schema.String,
  councilModel: Schema.String,
  selfImprovement: Schema.Struct({
    enabled: Schema.Boolean,
    state: Schema.Literals(["off", "on", "paused"]),
    mode: Schema.Literals(["suggest-only", "suggest-and-execute"]),
    coreSelfEdit: Schema.Literals(["disabled", "gated", "allowed"]),
    intervalMinutes: PositiveInt,
  }),
})

export const MagiApi = HttpApi.make("magi")
  .add(
    HttpApiGroup.make("magi")
      .add(
        HttpApiEndpoint.get("status", root, {
          success: described(MagiStatusResponse, "Resolved Magi status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "magi.status",
            summary: "Get Magi status",
            description: "Get resolved Magi dual-model and self-improvement settings.",
          }),
        ),
        HttpApiEndpoint.post("review", `${root}/review`, {
          payload: MagiReviewPayload,
          success: described(MagiReviewResponse, "Magi council review result"),
          error: [HttpApiError.BadRequest, HttpApiError.NotFound],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "magi.review",
            summary: "Run Magi council review",
            description: "Run the three-member Magi council debate with the configured council model.",
          }),
        ),
        HttpApiEndpoint.post("selfImproveAsync", `${root}/self_improve_async`, {
          payload: MagiSelfImprovePayload,
          success: described(HttpApiSchema.NoContent, "Self-improvement cycle accepted"),
          error: [HttpApiError.BadRequest, HttpApiError.NotFound],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "magi.self_improve_async",
            summary: "Start Magi self-improvement",
            description:
              "Start one asynchronous Magi self-improvement cycle if self-improvement is enabled in config.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "magi",
          description: "Magi council routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode Magi HttpApi",
      version: "0.0.1",
      description: "Magi council API surface.",
    }),
  )
