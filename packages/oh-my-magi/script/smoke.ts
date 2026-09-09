// Real OpenCode, isolated configuration, deterministic local provider; no account credentials.
import { mkdtemp, mkdir } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { pathToFileURL } from "node:url"
import { readMagiState } from "../src/state"
import compatibility from "../compatibility.json"
import { repairWindowsRuntime } from "../src/windows"

const directory = await mkdtemp(path.join(process.env.MAGI_SMOKE_ROOT ?? os.tmpdir(), "magi-smoke-"))
const project = path.join(directory, "project")
await mkdir(project, { recursive: true })
// Keep OpenCode's local config discovery inside the isolated project, even when the fixture lives inside this repo.
await mkdir(path.join(project, ".opencode"), { recursive: true })
await Bun.write(path.join(project, ".opencode", "opencode.json"), "{}\n")
await Bun.write(path.join(project, "fixture.txt"), "MAGI_OMO_CHILD_EVIDENCE\n")
const git = Bun.spawn(["git", "init", project], { stdout: "ignore", stderr: "pipe" })
if (await git.exited) throw new Error("Cannot isolate smoke repository: " + (await new Response(git.stderr).text()))
const provider = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { messages?: { role: string; content: unknown }[]; stream?: boolean }
    const prompt = JSON.stringify(body.messages)
    const lastUserIndex = body.messages?.findLastIndex((message) => message.role === "user") ?? -1
    const lastUser = JSON.stringify(body.messages?.[lastUserIndex]?.content ?? "")
    const hasToolResult = body.messages?.slice(lastUserIndex + 1).some((message) => message.role === "tool")
    const system = JSON.stringify(body.messages?.filter((message) => message.role === "system"))
    const reviewing = [
      "proposal owner",
      "independent milestone reviewer",
      "You are MELCHIOR",
      "You are BALTHASAR",
      "You are CASPER",
    ].some((role) => system.includes(role))
    const call =
      !reviewing && !hasToolResult && lastUser.includes("magi-smoke-child")
        ? { name: "read", arguments: JSON.stringify({ filePath: path.join(project, "fixture.txt") }) }
        : !reviewing && !hasToolResult && lastUser.includes("[OH-MY-MAGI COUNCIL TASK")
          ? {
              name: "task",
              arguments: JSON.stringify({
                description: "Inspect smoke evidence",
                prompt: "magi-smoke-child: read fixture.txt and return MAGI_OMO_CHILD_EVIDENCE",
                subagent_type: "explore",
                run_in_background: false,
                load_skills: [],
              }),
            }
          : undefined
    const text = prompt.includes("proposal owner")
      ? JSON.stringify({
          title: "Smoke evidence",
          prompt: "Report the fixture evidence",
          rationale: "Advance the original smoke goal",
        })
      : prompt.includes("independent milestone reviewer")
        ? JSON.stringify({ approved: true, critique: "Smoke fixture verification evidence received", confidence: 0.9 })
        : prompt.includes("Round 1 deliberation")
          ? JSON.stringify({ position: "approve", rationale: "Smoke fixture council vote", confidence: 0.9 })
          : "MAGI_OMO_CHILD_EVIDENCE: Smoke fixture execution completed. The verification command validates the deterministic fixture."
    const id = "chatcmpl-" + crypto.randomUUID()
    const toolCalls = call
      ? [{ index: 0, id: "call-" + crypto.randomUUID(), type: "function", function: call }]
      : undefined
    if (!body.stream)
      return Response.json({
        id,
        object: "chat.completion",
        created: 1,
        model: "fixture",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: call ? null : text,
              ...(toolCalls ? { tool_calls: toolCalls } : {}),
            },
            finish_reason: call ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
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
                delta: { role: "assistant", ...(toolCalls ? { tool_calls: toolCalls } : { content: text }) },
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
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        "data: [DONE]",
        "",
      ].join("\n\n"),
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
const env = {
  PATH: process.env.PATH!,
  SystemRoot: process.env.SystemRoot ?? "",
  COMSPEC: process.env.COMSPEC ?? "",
  TEMP: directory,
  TMP: directory,
  OPENCODE_TEST_HOME: path.join(directory, "home"),
  HOME: path.join(directory, "home"),
  USERPROFILE: path.join(directory, "home"),
  OMO_DISABLE_POSTHOG: "1",
  OMO_DISABLE_PROCESS_CLEANUP: "1",
  XDG_CONFIG_HOME: path.join(directory, "config"),
  XDG_DATA_HOME: path.join(directory, "data"),
  XDG_STATE_HOME: path.join(directory, "state"),
  XDG_CACHE_HOME: path.join(directory, "cache"),
  OPENCODE_CONFIG_DIR: path.join(directory, "config", "opencode"),
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
  OPENCODE_DISABLE_AUTOUPDATE: "true",
}
await mkdir(env.OPENCODE_TEST_HOME, { recursive: true })
await Bun.write(
  path.join(project, ".omo", "omo.jsonc"),
  JSON.stringify({
    telemetry: false,
    disabled_mcps: ["websearch", "context7", "grep_app"],
    disabled_hooks: ["auto-update-checker", "codegraph-bootstrap", "ast-grep-sg-provision"],
    agents: Object.fromEntries(
      [
        "sisyphus",
        "hephaestus",
        "prometheus",
        "atlas",
        "sisyphus-junior",
        "oracle",
        "explore",
        "librarian",
        "metis",
        "momus",
        "multimodal-looker",
        "athena",
        "athena-junior",
      ].map((name) => [name, { model: "fixture/fixture" }]),
    ),
  }),
)
const executable = process.env.MAGI_OPENCODE_BIN
  ? [process.env.MAGI_OPENCODE_BIN]
  : [
      process.execPath,
      "x",
      "--package",
      "opencode-ai@" + (process.env.MAGI_OPENCODE_VERSION || compatibility.opencodeTested),
      "opencode",
    ]
