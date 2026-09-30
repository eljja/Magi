import path from "node:path"
import assert from "node:assert/strict"
import { dataDirectory } from "../src/store"
import { owned, terminate, spawnWithRetry } from "../src/process"
import { type Evidence } from "./evidence"

type Connection = {
  url: string
  username: string
  password: string
  project: string
  pid: number
  supervisorPid: number
  startedAt: number
}

export async function supervisedHost(
  log: Evidence,
  options: { installed: string; project: string; env: NodeJS.ProcessEnv; executable: string; port: number },
) {
  const child = owned(
    await spawnWithRetry(
      () =>
        Bun.spawn(
          [
            process.execPath,
            path.join(options.installed, "dist", "cli.js"),
            "serve",
            "--project",
            options.project,
            "--port",
            String(options.port),
            "--executable",
            options.executable,
          ],
          {
            cwd: options.project,
            env: options.env,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            detached: process.platform !== "win32",
            windowsHide: true,
          },
        ),
      {
        onRetry: (attempt, error) =>
          log.event("command-spawn-retry", { name: "supervisor", attempt, error: String(error) }),
      },
    ),
  )
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const connectionFile = path.join(dataDirectory(options.project, options.env.OPENMAGI_HOME), "connection.json")
  const connection = async () => {
    const value = (await Bun.file(connectionFile).json()) as Connection
    assert.equal(value.supervisorPid, child.pid, "Connection must belong to this supervisor")
    assert.equal(path.resolve(value.project), path.resolve(options.project))
    assert.equal(value.url, "http://127.0.0.1:" + options.port)
    assert.ok(Number.isSafeInteger(value.pid) && value.pid > 0)
    return value
  }
  const api = async (url: string, body?: unknown, timeout = 60000): Promise<unknown> => {
    const credentials = await connection()
    const response = await fetch(credentials.url + url + "?directory=" + encodeURIComponent(options.project), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Basic " + Buffer.from(credentials.username + ":" + credentials.password).toString("base64"),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    })
    if (!response.ok) throw new Error(url + ": " + response.status + " " + (await response.text()).slice(0, 1000))
    return response.status === 204 ? undefined : response.json()
  }
  const until = async (predicate: () => boolean | Promise<boolean>, label: string, timeout = 240000) => {
    const started = Date.now()
    while (!(await predicate())) {
      if (child.exitCode !== null) throw new Error(label + ": supervisor exited with " + child.exitCode)
      if (Date.now() - started >= timeout) throw new Error(label + " timed out")
      await Bun.sleep(500)
    }
    log.event("observation", { label, elapsedMs: Date.now() - started })
  }
  return {
    child,
    api,
    until,
    connection,
    async ready(version: string) {
      await until(
        () =>
          api("/global/health", undefined, 1500).then(
            (value) => {
              assert.equal((value as { version: string }).version, version)
              return true
            },
            () => false,
          ),
        "authenticated host readiness",
      )
      await api("/agent", undefined, 240000)
      const value = await connection()
      log.event("host-ready", { supervisorPid: child.pid, pid: value.pid, version })
      return value.pid
    },
    async crash() {
      const value = await connection()
      assert.equal(child.exitCode, null, "Supervisor must still be running")
      const inspection =
        process.platform === "win32"
          ? [
              "powershell.exe",
              "-NoProfile",
              "-Command",
              `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${value.pid}'; if ($null -eq $p) { exit 2 }; [pscustomobject]@{ parent = $p.ParentProcessId; executable = $p.ExecutablePath } | ConvertTo-Json -Compress`,
            ]
          : ["ps", "-o", "ppid=", "-p", String(value.pid)]
      const check = await spawnWithRetry(
        () => Bun.spawn(inspection, { stdout: "pipe", stderr: "pipe", windowsHide: true }),
        {
          onRetry: (attempt, error) =>
            log.event("command-spawn-retry", { name: "fault-target-inspection", attempt, error: String(error) }),
        },
      )
      const [code, text] = await Promise.all([check.exited, new Response(check.stdout).text()])
      assert.equal(code, 0, "Cannot establish ownership of fault-injection target")
      const processInfo =
        process.platform === "win32"
          ? (JSON.parse(text) as { parent: number; executable: string })
          : { parent: Number(text.trim()) }
      assert.equal(processInfo.parent, child.pid, "Refusing to kill a process outside this supervisor")
      if ("executable" in processInfo)
        assert.equal(path.resolve(processInfo.executable).toLowerCase(), path.resolve(options.executable).toLowerCase())
      assert.equal((await connection()).pid, value.pid)
      const time = Date.now()
      process.kill(value.pid, "SIGKILL")
      log.event("host-fault-injected", { pid: value.pid, supervisorPid: child.pid, signal: "SIGKILL", time })
      return { pid: value.pid, time }
    },
    async stop() {
      await terminate(child)
      await child.exited
      const logs = await output
      await log.write("supervisor-output.json", { stdout: logs[0], stderr: logs[1] })
    },
  }
}
