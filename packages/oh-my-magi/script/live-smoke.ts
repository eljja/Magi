import path from "node:path"
import os from "node:os"
import { mkdtemp, mkdir, copyFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { readMagiState } from "../src/state"
import { setAutonomousLoop } from "../src/continuation"
import { terminateProcessTree } from "../src/process"
import { repairWindowsRuntime } from "../src/windows"

async function readKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY
  if (!process.stdin.isTTY) throw new Error("Use a TTY or OPENROUTER_API_KEY")
  process.stdin.setRawMode(true)
  process.stdin.resume()
  console.log("OPENROUTER_KEY_INPUT_READY (hidden input)")
  return new Promise<string>((resolve) => {
    let value = ""
    const input = (bytes: Buffer) => {
      for (const char of bytes.toString()) {
        if (char === "\r" || char === "\n") {
          process.stdin.off("data", input)
          process.stdin.setRawMode(false)
          process.stdin.pause()
          resolve(value.trim())
          return
        }
        if (char === "\u0003") process.exit(130)
        if (char === "\u007f") value = value.slice(0, -1)
        else value += char
      }
    }
    process.stdin.on("data", input)
  })
}

const key = await readKey()
const clean = (text: string) => text.replaceAll(key, "[REDACTED]").replace(/sk-or-v1-[a-zA-Z0-9_-]+/g, "[REDACTED]")
const account = async () => {
  const response = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { Authorization: "Bearer " + key },
    signal: AbortSignal.timeout(30000),
  })
  const body = await response.json()
  if (!response.ok) throw new Error("OpenRouter authentication: " + response.status + " " + clean(JSON.stringify(body)))
  return { usage: body.data.usage, free: body.data.free_model_daily_requests, freeTier: body.data.is_free_tier }
}
const before = await account()
console.log("OpenRouter authentication verified: " + JSON.stringify(before))
const catalog = await fetch("https://openrouter.ai/api/v1/models").then((r) => r.json())
const model = process.env.MAGI_LIVE_MODEL
if (!model) throw new Error("Set MAGI_LIVE_MODEL to an explicit currently available OpenRouter :free model")
const entry = catalog.data.find((item: { id: string }) => item.id === model)
if (
  !model.endsWith(":free") ||
  !entry ||
  Number(entry.pricing.prompt) !== 0 ||
  Number(entry.pricing.completion) !== 0 ||
  !entry.supported_parameters.includes("tools")
)
  throw new Error("Selected model is not a verified zero-price tool model")
const directory = await mkdtemp(path.join(os.tmpdir(), "magi-openrouter-live-"))
const project = path.join(directory, "project")
await mkdir(project, { recursive: true })
const write = async (name: string, value: unknown) =>
  Bun.write(
    path.join(directory, name),
    clean(
      typeof value === "string"
        ? value
        : JSON.stringify(
            value,
            (key, value: unknown) => {
              if (["reasoning", "reasoning_details"].includes(key)) return undefined
              return Array.isArray(value) ? value.filter((item) => item?.type !== "reasoning") : value
            },
            2,
          ),
    ),
  )
await write("environment.json", {
  model,
  prices: entry.pricing,
  before,
  git: "removed from child PATH",
  started: new Date().toISOString(),
})
console.log("LIVE_ARTIFACTS " + directory)

const calls: { started: number; model: string; role: string; status?: number; response?: unknown }[] = []
const audits: Promise<unknown>[] = []
// Limits belong to this test only, never the persistent Magi goal.
const requestBudget = Number(process.env.MAGI_LIVE_MAX_REQUESTS ?? 80)
const minutes = Number(process.env.MAGI_LIVE_MINUTES ?? 20)
if (!Number.isSafeInteger(requestBudget) || requestBudget < 12 || !Number.isFinite(minutes) || minutes <= 0)
  throw new Error("Provide a positive test duration and an integer request budget of at least 12")
