// Real OpenCode, isolated configuration, deterministic local provider; no account credentials.
import { mkdtemp, mkdir } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { pathToFileURL } from "node:url"
import { readMagiState } from "../src/state"
import compatibility from "../compatibility.json"
import { repairWindowsRuntime } from "../src/windows"
import { existsSync } from "node:fs"

const directory = await mkdtemp(path.join(process.env.MAGI_SMOKE_ROOT ?? os.tmpdir(), "magi-smoke-"))
const project = path.join(directory, "project")
await mkdir(project, { recursive: true })
// Keep OpenCode's local config discovery inside the isolated project, even when the fixture lives inside this repo.
await mkdir(path.join(project, ".opencode"), { recursive: true })
await Bun.write(path.join(project, ".opencode", "opencode.json"), "{}\n")
await Bun.write(path.join(project, "fixture.txt"), "MAGI_OMO_CHILD_EVIDENCE\n")
if (process.env.MAGI_SMOKE_GIT === "true") {
  const git = Bun.spawn(["git", "init", project], { stdout: "ignore", stderr: "pipe" })
  if (await git.exited) throw new Error("Cannot initialize optional smoke repository")
}
const provider = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as {
      model?: string
      messages?: { role: string; content: unknown }[]
      stream?: boolean
      tools?: { function: { name: string } }[]
    }
    if (body.model !== "fixture")
      return Response.json({ error: { message: "Unexpected model selected in compatibility test" } }, { status: 400 })
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
    const backgroundTask = lastUser.includes("BACKGROUND TASK") ? lastUser.match(/bg_[a-f0-9]+/)?.[0] : undefined
    const workforceCall =
      !reviewing && !hasToolResult && backgroundTask
        ? { name: "background_output", arguments: JSON.stringify({ task_id: backgroundTask }) }
        : !reviewing && !hasToolResult && lastUser.includes("magi-smoke-child")
          ? { name: "read", arguments: JSON.stringify({ filePath: path.join(project, "fixture.txt") }) }
          : !reviewing && !hasToolResult && lastUser.includes("magi-smoke-category-probe")
            ? {
                name: "task",
                arguments: JSON.stringify({
                  description: "Verify configured category model",
                  prompt: "magi-smoke-child: read fixture.txt and return MAGI_OMO_CHILD_EVIDENCE",
                  category: "deep",
                  run_in_background: false,
                  load_skills: [],
                }),
              }
            : !reviewing && !hasToolResult && lastUser.includes("[OH-MY-MAGI COUNCIL TASK")
              ? {
                  name: "task",
                  arguments: JSON.stringify({
                    description: "Inspect smoke evidence",
                    prompt: "magi-smoke-child: read fixture.txt and return MAGI_OMO_CHILD_EVIDENCE",
                    subagent_type: "explore",
                    run_in_background: lastUser.includes("CYCLE #1]"),
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
    const call =
      reviewing && body.tools?.some((tool) => tool.function.name === "StructuredOutput")
        ? { name: "StructuredOutput", arguments: text }
        : workforceCall
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
  PATH:
    process.env.MAGI_SMOKE_NO_GIT === "true"
      ? process.env
          .PATH!.split(path.delimiter)
          .filter((folder) => !existsSync(path.join(folder, process.platform === "win32" ? "git.exe" : "git")))
          .join(path.delimiter)
      : process.env.PATH!,
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
    categories: { deep: { model: "fixture/fixture" } },
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
      ].map((name) => [name, { model: name === "hephaestus" ? "fixture/gpt-5.6-sol" : "fixture/fixture" }]),
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
await run(["plugin", process.env.MAGI_PLUGIN_SPECIFIER || packageDirectory, "--global"])
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
        models: {
          fixture: { name: "Fixture", limit: { context: 128000, output: 8192 } },
          "gpt-5.6-sol": { name: "Forbidden default model decoy", limit: { context: 128000, output: 8192 } },
        },
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
const request = async (url: string, body?: unknown, timeout = 120000) => {
  const response = await fetch(base + url + "?directory=" + encodeURIComponent(project), {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  }).catch((error) => {
    throw new Error(url + " request failed after up to " + timeout + "ms: " + String(error))
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
  // Cold Windows runners may still be resolving the existing upstream plugin.
  // Model execution keeps its shorter deadline; only first plugin loading gets this allowance.
  let agents = (await request("/agent", undefined, 300000)) as { name: string }[]
  if (process.env.MAGI_SMOKE_EXISTING_OMO === "true") {
    const migrated = await Bun.file(path.join(env.OPENCODE_CONFIG_DIR, "opencode.json")).json()
    if (migrated.plugin.some((entry: unknown) => typeof entry === "string" && entry.startsWith("oh-my-opencode")))
      throw new Error("Existing global OmO registration was not migrated")
    if (!agents.some((agent) => agent.name === "magi") || agents.some((agent) => agent.name === "magi-reviewer"))
      throw new Error("Migration must keep the Magi setup agent visible without starting another workforce")
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
    agents = (await request("/agent", undefined, 300000)) as { name: string }[]
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
  const probe = (await request("/session", { title: "OmO category model compatibility probe" })) as { id: string }
  await request("/session/" + probe.id + "/message", {
    agent: agents.find((agent) => /^sisyphus(?:\s|$)/i.test(agent.name))!.name,
    model: { providerID: "fixture", modelID: "fixture" },
    parts: [{ type: "text", text: "magi-smoke-category-probe" }],
  })
  const categoryEvidence = await executionEvidence(probe.id)
  await Bun.write(path.join(directory, "category-evidence.json"), JSON.stringify(categoryEvidence, null, 2))
  if (
    !categoryEvidence.some(
      (message) =>
        message.info.agent?.toLowerCase().includes("junior") &&
        message.parts.some((part) => part.tool === "read" && part.state?.status === "completed"),
    )
  )
    throw new Error("Legacy category model override did not execute through the configured provider")
  console.log("Native OmO category model override and Sisyphus-Junior execution verified")
  const session = (await request("/session", { title: "Magi smoke" })) as { id: string }
  await request("/session/" + session.id + "/message", {
    agent: "magi",
    model: { providerID: "fixture", modelID: "fixture" },
    parts: [{ type: "text", text: "Verify the deterministic fixture repeatedly" }],
  })
  const started = await readMagiState(project)
  if (!started.loopActive || started.goal !== "Verify the deterministic fixture repeatedly")
    throw new Error("Selecting Magi and sending a goal did not activate the council")
  console.log("Magi selection + ordinary goal message started autonomy, without a slash command")
  for (let attempt = 0; ; attempt++) {
    const state = await readMagiState(project)
    if (state.currentCycle >= 3) {
      console.log("Real OpenCode continued through cycle " + state.currentCycle)
      break
    }
    if (attempt >= 300) throw new Error("Continuation timed out: " + JSON.stringify(state))
    await Bun.sleep(500)
  }
  const evidence = await executionEvidence(session.id)
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
  if (firstExecutor?.info.agent !== "magi")
    throw new Error("The user's selected Magi agent did not acknowledge the goal")
  if (
    !evidence.some(
      (message) =>
        message.info.agent?.toLowerCase().startsWith("sisyphus") && message.parts.some((part) => part.tool === "task"),
    )
  )
    throw new Error("Approved work did not execute through real OmO")
  const childSessions = (await request("/session/" + session.id + "/children")) as { id: string }[]
  if (!childSessions.length) throw new Error("OmO did not create an actual child session")
  const childEvidence = await Promise.all(childSessions.map((child) => executionEvidence(child.id)))
  await Bun.write(path.join(directory, "child-evidence.json"), JSON.stringify(childEvidence, null, 2))
  if (!JSON.stringify(childEvidence).includes('"tool":"read"')) throw new Error("Child agent did not use read tool")
  if (
    !evidence.some((message) =>
      message.parts.some(
        (part) =>
          part.tool === "background_output" &&
          part.state?.status === "completed" &&
          part.state.output?.includes("MAGI_OMO_CHILD_EVIDENCE"),
      ),
    )
  )
    throw new Error("The first cycle did not collect the real OmO background result before advancing")
  const executions = (await request("/session/" + session.id + "/children")) as {
    id: string
    title: string
    time: { created: number }
  }[]
  const firstCycle = executions.find((child) => child.title === "Magi workforce · cycle 1")
  const secondCycle = executions.find((child) => child.title === "Magi workforce · cycle 2")
  if (!firstCycle || !secondCycle) throw new Error("Missing isolated first/second execution sessions")
  const firstReplies = (await executionEvidence(firstCycle.id)).filter((message) => message.info.role === "assistant")
  if (secondCycle.time.created - Math.max(...firstReplies.map((message) => message.info.time.completed ?? 0)) < 30000)
    throw new Error("A new execution overlapped the first background result settlement window")
  console.log("Native background result collection and completion settlement verified")
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
  const resumeTime = Date.now()
  await request("/session/" + session.id + "/command", { command: "magi", arguments: "resume" })
  const resumed = await readMagiState(project)
  // Resuming a partially recorded meeting continues that cycle instead of
  // incrementing a counter and abandoning its decisions. Require real work.
  if (
    !resumed.loopActive ||
    resumed.goal !== beforeStop.goal ||
    resumed.currentCycle < beforeStop.currentCycle ||
    resumed.runID === beforeStop.runID
  )
    throw new Error("Resume did not preserve the goal and renew its controller generation")
  for (let attempt = 0; ; attempt++) {
    const messages = await executionEvidence(session.id)
    if (
      messages.some(
        (message) =>
          message.info.time.created >= resumeTime &&
          message.info.agent?.toLowerCase().startsWith("sisyphus") &&
          message.parts.some((part) => part.tool === "task" && part.state?.status === "completed"),
      )
    )
      break
    if (attempt >= 240) throw new Error("Resumed council did not dispatch real OmO work")
    await Bun.sleep(500)
  }
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
  const logs = (await Promise.all(stderr)).join("\n")
  await Bun.write(path.join(directory, "stderr.log"), logs)
  console.log("OpenCode log tail:\n" + logs.split("\n").slice(-45).join("\n"))
  provider.stop(true)
  console.log("Smoke logs: " + directory)
}

async function executionEvidence(sessionID: string): Promise<
  {
    info: { role: string; agent?: string; time: { created: number; completed?: number } }
    parts: { type: string; tool?: string; state?: { status: string; output?: string } }[]
  }[]
> {
  const [messages, children] = await Promise.all([
    request("/session/" + sessionID + "/message"),
    request("/session/" + sessionID + "/children") as Promise<{ id: string }[]>,
  ])
  return [...messages, ...(await Promise.all(children.map((child) => executionEvidence(child.id)))).flat()]
}
