import net from "node:net"
import path from "node:path"
import { unlink } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { magiRuntimeDir } from "./state"
import { safeWriteFile } from "./fs"

// The OS owns the lease, so process death releases it without stale PID/file
// takeover races. The JSON file is diagnostic only, never the lock authority.
export function createControllerLease(directory: string) {
  const resolved = realpathSync(directory)
  const canonical = process.platform === "win32" ? resolved.toLowerCase() : resolved
  const digest = new Bun.CryptoHasher("sha256").update(canonical).digest("hex")
  const base = Number.parseInt(digest.slice(0, 8), 16)
  const file = path.join(magiRuntimeDir(directory), "controller.json")
  const token = crypto.randomUUID()
  const ownership: { server?: net.Server; pending?: Promise<boolean> } = {}
  const claim = async () => {
    if (ownership.server?.listening) return true
    for (let slot = 0; slot < 16; slot++) {
      const port = 20000 + ((base + slot * 7919) % 40000)
      const server = net.createServer((socket) => {
        socket.end(JSON.stringify({ directory: canonical, token }))
      })
      const acquired = await new Promise<boolean>((resolve, reject) => {
        server.once("error", (error: NodeJS.ErrnoException) =>
          error.code === "EADDRINUSE" ? resolve(false) : reject(error),
        )
        server.listen({ host: "127.0.0.1", port, exclusive: true }, () => resolve(true))
      })
      if (!acquired) {
        const other = await new Promise<string | undefined>((resolve) => {
          const socket = net.connect({ host: "127.0.0.1", port })
          const finish = (value?: string) => {
            socket.destroy()
            resolve(value)
          }
          socket.setTimeout(1000, () => finish())
          socket.once("error", () => finish())
          socket.once("data", (data) => {
            try {
              const owner = JSON.parse(data.toString())
              finish(typeof owner.directory === "string" ? owner.directory : undefined)
            } catch {
              finish()
            }
          })
        })
        // Only skip a slot when another Magi controller positively identifies a
        // different project. Unknown listeners fail closed rather than duplicating.
        if (!other || other === canonical) return false
        continue
      }
      ownership.server = server
      server.unref()
      try {
        await safeWriteFile(file, JSON.stringify({ pid: process.pid, token, port, directory: canonical }))
        return true
      } catch (error) {
        await new Promise<void>((resolve) => server.close(() => resolve()))
        ownership.server = undefined
        throw error
      }
    }
    throw new Error("Magi controller lease ports are occupied by other projects")
  }
  return {
    acquire() {
      ownership.pending ??= claim().finally(() => {
        ownership.pending = undefined
      })
      return ownership.pending
    },
    async release() {
      await ownership.pending
      if (!ownership.server) return
      // Remove diagnostics while still holding the OS lease.
      await unlink(file).catch(() => undefined)
      await new Promise<void>((resolve) => ownership.server!.close(() => resolve()))
      ownership.server = undefined
    },
  }
}
