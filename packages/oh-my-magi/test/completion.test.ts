import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { collectArtifactEvidence } from "../src/artifacts"
import { submitExecution } from "../src/execution"
import { setAutonomousLoop } from "../src/continuation"
import { mutateMagiState, readMagiState } from "../src/state"
import { runIndependentJudge } from "../src/verification"
import { MagiConfigDefault } from "../src/config"
import { openCodeFixture } from "./fixture"

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "magi-completion-"))
  await Bun.write(path.join(directory, "result.ts"), "export const result = 42\n")
})
afterEach(() => rm(directory, { recursive: true, force: true }))

test("artifact evidence contains real content and detects changes without Git", async () => {
  const original = await collectArtifactEvidence(directory, ["result.ts", "result.ts", "missing.ts", "../"])
  expect(original).toHaveLength(3)
  expect(original[0]?.excerpt).toContain("result = 42")
  expect(original[1]?.error).toBeDefined()
  expect(original[2]?.error).toBeDefined()
  await Bun.write(path.join(directory, "result.ts"), "export const result = 43\n")
  expect((await collectArtifactEvidence(directory, ["result.ts"]))[0]?.sha256).not.toBe(original[0]?.sha256)
})

test("only the current worker can submit artifacts; submission is not acceptance or stopping", async () => {
  await setAutonomousLoop(directory, true, { sessionID: "owner", goal: "Produce the requested result" })
  await mutateMagiState(directory, (state) => ({ ...state, executionSessionID: "worker", awaitingExecution: true }))
  const input = {
    directory,
    sessionID: "worker",
    summary: "Implemented the result",
    artifacts: ["result.ts"],
    unresolved: ["Need council review"],
  }
  for (const sessionID of ["owner", "old-worker", "child"])
    await expect(submitExecution({ ...input, sessionID })).rejects.toThrow("currently approved")
  await expect(submitExecution({ ...input, artifacts: ["missing.ts"] })).rejects.toThrow("readable files")
  await submitExecution(input)
  const state = await readMagiState(directory)
  expect(state.executionSubmission?.artifacts).toEqual(["result.ts"])
  expect(state.awaitingExecution).toBe(true)
  expect(state.loopActive).toBe(true)
  expect(state.votes).toEqual({})
  await setAutonomousLoop(directory, false)
  await expect(submitExecution(input)).rejects.toThrow("currently approved")
})

const reviewInput = () => ({
  directory,
  config: { ...MagiConfigDefault, resilience: { ...MagiConfigDefault.resilience, maxRetries: 0 } },
  taskTitle: "Produce a result",
  taskPrompt: "Implement result.ts and verify the result",
  executionReport: "Implemented result.ts",
  artifactPaths: ["result.ts"],
  verificationReport: { passed: true, checks: [], summary: "The behavior check passed" },
})

test("three independent completion opinions are shared before final majority votes", async () => {
  const fixture = openCodeFixture({
    reply: async (body) =>
      JSON.stringify({
        position: body.agent === "magi-casper" ? "revise" : "approve",
        rationale: "Evidence assessed independently by " + body.agent,
        requiredChange: body.agent === "magi-casper" ? "Explain the remaining usability concern" : "",
        safetyCritical: false,
      }),
  })
  try {
    const verdict = await runIndependentJudge({ ...reviewInput(), client: fixture.client })
    expect(verdict.approved).toBe(true)
    expect(verdict.critique).toContain("CASPER: revise")
    const prompts = fixture.requests.filter((item) => item.path.endsWith("/message"))
    expect(prompts).toHaveLength(6)
    expect(new Set(prompts.slice(0, 3).map((item) => item.body.agent)).size).toBe(3)
    for (const prompt of prompts.slice(0, 3))
      expect(JSON.stringify(prompt.body.parts)).not.toContain("Council cross-examination")
    for (const prompt of prompts.slice(3)) {
      const text = JSON.stringify(prompt.body.parts)
      expect(text).toContain("Council cross-examination")
      for (const member of ["melchior", "balthasar", "casper"])
        expect(text).toContain("independently by magi-" + member)
      expect(text).toContain("export const result = 42")
    }
  } finally {
    fixture.stop()
  }
})

test("a safety-critical completion veto blocks acceptance despite two approvals", async () => {
  const fixture = openCodeFixture({
    reply: async (body) =>
      JSON.stringify({
        position: body.agent === "magi-balthasar" ? "reject" : "approve",
        rationale: body.agent === "magi-balthasar" ? "Evidence shows a regression" : "Other criteria pass",
        safetyCritical: body.agent === "magi-balthasar",
      }),
  })
  try {
    expect((await runIndependentJudge({ ...reviewInput(), client: fixture.client })).approved).toBe(false)
  } finally {
    fixture.stop()
  }
})

test("an interrupted completion vote resumes saved opinions without asking successful members again", async () => {
  await setAutonomousLoop(directory, true, { sessionID: "owner", goal: "Produce a result" })
  const state = await mutateMagiState(directory, (current) => ({
    ...current,
    currentCycle: 1,
    pendingVerification: { messageID: "result", executionReport: "Implemented result.ts", toolEvidence: "" },
  }))
  let unavailable = true
  const fixture = openCodeFixture({
    reply: async (body) => {
      if (
        unavailable &&
        body.agent === "magi-casper" &&
        JSON.stringify(body.parts).includes("Council cross-examination")
      ) {
        unavailable = false
        return undefined
      }
      return JSON.stringify({ position: "approve", rationale: "The actual artifact satisfies the criteria" })
    },
  })
  try {
    const input = { ...reviewInput(), client: fixture.client, runID: state.runID }
    await expect(runIndependentJudge(input)).rejects.toThrow()
    const pending = (await readMagiState(directory)).pendingVerification?.review
    expect(Object.keys(pending?.opening ?? {})).toHaveLength(3)
    expect(Object.keys(pending?.votes ?? {})).toHaveLength(2)
    expect((await runIndependentJudge(input)).approved).toBe(true)
    expect(fixture.requests.filter((item) => item.path.endsWith("/message"))).toHaveLength(7)
    expect((await readMagiState(directory)).pendingVerification?.review?.votes?.casper?.position).toBe("approve")
  } finally {
    fixture.stop()
  }
})

test("file edits during completion review invalidate even unanimous approval", async () => {
  const fixture = openCodeFixture({
    reply: async () => {
      await Bun.write(path.join(directory, "result.ts"), "export const result = -1\n")
      return JSON.stringify({ position: "approve", rationale: "The supplied snapshot passed", safetyCritical: false })
    },
  })
  try {
    await expect(runIndependentJudge({ ...reviewInput(), client: fixture.client })).rejects.toThrow("Artifacts changed")
  } finally {
    fixture.stop()
  }
})
