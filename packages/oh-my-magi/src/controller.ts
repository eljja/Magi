import { ensureDirectory } from "./fs"
import { open, unlink } from "node:fs/promises"
import path from "node:path"
import { magiRuntimeDir } from "./state"

// One OpenCode server owns scheduling for a directory, even when CLI/web/desktop coexist.
export function createControllerLease(directory: string) {
  const file = path.join(magiRuntimeDir(directory), "controller.json")
  const token = crypto.randomUUID()
  let owned = false
  let pending: Promise<boolean> | undefined
  const claim = async (): Promise<boolean> => {
    if (owned) return true
    await ensureDirectory(magiRuntimeDir(directory))
    const handle = await open(file, "wx").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error
      return undefined
    })
    if (handle) {
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token }))
      } finally {
        await handle.close()
      }
      owned = true
      return true
    }
    const owner = (await Bun.file(file)
      .json()
      .catch(() => undefined)) as { pid?: number } | undefined
    if (!owner || !Number.isInteger(owner.pid) || owner.pid! <= 0) return false
    const alive = (() => {
      try {
        process.kill(owner.pid!, 0)
        return true
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH"
      }
    })()
    if (alive) return false
    await unlink(file).catch(() => undefined)
    return claim()
  }
  return {
    acquire() {
      pending ??= claim().finally(() => {
        pending = undefined
      })
      return pending
    },
    async release() {
      await pending
      if (!owned) return
      const owner = (await Bun.file(file)
        .json()
        .catch(() => undefined)) as { token?: string } | undefined
      if (owner?.token === token) await unlink(file).catch(() => undefined)
      owned = false
    },
  }
}
