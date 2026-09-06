import { describe, expect, test } from "bun:test"
import {
  decisionFromJudgment,
  finalDebatePosition,
  MagiCouncilMembers,
  majorityPosition,
  nextCouncilProposer,
  normalizeCouncilJudgment,
  normalizeProposalDraft,
  shouldContinueDebate,
  shouldStopSelfImprovement,
  STOP_SELF_IMPROVEMENT,
  type MagiDebateRound,
  type MagiDecision,
} from "../src/council"

describe("Council Engine", () => {
  test("includes three canonical members", () => {
    expect(MagiCouncilMembers).toEqual(["melchior", "balthasar", "casper"])
  })

  test("calculates majority position correctly", () => {
    const approveMajority: MagiDecision[] = [
      { member: "melchior", vote: "approve", position: "approve", rationale: "Solid design" },
      { member: "balthasar", vote: "reject", position: "reject", rationale: "Risk detected" },
      { member: "casper", vote: "approve", position: "approve", rationale: "Good UX" },
    ]
    expect(majorityPosition(approveMajority)).toBe("approve")

    const reviseMajority: MagiDecision[] = [
      { member: "melchior", vote: "abstain", position: "revise", rationale: "Needs tests" },
      { member: "balthasar", vote: "reject", position: "reject", rationale: "Risk detected" },
      { member: "casper", vote: "abstain", position: "revise", rationale: "Refine copy" },
    ]
    expect(majorityPosition(reviseMajority)).toBe("revise")

    const splitWithoutMajority: MagiDecision[] = [
      { member: "melchior", vote: "approve", position: "approve", rationale: "Looks good" },
      { member: "balthasar", vote: "reject", position: "reject", rationale: "Too risky" },
      { member: "casper", vote: "abstain", position: "revise", rationale: "Clarify intent" },
    ]
    expect(majorityPosition(splitWithoutMajority)).toBe("revise")
  })

  test("applies safety-critical veto", () => {
    const rounds: MagiDebateRound[] = [
      {
        round: 1,
        newEvidence: true,
        decisions: [
          { member: "melchior", vote: "approve", position: "approve", rationale: "Good structure" },
          { member: "balthasar", vote: "reject", position: "reject", rationale: "Will drop production DB!", safetyCritical: true },
          { member: "casper", vote: "approve", position: "approve", rationale: "Ship it fast" },
        ],
      },
    ]
    expect(finalDebatePosition(rounds, "safety-critical")).toBe("reject")
  })

  test("stops debate on stagnation", () => {
    const rounds: MagiDebateRound[] = [
      {
        round: 1,
        newEvidence: false,
        decisions: [],
      },
    ]
    expect(shouldContinueDebate(rounds, 3, true, 1)).toBe(false)
  })

  test("detects unanimous stop self-improvement", () => {
    const nonUnanimous: MagiDebateRound[] = [
      {
        round: 1,
        newEvidence: false,
        decisions: [
          { member: "melchior", vote: "reject", position: "reject", rationale: "Done", requiredChange: STOP_SELF_IMPROVEMENT },
          { member: "balthasar", vote: "reject", position: "reject", rationale: "Done", requiredChange: STOP_SELF_IMPROVEMENT },
          { member: "casper", vote: "approve", position: "approve", rationale: "More features needed" },
        ],
      },
    ]
    expect(shouldStopSelfImprovement(nonUnanimous)).toBe(false)

    const unanimousStop: MagiDebateRound[] = [
      {
        round: 1,
        newEvidence: false,
        decisions: [
          { member: "melchior", vote: "reject", position: "reject", rationale: "Done", requiredChange: STOP_SELF_IMPROVEMENT },
          { member: "balthasar", vote: "reject", position: "reject", rationale: "Done", requiredChange: STOP_SELF_IMPROVEMENT },
          { member: "casper", vote: "reject", position: "reject", rationale: "Done", requiredChange: STOP_SELF_IMPROVEMENT },
        ],
      },
    ]
    expect(shouldStopSelfImprovement(unanimousStop)).toBe(true)
  })

  test("rotates proposal owners in council sequence", () => {
    expect(nextCouncilProposer(MagiCouncilMembers, "melchior")).toBe("balthasar")
    expect(nextCouncilProposer(MagiCouncilMembers, "balthasar")).toBe("casper")
    expect(nextCouncilProposer(MagiCouncilMembers, "casper")).toBe("melchior")
  })

  test("normalizes council judgment gracefully", () => {
    const judgment = normalizeCouncilJudgment({
      position: "accept",
      rationale: "Approved after careful analysis",
      confidence: 0.95,
      evidence: ["passes unit tests"],
      newEvidence: true,
      safetyCritical: false,
    })
    expect(judgment.position).toBe("approve")
    expect(judgment.confidence).toBe(0.95)
    expect(judgment.evidence).toEqual(["passes unit tests"])

    const decision = decisionFromJudgment("melchior", judgment)
    expect(decision.vote).toBe("approve")
    expect(decision.member).toBe("melchior")
  })

  test("normalizes proposal drafts", () => {
    const draft = normalizeProposalDraft("balthasar", {
      title: "Add security validation",
      prompt: "Add zod schemas to prevent injection",
      rationale: "Reduces attack surface",
      terminal: false,
    })
    expect(draft.proposer).toBe("balthasar")
    expect(draft.title).toBe("Add security validation")
    expect(draft.terminal).toBe(false)
  })
})