const run = async (args: string[]) => {
  const proc = Bun.spawn([...executable, ...args], { cwd: project, env, stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code) throw new Error(args.join(" ") + " failed: " + out + err)
  console.log(out.trim())
}
const packageDirectory = process.env.MAGI_PLUGIN_PACKAGE ?? path.resolve(import.meta.dirname, "..")
await run(["--version"])
await run(["plugin", process.env.MAGI_PLUGIN_SPECIFIER || packageDirectory])
await Bun.write(
  path.join(env.OPENCODE_CONFIG_DIR, "opencode.json"),
  JSON.stringify({
    plugin: [
      ...(process.env.MAGI_SMOKE_EXISTING_OMO === "true" ? ["oh-my-opencode@" + compatibility.omoTested] : []),
      process.env.MAGI_PLUGIN_SPECIFIER || pathToFileURL(path.join(packageDirectory, "dist", "server.js")).href,
    ],
    model: "fixture/fixture",
    small_model: "fixture/fixture",
    provider: {
      fixture: {
        npm: "@ai-sdk/openai-compatible",
        name: "Local smoke fixture",
        options: { baseURL: provider.url.toString() + "v1", apiKey: "fixture-only" },
        models: { fixture: { name: "Fixture", limit: { context: 128000, output: 8192 } } },
      },
    },
  }),
)
await Bun.write(
  path.join(project, ".magi", "config.jsonc"),
  JSON.stringify({
    resilience: { maxRetries: 0, timeoutMs: 20000 },
    verification: {
      commands: [{ name: "fixture", command: [process.execPath, "-e", "console.log('fixture evidence verified')"] }],
    },
  }),
)
const reservation = Bun.serve({ port: 0, fetch: () => new Response() })
const port = reservation.port!
reservation.stop(true)
const boot = () =>
  Bun.spawn([...executable, "serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"], {
    cwd: project,
    env: { ...env, OPENCODE_DISABLE_PROJECT_CONFIG: "true" },
    stdout: "pipe",
    stderr: "pipe",
  })
let proc = boot()
const stdout = [new Response(proc.stdout).text()]
const stderr = [new Response(proc.stderr).text()]
const base = "http://127.0.0.1:" + port
const request = async (url: string, body?: unknown) => {
  const response = await fetch(base + url + "?directory=" + encodeURIComponent(project), {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  })
  if (!response.ok) throw new Error(url + ": " + response.status + " " + (await response.text()))
  return response.json()
}
try {
  for (let attempt = 0; ; attempt++) {
    if (
      await fetch(base + "/global/health")
        .then((response) => response.ok)
        .catch(() => false)
    )
      break
    if (attempt >= 120) throw new Error("OpenCode server startup timed out")
    await Bun.sleep(500)
  }
  let agents = (await request("/agent")) as { name: string }[]
  if (process.env.MAGI_SMOKE_EXISTING_OMO === "true") {
    const migrated = await Bun.file(path.join(env.OPENCODE_CONFIG_DIR, "opencode.json")).json()
    if (migrated.plugin.some((entry: unknown) => typeof entry === "string" && entry.startsWith("oh-my-opencode")))
      throw new Error("Existing global OmO registration was not migrated")
    if (agents.some((agent) => agent.name === "magi"))
      throw new Error("OMM initialized in the old OmO process instead of requesting restart")
    if (process.platform === "win32")
      await Bun.spawn(["taskkill", "/pid", String(proc.pid), "/t", "/f"], { stdout: "ignore", stderr: "ignore" }).exited
    if (process.platform !== "win32") proc.kill()
    await proc.exited
    await repairWindowsRuntime(project, env, true)
    proc = boot()
    stdout.push(new Response(proc.stdout).text())
    stderr.push(new Response(proc.stderr).text())
    for (let attempt = 0; ; attempt++) {
      if (
        await fetch(base + "/global/health")
          .then((response) => response.ok)
          .catch(() => false)
      )
        break
      if (attempt >= 120) throw new Error("Migrated OpenCode restart timed out")
      await Bun.sleep(500)
    }
    agents = (await request("/agent")) as { name: string }[]
    console.log("Existing OmO -> backed-up OMM migration and native restart verified")
  }
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
  ]) {
    if (!agents.some((agent) => agent.name.toLowerCase().startsWith(name)))
      throw new Error("Missing real OmO agent: " + name + " " + JSON.stringify(agents.map((agent) => agent.name)))
  }
  if (!agents.some((agent) => agent.name === "magi") || !agents.some((agent) => agent.name === "magi-reviewer"))
    throw new Error("Magi agents were not registered")
  console.log("Latest OpenCode loaded Magi agents and plugin")
  const session = (await request("/session", { title: "Magi smoke" })) as { id: string }
  await request("/session/" + session.id + "/command", {
    command: "magi",
    arguments: "start Verify the deterministic fixture repeatedly",
  })
  for (let attempt = 0; ; attempt++) {
    const state = await readMagiState(project)
    if (state.currentCycle >= 3) {
      console.log("Real OpenCode continued through cycle " + state.currentCycle)
      break
    }
    if (attempt >= 180) throw new Error("Continuation timed out: " + JSON.stringify(state))
    await Bun.sleep(500)
  }
  const evidence = (await request("/session/" + session.id + "/message")) as {
    info: { role: string; agent?: string }
    parts: { type: string; tool?: string; state?: { status: string; output?: string } }[]
  }[]
  await Bun.write(path.join(directory, "execution-evidence.json"), JSON.stringify(evidence, null, 2))
  const task = evidence
    .flatMap((message) => message.parts)
    .find(
      (part) =>
        part.type === "tool" &&
        part.tool === "task" &&
        part.state?.status === "completed" &&
        part.state.output?.includes("MAGI_OMO_CHILD_EVIDENCE"),
    )
  if (!task) throw new Error("Real OmO task delegation did not return child evidence")
  const firstExecutor = evidence.find((message) => message.info.role === "assistant")
  if (!firstExecutor?.info.agent?.toLowerCase().startsWith("sisyphus"))
    throw new Error("First command did not execute through OmO: " + JSON.stringify(firstExecutor?.info))
  const childSessions = (await request("/session/" + session.id + "/children")) as { id: string }[]
  if (!childSessions.length) throw new Error("OmO did not create an actual child session")
  const childEvidence = await Promise.all(childSessions.map((child) => request("/session/" + child.id + "/message")))
  await Bun.write(path.join(directory, "child-evidence.json"), JSON.stringify(childEvidence, null, 2))
  if (!JSON.stringify(childEvidence).includes('"tool":"read"')) throw new Error("Child agent did not use read tool")
  console.log("Real OmO task -> explore -> read verified, including first execution")
  const guidance = "Preserve the smoke goal and report child evidence"
  await request("/session/" + session.id + "/message", {
    parts: [{ type: "text", text: guidance }],
  })
  const beforeStop = await readMagiState(project)
  if (!beforeStop.steeringQueue?.some((item) => item.text === guidance && item.source?.sessionID === session.id))
    throw new Error("Ordinary conversation was not captured as council guidance")
  if (beforeStop.steeringQueue.some((item) => item.text.includes("[OH-MY-MAGI COUNCIL TASK")))
    throw new Error("Internal council execution was incorrectly captured as user steering")
  const conversationLedger = await Bun.file(path.join(project, ".magi", "COUNCIL.md")).text()
  if (!conversationLedger.includes("Conversation message:") || !conversationLedger.includes(guidance))
    throw new Error("Conversation receipt was not archived")
  await request("/session/" + session.id + "/command", { command: "magi", arguments: "stop" }).catch(() => undefined)
  if ((await readMagiState(project)).loopActive) throw new Error("Stop did not persist")
  console.log("Stop persisted. PASS. Artifacts: " + directory)
  await request("/session/" + session.id + "/command", { command: "magi", arguments: "resume" })
  const resumed = await readMagiState(project)
  if (!resumed.loopActive || resumed.goal !== beforeStop.goal || resumed.currentCycle <= beforeStop.currentCycle)
    throw new Error("Resume did not preserve and advance the goal")
  await request("/session/" + session.id + "/command", { command: "magi", arguments: "stop" }).catch(() => undefined)
  for (const file of ["COUNCIL.md", "STATUS.md", "index.html"]) {
    if (!(await Bun.file(path.join(project, ".magi", file)).exists())) throw new Error("Missing report: " + file)
  }
  console.log("Natural conversational steering, stop/resume, meeting archive and live monitor verified")
  if (process.env.MAGI_SMOKE_KEEP_ALIVE === "true") {
    console.log("Web QA URL: " + base + "; project: " + project)
    await new Promise(() => {})
  }
} finally {
  if (process.platform === "win32")
    await Bun.spawn(["taskkill", "/pid", String(proc.pid), "/t", "/f"], { stdout: "ignore", stderr: "ignore" }).exited
  if (process.platform !== "win32") proc.kill()
  await proc.exited
  await Bun.write(path.join(directory, "stdout.log"), (await Promise.all(stdout)).join("\n"))
  await Bun.write(path.join(directory, "stderr.log"), (await Promise.all(stderr)).join("\n"))
  provider.stop(true)
  console.log("Smoke logs: " + directory)
}
