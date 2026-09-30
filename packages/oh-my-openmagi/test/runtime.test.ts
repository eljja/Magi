import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, unlink } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Store } from "../src/store"
import { Engine, backoff } from "../src/engine"
import { configSchema } from "../src/config"
import { applyControl, parseControl } from "../src/control"
import { decide, decode, voteSchema } from "../src/council"
import { receiveHuman } from "../src/receive"
import { Reporter } from "../src/reports"
import { writeViews } from "../src/views"
import type { Host, Job, Report, Snapshot } from "../src/types"

const temporary: { path: string; store: Store; engine: Engine }[] = []
const vote = {
  position: "approve" as const,
  summary: "Evidence supports this bounded task",
  rationale: "Within the goal; verification is specified",
  evidence: ["goal"],
}
const proposal = {
  action: "work",
  title: "Inspect fixture",
  instruction: "Inspect local fixture and report evidence",
  rationale: "Advance original goal",
  executor: "sisyphus",
  acceptance: ["fixture inspected"],
}
class Transport implements Host {
  sessions = new Map<string, { title: string; job?: Job; snapshot?: Snapshot }>()
  sent: Job[] = []
  aborted: string[] = []
  reports: Report[] = []
  hold = new Set<string>()
  failSend = false
  failReport = false
  async create(title: string) {
    const id = crypto.randomUUID()
    this.sessions.set(id, { title })
    return id
  }
  async find(title: string) {
    return [...this.sessions].find(([, session]) => session.title === title)?.[0]
  }
  async hasMessage(session: string, message: string) {
    return this.sessions.get(session)?.job?.message === message
  }
  async send(job: Job) {
    this.sent.push({ ...job })
    this.sessions.get(job.session!)!.job = { ...job }
    if (this.failSend) {
      this.failSend = false
      throw new Error("network response lost after acceptance")
    }
  }
  async inspect(job: Job): Promise<Snapshot> {
    if (this.sessions.get(job.session!)?.snapshot) return this.sessions.get(job.session!)!.snapshot!
    if (this.hold.has(job.member || job.kind))
      return { busy: true, answered: false, text: "", evidence: "", activity: "waiting" }
    return {
      busy: false,
      answered: true,
      text:
        job.kind === "proposal"
          ? JSON.stringify(proposal)
          : job.kind === "execution"
            ? "Read fixture"
            : JSON.stringify(vote),
      evidence: "Actual fixture evidence",
      activity: "complete",
    }
  }
  async abort(session: string) {
    this.aborted.push(session)
  }
  async agents() {
    return [{ name: "Sisyphus (Ultraworker)", mode: "primary" }]
  }
  async report(_owner: string, report: Report) {
    if (this.failReport) throw new Error("offline")
    this.reports.push(report)
  }
}
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "openmagi-unit-"))
  const store = new Store(directory, path.join(directory, "data"))
  const host = new Transport()
  const settings = configSchema.parse({ resilience: { retryBaseMs: 10, retryMaxMs: 100, requestTimeoutMs: 100000 } })
  const engine = new Engine(store, host, async () => settings)
  store.update((state) => ({
    ...state,
    goal: "Inspect this project and improve it",
    owner: "owner",
    model: "local/test",
    desiredState: "running",
    phase: "planning",
    reporting: { ...state.reporting, nextAt: Date.now() + 3600000 },
  }))
  temporary.push({ path: directory, store, engine })
  return { directory, store, host, engine, settings }
}
afterEach(async () => {
  for (const item of temporary.splice(0)) {
    await item.engine.dispose()
    item.store.close()
    await rm(item.path, { recursive: true, force: true })
  }
})
async function advance(engine: Engine, ticks = 12) {
  for (let index = 0; index < ticks; index++) await engine.tick(Date.now() + index * 4000)
}

