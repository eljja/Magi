import { test, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { cleanupWindowsLsp } from "../src/windows-lsp"
import { owned, spawnWithRetry, terminate } from "../src/process"

test.skipIf(process.platform !== "win32")(
  "private LSP cleanup proves pipe ownership and leaves another daemon alive",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openmagi-lsp-"))
    const cli = path.resolve(
      Bun.resolveSync("oh-my-opencode", import.meta.dir),
      "../../packages/lsp-daemon/dist/cli.js",
    )
    const started = Date.now()
    const launch = async (name: string) =>
      owned(
        await spawnWithRetry(() =>
          Bun.spawn([Bun.which("node") || process.execPath, cli, "daemon"], {
            env: { ...process.env, OMO_LSP_DAEMON_DIR: path.join(root, name) },
            stdout: "ignore",
            stderr: "ignore",
            windowsHide: true,
          }),
        ),
      )
    const privateChild = await launch("private")
    const other = await launch("other")
    const ownerFile = path.join(root, "private", "v0.1.0", "daemon.owner")
    const pidFile = path.join(root, "private", "v0.1.0", "daemon.pid")
    await (async () => {
      const deadline = Date.now() + 10000
      while (
        !(await Bun.file(ownerFile).exists()) ||
        !(await Bun.file(path.join(root, "other", "v0.1.0", "daemon.owner")).exists())
      ) {
        if (Date.now() > deadline) throw new Error("Actual upstream daemons did not start")
        await Bun.sleep(100)
      }
      const owner = await Bun.file(ownerFile).text()
      const pid = await Bun.file(pidFile).text()
      const otherOwner = await Bun.file(path.join(root, "other", "v0.1.0", "daemon.owner")).json()
      await Bun.write(
        ownerFile,
        JSON.stringify({ ...JSON.parse(owner), pid: other.pid, startedAt: otherOwner.startedAt }),
      )
      await Bun.write(pidFile, String(other.pid))
      await expect(cleanupWindowsLsp(path.join(root, "private"), process.env, started)).rejects.toThrow(
        "Private LSP pipe does not belong",
      )
      expect(other.exitCode).toBeNull()
      expect(privateChild.exitCode).toBeNull()
      await Bun.write(ownerFile, owner)
      await Bun.write(pidFile, pid)
      await cleanupWindowsLsp(path.join(root, "private"), process.env, started)
      await privateChild.exited
      expect(other.exitCode).toBeNull()
      await cleanupWindowsLsp(path.join(root, "private"), process.env, started)
    })().finally(async () => {
      await Promise.all([terminate(privateChild), terminate(other)])
      await rm(root, { recursive: true, force: true })
    })
  },
  30000,
)
