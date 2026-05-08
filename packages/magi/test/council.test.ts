import { describe, expect, test } from "bun:test"
import {
  buildSelfImprovementQuestion,
  buildDebateRoundPrompt,
  canExecuteImprovementTask,
  finalDebatePosition,
  magiConfig,
  magiReviewResult,
  majorityApproved,
  majorityPosition,
  normalizeJudgment,
  normalizeMembers,
  selfImprovementEnabled,
  shouldCreateImprovementTask,
  shouldContinueDebate,
  shouldStopSelfImprovement,
} from "../src/council"

describe("Magi council", () => {
  test("normalizes council members to the three supported roles", () => {
    expect(normalizeMembers(["melchior", "unknown", "casper"])).toEqual(["melchior", "casper"])
    expect(normalizeMembers(["unknown"])).toEqual(["melchior", "balthasar", "casper"])
  })

  test("keeps public default self-improvement off", () => {
    const config = {}
    expect(selfImprovementEnabled(config)).toBe(false)
    expect(shouldCreateImprovementTask(config)).toBe(false)
  })

  test("resolves Magi defaults and user-selected dual models", () => {
    const config = {
      magi: {
        models: {
          executor: "anthropic/claude-sonnet-4-5",
          council: "lmstudio/qwen/qwen3-coder-local",
          councilFallbacks: ["google/gemini-3.1-flash-lite"],
        },
        selfImprovement: {
          enabled: true,
          state: "on" as const,
        },
      },
    }

    expect(magiConfig(config)).toMatchObject({
      executorModel: "anthropic/claude-sonnet-4-5",
      councilModel: "lmstudio/qwen/qwen3-coder-local",
      councilFallbackModels: ["google/gemini-3.1-flash-lite"],
      selfImprovement: {
        enabled: true,
        state: "on",
        mode: "suggest-and-execute",
        coreSelfEdit: "gated",
      },
    })
  })

  test("uses majority voting by default", () => {
    expect(
      majorityApproved([
        { member: "melchior", vote: "approve", rationale: "fits" },
        { member: "balthasar", vote: "reject", rationale: "risk" },
        { member: "casper", vote: "approve", rationale: "better" },
      ]),
    ).toBe(true)
  })

  test("returns revise when a debate vote has no majority", () => {
    expect(
      majorityPosition([
        { member: "melchior", vote: "approve", rationale: "fits" },
        { member: "balthasar", vote: "reject", rationale: "risk" },
        { member: "casper", vote: "abstain", rationale: "unclear" },
      ]),
    ).toBe("revise")
  })

  test("counts revise positions as votes instead of ignoring them", () => {
    expect(
      majorityPosition([
        { member: "melchior", vote: "approve", position: "approve", rationale: "fits" },
        { member: "balthasar", vote: "abstain", position: "revise", rationale: "needs stronger bounds" },
        { member: "casper", vote: "abstain", position: "revise", rationale: "needs more synthesis room" },
      ]),
    ).toBe("revise")
    expect(
      majorityApproved([
        { member: "melchior", vote: "approve", position: "approve", rationale: "fits" },
        { member: "balthasar", vote: "abstain", position: "revise", rationale: "needs stronger bounds" },
        { member: "casper", vote: "abstain", position: "revise", rationale: "needs more synthesis room" },
      ]),
    ).toBe(false)
  })

  test("stops continuous debate when no new evidence appears", () => {
    const config = {
      magi: {
        debate: {
          maxRounds: 3,
          requireNewEvidence: true,
          stagnationLimit: 1,
        },
      },
    }
    expect(shouldContinueDebate({ config, rounds: [] })).toBe(true)
    expect(
      shouldContinueDebate({
        config,
        rounds: [{ round: 1, newEvidence: false, decisions: [] }],
      }),
    ).toBe(false)
  })

  test("uses the final round for the final debate position", () => {
    expect(
      finalDebatePosition({
        config: {},
        rounds: [
          {
            round: 1,
            newEvidence: true,
            decisions: [
              { member: "melchior", vote: "approve", rationale: "fits" },
              { member: "balthasar", vote: "reject", rationale: "risk" },
              { member: "casper", vote: "reject", rationale: "weak value" },
            ],
          },
        ],
      }),
    ).toBe("reject")
  })

  test("gates core self-edit execution separately from prompt and config improvements", () => {
    const config = {
      magi: {
        selfImprovement: {
          enabled: true,
          state: "on" as const,
          mode: "suggest-and-execute" as const,
          coreSelfEdit: "disabled" as const,
        },
      },
    }

    expect(
      canExecuteImprovementTask(config, {
        kind: "self-improvement",
        title: "Tune council prompts",
        prompt: "Update prompts",
        requiresCoreSelfEdit: false,
      }),
    ).toBe(true)
    expect(
      canExecuteImprovementTask(config, {
        kind: "self-improvement",
        title: "Rewrite executor loop",
        prompt: "Edit core loop",
        requiresCoreSelfEdit: true,
      }),
    ).toBe(false)
  })

  test("builds a self-improvement prompt for local council review", () => {
    const prompt = buildSelfImprovementQuestion({ recentWork: "Changed the settings UI.", cycle: 2 })
    expect(prompt).toContain("Magi council task: self-improvement")
    expect(prompt).toContain("autonomous self-improvement cycle #2")
    expect(prompt).toContain("exact executor input")
    expect(prompt).toContain("STOP_SELF_IMPROVEMENT")
    expect(prompt).toContain("Recent work:")
    expect(prompt).toContain("approve, revise, or reject")
  })

  test("only stops self-improvement when every member explicitly votes for terminal stop", () => {
    expect(
      shouldStopSelfImprovement([
        {
          round: 1,
          newEvidence: false,
          decisions: [
            {
              member: "melchior",
              vote: "reject",
              position: "reject",
              rationale: "complete",
              requiredChange: "STOP_SELF_IMPROVEMENT",
            },
            {
              member: "balthasar",
              vote: "reject",
              position: "reject",
              rationale: "complete",
              requiredChange: "STOP_SELF_IMPROVEMENT",
            },
            {
              member: "casper",
              vote: "reject",
              position: "reject",
              rationale: "complete",
              requiredChange: "STOP_SELF_IMPROVEMENT",
            },
          ],
        },
      ]),
    ).toBe(true)
    expect(
      shouldStopSelfImprovement([
        {
          round: 1,
          newEvidence: false,
          decisions: [
            {
              member: "melchior",
              vote: "reject",
              position: "reject",
              rationale: "complete",
              requiredChange: "STOP_SELF_IMPROVEMENT",
            },
            { member: "balthasar", vote: "abstain", position: "revise", rationale: "one more task" },
            {
              member: "casper",
              vote: "reject",
              position: "reject",
              rationale: "complete",
              requiredChange: "STOP_SELF_IMPROVEMENT",
            },
          ],
        },
      ]),
    ).toBe(false)
  })

  test("normalizes structured local model judgments", () => {
    expect(
      normalizeJudgment("balthasar", {
        position: "reject",
        rationale: "Rollback is missing.",
        confidence: 2,
        evidence: ["no rollback plan", 7],
        safetyCritical: true,
        newEvidence: true,
      }),
    ).toEqual({
      member: "balthasar",
      vote: "reject",
      position: "reject",
      rationale: "Rollback is missing.",
      confidence: 1,
      evidence: ["no rollback plan"],
      safetyCritical: true,
      newEvidence: true,
      requiredChange: undefined,
    })
  })

  test("builds debate prompts with prior disagreement context", () => {
    const prompt = buildDebateRoundPrompt({
      kind: "review",
      member: "melchior",
      round: 2,
      proposal: "Change executor routing.",
      previousRounds: [
        {
          round: 1,
          newEvidence: true,
          decisions: [
            { member: "melchior", vote: "approve", position: "approve", rationale: "coherent" },
            { member: "balthasar", vote: "reject", position: "reject", rationale: "unsafe" },
          ],
        },
      ],
    })

    expect(prompt).toContain("MELCHIOR")
    expect(prompt).toContain("Previous debate rounds:")
    expect(prompt).toContain("Do not agree just to be agreeable")
  })

  test("turns final debate position into a review result", () => {
    expect(
      magiReviewResult({
        config: {},
        rounds: [
          {
            round: 1,
            newEvidence: true,
            decisions: [
              { member: "melchior", vote: "approve", position: "approve", rationale: "fits" },
              { member: "balthasar", vote: "approve", position: "approve", rationale: "safe" },
              { member: "casper", vote: "reject", position: "reject", rationale: "weak value" },
            ],
          },
        ],
      }),
    ).toMatchObject({ finalPosition: "approve", approved: true })
  })
})
