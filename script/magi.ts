#!/usr/bin/env bun

import path from "path"
import net from "net"

const repo = path.resolve(import.meta.dirname, "..")
const opencode = path.join(repo, "packages/opencode")
const app = path.join(repo, "packages/app")
const args = process.argv.slice(2)

const usage = () =>
  [
    "Usage:",
    "  magi [project] [opencode options]",
    "  magi web [project] [--server-port 4096] [--app-port 3000]",
    "  magi status [--project <path>] [--server http://127.0.0.1:4096]",
    "  magi review --proposal <text> [--evidence <text>] [--execute] [--project <path>]",
    "  magi self-improve [--recent-work <text>] [--constraints <text>] [--project <path>]",
    "",
    "Examples:",
    "  magi web .",
    "  magi status --project D:\\Code\\MagiTest",
    '  magi review --proposal "Review onboarding clarity" --evidence "Windows PowerShell user"',
    "",
    "Notes:",
    "  magi web starts both the Magi API server and the local web UI.",
    "  status/review/self-improve call a running Magi server and print council state.",
  ].join("\n")

const value = (name: string, fallback: string) => {
  const exact = args.indexOf(name)
  if (exact >= 0) return args[exact + 1] ?? fallback
  const prefix = `${name}=`
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? fallback
}

const flag = (name: string) => args.includes(name)

const command = args[0]
const optionsWithValue = new Set([
  "--project",
  "--directory",
  "--server",
  "--server-port",
  "--port",
  "--app-port",
  "--hostname",
  "--proposal",
  "--evidence",
  "--recent-work",
  "--constraints",
])

const positionals = (start: number) => {
  const result: string[] = []
  for (let index = start; index < args.length; index++) {
    const arg = args[index]
    if (arg.startsWith("--")) {
      if (!arg.includes("=") && optionsWithValue.has(arg)) index++
      continue
    }
    result.push(arg)
  }
  return result
}

if (flag("--help") || flag("-h")) {
  console.log(usage())
  process.exit(0)
}

const opencodeEnv = () => ({
  ...process.env,
  OPENCODE_EXPERIMENTAL_HTTPAPI: process.env.OPENCODE_EXPERIMENTAL_HTTPAPI ?? "1",
})

const runOpencode = async (input: string[]) => {
  const proc = Bun.spawn([process.execPath, "run", "--cwd", opencode, "--conditions=browser", "src/index.ts", ...input], {
    stdio: ["inherit", "inherit", "inherit"],
    env: opencodeEnv(),
  })
  process.exit(await proc.exited)
}

const projectArg = (start: number, allowPositional = false) =>
  path.resolve(
    value("--project", value("--directory", allowPositional ? (positionals(start)[0] ?? process.cwd()) : process.cwd())),
  )

const serverBase = () => value("--server", `http://127.0.0.1:${value("--server-port", value("--port", "4096"))}`)

const availablePort = (start: number, hostname: string): Promise<number> =>
  new Promise((resolve) => {
    const test = (port: number) => {
      const server = net.createServer()
      server.once("error", () => test(port + 1))
      server.once("listening", () => server.close(() => resolve(port)))
      server.listen(port, hostname)
    }
    test(start)
  })

const runQuiet = async (cmd: string[]) => {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
  await proc.exited
  return new TextDecoder().decode(proc.stdout).trim()
}