describe("human controls", () => {
  test.each([
    ["report interval 30m", 1800000],
    ["앞으로 한 시간마다 보고해", 3600000],
    ["보고 간격을 30분으로 줄여", 1800000],
    ["이제 네 시간마다 보고해도 돼", 14400000],
  ])("%s changes interval", (text, ms) => expect(parseControl(text)).toEqual({ type: "interval", ms }))
  test("quoted instructions and questions do not become stop or schedule changes", () => {
    expect(parseControl('agent said "stop"')).toBeUndefined()
    expect(parseControl("보고 간격을 줄여도 될까?")).toBeUndefined()
    expect(parseControl("report interval 0m")?.type).toBe("invalid")
  })
  test("stop remains persisted after reopen and only resume restarts", async () => {
    const { store, engine } = await fixture()
    applyControl(store, { type: "stop" })
    await advance(engine)
    const other = new Store(store.directory, path.dirname(store.home))
    expect(other.read().desiredState).toBe("stopped")
    expect(other.read().reporting.nextAt).toBeUndefined()
    other.close()
    applyControl(store, { type: "resume" }, 1000)
    expect(store.read().desiredState).toBe("running")
    expect(store.read().reporting.nextAt).toBe(3601000)
    const generation = store.read().generation
    applyControl(store, { type: "resume" })
    expect(store.read().generation).toBe(generation)
  })
})
describe("council and execution", () => {
  test("unavailable verification executable waits and resumes checks without agent replay", async () => {
    const { engine, store, host, settings, directory } = await fixture()
    settings.verification = [
      { name: "independent check", command: [path.join(directory, "missing-executable")], timeoutMs: 5000 },
    ]
    store.update((state) => ({ ...state, phase: "verifying" }))
    await engine.tick()
    expect(store.read().desiredState).toBe("running")
    expect(store.read().phase).toBe("dependency_wait")
    expect(store.read().resumePhase).toBe("verifying")
    expect(store.read().error).toContain("Verification command unavailable")
    expect(store.read().progress).toHaveLength(0)
    settings.verification[0]!.command = [process.execPath, "-e", "console.log('recovered check')"]
    const after = store.read().retryAt! + 1
    await engine.tick(after)
    await engine.tick(after + 1)
    expect(store.read().progress[0]?.checks[0]?.passed).toBe(true)
    expect(store.read().cycle).toBe(2)
    expect(host.sent).toHaveLength(0)
  })
  test("three valid votes are required; ordinary dissent differs from concrete security risk", () => {
    expect(decide({ melchior: vote, casper: vote })).toBeUndefined()
    expect(decide({ melchior: vote, casper: vote, balthasar: { ...vote, position: "reject" } })).toBe("approved")
    expect(
      decide({
        melchior: vote,
        casper: vote,
        balthasar: {
          ...vote,
          risk: { kind: "data_loss", evidence: "unbacked database deletion", mitigation: "backup" },
        },
      }),
    ).toBe("revise")
    expect(() => decode(voteSchema, '{"position":"approve"}')).toThrow()
  })
  test("real state machine opens three sessions, votes, delegates to native primary, verifies and continues", async () => {
    const { engine, store, host, settings, directory } = await fixture()
    settings.verification = [
      { name: "real command", command: [process.execPath, "-e", "console.log('verified')"], timeoutMs: 5000 },
    ]
    await advance(engine, 16)
    expect(store.read().desiredState).toBe("running")
    expect(store.read().cycle).toBeGreaterThan(1)
    expect(host.sent.filter((job) => job.kind === "opening").length).toBeGreaterThanOrEqual(3)
    expect(host.sent.find((job) => job.kind === "execution")?.agent).toBe("Sisyphus (Ultraworker)")
    expect(store.read().progress[0]?.checks[0]?.passed).toBe(true)
    expect(store.meetings().length).toBeGreaterThan(0)
    await writeViews(store)
    const history = await Bun.file(path.join(directory, ".magi", "VOTES.md")).text()
    await writeViews(store)
    expect(await Bun.file(path.join(directory, ".magi", "VOTES.md")).text()).toBe(history)
    expect(history).toContain("🟢 찬성")
  })
  test("missing member cannot be counted as approval", async () => {
    const { engine, store, host } = await fixture()
    host.hold.add("casper")
    await advance(engine)
    expect(store.read().decision).toBeUndefined()
    expect(host.sent.some((job) => job.kind === "execution")).toBe(false)
  })
  test("accepted message survives ambiguous network timeout without duplicate dispatch", async () => {
    const { engine, store, host } = await fixture()
    host.failSend = true
    await engine.tick()
    expect(store.read().phase).toBe("retry_wait")
    expect(store.read().desiredState).toBe("running")
    await engine.tick(Date.now() + 1000)
    await engine.tick(Date.now() + 2000)
    expect(host.sent.length).toBe(1)
    expect(store.jobs()[0]?.status).toBe("running")
  })
  test("stop during async session creation fences late dispatch", async () => {
    const { engine, store, host } = await fixture()
    const create = host.create.bind(host)
    host.create = async (title) => {
      const id = await create(title)
      applyControl(store, { type: "stop" })
      return id
    }
    await engine.tick()
    expect(host.sent.length).toBe(0)
    expect(store.read().desiredState).toBe("stopped")
  })
  test("only one controller can send and another can recover after release", async () => {
    const { engine, store, host, settings } = await fixture()
    const other = new Engine(store, host, async () => settings)
    await engine.tick()
    await other.tick()
    expect(host.sent.length).toBe(1)
    await engine.dispose()
    await other.tick()
    expect(store.read().phase).toBe("opening")
    await other.dispose()
  })
  test("partial final votes survive another member's invalid response and retry", async () => {
    const { engine, store, host, settings } = await fixture()
    settings.council.members.casper = "approved/primary"
    settings.council.fallbackModels = ["approved/backup"]
    await advance(engine, 5)
    const failed = host.sent.find((job) => job.kind === "vote" && job.member === "casper")!
    host.sessions.get(failed.session!)!.snapshot = {
      busy: false,
      answered: true,
      text: JSON.stringify({ ...vote, risk: null }),
      evidence: "",
      activity: "invalid",
    }
    await engine.tick(Date.now() + 20000)
    expect(store.read().phase).toBe("retry_wait")
    expect(Object.keys(store.read().votes).sort()).toEqual(["balthasar", "melchior"])
    expect(store.read().decision).toBeUndefined()
    await engine.tick(Date.now() + 30000)
    await engine.tick(Date.now() + 31000)
    expect(host.sent.filter((job) => job.kind === "vote" && job.member === "melchior").length).toBe(1)
    expect(host.sent.filter((job) => job.kind === "vote" && job.member === "casper").length).toBe(2)
    expect(host.sent.findLast((job) => job.kind === "vote" && job.member === "casper")?.model).toBe("approved/backup")
    const retry = host.sent.findLast((job) => job.kind === "vote" && job.member === "casper")!
    expect(retry.prompt).toContain("The previous attempt was rejected")
    expect(retry.prompt).toContain("received null")
    expect(retry.prompt).toContain("risk")
    expect(store.read().desiredState).toBe("running")
    await engine.tick(Date.now() + 32000)
    expect(store.read().phase).toBe("executing")
    expect(store.read().error).toBeUndefined()
  })
  test("aborted execution becomes evidence for council, never a stop or blind replay", async () => {
    const { engine, host, store } = await fixture()
    await advance(engine, 7)
    const job = host.sent.find((job) => job.kind === "execution")
    expect(job).toBeDefined()
    host.sessions.get(job!.session!)!.snapshot = {
      busy: false,
      answered: false,
      text: "Partial edit",
      evidence: "file changed",
      activity: "aborted",
      error: "MessageAbortedError",
    }
    await advance(engine, 3)
    expect(store.read().desiredState).toBe("running")
    expect(store.read().progress[0]?.summary).toContain("Partial edit")
    expect(host.sent.filter((item) => item.id === job!.id).length).toBe(1)
  })
  test("unbounded retries respect Retry-After without changing desired intent", async () => {
    const { settings } = await fixture()
    expect(backoff(settings, 100000, "retry-after: 120", 0, 0)).toBe(120000)
    expect(backoff(settings, 100000, "offline", 0, 1)).toBe(100)
  })
})
test("first rendering preserves existing legacy documents before replacing projections", async () => {
  const { store, directory } = await fixture()
  await Bun.write(path.join(directory, ".magi", "COUNCIL.md"), "Original legacy council history")
  await writeViews(store)
  const backup = path.join(directory, ".magi", "backups", "documents-" + store.read().generation, "COUNCIL.md")
  expect(await Bun.file(backup).text()).toBe("Original legacy council history")
  await writeViews(store)
  expect(await Bun.file(backup).text()).toBe("Original legacy council history")
})

