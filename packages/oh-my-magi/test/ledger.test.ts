import { describe, expect, it } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import {
  initializeCouncilLedger,
  recordCouncilDeliberation,
  recordCycleOutcome,
  magiCouncilLedgerPath,
} from "../src/ledger"

describe("Council Deliberation Ledger (.magi/COUNCIL.md)", () => {
  it("initializes council ledger with executive header and goal", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "magi-ledger-test-"))
    const file = await initializeCouncilLedger(dir, "Build high-integrity AI platform")

    expect(await Bun.file(file).exists()).toBe(true)
    const content = await Bun.file(file).text()
    expect(content).toContain("# 🏛️ MAGI SUPREME COUNCIL: Deliberation Ledger & Minutes")
    expect(content).toContain("Build high-integrity AI platform")
    expect(content).toContain("oh-my-openagent")
  })

  it("records deliberation entry with proposal, tripartite debate, and Sisyphus directive", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "magi-ledger-test-"))
    await recordCouncilDeliberation(dir, {
      cycle: 1,
      goal: "Automate test generation",
      milestoneTitle: "Setup baseline test suite",
      milestoneId: 1,
      proposer: "melchior",
      proposalTitle: "Construct test scaffolding",
      proposalRationale: "A solid baseline prevents regression.",
      userSteering: "Focus primarily on auth module tests",
      rounds: [
        {
          round: 1,
          newEvidence: false,
          decisions: [
            {
              member: "melchior",
              position: "approve",
              vote: "approve",
              rationale: "Clean modular separation.",
              confidence: 0.9,
              safetyCritical: false,
              newEvidence: false,
            },
            {
              member: "balthasar",
              position: "approve",
              vote: "approve",
              rationale: "No security issues identified.",
              confidence: 0.85,
              safetyCritical: false,
              newEvidence: false,
            },
            {
              member: "casper",
              position: "approve",
              vote: "approve",
              rationale: "High deliverable value.",
              confidence: 0.95,
              safetyCritical: false,
              newEvidence: false,
            },
          ],
        },
      ],
      finalPosition: "approve",
      directivePrompt: "[OH-MY-MAGI COUNCIL TASK — CYCLE #1]\nImplement auth test suite.",
    })

    const file = magiCouncilLedgerPath(dir)
    const content = await Bun.file(file).text()
    expect(content).toContain("## Cycle #1: Construct test scaffolding")
    expect(content).toContain("USER INTERVENTION / STEERING APPLIED")
    expect(content).toContain("Focus primarily on auth module tests")
    expect(content).toContain("MELCHIOR")
    expect(content).toContain("BALTHASAR")
    expect(content).toContain("CASPER")
    expect(content).toContain("APPROVED")
    expect(content).toContain("Implement auth test suite.")
  })

  it("appends cycle execution outcome with telemetry and verification", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "magi-ledger-test-"))
    await recordCouncilDeliberation(dir, {
      cycle: 1,
      goal: "Test goal",
      proposer: "casper",
      proposalTitle: "Initial step",
      proposalRationale: "Rationale",
      rounds: [],
      finalPosition: "approve",
      directivePrompt: "Do step",
    })

    await recordCycleOutcome(dir, {
      cycle: 1,
      verificationPassed: true,
      verificationSummary: "bun test: 12 pass, 0 fail",
      judgeApproved: true,
      judgeCritique: "All requirements cleanly satisfied.",
      milestoneCompleted: true,
      milestoneTitle: "Initial Milestone",
      telemetry: {
        toolCallCount: 5,
        modifiedFiles: ["src/index.ts", "test/index.test.ts"],
        lastActiveAt: Date.now(),
        stallCount: 0,
      },
    })

    const file = magiCouncilLedgerPath(dir)
    const content = await Bun.file(file).text()
    expect(content).toContain("Workforce Execution & Verification Outcome")
    expect(content).toContain("VERIFIED & PASSED")
    expect(content).toContain("5 tool operations performed")
    expect(content).toContain("src/index.ts")
    expect(content).toContain("bun test: 12 pass, 0 fail")
    expect(content).toContain("Milestone #1 (Initial Milestone) marked **COMPLETED & VERIFIED**")
  })
})