const maximum = Math.min(requestBudget, Math.max(0, (before.free?.remaining ?? requestBudget) - 1))
if (maximum < 12) throw new Error("Insufficient remaining free requests for a council integration run")
let nextRequest = 0
let quotaBlocked = false
const deniedModels = new Set<string>()
const gateway = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 255,
  async fetch(request) {
    if (!new URL(request.url).pathname.endsWith("/chat/completions"))
      return new Response("Unsupported audit route", { status: 404 })
    const body = await request.json()
    if (body.model !== model) {
      deniedModels.add(String(body.model))
      await write("denied-models.json", [...deniedModels])
      return Response.json(
        {
          error: {
            message: "Live-test model configuration rejected: only the selected free model is allowed",
            code: 400,
          },
        },
        { status: 400 },
      )
    }
    if (calls.length >= maximum || quotaBlocked)
      return Response.json(
        { error: { message: "Live-test free-only allowance exhausted or model denied", code: 429 } },
        { status: 429 },
      )
    const system = JSON.stringify(body.messages.filter((item: { role: string }) => item.role === "system"))
    const role = system.includes("proposal owner")
      ? "proposal"
      : system.includes("independent milestone reviewer")
        ? "judge"
        : ["MELCHIOR", "BALTHASAR", "CASPER"].find((name) => system.includes("You are " + name)) || "agent"
    const call = { started: Date.now(), model, role } as (typeof calls)[number]
    calls.push(call)
    const index = calls.length
    await write("request-" + index + ".json", {
      model: body.model,
      tool_choice: body.tool_choice,
      tools: body.tools?.map((tool: { function?: { name?: string } }) => tool.function?.name),
      messages: body.messages.map(({ reasoning, reasoning_details, ...message }: Record<string, unknown>) => message),
    })
    const scheduled = Math.max(Date.now(), nextRequest)
    nextRequest = scheduled + 6500
    await Bun.sleep(Math.max(0, scheduled - Date.now()))
    if (request.signal.aborted) return new Response("Cancelled", { status: 499 })
    // Forward the actual OpenCode request unchanged, except a zero-price provider guard.
    body.provider = { ...body.provider, max_price: { prompt: 0, completion: 0 } }
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        "X-Title": "Oh-My-Magi live verification",
      },
      body: JSON.stringify(body),
      signal: request.signal,
    })
    call.status = response.status
    console.log("REAL_API " + index + " " + role + " HTTP " + response.status)
    if (!response.body) return response
    // Buffer real SSE verbatim; Bun 1.3.13 on Windows can throw when a teed
    // upstream body is aborted. No model content is synthesized or changed.
    const output = await response.text()
    audits.push(
      Promise.resolve(output)
        .then(async (raw) => {
          const frames =
            raw.startsWith("data:") || raw.includes("\ndata:")
              ? raw
                  .split("\n")
                  .filter((line) => line.startsWith("data:") && !line.includes("[DONE]"))
                  .flatMap((line) => {
                    try {
                      return [JSON.parse(line.slice(5))]
                    } catch {
                      return []
                    }
                  })
              : [JSON.parse(raw)]
          const errors = frames.flatMap((frame) => (frame.error ? [frame.error] : []))
          if (errors.some((error) => /free-models-per-day|daily|free.*allowance/i.test(JSON.stringify(error))))
            quotaBlocked = true
          call.response = {
            id: frames.find((frame) => frame.id)?.id,
            routedModel: frames.find((frame) => frame.model)?.model,
            content: frames
              .flatMap(
                (frame) =>
                  frame.choices?.map(
                    (choice: { delta?: { content?: string }; message?: { content?: string } }) =>
                      choice.delta?.content || choice.message?.content || "",
                  ) || [],
              )
              .join(""),
            toolCalls: frames.flatMap(
              (frame) =>
                frame.choices?.flatMap(
                  (choice: { delta?: { tool_calls?: unknown[] }; message?: { tool_calls?: unknown[] } }) =>
                    choice.delta?.tool_calls || choice.message?.tool_calls || [],
                ) || [],
            ),
            usage: frames.findLast((frame) => frame.usage)?.usage,
            errors,
          }
          await write("provider-calls.json", calls)
        })
        .catch((error) => {
          call.response = { auditError: clean(String(error)) }
        }),
    )
    return new Response(output, {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") || "application/json" },
    })
  },
})

