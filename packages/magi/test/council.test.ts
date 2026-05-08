import { describe, expect, test } from "bun:test"
import {
  buildSelfImprovementQuestion,
  buildSelfImprovementDraftPrompt,
  buildDebateRoundPrompt,
  canExecuteImprovementTask,
  finalDebatePosition,
  magiConfig,
  magiReviewResult,
  majorityApproved,
  majorityPosition,
  nextCouncilProposer,
  normalizeProposalDraft,
  normalizeJudgment,
  normalizeMembers,
  selfImprovementExecutorPrompt,
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
    expect(
      canExecuteImprovementTask(
        {
          magi: {
            selfImprovement: {
              enabled: true,
              state: "on" as const,
              mode: "suggest-and-execute" as const,
              coreSelfEdit: "gated" as const,
            },
          },
        },
        {
          kind: "self-improvement",
          title: "Rewrite executor loop",
          prompt: "Edit core loop",
          requiresCoreSelfEdit: true,
        },
      ),
    ).toBe(false)
    expect(
      canExecuteImprovementTask(
        {
          magi: {
            selfImprovement: {
              enabled: true,
              state: "on" as const,
              mode: "suggest-and-execute" as const,
              coreSelfEdit: "allowed" as const,
            },
          },
        },
        {
          kind: "self-improvement",
          title: "Rewrite executor loop",
          prompt: "Edit core loop",
          requiresCoreSelfEdit: true,
        },
      ),
    ).toBe(true)
  })

  test("builds a self-improvement prompt for local council review", () => {
    const draft = normalizeProposalDraft("balthasar", {
      title: "Harden completion checks",
      prompt: "Implement verifier-backed completion checks for Magi.",
      rationale: "Rotation should depend on real completion.",
      requiresCoreSelfEdit: true,
    })
    const prompt = buildSelfImprovementQuestion({
      recentWork: "Changed the settings UI.",
      cycle: 2,
      proposer: "balthasar",
      previousCompleted: false,
      draft,
      memory: "Last cycle did not change files.",
    })
    expect(prompt).toContain("Magi council task: self-improvement")
    expect(prompt).toContain("autonomous self-improvement cycle #2")
    expect(prompt).toContain("Current proposal owner: BALTHASAR")
    expect(prompt).toContain("Owner draft executor prompt")
    expect(prompt).toContain("Implement verifier-backed completion checks")
    expect(prompt).toContain("keeps priority")
    expect(prompt).toContain("exact executor input")
    expect(prompt).toContain("STOP_SELF_IMPROVEMENT")
    expect(prompt).toContain("Last cycle did not change files")
    expect(prompt).toContain("Recent work:")
    expect(prompt).toContain("approve, revise, or reject")
  })

  test("builds and normalizes proposer-only drafts", () => {
    const prompt = buildSelfImprovementDraftPrompt({
      recentWork: "Vote UI is visible.",
      proposer: "casper",
      previousCompleted: true,
    })
    expect(prompt).toContain("sole proposal owner")
    expect(prompt).toContain("CASPER")
    expect(
      normalizeProposalDraft("casper", {
        title: "Improve vote affordance",
        prompt: "Add a clearer council vote status tooltip.",
        rationale: "Users need legibility.",
        requiresCoreSelfEdit: false,
        terminal: false,
      }),
    ).toEqual({
      proposer: "casper",
      title: "Improve vote affordance",
      prompt: "Add a clearer council vote status tooltip.",
      rationale: "Users need legibility.",
      requiresCoreSelfEdit: false,
      terminal: false,
    })
  })

  test("rotates proposal ownership after completed work", () => {
    expect(nextCouncilProposer(["melchior", "balthasar", "casper"], "melchior")).toBe("balthasar")
    expect(nextCouncilProposer(["melchior", "balthasar", "casper"], "casper")).toBe("melchior")
  })

  test("prefers the current proposer's executor prompt", () => {
    expect(
      selfImprovementExecutorPrompt({
        proposer: "balthasar",
        draft: normalizeProposalDraft("balthasar", {
          title: "Fallback",
          prompt: "Implement fallback prompt.",
          rationale: "Fallback.",
        }),
        rounds: [
          {
            round: 1,
            newEvidence: false,
            decisions: [
              {
                member: "melchior",
                vote: "approve",
                position: "approve",
                rationale: "fine",
                requiredChange: "Implement Melchior's alternative.",
              },
              {
                member: "balthasar",
                vote: "approve",
                position: "approve",
                rationale: "owned",
                requiredChange: "Implement Balthasar's safety hardening.",
              },
              {
                member: "casper",
                vote: "approve",
                position: "approve",
                rationale: "fine",
                requiredChange: "Implement Casper's polish.",
              },
            ],
          },
        ],
      }),
    ).toBe("Implement Balthasar's safety hardening.")
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
