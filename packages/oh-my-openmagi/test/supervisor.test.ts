import { test, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { supervise, serviceFiles } from "../src/supervisor"
import { Store } from "../src/store"

test("supervisor restarts an actual failed process and preserves intent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openmagi-supervisor-"))
  const previous = process.env.OPENMAGI_HOME
  process.env.OPENMAGI_HOME = path.join(root, "data")
  const store = new Store(root)
  const abort = new AbortController()
  await (async () => {
    store.update((state) => ({ ...state, goal: "Keep improving", desiredState: "running", phase: "planning" }))
    const fixture = path.join(root, "host.ts")
    await Bun.write(
      fixture,
      `
const count = Number(await Bun.file("boots.txt").text().catch(() => "0")) + 1;
await Bun.write("boots.txt", String(count));
Bun.serve({ hostname:"127.0.0.1", port:Number(Bun.argv[Bun.argv.indexOf("--port")+1]), fetch:()=>Response.json([]) });
if(count===1)setTimeout(()=>process.exit(42),200);
`,
    )
    const reservation = Bun.serve({ port: 0, fetch: () => new Response() })
    const port = reservation.port!
    reservation.stop(true)
    const running = supervise(root, {
      port,
      command: [process.execPath, fixture],
      signal: abort.signal,
      pollMs: 100,
      env: {
        ...process.env,
        OPENCODE_TEST_HOME: path.join(root, "home"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_STATE_HOME: path.join(root, "state"),
        OPENCODE_CONFIG_DIR: path.join(root, "config", "opencode"),
        TEMP: root,
        TMP: root,
        TMPDIR: root,
      },
    })
    const deadline = Date.now() + 20000
    while (
      Number(
        await Bun.file(path.join(root, "boots.txt"))
          .text()
          .catch(() => "0"),
      ) < 2
    ) {
      if (Date.now() > deadline) throw new Error("Supervisor did not restart the host")
      await Bun.sleep(100)
    }
    abort.abort()
    await running
    expect(store.read().desiredState).toBe("running")
    expect(store.read().goal).toBe("Keep improving")
    expect(await Bun.file(path.join(store.home, "connection.json")).exists()).toBe(true)
    const services = await serviceFiles(root, port, path.join(root, "cli.js"))
    expect(await Bun.file(path.join(services, "openmagi.service")).text()).toContain("Restart=always")
    expect(await Bun.file(path.join(services, "openmagi-task.xml")).text()).toContain("<LogonTrigger>")
    expect(await Bun.file(path.join(services, "dev.openmagi.plist")).text()).toContain("KeepAlive")
  })().finally(async () => {
    abort.abort()
    store.close()
    if (previous === undefined) delete process.env.OPENMAGI_HOME
    if (previous !== undefined) process.env.OPENMAGI_HOME = previous
    await rm(root, { recursive: true, force: true })
  })
}, 30000)

test("supervisor retries a spawn failure after the executable dependency is repaired", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openmagi-launch-retry-"))
  const store = new Store(root, path.join(root, "runtime"))
  const abort = new AbortController()
  const command = [path.join(root, "missing-executable")]
  const fixture = path.join(root, "host.ts")
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = reservation.port!
  reservation.stop(true)
  await Bun.write(
    fixture,
    'await Bun.write("booted.txt","yes"); Bun.serve({port:Number(Bun.argv[Bun.argv.indexOf("--port")+1]),fetch:()=>Response.json([])})',
  )
  store.update((state) => ({ ...state, goal: "Keep improving", desiredState: "running", phase: "planning" }))
  const running = supervise(root, {
    port,
    command,
    signal: abort.signal,
    pollMs: 50,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      OPENMAGI_HOME: path.join(root, "runtime"),
      OPENCODE_TEST_HOME: path.join(root, "home"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
      TEMP: root,
      TMP: root,
    },
  })
  await (async () => {
    const deadline = Date.now() + 20000
    while (!store.db.query("SELECT id FROM audit WHERE kind='supervisor-retry'").get()) {
      if (Date.now() > deadline) throw new Error("Failed launch was not recorded")
      await Bun.sleep(50)
    }
    command.splice(0, command.length, process.execPath, fixture)
    while (!(await Bun.file(path.join(root, "booted.txt")).exists())) {
      if (Date.now() > deadline) throw new Error("Repaired dependency was not retried")
      await Bun.sleep(50)
    }
    abort.abort()
    await running
    expect(store.read().desiredState).toBe("running")
    expect(store.db.query("SELECT name FROM leases WHERE name='supervisor'").get()).toBeNull()
  })().finally(async () => {
    abort.abort()
    await running
    store.close()
    await rm(root, { recursive: true, force: true })
  })
}, 30000)

test("an already cancelled supervisor does not launch or create state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openmagi-cancelled-"))
  await (async () => {
    await supervise(root, {
      port: 4096,
      signal: AbortSignal.abort(),
      env: { OPENMAGI_HOME: path.join(root, "runtime") },
    })
    expect(await Bun.file(path.join(root, "runtime")).exists()).toBe(false)
  })().finally(() => rm(root, { recursive: true, force: true }))
})