const modelID = "openrouter/" + model
const toolDirectory = path.join(directory, "tools")
await mkdir(toolDirectory, { recursive: true })
await copyFile(process.execPath, path.join(toolDirectory, process.platform === "win32" ? "bun.exe" : "bun"))
const env = {
  PATH:
    toolDirectory +
    path.delimiter +
    process.env
      .PATH!.split(path.delimiter)
      .filter((folder) => !existsSync(path.join(folder, process.platform === "win32" ? "git.exe" : "git")))
      .join(path.delimiter),
  SystemRoot: process.env.SystemRoot || "",
  PATHEXT: process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD",
  COMSPEC: process.env.COMSPEC || "",
  TEMP: directory,
  TMP: directory,
  OPENCODE_TEST_HOME: path.join(directory, "home"),
  HOME: path.join(directory, "home"),
  USERPROFILE: path.join(directory, "home"),
  XDG_CONFIG_HOME: path.join(directory, "config"),
  XDG_DATA_HOME: path.join(directory, "data"),
  XDG_STATE_HOME: path.join(directory, "state"),
  XDG_CACHE_HOME: path.join(directory, "cache"),
  OPENCODE_CONFIG_DIR: path.join(directory, "config", "opencode"),
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
  OPENCODE_DISABLE_AUTOUPDATE: "true",
  OPENCODE_DISABLE_PROJECT_CONFIG: "true",
  OMO_DISABLE_POSTHOG: "1",
  OMO_DISABLE_PROCESS_CLEANUP: "1",
  OPENROUTER_API_KEY: "local-audit-gateway",
}
await mkdir(env.HOME, { recursive: true })
const preflight = Bun.spawn([path.join(toolDirectory, process.platform === "win32" ? "bun.exe" : "bun"), "--version"], {
  env,
  stdout: "pipe",
  stderr: "pipe",
})
const preflightResult = await Promise.all([
  new Response(preflight.stdout).text(),
  new Response(preflight.stderr).text(),
  preflight.exited,
])
await write("tools.json", {
  bun: preflightResult[0].trim(),
  bunExit: preflightResult[2],
  bunOnPath: Bun.which("bun", { PATH: env.PATH }),
  gitOnPath: Bun.which("git", { PATH: env.PATH }),
})
if (preflightResult[2] || !Bun.which("bun", { PATH: env.PATH }) || Bun.which("git", { PATH: env.PATH }))
  throw new Error("Isolated tool preflight failed: Bun must be available and Git absent")
