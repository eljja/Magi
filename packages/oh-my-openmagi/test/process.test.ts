import { test, expect } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { pathToFileURL } from "node:url"
import { owned, terminate, spawnWithRetry } from "../src/process"
import { isolatedEnvironment } from "../script/native"

test("transient launch denial retries before starting one real process", async () => {
  const calls = { count: 0, retries: 0, children: 0 }
  const child = await spawnWithRetry(
    () => {
      if (++calls.count < 3) throw Object.assign(new Error("temporary OS launch denial"), { code: "EPERM" })
      const child = Bun.spawn([process.execPath, "-e", "console.log('actual child completed')"], {
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      })
      calls.children++
      return child
    },
    { onRetry: () => calls.retries++ },
  )
  expect(await child.exited).toBe(0)
  expect(await new Response(child.stdout).text()).toContain("actual child completed")
  expect(calls.children).toBe(1)
  expect(calls.retries).toBeGreaterThanOrEqual(2)
  expect(calls.count).toBe(calls.retries + 1)
})

test("persistent permission denial is surfaced after bounded launch retries", async () => {
  const failure = Object.assign(new Error("executable is not permitted"), { code: "EACCES" })
  const calls = { count: 0 }
  await expect(
    spawnWithRetry(() => {
      calls.count++
      throw failure
    }),
  ).rejects.toBe(failure)
  expect(calls.count).toBe(4)
}, 15000)

test("a stop during launch backoff prevents another attempt", async () => {
  const state = { active: true, calls: 0 }
  await expect(
    spawnWithRetry(
      () => {
        state.calls++
        throw Object.assign(new Error("temporary denial"), { code: "EPERM" })
      },
      {
        active: () => state.active,
        onRetry: () => {
          state.active = false
        },
      },
    ),
  ).rejects.toThrow("cancelled")
  expect(state.calls).toBe(1)
})

test("a real nonzero child exit never causes command replay", async () => {
  const calls = { count: 0 }
  const child = await spawnWithRetry(() => {
    const child = Bun.spawn([process.execPath, "-e", "process.exit(43)"], {
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    })
    calls.count++
    return child
  })
  expect(await child.exited).toBe(43)
  expect(calls.count).toBe(1)
})

test("termination cleans descendants after their launcher has already exited", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openmagi-process-"))
  const worker = path.join(root, "worker.ts")
  const launcher = path.join(root, "launcher.ts")
  const signal = path.join(root, "heartbeat.txt")
  await Bun.write(worker, "setInterval(() => Bun.write(" + JSON.stringify(signal) + ", String(Date.now())), 30)")
  await Bun.write(
    launcher,
    "Bun.spawn([" +
      JSON.stringify(process.execPath) +
      "," +
      JSON.stringify(worker) +
      '], {stdout:"inherit",stderr:"inherit",windowsHide:true}); setTimeout(()=>process.exit(42), 500)',
  )
  const child = owned(
    Bun.spawn([process.execPath, launcher], {
      stdout: "ignore",
      stderr: "ignore",
      detached: process.platform !== "win32",
      windowsHide: true,
    }),
  )
  const peer = owned(
    Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      stdout: "ignore",
      stderr: "ignore",
      detached: process.platform !== "win32",
      windowsHide: true,
    }),
  )
  await (async () => {
    expect(await child.exited).toBe(42)
    await Promise.all([terminate(child), terminate(child)])
    const stopped = await Bun.file(signal).text()
    await Bun.sleep(250)
    expect(await Bun.file(signal).text()).toBe(stopped)
    expect(peer.exitCode).toBeNull()
  })().finally(async () => {
    await terminate(child)
    await terminate(peer)
    await rm(root, { recursive: true, force: true })
  })
}, 30000)

test.skipIf(process.platform !== "win32")(
  "Windows refuses a process whose creation time contradicts ownership",
  async () => {
    const started = Date.now()
    const child = owned(
      Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      }),
      started + 60000,
    )
    await (async () => {
      await expect(terminate(child)).rejects.toThrow("PID was reused; refusing termination")
      expect(child.exitCode).toBeNull()
    })().finally(async () => {
      owned(child, started)
      await terminate(child)
    })
  },
  30000,
)

test.skipIf(process.platform !== "win32")(
  "Windows cleanup works in the native host's isolated environment",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "magi-cleanup-env-"))
    await Promise.all(["home", "tmp"].map((name) => mkdir(path.join(root, name))))
    const child = owned(
      Bun.spawn(
        [
          process.execPath,
          "-e",
          `import {owned,terminate} from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dir, "../src/process.ts")).href)};
const child=owned(Bun.spawn([process.execPath,'-e','process.exit(0)'],{stdout:'ignore',stderr:'ignore',windowsHide:true}));
await child.exited; await terminate(child); console.log('isolated cleanup completed');`,
        ],
        {
          cwd: root,
          env: isolatedEnvironment(root),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          windowsHide: true,
        },
      ),
    )
    await (async () => {
      const result = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(result[0], result[2]).toBe(0)
      expect(result[1]).toContain("isolated cleanup completed")
    })().finally(async () => {
      await terminate(child)
      await rm(root, { recursive: true, force: true })
    })
  },
  30000,
)