test("previous votes are never relabelled as a new meeting while planning", async () => {
  const { store, directory } = await fixture()
  const first = {
    ...store.read(),
    cycle: 1,
    round: 1,
    topic: "First task",
    votes: { melchior: vote, balthasar: vote, casper: vote },
  }
  store.meeting("first", Date.now(), first)
  store.update((state) => ({ ...state, ...first, cycle: 2, phase: "planning" }))
  await writeViews(store)
  const latest = await Bun.file(path.join(directory, ".magi", "VOTES-LATEST.md")).text()
  expect(latest).toContain("회의 #1")
  expect(latest).not.toContain("회의 #2")
  expect(latest).toContain("직전 확정 회의")
})

describe("independent reporting", () => {
  test("reports keep their schedule during outages, consolidate delivery, and do not invoke models", async () => {
    const { store, host, directory } = await fixture()
    const reporter = new Reporter(store, host)
    host.failReport = true
    store.update((state) => ({
      ...state,
      phase: "dependency_wait",
      reporting: { ...state.reporting, intervalMs: 60000, nextAt: 100 },
    }))
    await reporter.tick(100)
    await reporter.tick(60100)
    expect(store.reports().length).toBe(2)
    expect(store.read().reporting.nextAt).toBe(120100)
    expect(host.sent.length).toBe(0)
    host.failReport = false
    await reporter.tick(90100)
    expect(host.reports.length).toBe(1)
    expect(host.reports[0]?.text).toContain("2건")
    expect(store.reports().every((report) => report.delivered)).toBe(true)
    expect(await Bun.file(path.join(directory, ".magi", "LATEST-REPORT.md")).exists()).toBe(true)
    applyControl(store, { type: "stop" })
    await reporter.tick(10000000)
    expect(store.reports().length).toBe(2)
    applyControl(store, { type: "report-now" })
    await reporter.tick(10000001)
    expect(store.reports().length).toBe(3)
    expect(store.read().reporting.nextAt).toBeUndefined()
  })
  test("manual reporting does not delay the periodic deadline", async () => {
    const { store, host } = await fixture()
    store.update((state) => ({ ...state, reporting: { ...state.reporting, nextAt: 1000, manual: true } }))
    await new Reporter(store, host).tick(500)
    expect(store.read().reporting.nextAt).toBe(1000)
  })
})