const binary = process.env.MAGI_OPENCODE_BIN || Bun.which("opencode")
if (!binary) throw new Error("Install OpenCode or set MAGI_OPENCODE_BIN to its executable")
const packageDirectory = path.resolve(import.meta.dir, "..")
await Bun.write(path.join(project, ".opencode", "opencode.json"), "{}")
await Bun.write(
  path.join(project, "package.json"),
  JSON.stringify({ name: "magi-real-model-check", type: "module", scripts: { test: "bun test" } }),
)
await Bun.write(
  path.join(project, "sum.ts"),
  "export function sumPositiveIntegers(values: unknown[]): number { return 0 }\n",
)
await Bun.write(
  path.join(project, "sum.test.ts"),
  `import {test,expect} from "bun:test"; import {sumPositiveIntegers} from "./sum";
test("only positive finite integers are summed",()=>expect(sumPositiveIntegers([1,2,-3,0,2.5,"4",null,NaN,Infinity,5])).toBe(8));
test("empty and invalid-only arrays",()=>{expect(sumPositiveIntegers([])).toBe(0);expect(sumPositiveIntegers([-1,0,0.5,"1"])).toBe(0)});
test("input is not mutated",()=>{const input=Object.freeze([1,3,2]);expect(sumPositiveIntegers(input as unknown as unknown[])).toBe(6)});\n`,
)
const baseline = path.join(directory, "verification", "original.test.ts")
await Bun.write(
  baseline,
  (await Bun.file(path.join(project, "sum.test.ts")).text()).replace(
    '"./sum"',
    JSON.stringify(pathToFileURL(path.join(project, "sum.ts")).href),
  ),
)
await Bun.write(
  path.join(project, "REQUIREMENTS.md"),
  "Implement sumPositiveIntegers(values: unknown[]): number in sum.ts. Sum only finite positive integers; ignore other values; do not mutate input. Existing tests are the specification: do not weaken or delete them. After implementation add useful edge-case tests and concise usage documentation. Stay in this folder; Git, package installation and external browsing are unnecessary.\n",
)
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
      ].map((name) => [name, { models: [modelID] }]),
    ),
    categories: Object.fromEntries(
      [
        "quick",
        "unspecified-low",
        "unspecified-high",
        "writing",
        "visual-engineering",
        "ultrabrain",
        "deep",
        "artistry",
      ].map((name) => [name, { models: [modelID] }]),
    ),
  }),
)
await Bun.write(
  path.join(project, ".magi", "config.jsonc"),
  JSON.stringify({
    resilience: { maxRetries: 0, timeoutMs: 180000, stallTimeoutMs: 180000 },
    verification: { commands: [{ name: "real behavior tests", command: [process.execPath, "test", "sum.test.ts"] }] },
  }),
)
await repairWindowsRuntime(project, env, true)
const install = Bun.spawn([binary, "plugin", packageDirectory, "--global"], {
  cwd: project,
  env,
  stdout: "pipe",
  stderr: "pipe",
})
const installed = await Promise.all([
  new Response(install.stdout).text(),
  new Response(install.stderr).text(),
  install.exited,
])
await write("install.log", installed.slice(0, 2).join("\n"))
if (installed[2]) throw new Error("Native plugin installation failed")
await Bun.write(
  path.join(env.OPENCODE_CONFIG_DIR, "opencode.json"),
  JSON.stringify({
    plugin: [pathToFileURL(path.join(packageDirectory, "dist", "server.js")).href],
    model: modelID,
    small_model: modelID,
    enabled_providers: ["openrouter"],
    permission: { "*": "allow", external_directory: "deny" },
    provider: {
      openrouter: {
        whitelist: [model],
        options: { apiKey: "{env:OPENROUTER_API_KEY}", baseURL: gateway.url.toString() + "api/v1" },
        models: {
          [model]: {
            name: model,
            limit: { context: entry.context_length, output: 8192 },
            options: { reasoning: { effort: "low" }, provider: { max_price: { prompt: 0, completion: 0 } } },
          },
        },
      },
    },
  }),
)
const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
const port = reserve.port!
reserve.stop(true)
const server = Bun.spawn([binary, "serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"], {
  cwd: project,
  env,
  stdout: "pipe",
  stderr: "pipe",
})
const stdout = new Response(server.stdout).text()
const stderr = new Response(server.stderr).text()
const request = async (url: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
  const response = await fetch("http://127.0.0.1:" + port + url + "?directory=" + encodeURIComponent(project), {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(300000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(url + " HTTP " + response.status + " " + clean(text))
  return text ? JSON.parse(text) : undefined
}
let sessionID = ""
let verdict = "incomplete"
let workforceVerified = false
try {
  for (let i = 0; ; i++) {
    if (
      await fetch("http://127.0.0.1:" + port + "/global/health")
        .then((r) => r.ok)
        .catch(() => false)
    )
      break
    if (i > 120) throw new Error("OpenCode boot timeout")
    await Bun.sleep(500)
  }
  const agents = await request("/agent")
  await write("agents.json", agents)
  if (
    !agents.some((agent: { name: string }) => agent.name === "magi") ||
    !agents.some((agent: { name: string }) => /^sisyphus/i.test(agent.name))
  )
    throw new Error("Missing actual Magi/OmO agents")
  const providers = await request("/provider")
  const upstreamLog = await Bun.file(path.join(directory, "oh-my-opencode.log"))
    .text()
    .catch(() => "")
  const configurationWarnings = upstreamLog.split("\n").filter((line) => line.includes("Migration validation failed"))
  await write("configuration-warnings.log", configurationWarnings.join("\n"))
  if (configurationWarnings.some((line) => line.includes(JSON.stringify(project).slice(1, -1))))
    throw new Error("OmO rejected its configuration; fix the schema before testing model behavior")
  for (const name of ["Sisyphus - ultraworker", "Sisyphus-Junior", "explore", "librarian"]) {
    const agent = agents.find((agent: { name: string }) => agent.name === name)
    if (agent?.model?.providerID !== "openrouter" || agent.model.modelID !== model)
      throw new Error("OmO did not apply the selected free model to " + name)
  }
  console.log("REAL_OPENCODE_READY " + JSON.stringify({ port, project, connected: providers.connected, model }))
  const probe = (await request("/session", { title: "Isolated shell preflight (not goal evidence)" })).id
  await request("/session/" + probe + "/shell", {
    agent: agents.find((agent: { name: string }) => /^sisyphus/i.test(agent.name)).name,
    command: "bun --version",
  })
  const probeMessages = await collectMessages(probe)
  await write("native-tools.json", probeMessages)
  if (
    !probeMessages.some((message) =>
      message.parts.some(
        (part) =>
          part.type === "tool" &&
          part.state?.status === "completed" &&
          /^\s*\d+\.\d+\.\d+(?:[-+][\w.-]+)?\s*$/.test(part.state.output ?? ""),
      ),
    )
  )
    throw new Error("Native OpenCode shell cannot execute Bun; live model test was not started")
  await request("/session/" + probe, undefined, "DELETE")
  sessionID = (await request("/session", { title: "Real OpenRouter free-model Magi verification" })).id
  await write("connection.json", { port, project, sessionID, model, connected: providers.connected })
  const goal =
    "이 폴더의 REQUIREMENTS.md에 맞게 sumPositiveIntegers 함수를 개발하고 테스트와 문서를 지속적으로 개선해줘. 기존 테스트를 약화하지 말고 sum.ts의 실제 버그를 고쳐줘. 첫 승인 작업은 실제 OmO task 도구로 explore에게 요구사항·테스트를 읽게 한 뒤 구현을 진행해줘. Git 설치나 저장소 초기화는 필요 없어. 이 작은 로컬 과제만 수행하고, 외부 검색·패키지 설치·환경변수 읽기는 하지 마. 사용자 승인을 다시 요구하지 말고 의회의 실제 토론과 투표로 진행해. 각 작업에서 실제 파일 또는 검증 증거를 남기고 같은 목표를 계속 개선해줘."
  await request("/session/" + sessionID + "/prompt_async", {
    agent: "magi",
    model: { providerID: "openrouter", modelID: model },
    parts: [{ type: "text", text: goal }],
  })
  const started = Date.now()
  let last = ""
  let guided = false
  while (Date.now() - started < minutes * 60 * 1000) {
    await Bun.sleep(5000)
    const state = await readMagiState(project)
    const summary = JSON.stringify({
      cycle: state.currentCycle,
      status: state.status,
      active: state.loopActive,
      awaiting: state.awaitingExecution,
      tools: state.telemetry?.toolCallCount,
      round: state.meeting?.round,
      error: state.error,
      calls: calls.length,
    })
    if (summary !== last) {
      console.log("LIVE_STATE " + clean(summary))
      last = summary
    }
    await write("progress.json", state)
    if (deniedModels.size) {
      verdict = "model-configuration-error"
      break
    }
    if (!guided && state.currentCycle >= 2 && !state.awaitingExecution) {
      await request("/session/" + sessionID + "/prompt_async", {
        agent: "magi",
        model: { providerID: "openrouter", modelID: model },
        parts: [
          {
            type: "text",
            text: "기존 목표를 유지하고 다음 단계에서는 입력을 변경하지 않는다는 경계값 검증과 간단한 사용법을 보강해줘.",
          },
        ],
      })
      guided = true
    }
    const ledger = await Bun.file(path.join(project, ".magi", "COUNCIL.md"))
      .text()
      .catch(() => "")
    if (
      state.currentCycle >= 3 &&
      (state.telemetry?.toolCallCount || 0) >= 3 &&
      ledger.includes("COMPLETED & VERIFIED")
    ) {
      verdict = "cycles-and-verified-milestone"
      break
    }
    if (await Bun.file(path.join(directory, "STOP-TEST")).exists()) {
      verdict = "stopped-for-inspection"
      break
    }
    if (quotaBlocked || calls.length >= maximum) {
      verdict = "free-request-allowance-reached"
      break
    }
    if (state.error && /configuration required|authentication|model.*unavailable/i.test(state.error)) {
      verdict = "configuration-error"
      break
    }
  }
  const evidence = await collectMessages(sessionID)
  workforceVerified =
    evidence.some((message) =>
      message.parts.some((part) => part.type === "tool" && part.tool === "task" && part.state?.status === "completed"),
    ) &&
    evidence.some(
      (message) =>
        message.info.agent === "explore" &&
        message.parts.some((part) => part.tool === "read" && part.state?.status === "completed"),
    )
  await write("messages.json", evidence)
  const children = await request("/session/" + sessionID + "/children")
  await write("children.json", children)
  await write(
    "child-messages.json",
    await Promise.all(children.map((child: { id: string }) => request("/session/" + child.id + "/message"))),
  )
} catch (error) {
  verdict = "error"
  console.log("LIVE_ERROR " + clean(String(error)))
  await write("error.txt", String(error))
} finally {
  await setAutonomousLoop(project, false)
  if (sessionID) await request("/session/" + sessionID + "/abort", {}).catch(() => undefined)
  await terminateProcessTree(server)
  await server.exited
  gateway.stop(true)
  await Promise.race([Promise.allSettled(audits), Bun.sleep(3000)])
  await write("provider-calls.json", calls)
  await write("stdout.log", await stdout)
  await write("stderr.log", await stderr)
  const after = await account().catch(() => undefined)
  const tests = Bun.spawn([process.execPath, "test", baseline], { cwd: project, stdout: "pipe", stderr: "pipe" })
  const verified = await Promise.all([
    new Response(tests.stdout).text(),
    new Response(tests.stderr).text(),
    tests.exited,
  ])
  await write("verification.log", verified.slice(0, 2).join("\n"))
  await write("result.json", {
    verdict,
    model,
    requests: calls.length,
    before,
    after,
    workforceVerified,
    deniedModels: [...deniedModels],
    verificationExit: verified[2],
    state: await readMagiState(project),
    finished: new Date().toISOString(),
  })
  console.log(
    "LIVE_FINISHED " +
      JSON.stringify({ verdict, requests: calls.length, verificationExit: verified[2], before, after, directory }),
  )
  if (verdict !== "cycles-and-verified-milestone" || !workforceVerified || verified[2] !== 0) process.exitCode = 1
}

async function collectMessages(id: string): Promise<
  {
    info: { agent?: string }
    parts: { type: string; tool?: string; state?: { status: string; output?: string; metadata?: { exit?: number } } }[]
  }[]
> {
  const messages = await request("/session/" + id + "/message")
  const children = (await request("/session/" + id + "/children")) as { id: string }[]
  return [...messages, ...(await Promise.all(children.map((child) => collectMessages(child.id)))).flat()]
}
