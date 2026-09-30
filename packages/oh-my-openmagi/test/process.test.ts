import { test, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { owned, terminate, spawnWithRetry } from "../src/process"

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
  await (async () => {
    expect(await child.exited).toBe(42)
    await terminate(child)
    const stopped = await Bun.file(signal).text()
    await Bun.sleep(250)
    expect(await Bun.file(signal).text()).toBe(stopped)
  })().finally(async () => {
    await terminate(child)
    await rm(root, { recursive: true, force: true })
  })
}, 30000)