describe("release regression audit", () => {
  test("resume clears a stale retry phase before a new planning failure", async () => {
    const { store, host, engine } = await fixture()
    store.update((state) => ({ ...state, phase: "dependency_wait", resumePhase: "executing" }))
    applyControl(store, { type: "stop" })
    applyControl(store, { type: "resume" })
    host.failSend = true
    await engine.tick()
    expect(store.read().resumePhase).toBe("planning")
    await advance(engine, 4)
    expect(store.read().phase).not.toBe("executing")
    expect(store.read().desiredState).toBe("running")
  })
  test("a failed configuration read does not consume the human's start receipt", async () => {
    const { store, directory } = await fixture()
    applyControl(store, { type: "stop" })
    const file = path.join(directory, ".magi", "openmagi.jsonc")
    await Bun.write(file, "broken json")
    await expect(receiveHuman(store, "owner", "start New goal", "receipt", "local/test", true)).rejects.toThrow()
    await Bun.write(file, "{}")
    await receiveHuman(store, "owner", "start New goal", "receipt", "local/test", true)
    expect(store.read().goal).toBe("New goal")
    expect(store.read().desiredState).toBe("running")
    const generation = store.read().generation
    await receiveHuman(store, "owner", "start New goal", "receipt", "local/test", true)
    expect(store.read().generation).toBe(generation)
  })
  test("concurrent first messages cannot replace another conversation's goal", async () => {
    const { store } = await fixture()
    applyControl(store, { type: "stop" })
    const receipts = await Promise.all([
      receiveHuman(store, "first", "start First goal", "one", "local/test", true),
      receiveHuman(store, "second", "start Second goal", "two", "local/test", true),
    ])
    expect(receipts.filter((receipt) => receipt.includes("다른 대화")).length).toBe(1)
    expect(["first", "second"]).toContain(store.read().owner!)
    expect(store.read().goal).toBe(store.read().owner === "first" ? "First goal" : "Second goal")
  })
  test("empty start and quoted or negated schedule text are not commands", async () => {
    const { store } = await fixture()
    applyControl(store, { type: "stop" })
    const generation = store.read().generation
    await receiveHuman(store, "owner", "start", "empty", undefined, true)
    expect(store.read().generation).toBe(generation)
    expect(parseControl('문서 예: "한 시간마다 보고해"')).toBeUndefined()
    expect(parseControl("보고 간격을 한 시간으로 설정하지 마")).toBeUndefined()
  })
  test("retried council sessions retain their ownership after reopening the database", async () => {
    const { store, engine, host } = await fixture()
    await engine.tick()
    const job = store.jobs()[0]!
    store.saveJob({ ...job, status: "failed" })
    await engine.tick()
    expect(host.sent.length).toBe(2)
    const reopened = new Store(store.directory, path.dirname(store.home))
    expect(reopened.sessionJob(job.session!)?.generation).toBe(job.generation)
    expect(reopened.sessionJob(host.sent[1]!.session!)?.attempt).toBe(2)
    reopened.close()
  })
  test("old undelivered reports are archived without replay into a resumed goal", async () => {
    const { store, host } = await fixture()
    const reporter = new Reporter(store, host)
    host.failReport = true
    applyControl(store, { type: "report-now" })
    await reporter.tick(100)
    const old = store.reports()[0]!
    applyControl(store, { type: "stop" })
    applyControl(store, { type: "resume" }, 200)
    host.failReport = false
    await reporter.tick(40000)
    expect(host.reports.length).toBe(0)
    expect(store.reports()[0]?.superseded).toBe(true)
    expect(store.reports()[0]?.delivered).toBe(false)
    applyControl(store, { type: "report-now" })
    await reporter.tick(50000)
    expect(host.reports.length).toBe(1)
    expect(host.reports[0]?.generation).not.toBe(old.generation)
  })
  test("report file failure does not block delivery and projection recovers without resending", async () => {
    const { store, directory, host } = await fixture()
    const reporter = new Reporter(store, host)
    const blocked = path.join(directory, ".magi", "reports")
    await Bun.write(blocked, "A file blocks creation of the report directory")
    applyControl(store, { type: "report-now" })
    await reporter.tick(100)
    expect(host.reports.length).toBe(1)
    expect(store.read().reporting.fileError).toBeDefined()
    expect(store.reports()[0]?.projected).not.toBe(true)
    await unlink(blocked)
    await reporter.tick(200)
    expect(host.reports.length).toBe(1)
    expect(store.reports()[0]?.projected).toBe(true)
    expect(store.read().reporting.fileError).toBeUndefined()
    expect(await Bun.file(path.join(directory, ".magi", "LATEST-REPORT.md")).exists()).toBe(true)
  })
  test("a first report preserves legacy documents even before the view writer runs", async () => {
    const { store, directory, host } = await fixture()
    await Bun.write(path.join(directory, ".magi", "LATEST-REPORT.md"), "Original report")
    applyControl(store, { type: "report-now" })
    await Promise.all([new Reporter(store, host).tick(100), writeViews(store)])
    expect(
      await Bun.file(
        path.join(directory, ".magi", "backups", "documents-" + store.read().generation, "LATEST-REPORT.md"),
      ).text(),
    ).toBe("Original report")
  })
  test("a late report error cannot contaminate the replacement goal", async () => {
    const { store, host } = await fixture()
    host.report = async () => {
      applyControl(store, { type: "stop" })
      applyControl(store, { type: "resume" })
      throw new Error("old delivery failed")
    }
    applyControl(store, { type: "report-now" })
    await new Reporter(store, host).tick(100)
    expect(store.read().reporting.deliveryError).toBeUndefined()
  })
  test("configuration rejects misspelled roles, malformed models and overflowing timers", () => {
    for (const value of [
      { council: { members: { caspar: "local/test" } } },
      { council: { model: "missing-provider" } },
      { executors: { syssiphus: "local/test" } },
      { resilience: { requestTimeoutMs: 2147483648 } },
      { reporting: { interval: 30 } },
    ])
      expect(configSchema.safeParse(value).success).toBe(false)
    expect(configSchema.safeParse({ council: { model: "openrouter/vendor/model" } }).success).toBe(true)
  })
})

