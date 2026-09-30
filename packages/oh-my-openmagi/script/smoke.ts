// Real OpenCode + unchanged OmO + a deterministic local model provider. No account credentials.
import { mkdtemp, mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import assert from "node:assert/strict"
import { Database } from "bun:sqlite"
import { Store } from "../src/store"
import { terminate, owned, spawnWithRetry } from "../src/process"
import type { Subprocess } from "bun"
import { evidence, releaseIdentity, run } from "./evidence"
import { isolatedEnvironment, nativeHost } from "./native"
import { supervisedHost } from "./supervised-host"
import { auditOmoConfig, verifyWorkforce } from "./workforce"

const log = await evidence("native-smoke")
await (async () => {
  const release = await releaseIdentity(process.env.OPENMAGI_PLUGIN_PACKAGE)
  log.event("release-under-test", { archive: release.archive, sha256: release.sha256, installed: release.installed })

  const root = await mkdtemp(path.join(process.env.OPENMAGI_SMOKE_ROOT || os.tmpdir(), "openmagi-smoke-"))
  console.log("Smoke artifacts: " + root)
  const project = path.join(root, "project")
  await mkdir(path.join(project, ".opencode"), { recursive: true })
  await Bun.write(path.join(project, ".opencode", "opencode.json"), "{}")
  await Bun.write(path.join(project, "fixture.txt"), "OPENMAGI_REAL_CHILD_EVIDENCE\n")
  await Bun.write(path.join(project, "fixture.ts"), "export const evidence = 1\n")
  const requests: { model?: string; tools: string[]; kind: string }[] = []
  const faults = new Set<string>()
  const provider = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as {
        model?: string
        stream?: boolean
        messages?: { role: string; content: unknown }[]
        tools?: { function: { name: string } }[]
      }
      const user = JSON.stringify(body.messages?.filter((message) => message.role === "user").at(-1)?.content)
      const prompt = JSON.stringify(body.messages)
      const kind = user.includes("[OPENMAGI PROPOSAL]")
        ? "proposal"
        : user.includes("[OPENMAGI OPENING")
          ? "opening"
          : user.includes("[OPENMAGI FINAL VOTE")
            ? "vote"
            : user.includes("[OPENMAGI APPROVED TASK")
              ? "execution"
              : user.includes("openmagi-smoke-child")
                ? "child"
                : "conversation"
      requests.push({ model: body.model, tools: body.tools?.map((tool) => tool.function.name) || [], kind })
      if (body.model !== "fixture")
        return Response.json({ error: { message: "Unconfigured model selected" } }, { status: 400 })
      const lastUser = body.messages?.findLastIndex((message) => message.role === "user") ?? -1
      const completed = body.messages?.slice(lastUser + 1).some((message) => message.role === "tool")
      const backgroundID = user.match(/bg_[a-zA-Z0-9]+/)?.[0]
      const call =
        kind !== "execution" &&
        backgroundID &&
        !completed &&
        body.tools?.some((tool) => tool.function.name === "background_output")
          ? { name: "background_output", arguments: JSON.stringify({ task_id: backgroundID }) }
          : kind === "execution" && !completed
            ? {
                name: "task",
                arguments: JSON.stringify({
                  description: "Read smoke evidence",
                  prompt:
                    "openmagi-smoke-child: read fixture.txt, run lsp_diagnostics on fixture.ts without installing a server, and return the fixture content",
                  ...(process.env.OPENMAGI_SMOKE_BACKGROUND === "true"
                    ? { subagent_type: "explore" }
                    : { category: "quick" }),
                  run_in_background: process.env.OPENMAGI_SMOKE_BACKGROUND === "true",
                  load_skills: [],
                }),
              }
            : kind === "child" && !completed
              ? { name: "read", arguments: JSON.stringify({ filePath: path.join(project, "fixture.txt") }) }
              : kind === "child" && !prompt.includes('"name":"lsp_diagnostics"')
                ? { name: "lsp_diagnostics", arguments: JSON.stringify({ filePath: path.join(project, "fixture.ts") }) }
                : undefined
      const malformed = kind === "vote" && user.includes("[OPENMAGI FINAL VOTE casper]") && !faults.has("invalid-vote")
      if (malformed) faults.add("invalid-vote")
      const text = malformed
        ? "Incomplete vote; retry required"
        : kind === "proposal"
          ? JSON.stringify({
              action: "work",
              title: "Inspect local fixture",
              instruction: "Use the real OmO task tool to inspect fixture.txt through the configured specialist.",
              rationale: "Collect verifiable local evidence",
              executor: "sisyphus",
              acceptance: ["A native read tool returned fixture content"],
            })
          : ["opening", "vote"].includes(kind)
            ? JSON.stringify({
                position: "approve",
                summary: "Read-only fixture inspection is appropriate",
                rationale: "A bounded local inspection supports the goal",
                evidence: ["fixture.txt"],
              })
            : prompt.includes("OPENMAGI_REAL_CHILD_EVIDENCE")
              ? "OPENMAGI_REAL_CHILD_EVIDENCE observed. Continue council review."
              : "Magi runtime receipt acknowledged."
      const id = "chatcmpl_" + crypto.randomUUID()
      const calls = call
        ? [{ index: 0, id: "call_" + crypto.randomUUID(), type: "function", function: call }]
        : undefined
      const usage = { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 }
      if (!body.stream)
        return Response.json({
          id,
          object: "chat.completion",
          created: 1,
          model: "fixture",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: call ? null : text, ...(calls ? { tool_calls: calls } : {}) },
              finish_reason: call ? "tool_calls" : "stop",
            },
          ],
          usage,
        })
      return new Response(
        [
          "data: " +
            JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created: 1,
              model: "fixture",
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", ...(calls ? { tool_calls: calls } : { content: text }) },
                  finish_reason: null,
                },
              ],
            }),
          "data: " +
            JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created: 1,
              model: "fixture",
              choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }],
              usage,
            }),
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  const env = isolatedEnvironment(root)
  await run(log, "project-init", ["git", "init", "--initial-branch=dev", project], { env })
  await mkdir(env.OPENCODE_TEST_HOME!, { recursive: true })
  await Bun.write(
    path.join(project, ".omo", "omo.jsonc"),
    JSON.stringify(auditOmoConfig("fixture/fixture", "fixture/gpt-5.6-sol")),
  )
  await Bun.write(
    path.join(project, ".magi", "openmagi.jsonc"),
    JSON.stringify({
      council: { model: "fixture/fixture" },
      executors: { sisyphus: "fixture/fixture" },
      reporting: { intervalMs: 12000 },
      resilience: { requestTimeoutMs: 30000, retryBaseMs: 2000, retryMaxMs: 10000 },
      verification: [
        {
          name: "native fixture verification",
          command: [
            process.execPath,
            "-e",
            "if(!(await Bun.file('fixture.txt').text()).includes('OPENMAGI_REAL_CHILD_EVIDENCE'))process.exit(1)",
          ],
        },
      ],
    }),
  )
  const version = process.env.OPENMAGI_OPENCODE_VERSION || "1.18.31"
  const executable = [await nativeHost(log, root, version, env)]
  const plugin = release.installed
  const installer = await spawnWithRetry(
    () =>
      Bun.spawn([...executable, "plugin", plugin, "--global"], {
        cwd: project,
        env,
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      }),
    {
      onRetry: (attempt, error) =>
        log.event("command-spawn-retry", { name: "native-plugin-install", attempt, error: String(error) }),
    },
  )
  const installation = await Promise.all([
    installer.exited,
    new Response(installer.stdout).text(),
    new Response(installer.stderr).text(),
  ])
  assert.equal(installation[0], 0, installation.slice(1).join("\n"))
  const installed = (await Bun.file(path.join(env.OPENCODE_CONFIG_DIR!, "opencode.json")).json()) as {
    plugin: string[]
  }
  assert.ok(installed.plugin.length, "Native installer must register the server plugin")
  await Bun.write(
    path.join(env.OPENCODE_CONFIG_DIR!, "opencode.json"),
    JSON.stringify({
      ...installed,
      model: "fixture/fixture",
      small_model: "fixture/fixture",
      provider: {
        fixture: {
          npm: "@ai-sdk/openai-compatible",
          name: "Local deterministic fixture",
          options: { baseURL: provider.url.toString() + "v1", apiKey: "fixture-only" },
          models: {
            fixture: { name: "Fixture", limit: { context: 128000, output: 8192 } },
            "gpt-5.6-sol": { name: "Forbidden decoy", limit: { context: 128000, output: 8192 } },
          },
        },
      },
    }),
  )
  const serverCommand = executable
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = reservation.port!
  reservation.stop(true)
  const base = "http://127.0.0.1:" + port
  const logs: Promise<string>[] = []
  const captured = new WeakSet<object>()
  const boot = async (): Promise<Subprocess<"ignore", "pipe", "pipe">> => {
    const child = await spawnWithRetry(
      () =>
        Bun.spawn([...serverCommand, "serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"], {
          cwd: project,
          env,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          detached: process.platform !== "win32",
          windowsHide: true,
        }),
      {
        onRetry: (attempt, error) =>
          log.event("command-spawn-retry", { name: "native-host", attempt, error: String(error) }),
      },
    )
    if (!captured.has(child)) {
      captured.add(child)
      logs.push(new Response(child.stdout).text(), new Response(child.stderr).text())
    }
    return owned(child)
  }
  const configFile = path.join(env.OPENCODE_CONFIG_DIR!, "opencode.json")
  const configured = await Bun.file(configFile).text()
  const upstream = path.dirname(path.dirname(Bun.resolveSync("oh-my-opencode", plugin)))
  await Bun.write(configFile, JSON.stringify({ ...JSON.parse(configured), plugin: [upstream] }))
  let child = await boot()
  const store = new Store(project, env.OPENMAGI_HOME)
  let supervised: Awaited<ReturnType<typeof supervisedHost>> | undefined
  const recoveries: {
    crashAt: number
    oldPid: number
    newPid: number
    readyMs: number
    progressMs?: number
    stopped: boolean
  }[] = []
  async function api(url: string, body?: unknown, timeout = 60000): Promise<unknown> {
    if (supervised) return supervised.api(url, body, timeout)
    const response = await fetch(base + url + "?directory=" + encodeURIComponent(project), {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    })
    if (!response.ok) throw new Error(url + ": " + response.status + " " + (await response.text()))
    return response.status === 204 ? undefined : response.json()
  }
  async function until(predicate: () => boolean | Promise<boolean>, label: string, timeout = 120000) {
    const started = Date.now()
    while (!(await predicate())) {
      if (child.exitCode !== null) throw new Error(label + ": host exited with code " + child.exitCode)
      if (Date.now() - started > timeout) throw new Error(label + " timed out: " + JSON.stringify(store.read()))
      await Bun.sleep(500)
    }
  }
  try {
    await until(
      () =>
        fetch(base + "/global/health", { signal: AbortSignal.timeout(1000) }).then(
          (response) => response.ok,
          () => false,
        ),
      "boot",
    )
    const health = (await api("/global/health")) as { version: string }
    assert.equal(health.version, version, "The running OpenCode binary must match the requested version")
    const baseline = (await api("/agent", undefined, 240000)) as { name: string; mode: string; hidden?: boolean }[]
    await terminate(child)
    await child.exited
    await Bun.write(
      configFile,
      JSON.stringify({
        ...JSON.parse(configured),
        plugin: [upstream, ...installed.plugin],
        agent: { magi: { mode: "primary", prompt: "Test an inherited Magi agent after plugin initialization fails." } },
      }),
    )
    child = await boot()
    await until(
      () =>
        fetch(base + "/global/health", { signal: AbortSignal.timeout(1000) }).then(
          (response) => response.ok,
          () => false,
        ),
      "duplicate configuration boot",
    )
    await api("/agent", undefined, 240000)
    const rejectedSession = (await api("/session", { title: "Rejected duplicate-plugin goal" })) as { id: string }
    const requestsBefore = requests.length
    await assert.rejects(
      () =>
        api("/session/" + rejectedSession.id + "/message", {
          agent: "magi",
          model: { providerID: "fixture", modelID: "fixture" },
          parts: [{ type: "text", text: "Start work despite a failed plugin configuration." }],
        }),
      /\/message: 500 /,
    )
    await until(
      async () =>
        (await Bun.file(path.join(env.XDG_DATA_HOME!, "opencode", "log", "opencode.log")).text()).includes(
          "Magi configuration did not initialize",
        ),
      "The server log must identify the initialization guard behind the sanitized HTTP error",
      10000,
    )
    assert.equal(store.read().desiredState, "stopped")
    assert.equal(requests.length, requestsBefore, "A failed configuration must not dispatch a model request")
    faults.add("configuration-failure-blocked")
    await terminate(child)
    await child.exited
    await Bun.write(configFile, configured)
    supervised = await supervisedHost(log, { installed: plugin, project, env, executable: executable[0]!, port })
    child = supervised.child
    await supervised.ready(version)
    const agents = (await api("/agent", undefined, 240000)) as (Parameters<typeof verifyWorkforce>[0][number] & {
      hidden?: boolean
    })[]
    log.event("workforce-verified", {
      stage: "initial",
      agents: verifyWorkforce(agents, "fixture/fixture", "fixture/gpt-5.6-sol"),
    })
    assert.deepEqual(
      agents.filter((agent) => !agent.name.startsWith("magi")),
      baseline,
      "Existing OmO/OpenCode agent definitions must remain unchanged",
    )
    console.log("Original OmO baseline and wrapped agent definitions match exactly.")
    assert.ok(agents.some((agent) => agent.name === "magi" && agent.mode === "primary"))
    assert.equal(
      agents.filter((agent) => agent.name.startsWith("magi-") && agent.mode === "subagent" && agent.hidden).length,
      3,
    )
    for (const name of [
      "sisyphus",
      "hephaestus",
      "prometheus",
      "atlas",
      "oracle",
      "explore",
      "librarian",
      "metis",
      "momus",
    ])
      assert.ok(
        agents.some((agent) => agent.name.toLowerCase().startsWith(name)),
        name,
      )
    console.log("Native installation, one Magi primary, three hidden council members and upstream agents verified.")
    const session = (await api("/session", { title: "OpenMagi integration test" })) as { id: string }
    await api("/session/" + session.id + "/message", {
      agent: "magi",
      model: { providerID: "fixture", modelID: "fixture" },
      parts: [{ type: "text", text: "Inspect fixture.txt and continually verify local evidence." }],
    })
    await until(() => store.read().cycle >= 2, "real council + OmO execution + verification")
    assert.ok(store.read().progress[0]?.checks[0]?.passed)
    assert.ok(store.read().progress[0]?.summary.includes("OPENMAGI_REAL_CHILD_EVIDENCE"))
    assert.ok(requests.some((item) => item.kind === "execution" && item.tools.includes("task")))
    assert.ok(requests.some((item) => item.kind === "child" && item.tools.includes("read")))
    const nativeTools = new Database(path.join(env.XDG_DATA_HOME!, "opencode", "opencode.db"), { readonly: true })
    const lspCalls = nativeTools
      .query<
        { tool: string; status: string },
        []
      >("SELECT json_extract(data,'$.tool') AS tool, json_extract(data,'$.state.status') AS status FROM part WHERE json_extract(data,'$.type')='tool' AND json_extract(data,'$.tool')='lsp_diagnostics'")
      .all()
    nativeTools.close()
    assert.ok(
      lspCalls.some((call) => call.status === "completed"),
      "The native LSP path must execute before the crash",
    )
    log.event("native-lsp-before-crash", { calls: lspCalls })
    assert.ok(
      requests
        .filter((item) => ["opening", "vote", "proposal"].includes(item.kind))
        .every((item) => item.tools.length === 0),
    )
    assert.ok(store.meetings().every((meeting) => Object.keys(meeting.state.votes).length === 3))
    await until(() => store.reports().some((report) => report.delivered), "independent automatic report")
    console.log("Three actual votes, native OmO task→specialist→read/LSP, verification and timed report verified.")
    await api("/session/" + session.id + "/message", {
      agent: "magi",
      model: { providerID: "fixture", modelID: "fixture" },
      parts: [{ type: "text", text: "보고 간격을 30분으로 줄여" }],
    })
    assert.equal(store.read().reporting.intervalMs, 1800000)
    const before = store.read().cycle
    const crashed = await supervised.crash()
    await supervised.until(
      () => supervised!.connection().then((connection) => connection.pid !== crashed.pid),
      "supervisor replaced the failed native host",
    )
    const newPid = await supervised.ready(version)
    log.event("workforce-verified", {
      stage: "after-crash",
      agents: verifyWorkforce(
        (await api("/agent")) as Parameters<typeof verifyWorkforce>[0],
        "fixture/fixture",
        "fixture/gpt-5.6-sol",
      ),
    })
    const readyMs = Date.now() - crashed.time
    await until(() => store.read().cycle > before, "crash recovery", 180000)
    recoveries.push({
      crashAt: crashed.time,
      oldPid: crashed.pid,
      newPid,
      readyMs,
      progressMs: Date.now() - crashed.time,
      stopped: false,
    })
    assert.equal(store.read().reporting.intervalMs, 1800000)
    assert.ok(
      store
        .read()
        .progress.filter((entry) => entry.checks.some((check) => check.passed))
        .every((entry) => entry.summary.includes('"tool":"task"') && !entry.summary.includes("Task not found:")),
      "Every verified cycle must run its own task, not reuse a historical background ID",
    )
    const stopsBefore = store.db
      .query<{ count: number }, []>("SELECT count(*) as count FROM audit WHERE kind='user-stop'")
      .get()!.count
    await api("/session/" + session.id + "/command", {
      command: "magi",
      arguments: "stop",
      agent: "magi",
      model: "fixture/fixture",
    })
    assert.equal(store.read().desiredState, "stopped")
    assert.equal(
      store.db.query<{ count: number }, []>("SELECT count(*) as count FROM audit WHERE kind='user-stop'").get()!.count,
      stopsBefore + 1,
      "Slash stop must be applied once, not replayed as a new human message",
    )
    assert.ok(faults.has("invalid-vote"))
    assert.ok(
      store.jobs().some((job) => job.kind === "vote" && job.member === "casper" && job.attempt > 1),
      "A malformed vote must be retried before execution",
    )
    const stopped = store.read().cycle
    await Bun.sleep(3500)
    assert.equal(store.read().cycle, stopped)
    const stoppedCrash = await supervised.crash()
    await supervised.until(
      () => supervised!.connection().then((connection) => connection.pid !== stoppedCrash.pid),
      "supervisor replacement while stopped",
    )
    const stoppedPid = await supervised.ready(version)
    log.event("workforce-verified", {
      stage: "stopped-restart",
      agents: verifyWorkforce(
        (await api("/agent")) as Parameters<typeof verifyWorkforce>[0],
        "fixture/fixture",
        "fixture/gpt-5.6-sol",
      ),
    })
    recoveries.push({
      crashAt: stoppedCrash.time,
      oldPid: stoppedCrash.pid,
      newPid: stoppedPid,
      readyMs: Date.now() - stoppedCrash.time,
      stopped: true,
    })
    await Bun.sleep(2000)
    assert.equal(store.read().desiredState, "stopped")
    console.log("Native supervisor automatic recovery and durable /magi stop verified.")
    await Bun.write(
      path.join(root, "result.json"),
      JSON.stringify(
        {
          version: health.version,
          release: { archive: release.archive, sha256: release.sha256, installed: release.installed },
          supervisor: { pid: child.pid, recoveries },
          reporting: { testIntervalMs: 12000, defaultHourlyWallClockTested: false },
          stopCommand: "/magi stop",
          nativeExecutable: serverCommand,
          agents: agents.map((agent) => agent.name),
          upstreamBaselineMatched: true,
          faultRecovery: [...faults],
          cleanConfig: { plugin: JSON.parse(configured).plugin, root },
          meetings: store.meetings().length,
          progress: store.read().progress,
          reports: store.reports().length,
          requests,
        },
        null,
        2,
      ),
    )
    const result = await Bun.file(path.join(root, "result.json")).json()
    await log.write("smoke.json", result)
  } finally {
    if (supervised) await supervised.stop()
    if (!supervised) {
      await terminate(child)
      await child.exited
    }
    provider.stop(true)
    const baselineLogs = (await Promise.all(logs)).join("\n")
    await Bun.write(path.join(root, "opencode.log"), baselineLogs)
    await log.write("baseline-output.json", { output: baselineLogs })
    store.close()
  }
  await log.finish("passed", await Bun.file(path.join(root, "result.json")).json())
})().catch(async (error: unknown) => {
  await log.finish("failed", String(error))
  throw error
})