const killProcess = async (pid: string) => {
  if (pid === String(process.pid) || pid === String(process.ppid)) return
  const command =
    process.platform === "win32"
      ? ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`]
      : ["kill", "-TERM", pid]
  await runQuiet(command)
}

const cleanupExistingWeb = async () => {
  if (flag("--no-clean")) return
  const output =
    process.platform === "win32"
      ? await runQuiet([
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          [
            "$current = $PID",
            "$parent = (Get-CimInstance Win32_Process -Filter \"ProcessId=$current\").ParentProcessId",
            `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $current -and $_.ProcessId -ne $parent -and $_.CommandLine -like ${JSON.stringify(`*${repo}*`)} -and ($_.CommandLine -match 'script[\\\\/]magi\\.ts web|packages[\\\\/]opencode|packages[\\\\/]app.*vite|packages[\\\\/]app dev') } | Select-Object -ExpandProperty ProcessId`,
          ].join("; "),
        ])
      : await runQuiet(["ps", "-eo", "pid=,args="])
          .then((text) =>
            text
              .split("\n")
              .filter((line) => line.includes(repo) && /script\/magi\.ts web|packages\/opencode|packages\/app.*vite|packages\/app dev/.test(line))
              .map((line) => line.trim().split(/\s+/, 1)[0])
              .join("\n"),
          )
  const pids = output.split(/\s+/).filter(Boolean)
  if (pids.length === 0) return
  console.log(`Stopping existing Magi web processes: ${pids.join(", ")}`)
  await Promise.all(pids.map(killProcess))
}

const printStatus = (status: unknown) => {
  const input = status as {
    executorModel?: string
    councilModel?: string
    selfImprovement?: { state?: string; enabled?: boolean }
    activity?: {
      topic?: string
      state?: string
      round?: number
      finalPosition?: string
      votes?: Array<{ member?: string; state?: string; model?: string; rationale?: string; detail?: string }>
    }
  }
  console.log(`executor: ${input.executorModel ?? "unknown"}`)
  console.log(`council:  ${input.councilModel ?? "unknown"}`)
  console.log(
    `self-improvement: ${input.selfImprovement?.state ?? "unknown"} (${input.selfImprovement?.enabled ? "enabled" : "disabled"})`,
  )
  if (!input.activity) return
  console.log("")
  console.log(`topic: ${input.activity.topic ?? "Magi"}`)
  console.log(`state: ${input.activity.state ?? "unknown"} round=${input.activity.round ?? "?"}`)
  if (input.activity.finalPosition) console.log(`final: ${input.activity.finalPosition}`)
  for (const vote of input.activity.votes ?? []) {
    console.log(`- ${vote.member?.toUpperCase() ?? "MEMBER"}: ${vote.state ?? "pending"} (${vote.model ?? "model?"})`)
    const detail = vote.detail ?? vote.rationale
    if (detail) console.log(`  ${detail.split("\n")[0]}`)
  }
}

const request = async (method: "GET" | "POST", route: string, body?: Record<string, unknown>) => {
  const response = await fetch(`${serverBase()}${route}`, {
    method,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-opencode-directory": projectArg(1),
    },
    body: body ? JSON.stringify(body) : undefined,
  }).catch((error) => {
    console.error(`Could not connect to ${serverBase()}. Start Magi with: magi web ${projectArg(1)}`)
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
  if (!response.ok) {
    console.error(`${method} ${route} failed: ${response.status} ${response.statusText}`)
    console.error(await response.text())
    process.exit(1)
  }
  if (response.status === 204) return undefined
  return await response.json()
}

if (command === "web") {
  const project = projectArg(1, true)
  const hostname = value("--hostname", "127.0.0.1")
  const serverPort = value("--server-port", value("--port", "4096"))
  await cleanupExistingWeb()
  const appPort = String(await availablePort(Number(value("--app-port", "3000")), "127.0.0.1"))
  const appURL = `http://127.0.0.1:${appPort}`
  const serverURL = `http://${hostname}:${serverPort}`
  const server = Bun.spawn(
    [
      process.execPath,
      "run",
      "--cwd",
      opencode,
      "--conditions=browser",
      "src/index.ts",
      "serve",
      "--hostname",
      hostname,
      "--port",
      serverPort,
      "--cors",
      appURL,
      "--cors",
      `http://localhost:${appPort}`,
    ],
    { stdio: ["inherit", "inherit", "inherit"], env: opencodeEnv() },
  )
  const web = Bun.spawn(
    [process.execPath, "--cwd", app, "dev", "--host", "127.0.0.1", "--port", appPort, "--strictPort"],
    {
      stdio: ["inherit", "inherit", "inherit"],
      env: process.env,
    },
  )
  const stop = () => {
    server.kill()
    web.kill()
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  console.log("")
  console.log("Magi web is starting.")
  console.log(`  API: ${serverURL}`)
  console.log(`  UI:  ${appURL}`)
  console.log(`  Project: ${project}`)
  console.log("")
  console.log("Open the UI, connect to the API server, then select the project directory.")
  console.log("Press Ctrl+C in this terminal to stop both processes.")
  console.log("")
  await Promise.race([server.exited, web.exited]).finally(stop)
  process.exit(0)
}

if (command === "status") {
  printStatus(await request("GET", "/magi"))
  process.exit(0)
}

if (command === "review") {
  const proposal = value("--proposal", positionals(1).join(" "))
  if (!proposal) {
    console.error("Missing proposal. Use: magi review --proposal <text>")
    process.exit(1)
  }
  const result = (await request("POST", "/magi/review", {
    proposal,
    evidence: value("--evidence", ""),
    kind: "review",
    execute: flag("--execute"),
  })) as { finalPosition?: string; approved?: boolean; executed?: boolean }
  console.log(
    `review: final=${result.finalPosition ?? "unknown"} approved=${result.approved ?? false} executed=${result.executed ?? false}`,
  )
  printStatus(await request("GET", "/magi"))
  process.exit(0)
}

if (command === "self-improve") {
  await request("POST", "/magi/self_improve_async", {
    recentWork: value("--recent-work", "Magi self-improvement was started from the CLI."),
    constraints: value("--constraints", ""),
  })
  console.log("Self-improvement request accepted. Run `magi status` to watch council activity.")
  process.exit(0)
}

await runOpencode(args.length === 0 ? [process.cwd()] : args)