test("planning uses Melchior's configured model and resets the timeout after delivery recovery", async () => {
  const { store, engine, host, settings } = await fixture()
  settings.council.members.melchior = "approved/melchior"
  host.failSend = true
  const start = Date.now()
  await engine.tick(start)
  expect(host.sent[0]?.model).toBe("approved/melchior")
  await engine.tick(start + 200000)
  await engine.tick(start + 201000)
  expect(store.jobs()[0]?.startedAt).toBe(start + 201000)
  expect(host.sent.length).toBe(1)
})

test("long-running history keeps every archived meeting while bounding the main view", async () => {
  const { store, directory } = await fixture()
  const day = Date.parse("2026-09-20T00:00:00Z")
  store.db
    .transaction(() => {
      for (let index = 1; index <= 220; index++)
        store.meeting("history-" + index, day + index * 1000, { ...store.read(), cycle: index, topic: "Task " + index })
    })
    .immediate()
  await writeViews(store)
  const file = await Bun.file(path.join(directory, ".magi", "VOTES.md")).text()
  expect(file).not.toContain("회의 #1 ·")
  expect(file).toContain("회의 #220 ·")
  const archive = await Bun.file(path.join(directory, ".magi", "history", "2026-09-20.md")).text()
  expect(archive).toContain("회의 #1 ·")
  expect(archive).toContain("회의 #220 ·")
  store.meeting("tomorrow", day + 86400000, { ...store.read(), cycle: 221, topic: "Tomorrow" })
  await writeViews(store)
  expect(await Bun.file(path.join(directory, ".magi", "history", "2026-09-20.md")).text()).toBe(archive)
  expect(await Bun.file(path.join(directory, ".magi", "history", "2026-09-21.md")).text()).toContain("회의 #221 ·")
})

