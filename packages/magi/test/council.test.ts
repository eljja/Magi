import { describe, expect, test } from "bun:test"
import {
  buildSelfImprovementQuestion,
  canExecuteImprovementTask,
  magiConfig,
  majorityApproved,
  normalizeMembers,
  selfImprovementEnabled,
  shouldCreateImprovementTask,
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
    expect(prompt).toContain("approve, reject, or abstain")
  })
})
