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
    const prompt = buildSelfImprovementQuestion({ recentWork: "Changed the settings UI." })
    expect(prompt).toContain("Magi council task: self-improvement")
    expect(prompt).toContain("Recent work:")
    expect(prompt).toContain("approve, revise, or reject")
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
