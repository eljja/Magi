// Real OpenCode, isolated configuration, deterministic local provider; no account credentials.
import { mkdtemp, mkdir } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { pathToFileURL } from "node:url"
import { readMagiState } from "../src/state"

const directory = await mkdtemp(path.join(process.env.MAGI_SMOKE_ROOT ?? os.tmpdir(), "magi-smoke-"))
const project = path.join(directory, "project")
await mkdir(project, { recursive: true })
// Keep OpenCode's local config discovery inside the isolated project, even when the fixture lives inside this repo.
await mkdir(path.join(project, ".opencode"), { recursive: true })
await Bun.write(path.join(project, ".opencode", "opencode.json"), "{}\n")
const git = Bun.spawn(["git", "init", project], { stdout: "ignore", stderr: "pipe" })
if (await git.exited) throw new Error("Cannot isolate smoke repository: " + (await new Response(git.stderr).text()))
const provider = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { messages?: { role: string; content: unknown }[]; stream?: boolean }
    const prompt = JSON.stringify(body.messages)
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
          : "Smoke fixture execution completed. The verification command validates the deterministic fixture."
    const id = "chatcmpl-" + crypto.randomUUID()
    if (!body.stream)
      return Response.json({
        id,
        object: "chat.completion",
        created: 1,
        model: "fixture",
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
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
            choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
          }),
        "data: " +
          JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
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
  XDG_CONFIG_HOME: path.join(directory, "config"),
  XDG_DATA_HOME: path.join(directory, "data"),
  XDG_STATE_HOME: path.join(directory, "state"),
  XDG_CACHE_HOME: path.join(directory, "cache"),
  OPENCODE_CONFIG_DIR: path.join(directory, "config", "opencode"),
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
  OPENCODE_DISABLE_AUTOUPDATE: "true",
}
await mkdir(env.OPENCODE_TEST_HOME, { recursive: true })
const executable = process.env.MAGI_OPENCODE_BIN
  ? [process.env.MAGI_OPENCODE_BIN]
  : [process.execPath, "x", "--package", "opencode-ai@1.18.29", "opencode"]
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
const packageDirectory = path.resolve(import.meta.dirname, "..")
await run(["--version"])
await run(["plugin", packageDirectory])
await Bun.write(
  path.join(env.OPENCODE_CONFIG_DIR, "opencode.json"),
  JSON.stringify({
    plugin: [pathToFileURL(path.join(packageDirectory, "dist", "server.js")).href],
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
const proc = Bun.spawn([...executable, "serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"], {
  cwd: project,
  env: { ...env, OPENCODE_DISABLE_PROJECT_CONFIG: "true" },
  stdout: "pipe",
  stderr: "pipe",
})
const stdout = new Response(proc.stdout).text()
const stderr = new Response(proc.stderr).text()
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
  const agents = (await request("/agent")) as { name: string }[]
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
  await request("/session/" + session.id + "/command", { command: "magi", arguments: "stop" }).catch(() => undefined)
  if ((await readMagiState(project)).loopActive) throw new Error("Stop did not persist")
  console.log("Stop persisted. PASS. Artifacts: " + directory)
  if (process.env.MAGI_SMOKE_KEEP_ALIVE === "true") {
    console.log("Web QA URL: " + base + "; project: " + project)
    await new Promise(() => {})
  }
} finally {
  if (process.platform === "win32")
    await Bun.spawn(["taskkill", "/pid", String(proc.pid), "/t", "/f"], { stdout: "ignore", stderr: "ignore" }).exited
  if (process.platform !== "win32") proc.kill()
  await proc.exited
  await Bun.write(path.join(directory, "stdout.log"), await stdout)
  await Bun.write(path.join(directory, "stderr.log"), await stderr)
  provider.stop(true)
  console.log("Smoke logs: " + directory)
}
