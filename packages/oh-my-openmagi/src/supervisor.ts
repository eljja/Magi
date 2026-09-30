import path from "node:path"
import { Store } from "./store"
import { repairWindowsRuntime } from "./windows"
import { cleanupWindowsLsp } from "./windows-lsp"
import { terminate, bounded, owned } from "./process"
import { atomic, redact } from "./views"
import type { Subprocess } from "bun"

export async function supervise(
  directory: string,
  options: {
    port: number
    executable?: string
    command?: string[]
    signal?: AbortSignal
    pollMs?: number
    env?: NodeJS.ProcessEnv
  },
) {
  if (options.signal?.aborted) return
  const environment = options.env || process.env
  const store = new Store(directory, environment.OPENMAGI_HOME)
  const token = crypto.randomUUID()
  if (!store.lease("supervisor", token)) {
    store.close()
    throw new Error("Another supervisor already owns this project.")
  }
  const state: {
    child?: Subprocess
    lsp?: { directory: string; started: number }
    stopping: boolean
    failures: number
  } = { stopping: false, failures: 0 }
  const halt = new AbortController()
  const stop = () => {
    state.stopping = true
    halt.abort()
  }
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      if (halt.signal.aborted) return resolve()
      const finish = () => {
        clearTimeout(timer)
        halt.signal.removeEventListener("abort", finish)
        resolve()
      }
      const timer = setTimeout(finish, ms)
      halt.signal.addEventListener("abort", finish, { once: true })
    })
  const cleanup = async () => {
    const child = state.child
    if (!child) return
    // Do not spawn a replacement until the previous tree is confirmed terminated.
    while (true) {
      const error = await terminate(child)
        .then(async () => {
          if (state.lsp) await cleanupWindowsLsp(state.lsp.directory, environment, state.lsp.started)
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        )
      if (!error) break
      store.audit("termination-retry", redact(String(error)))
      await Bun.sleep(1000)
    }
    await child.exited
    state.child = undefined
    state.lsp = undefined
  }
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  options.signal?.addEventListener("abort", stop, { once: true })
  if (options.signal?.aborted) stop()
  const heartbeat = setInterval(() => {
    try {
      if (!store.lease("supervisor", token)) stop()
    } catch {
      stop()
    }
  }, 5000)
  const base = "http://127.0.0.1:" + options.port
  await (async () => {
    const running = await fetch(base + "/global/health", { signal: AbortSignal.timeout(1000) }).catch(() => undefined)
    if (running)
      throw new Error(
        "Port is already in use. Attach to that server or choose another --port; it will not be terminated.",
      )
    console.log("Magi supervisor: " + base + " · project " + store.directory)
    while (!state.stopping) {
      const started = Date.now()
      await (async () => {
        await repairWindowsRuntime(store.directory, environment, true)
        if (state.stopping) return
        const command =
          options.command ||
          (options.executable
            ? [options.executable]
            : [process.execPath, "x", "--package", "opencode-ai@1.18.31", "opencode"])
        const secret = environment.OPENCODE_SERVER_PASSWORD || crypto.randomUUID()
        const authorization =
          "Basic " + Buffer.from((environment.OPENCODE_SERVER_USERNAME || "opencode") + ":" + secret).toString("base64")
        const lsp = process.platform === "win32" ? path.join(store.home, "lsp-daemon", crypto.randomUUID()) : undefined
        const child = owned(
          Bun.spawn([...command, "serve", "--hostname", "127.0.0.1", "--port", String(options.port)], {
            cwd: store.directory,
            env: { ...environment, OPENCODE_SERVER_PASSWORD: secret, ...(lsp ? { OMO_LSP_DAEMON_DIR: lsp } : {}) },
            stdout: "pipe",
            stderr: "pipe",
            detached: process.platform !== "win32",
            windowsHide: true,
          }),
          Date.now(),
        )
        state.child = child
        state.lsp = lsp ? { directory: lsp, started } : undefined
        store.audit("host-start", { pid: child.pid, startedAt: started })
        const output = Promise.all([bounded(child.stdout), bounded(child.stderr)]).catch((error) => [
          redact(String(error)),
        ])
        await (async () => {
          await atomic(
            path.join(store.home, "connection.json"),
            JSON.stringify(
              {
                url: base,
                username: environment.OPENCODE_SERVER_USERNAME || "opencode",
                password: secret,
                project: store.directory,
                pid: child.pid,
                supervisorPid: process.pid,
                startedAt: started,
              },
              null,
              2,
            ),
          )
          if (process.platform !== "win32")
            await import("node:fs/promises").then((fs) => fs.chmod(path.join(store.home, "connection.json"), 0o600))
          let unhealthySince = 0
          while (!state.stopping && child.exitCode === null) {
            await pause(options.pollMs || 3000)
            if (state.stopping || child.exitCode !== null) break
            const healthy = await fetch(base + "/agent?directory=" + encodeURIComponent(store.directory), {
              headers: { authorization },
              signal: AbortSignal.any([AbortSignal.timeout(10000), halt.signal]),
            }).then(
              (response) => response.ok,
              () => false,
            )
            const persisted = store.read()
            const stalled =
              persisted.goal &&
              persisted.desiredState === "running" &&
              Date.now() - persisted.heartbeatAt > 90000 &&
              Date.now() - started > 120000
            if (healthy && !stalled) {
              unhealthySince = 0
              continue
            }
            unhealthySince ||= Date.now()
            if (Date.now() - unhealthySince > 90000) {
              store.audit("supervisor-restart", { reason: "OpenCode health or controller heartbeat expired" })
              break
            }
          }
        })().finally(cleanup)
        await atomic(path.join(store.home, "supervisor-last.log"), redact((await output).join("\n")))
        store.audit("host-exit", { code: child.exitCode })
      })()
        .catch((error) => {
          store.audit("supervisor-retry", redact(String(error)))
        })
        .finally(cleanup)
      if (state.stopping) break
      state.failures = Date.now() - started > 60000 ? 0 : state.failures + 1
      await pause(Math.min(60000, 1000 * 2 ** Math.min(state.failures, 6)))
    }
  })().finally(async () => {
    clearInterval(heartbeat)
    await cleanup()
    store.release("supervisor", token)
    store.close()
    process.off("SIGINT", stop)
    process.off("SIGTERM", stop)
    options.signal?.removeEventListener("abort", stop)
  })
}
export async function serviceFiles(directory: string, port: number, cli: string) {
  const store = new Store(directory)
  const root = path.join(store.home, "service")
  const xml = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
  const args = [cli, "serve", "--project", store.directory, "--port", String(port)]
  const quoted = (value: string) => '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"'
  const command = [process.execPath, ...args].map(quoted).join(" ")
  const files = {
    "openmagi.service": `[Unit]\nDescription=Oh My OpenMagi supervisor\nAfter=network-online.target\n\n[Service]\nExecStart=${command.replaceAll("%", "%%")}\nWorkingDirectory=${quoted(store.directory).replaceAll("%", "%%")}\nRestart=always\nRestartSec=10\n\n[Install]\nWantedBy=default.target\n`,
    "dev.openmagi.plist": `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>dev.openmagi.${path.basename(store.home).slice(0, 12)}</string><key>ProgramArguments</key><array>${[process.execPath, ...args].map((value) => "<string>" + xml(value) + "</string>").join("")}</array><key>WorkingDirectory</key><string>${xml(store.directory)}</string><key>KeepAlive</key><true/><key>RunAtLoad</key><true/></dict></plist>`,
    "openmagi-task.xml": `<?xml version="1.0" encoding="UTF-16"?><Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings><Actions><Exec><Command>${xml(process.execPath)}</Command><Arguments>${xml(args.map((value) => '"' + value.replaceAll('"', '\\"') + '"').join(" "))}</Arguments><WorkingDirectory>${xml(store.directory)}</WorkingDirectory></Exec></Actions></Task>`,
  }
  await Promise.all(
    Object.entries(files).map(([name, content]) =>
      atomic(path.join(root, name), content.replace('encoding="UTF-16"', 'encoding="UTF-8"')),
    ),
  )
  store.close()
  return root
}
