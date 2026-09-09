import { chmod, lstat, readdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Bun #34413: mkdir(recursive) fails on existing Windows ReadOnly directories.
// Touch only known runtime directories; never files, ACLs, or reparse targets.
export async function repairWindowsRuntime(directory: string, env = process.env, recursive = false) {
  if (process.platform !== "win32") return []
  const home = env.OPENCODE_TEST_HOME || os.homedir()
  const folders = [
    path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "opencode"),
    path.join(env.XDG_STATE_HOME || path.join(home, ".local", "state"), "opencode"),
    path.join(env.XDG_CACHE_HOME || path.join(home, ".cache"), "opencode"),
    path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode"),
    path.join(env.TMPDIR || env.TEMP || env.TMP || os.tmpdir(), "opencode"),
    ...(env.OPENCODE_CONFIG_DIR ? [env.OPENCODE_CONFIG_DIR] : []),
    path.join(directory, ".omo", "run-continuation"),
  ]
  const repaired: string[] = []
  const pending = [...new Set(folders)]
  for (const folder of pending) {
    const info = await lstat(folder).catch(() => undefined)
    if (!info?.isDirectory() || info.isSymbolicLink()) continue
    await chmod(folder, info.mode | 0o200)
    repaired.push(folder)
    if (recursive)
      pending.push(
        ...(await readdir(folder, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
          .map((entry) => path.join(folder, entry.name)),
      )
  }
  return repaired
}
