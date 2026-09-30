import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"
import assert from "node:assert/strict"
import { mkdir, mkdtemp } from "node:fs/promises"
import { parseArgs } from "node:util"
import { Store } from "../src/store"
import { applyControl } from "../src/control"
import { evidence, releaseIdentity, run, sha256 } from "./evidence"
import { isolatedEnvironment, nativeHost } from "./native"
import { supervisedHost } from "./supervised-host"
import { enduranceRequestInterval, freeRouter } from "./free-router"
import { auditOmoConfig, verifyWorkforce } from "./workforce"
import { soakPolicy } from "./soak-policy"

const args = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    minutes: { type: "string", default: String(soakPolicy.minutes) },
    model: { type: "string", default: "nvidia/nemotron-3-super-120b-a12b:free" },
    "max-requests": { type: "string", default: "200" },
    "auth-file": { type: "string" },
    "crash-host": { type: "boolean", default: false },
    "late-challenge": { type: "boolean", default: false },
  },
})
const minutes = Number(args.values.minutes)
const maxRequests = Number(args.values["max-requests"])
assert.ok(Number.isFinite(minutes) && minutes > 0 && minutes <= 10080, "--minutes must be >0 and <=10080")
assert.ok(
  Number.isSafeInteger(maxRequests) && maxRequests > 0 && maxRequests <= 10000,
  "--max-requests must be 1..10000",
)
const model = args.values.model!
const log = await evidence("free-llm-soak")
console.log("Free-only LLM evidence: " + log.root)
await (async () => {
  const release = await releaseIdentity()
  log.event("release-under-test", { archive: release.archive, sha256: release.sha256, source: release.source })
  const authPath = args.values["auth-file"] || path.join(os.homedir(), ".local", "share", "opencode", "auth.json")
  const key =
    process.env.OPENROUTER_API_KEY ||
    ((await Bun.file(authPath).json()) as { openrouter?: { type?: string; key?: string } }).openrouter?.key
  assert.ok(key, "An existing OpenRouter API key is required; never paste it into evidence or chat")
  const account = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { authorization: "Bearer " + key },
    signal: AbortSignal.timeout(20000),
    redirect: "error",
  })
  assert.ok(account.ok, "OpenRouter authentication failed: HTTP " + account.status)
  const quota = (await account.json()) as {
    data?: { free_model_daily_requests?: { used: number; limit: number; remaining: number } }
  }
  log.event("free-quota", {
    authenticated: true,
    daily: quota.data?.free_model_daily_requests || "not provided by API",
  })
  const root = await mkdtemp(path.join(log.root, "runtime-"))
  const minIntervalMs = enduranceRequestInterval(minutes * 60000, maxRequests)
  log.event("request-pacing", { minIntervalMs, minutes, maxRequests, allowanceFraction: 0.9 })
  const gateway = await freeRouter({ key, models: [model], maxRequests, minIntervalMs, event: log.event })
  const project = path.join(root, "project")
  const env = isolatedEnvironment(root)
  const resources: { host?: Awaited<ReturnType<typeof supervisedHost>>; store?: Store; interrupted: boolean } = {
    interrupted: false,
  }
  const interrupt = () => {
    resources.interrupted = true
    gateway.stop()
  }
  process.on("SIGINT", interrupt)
  process.on("SIGTERM", interrupt)
  let result: Record<string, unknown> | undefined
  let outcome: "passed" | "incomplete" = "incomplete"
  try {
    await Promise.all(
      [".opencode", ".omo", ".magi"].map((directory) => mkdir(path.join(project, directory), { recursive: true })),
    )
    await mkdir(env.OPENCODE_CONFIG_DIR!, { recursive: true })
    // A home override alone does not stop OpenCode from finding ancestor project plugins.
    // Keep this disposable repository as the config-discovery boundary, even inside a monorepo.
    await run(log, "project-init", ["git", "init", "--initial-branch=dev", project], { env })
    await Bun.write(
      path.join(project, "counter.ts"),
      "export function parseCount(text: string): number { return parseInt(text, 10) }\n",
    )
    await Bun.write(
      path.join(project, "README.md"),
      "# Count parser\nImprove parseCount and document its strict input contract.\n",
    )
    const checker = path.join(root, "independent-check.ts")
    await Bun.write(
      checker,
      `import assert from 'node:assert/strict'
import { parseCount } from './project/counter.ts'
for (const [input, expected] of [['0',0],['  +12  ',12],['9007199254740991',9007199254740991],['001',1]] as const) assert.equal(parseCount(input), expected, input)
for (const input of ['', ' ', '-1', '1.5', '12x', '1e2', '9007199254740992', 'Infinity', '+']) assert.throws(() => parseCount(input), undefined, JSON.stringify(input))
console.log('Independent parser contract verified')
`,
    )
    const checkerHash = await sha256(checker)
    const broken = await Bun.file(path.join(project, "counter.ts")).text()
    await Bun.write(
      path.join(project, "counter.ts"),
      `export function parseCount(text: string): number {
  const input = text.trim()
  if (!/^\\+?[0-9]+$/.test(input) || !Number.isSafeInteger(Number(input))) throw new Error('Invalid count')
  return Number(input)
}\n`,
    )
    await run(log, "checker-positive-control", [process.execPath, checker], { cwd: project, env })
    await Bun.write(path.join(project, "counter.ts"), broken)
    const negative = await run(log, "checker-negative-control", [process.execPath, checker], {
      cwd: project,
      env,
      allowFailure: true,
    })
    assert.notEqual(negative.code, 0, "Independent checker must reject the original broken parser")
    const nativeVersion = process.env.OPENMAGI_OPENCODE_VERSION || "1.18.31"
    const executable = await nativeHost(log, root, nativeVersion, env)
    const scopedModel = "freeaudit/" + model
    await Bun.write(path.join(project, ".opencode", "opencode.json"), "{}")
    await Bun.write(path.join(project, ".omo", "omo.jsonc"), JSON.stringify(auditOmoConfig(scopedModel)))
    await Bun.write(
      path.join(project, ".magi", "openmagi.jsonc"),
      JSON.stringify({
        council: { model: scopedModel, fallbackModels: [] },
        executors: { sisyphus: scopedModel, prometheus: scopedModel, atlas: scopedModel },
        reporting: { intervalMs: 3600000 },
        resilience: { requestTimeoutMs: 240000, stallTimeoutMs: 1800000, retryBaseMs: 60000, retryMaxMs: 1800000 },
        verification: [{ name: "independent parser contract", command: [process.execPath, checker] }],
      }),
    )
    await run(log, "native-plugin-install", [executable, "plugin", release.installed, "--global"], {
      cwd: project,
      env,
    })
    const config = path.join(env.OPENCODE_CONFIG_DIR!, "opencode.json")
    const installed = (await Bun.file(config).json()) as { plugin: string[] }
    assert.ok(installed.plugin.length)
    await Bun.write(
      config,
      JSON.stringify({
        ...installed,
        model: scopedModel,
        small_model: scopedModel,
        enabled_providers: ["freeaudit"],
        provider: {
          freeaudit: {
            npm: "@ai-sdk/openai-compatible",
            name: "OpenRouter free-only audit gateway",
            options: { baseURL: gateway.url, apiKey: gateway.token },
            models: { [model]: { name: model, limit: { context: gateway.models[0]!.context_length, output: 16384 } } },
          },
        },
      }),
    )
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
    const port = reservation.port!
    reservation.stop(true)
    const host = (resources.host = await supervisedHost(log, {
      installed: release.installed,
      project,
      env,
      executable,
      port,
    }))
    await host.ready(nativeVersion)
    const workforce = async () => {
      const registered = (await host.api("/agent")) as Parameters<typeof verifyWorkforce>[0]
      log.event("workforce-verified", {
        pid: (await host.connection()).pid,
        agents: verifyWorkforce(registered, scopedModel),
      })
    }
    await workforce()
    const effective = (await host.api("/config")) as { plugin?: (string | [string, unknown])[] }
    const plugins = (effective.plugin || []).map((entry) => (typeof entry === "string" ? entry : entry[0]))
    const localPlugin = (spec: string) => path.normalize(spec.startsWith("file:") ? fileURLToPath(spec) : spec)
    assert.deepEqual(
      plugins.map(localPlugin),
      installed.plugin.map(localPlugin),
      "Unexpected inherited plugin configuration in the real-provider test",
    )
    log.event("isolated-plugins", { plugins })
    const store = (resources.store = new Store(project, env.OPENMAGI_HOME))
    const heartbeat = store.read().heartbeatAt
    await host.until(
      () => store.read().heartbeatAt > heartbeat,
      "controller timer is running before the first model request",
      10000,
    )
    const session = (await host.api("/session", { title: "OpenMagi free-only qualification" })) as { id: string }
    const started = Date.now()
    const end = started + minutes * 60000
    const receipt = host
      .api(
        "/session/" + session.id + "/prompt_async",
        {
          agent: "magi",
          model: { providerID: "freeaudit", modelID: model },
          parts: [
            {
              type: "text",
              text: "Continually improve this disposable TypeScript count-parser project. parseCount(text) must accept trimmed ASCII decimal nonnegative integers with optional leading +, including zero/leading zeros, and reject empty, fractional, negative, trailing junk, exponent, and values above Number.MAX_SAFE_INTEGER by throwing. First inspect and fix counter.ts, then independently improve tests, documentation and boundary coverage. Use sisyphus for implementation. Verification is configured outside the project; do not modify it. Stay inside this project, do not publish, install paid services, change provider configuration or access credentials. When worthwhile improvements are exhausted, schedule a review in 30 minutes; preserve running intent. Do not stop yourself. A test harness will stop this run explicitly.",
            },
          ],
        },
        10000,
      )
      .catch((error: unknown) => {
        log.event("initial-receipt-error", String(error))
        throw error
      })
    await receipt
    await host.until(() => store.read().desiredState === "running", "goal accepted")
    log.event("soak-start", {
      root,
      project,
      model,
      minutes,
      profile: soakPolicy.id,
      maxRequests,
      hourlyIntervalMs: 3600000,
      supervisorPid: host.child.pid,
      started,
      end,
      checkerHash,
      lateChallenge: args.values["late-challenge"]
        ? "Inject a documented parser regression at least 3 hours after first verified progress, then submit operator guidance through the native conversation"
        : undefined,
    })
    const observations = {
      snapshots: 0,
      progress: new Map<string, number>(),
      hourly: 0,
      autoStopped: false,
      checkerChanged: false,
      workforcePid: (await host.connection()).pid,
      challenge: undefined as { time: number; recovered: boolean } | undefined,
      recovery: undefined as
        | { oldPid: number; newPid: number; readyMs: number; recoveredProgress: boolean; time: number }
        | undefined,
    }
    while (
      Date.now() < end &&
      !resources.interrupted &&
      !gateway.state.violation &&
      gateway.state.requests < maxRequests
    ) {
      assert.equal(host.child.exitCode, null, "Supervisor exited during real-provider test")
      if (await Bun.file(path.join(log.root, "STOP")).exists()) {
        resources.interrupted = true
        log.event("operator-stop", { reason: "STOP marker requested by test operator" })
        break
      }
      const state = store.read()
      if (state.desiredState !== "running") {
        observations.autoStopped = true
        break
      }
      if ((await sha256(checker)) !== checkerHash) {
        observations.checkerChanged = true
        break
      }
      for (const entry of state.progress.filter(
        (entry) => entry.checks.length && entry.checks.every((check) => check.passed),
      ))
        observations.progress.set(String(entry.cycle) + ":" + entry.time, entry.time)
      observations.hourly = store.reports().filter((report) => !report.manual && report.delivered).length
      if (
        observations.recovery &&
        [...observations.progress.values()].some((time) => time > observations.recovery!.time)
      )
        observations.recovery.recoveredProgress = true
      if (
        observations.challenge &&
        [...observations.progress.values()].some((time) => time > observations.challenge!.time)
      )
        observations.challenge.recovered = true
      const connection = await host.connection()
      if (connection.pid !== observations.workforcePid) {
        await workforce()
        observations.workforcePid = connection.pid
      }
      const files = await Promise.all(
        ["runtime.sqlite", "runtime.sqlite-wal", "runtime.sqlite-shm"].map(async (name) => ({
          name,
          bytes: await Bun.file(path.join(store.home, name)).size,
        })),
      )
      log.event("soak-observation", {
        phase: state.phase,
        cycle: state.cycle,
        round: state.round,
        heartbeatAt: state.heartbeatAt,
        lastProgressAt: Math.max(0, ...observations.progress.values()),
        verifiedCycles: observations.progress.size,
        failures: state.failures,
        error: state.error,
        retryAt: state.retryAt,
        reports: observations.hourly,
        pid: connection.pid,
        supervisorPid: host.child.pid,
        requests: gateway.state.requests,
        responses: gateway.state.responses,
        gatewayRetryAt: gateway.state.retryAt,
        database: files,
        harnessRSS: process.memoryUsage().rss,
      })
      observations.snapshots++
      if (
        args.values["late-challenge"] &&
        !observations.challenge &&
        observations.progress.size &&
        Date.now() - Math.min(...observations.progress.values()) >= soakPolicy.progressSpanMs &&
        ["planning", "scheduled_review"].includes(state.phase) &&
        !store.jobs(true).some((job) => job.kind === "execution")
      ) {
        await Bun.write(
          path.join(project, "counter.ts"),
          "// Deliberate endurance-test regression injected by the test operator.\nexport function parseCount(text: string): number { return parseInt(text, 10) }\n",
        )
        const baseline = await run(log, "late-challenge-fails-contract", [process.execPath, checker], {
          cwd: project,
          env,
          allowFailure: true,
        })
        assert.notEqual(baseline.code, 0, "The controlled regression must fail the unchanged independent checker")
        observations.challenge = { time: Date.now(), recovered: false }
        log.event("late-challenge-injected", observations.challenge)
        await host.api("/session/" + session.id + "/prompt_async", {
          agent: "magi",
          model: { providerID: "freeaudit", modelID: model },
          parts: [
            {
              type: "text",
              text: "Endurance test operator update: counter.ts was deliberately reset to a parseInt implementation after three hours of observed operation. The unchanged independent checker now fails. Within the existing goal, arrange a new council decision and have sisyphus inspect and repair this regression, rerun tests and report evidence. Preserve running intent and the existing hourly report schedule. This is a controlled test injection, not an agent-created defect.",
            },
          ],
        })
      }
      if (args.values["crash-host"] && observations.progress.size >= 1 && !observations.recovery) {
        const fault = await host.crash()
        await host.until(
          () => host.connection().then((next) => next.pid !== fault.pid),
          "soak supervisor restarted native host",
        )
        const newPid = await host.ready(nativeVersion)
        await workforce()
        observations.workforcePid = newPid
        observations.recovery = {
          oldPid: fault.pid,
          newPid,
          time: fault.time,
          readyMs: Date.now() - fault.time,
          recoveredProgress: false,
        }
      }
      await Bun.sleep(Math.min(15000, Math.max(1, end - Date.now())))
    }
    const elapsedMs = Date.now() - started
    const beforeStop = store.read()
    const check = await run(log, "independent-final-verification", [process.execPath, checker], {
      cwd: project,
      env,
      allowFailure: true,
    })
    const times = [...observations.progress.values()]
    await workforce()
    const criteria = {
      workforceContinuity: true,
      real6Hours: elapsedMs >= soakPolicy.durationMs,
      progressAcross3Hours: times.length >= 2 && Math.max(...times) - Math.min(...times) >= soakPolicy.progressSpanMs,
      hourlyReports: observations.hourly >= soakPolicy.hourlyReports,
      continuousIntent: !observations.autoStopped && beforeStop.desiredState === "running",
      checkerIntegrity: !observations.checkerChanged && (await sha256(checker)) === checkerHash,
      independentContract: check.code === 0,
      recovery: observations.recovery?.recoveredProgress === true,
      lateChallenge: observations.challenge?.recovered === true,
      reportedUsageZero: gateway.state.usage.length > 0 && gateway.state.usage.every((usage) => usage.cost === 0),
      noFreePolicyViolation: !gateway.state.violation,
      withinRequestLimit: gateway.state.requests < maxRequests,
    }
    outcome = Object.values(criteria).every(Boolean) && !resources.interrupted ? "passed" : "incomplete"
    result = {
      release: { archive: release.archive, sha256: release.sha256 },
      model,
      started,
      elapsedMs,
      requestedMinutes: minutes,
      profile: soakPolicy.id,
      maxRequests,
      verifiedAt: times,
      criteria,
      runtime: root,
      snapshots: observations.snapshots,
      verifiedCycles: observations.progress.size,
      reports: observations.hourly,
      recovery: observations.recovery,
      challenge: observations.challenge,
      requests: gateway.state.requests,
      responses: gateway.state.responses,
      usage: gateway.state.usage,
      interrupted: resources.interrupted,
      requestLimitReached: gateway.state.requests >= maxRequests,
      finalPhase: beforeStop.phase,
      error: beforeStop.error,
      stopReason: "explicit test harness boundary; not an autonomous Magi stop",
    }
    await log.write("soak.json", result)
  } finally {
    if (resources.store) {
      applyControl(resources.store, { type: "stop" })
      log.event("test-stop", { reason: "test duration, request limit, signal or failure" })
    }
    gateway.stop()
    if (resources.host) await resources.host.stop()
    resources.store?.close()
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", interrupt)
  }
  await log.finish(outcome, result)
  console.log(JSON.stringify({ outcome, evidence: log.root, result }, null, 2))
  if (outcome !== "passed") process.exitCode = 2
})().catch(async (error: unknown) => {
  await log.finish("failed", String(error))
  console.error(String(error))
  process.exitCode = 1
})
