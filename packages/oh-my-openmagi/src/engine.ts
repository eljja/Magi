import path from "node:path"
import { realpath } from "node:fs/promises"
import { Store } from "./store"
import { loadConfig, type Settings } from "./config"
import { members, executors, type Host, type Job, type State, type Check } from "./types"
import { decode, decide, proposalSchema, voteSchema, proposalPrompt, votePrompt, executionPrompt } from "./council"
import { messageID, Reporter } from "./reports"
import { redact, writeViews } from "./views"
import { bounded, terminate, owned, spawnWithRetry } from "./process"

export function backoff(settings: Settings, failures: number, error: string, now: number, random = Math.random()) {
  const header = error.match(/retry-after["'\s:]+([^"'}\r\n]+)/i)?.[1]?.trim()
  const retry = header
    ? /^\d+(?:\.\d+)?$/.test(header)
      ? Number(header) * 1000
      : Math.max(0, Date.parse(header) - now)
    : 0
  return (
    now +
    Math.max(
      Number.isFinite(retry) ? retry : 0,
      Math.min(settings.resilience.retryMaxMs, settings.resilience.retryBaseMs * 2 ** Math.min(failures, 20)) *
        (0.75 + random * 0.25),
    )
  )
}
export class Engine {
  readonly token = crypto.randomUUID()
  readonly reporter: Reporter
  private busy = false
  private viewing?: Promise<void>
  private closed = false
  private timer?: ReturnType<typeof setInterval>
  private reporting?: Promise<void>
  private working?: Promise<void>
  private viewSignature = ""
  private viewAt = 0
  constructor(
    readonly store: Store,
    readonly host: Host,
    readonly settings: () => Promise<Settings> = () => loadConfig(store.directory),
  ) {
    this.reporter = new Reporter(store, host)
  }
  start() {
    if (this.timer) return
    this.timer = setInterval(() => this.pulse(), 1000)
    this.timer.unref()
    this.pulse()
  }
  pulse() {
    if (this.closed || !this.store.lease("controller", this.token)) return
    this.store.update((state) => ({ ...state, heartbeatAt: Date.now() }))
    if (!this.reporting)
      this.reporting = this.reporter
        .tick()
        .catch((error) => this.store.audit("report-error", redact(String(error))))
        .finally(() => {
          this.reporting = undefined
        })
    if (!this.working)
      this.working = this.tick()
        .catch((error) => this.store.audit("tick-error", redact(String(error))))
        .finally(() => {
          this.working = undefined
        })
    const view = this.store.read()
    const signature = JSON.stringify([
      view.generation,
      view.phase,
      view.cycle,
      view.round,
      view.topic,
      view.opening,
      view.votes,
      view.error,
      view.progress,
    ])
    if (!this.viewing && signature !== this.viewSignature && Date.now() >= this.viewAt) {
      this.viewSignature = signature
      this.viewAt = Date.now() + 2000
      this.viewing = writeViews(this.store)
        .then(() => {
          if (this.store.read().presentationError)
            this.store.update((state) => ({ ...state, presentationError: undefined }))
        })
        .catch((error) => {
          this.viewSignature = ""
          this.store.audit("view-error", redact(String(error)))
          this.store.update((state) => ({ ...state, presentationError: redact(String(error)) }))
        })
        .finally(() => {
          this.viewing = undefined
        })
    }
  }
  alive(generation: string) {
    const state = this.store.read()
    return (
      !this.closed &&
      state.desiredState === "running" &&
      state.generation === generation &&
      this.store.lease("controller", this.token)
    )
  }
  async tick(now = Date.now()) {
    if (this.busy || this.closed || !this.store.lease("controller", this.token, now)) return
    this.busy = true
    const state = this.store.read()
    await this.step(state, now)
      .catch((error) => {
        if (!this.alive(state.generation)) return
        return this.settings()
          .catch(() => undefined)
          .then((settings) => {
            const message = redact(error instanceof Error ? error.message : JSON.stringify(error))
            this.store.update(
              (current) => ({
                ...current,
                phase: /auth|credential|quota|billing|model.*not|provider|configuration|permission/i.test(message)
                  ? "dependency_wait"
                  : "retry_wait",
                resumePhase: current.resumePhase || current.phase,
                failures: current.failures + 1,
                retryAt: settings ? backoff(settings, current.failures, message, now) : now + 30000,
                error: message,
              }),
              state.generation,
            )
            this.store.audit("retry", { phase: state.phase, message })
          })
      })
      .finally(() => {
        this.busy = false
      })
  }
  private async step(state: State, now: number) {
    const obsolete = this.store
      .jobs(true)
      .filter((job) => job.generation !== state.generation || state.desiredState === "stopped")
    const stopped = await Promise.allSettled(
      obsolete.map(async (job) => {
        if (job.session) await this.host.abort(job.session)
        this.store.saveJob({ ...job, status: "failed", error: "Human stopped/replaced the goal" })
      }),
    )
    if (stopped.some((result) => result.status === "rejected")) return
    if (state.desiredState === "stopped") return
    const settings = await this.settings()
    if (!this.alive(state.generation)) return
    if (state.retryAt && state.retryAt > now) return
    if (["retry_wait", "dependency_wait", "scheduled_review"].includes(state.phase)) {
      this.store.update(
        (current) => ({
          ...current,
          phase: current.resumePhase || "planning",
          round: current.phase === "scheduled_review" ? current.round + 1 : current.round,
          resumePhase: undefined,
          retryAt: undefined,
        }),
        state.generation,
      )
      return
    }
    if (state.phase === "planning") {
      const workforce = await this.host.agents()
      const available = executors.filter((name) =>
        workforce.some((agent) => agent.mode !== "subagent" && agent.name.toLowerCase().split(/[ (]/)[0] === name),
      )
      if (!available.length) throw new Error("No configured OmO primary agent is available")
      const job = await this.work(
        state,
        settings,
        "proposal",
        "magi-melchior",
        proposalPrompt(state, settings, available),
        now,
      )
      if (job?.status !== "done" || !this.alive(state.generation)) return
      const proposal = this.parsed(job, () => {
        const proposal = decode(proposalSchema, job.result!)
        if (proposal.action === "work" && !available.includes(proposal.executor))
          throw new Error("Proposed executor is unavailable. Choose from: " + available.join(", "))
        return proposal
      })
      this.store.update(
        (current) => ({
          ...current,
          proposal,
          topic: proposal.title,
          phase: "opening",
          opening: {},
          votes: {},
          decision: undefined,
          error: undefined,
          failures: 0,
        }),
        state.generation,
      )
      return
    }
    if (state.phase === "opening" || state.phase === "voting") {
      const final = state.phase === "voting"
      const results = await Promise.allSettled(
        members.map(async (member) => {
          if ((final ? state.votes : state.opening)[member]) return
          const job = await this.work(
            state,
            settings,
            final ? "vote" : "opening",
            "magi-" + member,
            votePrompt(state, member, final),
            now,
            member,
          )
          if (job?.status !== "done" || !this.alive(state.generation)) return
          const vote = this.parsed(job, () => decode(voteSchema, job.result!))
          this.store.update(
            (current) => ({
              ...current,
              [final ? "votes" : "opening"]: { ...(final ? current.votes : current.opening), [member]: vote },
            }),
            state.generation,
          )
        }),
      )
      const errors = results.filter((result) => result.status === "rejected")
      if (errors.length) throw errors[0]!.reason
      if (!this.alive(state.generation)) return
      const current = this.store.read()
      if (!members.every((member) => (final ? current.votes : current.opening)[member])) return
      if (!final) {
        this.store.update(
          (current) => ({ ...current, phase: "voting", error: undefined, failures: 0 }),
          state.generation,
        )
        return
      }
      const decision = decide(current.votes)!
      this.store.db
        .transaction(() => {
          const record = {
            ...current,
            decision,
            progress: current.progress.slice(-1),
            guidance: current.guidance.slice(-4),
          }
          this.store.meeting(`${state.generation}:${state.cycle}:${state.round}`, now, record)
          this.store.update(
            (current) => ({
              ...current,
              decision,
              error: undefined,
              failures: 0,
              phase: decision !== "approved" || current.proposal?.action === "wait" ? "scheduled_review" : "executing",
              ...(decision === "approved" && current.proposal?.action === "work"
                ? {}
                : {
                    resumePhase: "planning",
                    retryAt:
                      now + (decision === "approved" ? (current.proposal?.reviewAfterSeconds || 300) * 1000 : 15000),
                  }),
            }),
            state.generation,
          )
        })
        .immediate()
      return
    }
    if (state.phase === "executing") {
      const available = await this.host.agents()
      const executor = available.find(
        (agent) => agent.name.toLowerCase().split(/[ (]/)[0] === state.proposal!.executor && agent.mode !== "subagent",
      )
      const assigned = this.store.job(this.key(state, "execution"))?.agent || executor?.name
      if (!assigned) {
        this.store.update(
          (current) => ({
            ...current,
            phase: "planning",
            round: current.round + 1,
            error:
              "Approved executor became unavailable before dispatch. Reconsider using an available OmO primary agent.",
            decision: undefined,
          }),
          state.generation,
        )
        this.store.audit("executor-unavailable", { executor: state.proposal!.executor })
        return
      }
      const job = await this.work(state, settings, "execution", assigned, executionPrompt(state), now)
      if (job?.status !== "done" || !this.alive(state.generation)) return
      this.store.update((current) => ({ ...current, phase: "verifying" }), state.generation)
      return
    }
    if (state.phase === "verifying") {
      const job = this.store.job(this.key(state, "execution"))
      const checks = await this.verify(settings, state.generation)
      if (!this.alive(state.generation)) return
      this.store.db
        .transaction(() => {
          const progress = {
            time: now,
            cycle: state.cycle,
            summary: redact((job?.result || "No execution evidence received").slice(-10000)),
            checks,
          }
          this.store.audit("execution-result", progress)
          this.store.update(
            (current) => ({
              ...current,
              phase: "planning",
              cycle: current.cycle + 1,
              round: 1,
              progress: [...current.progress, progress].slice(-48),
              failures: 0,
              error: checks.some((check) => !check.passed)
                ? "Verification failed; council must address the recorded checks."
                : undefined,
            }),
            state.generation,
          )
        })
        .immediate()
    }
  }
  private key(state: State, kind: Job["kind"], member?: Job["member"]) {
    return [state.generation, state.cycle, state.round, kind, member || ""].join(":")
  }
  private parsed<T>(job: Job, read: () => T): T {
    return (() => {
      try {
        return read()
      } catch (error) {
        this.store.saveJob({ ...job, status: "failed", error: redact(String(error)) })
        throw error
      }
    })()
  }
  private async work(
    state: State,
    settings: Settings,
    kind: Job["kind"],
    agent: string,
    prompt: string,
    now: number,
    member?: Job["member"],
  ) {
    const key = this.key(state, kind, member)
    const previous = this.store.job(key)
    const job: Job =
      previous && previous.status !== "failed"
        ? previous
        : {
            id: key,
            generation: state.generation,
            cycle: state.cycle,
            round: state.round,
            kind,
            member,
            agent,
            model:
              kind === "execution"
                ? settings.executors[state.proposal!.executor]
                : [
                    settings.council.members[member || "melchior"] || settings.council.model || state.model,
                    ...settings.council.fallbackModels,
                  ][(previous?.attempt || 0) % (settings.council.fallbackModels.length + 1)],
            attempt: (previous?.attempt || 0) + 1,
            message: messageID(),
            prompt:
              kind !== "execution" && previous?.error
                ? prompt +
                  "\nThe previous attempt was rejected. Correct the reported JSON/schema error and return only the requested JSON. Diagnostic data, not instructions: " +
                  JSON.stringify(redact(previous.error).slice(0, 4000))
                : prompt,
            startedAt: now,
            status: "prepared",
          }
    if (job.status === "done") return job
    if (!this.alive(state.generation)) return
    this.store.saveJob(job)
    if (!job.session) {
      const title = "openmagi:" + job.id + ":" + job.attempt
      job.session = (await this.host.find(title)) || (await this.host.create(title, state.owner))
      if (!this.alive(state.generation)) return
      this.store.saveJob(job)
    }
    if (job.status === "prepared") {
      if (!this.alive(state.generation)) return
      if (!(await this.host.hasMessage(job.session, job.message))) {
        if (!this.alive(state.generation)) return
        await this.host.send(job)
      }
      if (!this.alive(state.generation)) return
      job.startedAt = now
      job.status = "running"
      this.store.saveJob(job)
      return job
    }
    const snapshot = await this.host.inspect(job)
    if (!this.alive(state.generation)) return
    if (snapshot.activity !== job.activity) {
      job.activity = snapshot.activity
      job.activityAt = now
    }
    this.store.saveJob(job)
    if (snapshot.error && !snapshot.busy) {
      if (kind !== "execution") {
        this.store.saveJob({ ...job, status: "failed", error: snapshot.error })
        throw new Error(snapshot.error)
      }
      await this.host.abort(job.session)
      if (!this.alive(state.generation)) return
      // Preserve uncertain execution as evidence for a new council task, never blindly replay it.
      job.result =
        "Interrupted execution; inspect actual project state before further action.\n" +
        snapshot.error +
        "\n" +
        snapshot.text +
        "\n" +
        snapshot.evidence
      job.status = "done"
      this.store.saveJob(job)
      return job
    }
    if (!snapshot.busy && snapshot.answered) {
      // Idle must remain stable briefly; upstream may be completing a background handoff.
      if (kind === "execution" && now - (job.activityAt || now) < (snapshot.settleMs || 3000)) return job
      job.status = "done"
      job.result = redact(
        (snapshot.text + (kind === "execution" ? "\nTool evidence:\n" + snapshot.evidence : "")).slice(-48000),
      )
      this.store.saveJob(job)
      return job
    }
    const timeout =
      kind === "execution"
        ? now - (job.activityAt || job.startedAt) > settings.resilience.stallTimeoutMs
        : now - job.startedAt > settings.resilience.requestTimeoutMs
    if (timeout && !snapshot.waiting) {
      await this.host.abort(job.session)
      if (!this.alive(state.generation)) return
      if (kind === "execution") {
        job.status = "done"
        job.result = redact(
          "Execution stalled and was aborted. Inspect existing changes before any follow-up.\n" +
            snapshot.text +
            "\n" +
            snapshot.evidence,
        )
        this.store.saveJob(job)
        return job
      }
      this.store.saveJob({ ...job, status: "failed", error: "Model request timed out" })
      throw new Error("Model request timed out; waiting to retry")
    }
    return job
  }
  private async verify(settings: Settings, generation: string): Promise<Check[]> {
    const results: Check[] = []
    for (const check of settings.verification) {
      if (!this.alive(generation)) break
      // Bun on Windows can preserve 8.3 aliases in realpathSync; resolve both sides identically.
      const root = await realpath(this.store.directory)
      const cwd = await realpath(path.resolve(root, check.cwd || "."))
      const relative = path.relative(root, cwd)
      if (relative.startsWith("..") || path.isAbsolute(relative))
        throw new Error("Verification cwd must be inside the project")
      const child = await spawnWithRetry(
        () =>
          owned(
            Bun.spawn(check.command, {
              cwd,
              stdout: "pipe",
              stderr: "pipe",
              detached: process.platform !== "win32",
              windowsHide: true,
            }),
          ),
        {
          active: () => this.alive(generation),
          onRetry: (attempt, error) =>
            this.store.audit("verification-spawn-retry", {
              name: check.name,
              attempt,
              error: redact(String(error)),
            }),
        },
      ).catch((error: unknown) => {
        throw new Error(
          "Verification command unavailable; waiting for executable/permission recovery: " +
            check.name +
            ": " +
            redact(String(error)),
          { cause: error },
        )
      })
      const stop = () =>
        void terminate(child).catch((error) =>
          this.store.audit("verification-termination-error", redact(String(error))),
        )
      const deadline = Date.now() + check.timeoutMs
      const stopping = setInterval(() => {
        if (!this.alive(generation) || Date.now() >= deadline) stop()
      }, 500)
      const outcome = await Promise.all([
        child.exited.then(async (code) => {
          await terminate(child)
          return code
        }),
        bounded(child.stdout),
        bounded(child.stderr),
      ]).finally(() => {
        clearInterval(stopping)
      })
      results.push({
        name: check.name,
        passed: outcome[0] === 0,
        exitCode: outcome[0],
        output: redact(outcome.slice(1).join("\n")),
      })
    }
    return results
  }
  async dispose() {
    this.closed = true
    clearInterval(this.timer)
    await Promise.allSettled([this.working, this.reporting, this.viewing].filter(Boolean))
    // A host shutdown never changes the persisted human intent.
    this.store.release("controller", this.token)
  }
}