test("unavailable executors are excluded from proposals and cannot receive approved work", async () => {
  const { store, engine, host } = await fixture()
  const inspect = host.inspect.bind(host)
  host.inspect = async (job) =>
    job.kind === "proposal"
      ? {
          busy: false,
          answered: true,
          text: JSON.stringify({ ...proposal, executor: "hephaestus" }),
          evidence: "",
          activity: "done",
        }
      : inspect(job)
  await advance(engine, 2)
  expect(host.sent[0]?.prompt).toContain("Available executor IDs for this project: sisyphus.")
  expect(store.read().phase).toBe("retry_wait")
  expect(host.sent.some((job) => job.kind === "execution")).toBe(false)
})

test("an executor disappearing before dispatch returns to council and selects an available primary", async () => {
  const { store, engine, host } = await fixture()
  await advance(engine, 6)
  expect(store.read().phase).toBe("executing")
  host.agents = async () => [{ name: "Atlas (Plan Executor)", mode: "primary" }]
  await engine.tick()
  expect(store.read().phase).toBe("planning")
  expect(host.sent.some((job) => job.kind === "execution")).toBe(false)
  const inspect = host.inspect.bind(host)
  host.inspect = async (job) =>
    job.kind === "proposal"
      ? {
          busy: false,
          answered: true,
          text: JSON.stringify({ ...proposal, executor: "atlas" }),
          evidence: "",
          activity: "done",
        }
      : inspect(job)
  await advance(engine, 8)
  expect(host.sent.find((job) => job.kind === "execution")?.agent).toBe("Atlas (Plan Executor)")
  expect(store.meetings().length).toBe(2)
})
