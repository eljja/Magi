import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { setAutonomousLoop } from "../src/continuation"
import { MagiConfigDefault, loadMagiConfig } from "../src/config"
import { MagiCouncilMembers, decisionFromJudgment, normalizeCouncilJudgment } from "../src/council"
import { recordSignificantProgress, tickProgressReports } from "../src/progress"
import { mutateMagiState, readMagiState } from "../src/state"
import { publishReport } from "../src/reporting"
import { openCodeFixture } from "./fixture"

let directory: string
let fixture: ReturnType<typeof openCodeFixture>
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "magi-progress-"))
  fixture = openCodeFixture()
  await setAutonomousLoop(directory, true, { sessionID: "owner", goal: "한 목표를 계속 개선" })
})
afterEach(async () => {
  fixture.stop()
  await rm(directory, { recursive: true, force: true })
})
const votes = () =>
  MagiCouncilMembers.map((member) =>
    decisionFromJudgment(
      member,
      normalizeCouncilJudgment({
        position: "approve",
        rationale: "다음 작업에 찬성",
        significantProgress: {
          reason: member + " 관점에서 재현되는 개선",
          evidence: ["behavior.test.ts: regression now passes"],
        },
      }),
    ),
  )
const checkpoint = () =>
  mutateMagiState(directory, (state) => ({
    ...state,
    progress: {
      cycle: 1,
      time: Date.now(),
      summary: "버그 수정 확인",
      artifacts: ["sum.ts"],
      verification: { passed: true, checks: [], summary: "Tests passed" },
    },
  }))

test("four-hour active-time boundary reports without any completion or extra model request", async () => {
  expect((await loadMagiConfig(directory)).reporting.intervalMs).toBe(14400000)
  const now = Date.now()
  await mutateMagiState(directory, (state) => ({
    ...state,
    reporting: { activeMs: MagiConfigDefault.reporting.intervalMs - 15000, tickAt: now },
  }))
  await tickProgressReports(directory, fixture.client, now + 14999)
  expect((await readMagiState(directory)).reporting?.latest).toBeUndefined()
  await tickProgressReports(directory, fixture.client, now + 15000)
  const state = await readMagiState(directory)
  expect(state.reporting?.latest?.reason).toBe("periodic")
  expect(state.loopActive).toBe(true)
  expect(state.reporting?.latest?.text).toContain("아직 새로운 진행 기록이 없습니다")
  const prompts = fixture.requests.filter((item) => item.method === "POST" && item.path.endsWith("/message"))
  expect(prompts).toHaveLength(1)
  expect(prompts[0]?.body.noReply).toBe(true)
  expect(JSON.stringify(prompts[0]?.body)).toContain('"magiOrigin":"report"')
  await tickProgressReports(directory, fixture.client, now + 30000)
  expect(fixture.requests.filter((item) => item.method === "POST" && item.path.endsWith("/message"))).toHaveLength(1)
  expect(await Bun.file(path.join(directory, ".magi", "LATEST-REPORT.md")).text()).toContain("정기 보고")
})

test("host downtime and pauses do not count as four hours of progress", async () => {
  const now = Date.now()
  await mutateMagiState(directory, (state) => ({ ...state, reporting: { activeMs: 1000, tickAt: now - 5 * 3600000 } }))
  await tickProgressReports(directory, fixture.client, now)
  expect((await readMagiState(directory)).reporting?.activeMs).toBe(1000)
  await setAutonomousLoop(directory, false)
  await tickProgressReports(directory, fixture.client, now + 30000)
  expect((await readMagiState(directory)).reporting?.activeMs).toBe(1000)
  expect((await readMagiState(directory)).reporting?.latest).toBeUndefined()
})

test("an early report requires three evidence-backed opinions about observed progress, not merely approval", async () => {
  const runID = (await readMagiState(directory)).runID!
  await recordSignificantProgress(directory, runID, votes())
  expect((await readMagiState(directory)).reporting?.significant).toBeUndefined()
  await checkpoint()
  await recordSignificantProgress(directory, runID, votes().slice(0, 2))
  expect((await readMagiState(directory)).reporting?.significant).toBeUndefined()
  const ordinary = votes().map((vote) => ({ ...vote, significantProgress: undefined }))
  await recordSignificantProgress(directory, runID, ordinary)
  expect((await readMagiState(directory)).reporting?.significant).toBeUndefined()
  await recordSignificantProgress(directory, runID, votes())
  await tickProgressReports(directory, fixture.client)
  expect((await readMagiState(directory)).reporting?.latest?.reason).toBe("significant")
  for (const member of MagiCouncilMembers)
    expect((await readMagiState(directory)).reporting?.latest?.text).toContain(member.toUpperCase())
  await recordSignificantProgress(directory, runID, votes())
  expect((await readMagiState(directory)).reporting?.significant).toBeUndefined()
})

test("delivery errors leave a durable report and retry without pausing work", async () => {
  const unavailable = Bun.serve({ port: 0, fetch: () => new Response("temporarily unavailable", { status: 503 }) })
  const { createOpencodeClient } = await import("@opencode-ai/sdk")
  const client = createOpencodeClient({ baseUrl: unavailable.url.toString() })
  try {
    await checkpoint()
    await recordSignificantProgress(directory, (await readMagiState(directory)).runID!, votes())
    await tickProgressReports(directory, client)
    const pending = await readMagiState(directory)
    expect(pending.loopActive).toBe(true)
    expect(pending.reporting?.deliveryError).toBeDefined()
    expect(await Bun.file(path.join(directory, ".magi", "LATEST-REPORT.md")).exists()).toBe(true)
    await tickProgressReports(directory, fixture.client)
    const delivered = await readMagiState(directory)
    expect(delivered.reporting?.latest?.id).toBe(pending.reporting?.latest?.id)
    expect(delivered.reporting?.latest?.notified).toBe(true)
    expect(delivered.reporting?.deliveryError).toBeUndefined()
  } finally {
    unavailable.stop(true)
  }
})

test("monitor shows partial arguments and final reasons before all votes arrive", async () => {
  const opinion = normalizeCouncilJudgment({ position: "revise", rationale: "<script>실패 근거부터 확인</script>" })
  const state = await mutateMagiState(directory, (state) => ({
    ...state,
    councilOpinions: { cycle: 1, opening: { casper: opinion }, votes: { melchior: opinion } },
  }))
  await publishReport(directory, state)
  const html = await Bun.file(path.join(directory, ".magi", "index.html")).text()
  expect(html).toContain("상호 검토 후 최종 의견")
  expect(html).toContain("&lt;script&gt;실패 근거부터 확인")
  expect(html).not.toContain("<script>")
  expect(html).toContain("revise")
})
