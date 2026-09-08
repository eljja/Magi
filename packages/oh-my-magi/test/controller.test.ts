import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createControllerLease } from "../src/controller"

test("only one scheduler holds the project lease, and disposal transfers ownership", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "magi-lease-"))
  const first = createControllerLease(directory)
  const second = createControllerLease(directory)
  try {
    expect(await first.acquire()).toBe(true)
    expect(await first.acquire()).toBe(true)
    expect(await second.acquire()).toBe(false)
    await first.release()
    expect(await second.acquire()).toBe(true)
  } finally {
    await first.release()
    await second.release()
    await rm(directory, { recursive: true, force: true })
  }
})
