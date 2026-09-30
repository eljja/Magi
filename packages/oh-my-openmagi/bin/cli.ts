#!/usr/bin/env bun
import path from "node:path"
import { parseArgs } from "node:util"
import { Store } from "../src/store"
import { applyControl, parseControl, statusText } from "../src/control"
import { install, doctor, version } from "../src/installer"
import { supervise, serviceFiles } from "../src/supervisor"
import { writeViews } from "../src/views"
import { createHost } from "../src/host"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { Reporter } from "../src/reports"

const args = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    help: { type: "boolean" },
    version: { type: "boolean" },
    project: { type: "string", default: process.cwd() },
    global: { type: "boolean" },
    port: { type: "string", default: "4096" },
    executable: { type: "string" },
    plugin: { type: "string" },
  },
})
const directory = path.resolve(args.values.project!)
const command = args.values.version ? "version" : args.values.help ? "help" : args.positionals.join(" ")
const main = async () => {
  if (command === "version" || command === "--version") {
    console.log(version)
    return
  }
  if (command === "install") {
    console.log(JSON.stringify(await install(directory, args.values.global, args.values.plugin), null, 2))
    return
  }
  if (command === "doctor") {
    console.log(JSON.stringify(await doctor(directory), null, 2))
    return
  }
  const port = Number(args.values.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be 1..65535")
  if (command === "serve") {
    await supervise(directory, { port, executable: args.values.executable })
    return
  }
  if (command === "service files") {
    console.log(await serviceFiles(directory, port, path.resolve(Bun.argv[1]!)))
    return
  }
  if (command === "attach") {
    const store = new Store(directory)
    const connection = (await Bun.file(path.join(store.home, "connection.json")).json()) as {
      url: string
      password: string
      username: string
    }
    store.close()
    const child = Bun.spawn(
      [
        process.execPath,
        "x",
        "--package",
        "opencode-ai@1.18.31",
        "opencode",
        "attach",
        connection.url,
        "--dir",
        directory,
      ],
      {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env: {
          ...process.env,
          OPENCODE_SERVER_PASSWORD: connection.password,
          OPENCODE_SERVER_USERNAME: connection.username,
        },
      },
    )
    process.exitCode = await child.exited
    return
  }
  if (command === "votes") {
    console.log(await Bun.file(path.join(directory, ".magi", "VOTES-LATEST.md")).text())
    return
  }
  const control = parseControl(command)
  if (control) {
    const store = new Store(directory)
    console.log(applyControl(store, control))
    await writeViews(store)
    // CLI stop also aborts known work immediately when the owned supervisor is reachable.
    const connection = (await Bun.file(path.join(store.home, "connection.json"))
      .json()
      .catch(() => undefined)) as { url: string; password: string; username: string } | undefined
    if (connection) {
      const client = createOpencodeClient({
        baseUrl: connection.url,
        headers: {
          authorization: "Basic " + Buffer.from(connection.username + ":" + connection.password).toString("base64"),
        },
      })
      const host = createHost(client, directory)
      if (control.type === "stop")
        await Promise.allSettled(
          store
            .jobs()
            .filter((job) => job.status === "running" && job.session)
            .map((job) => host.abort(job.session!)),
        )
      if (control.type === "report-now") await new Reporter(store, host).tick()
    }
    if (!connection && control.type === "report-now") console.log(statusText(store))
    store.close()
    return
  }
  console.log(
    "oh-my-magi " +
      version +
      "\ninstall [--global] | serve | attach | service files | doctor | status | stop | resume | votes | report interval 1h | report now | report status\nOptions: --project <path>, --port 4096, --executable <opencode>, --plugin <specifier>\nStart a goal by selecting Magi in OpenCode, or /magi start <goal>.",
  )
}
await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
