export async function terminateProcessTree(proc: Bun.Subprocess) {
  if (process.platform === "win32") {
    const killer = Bun.spawn(["taskkill", "/pid", String(proc.pid), "/t", "/f"], { stdout: "ignore", stderr: "ignore" })
    const timeout = setTimeout(() => killer.kill(), 5000)
    try {
      await killer.exited
    } finally {
      clearTimeout(timeout)
    }
    proc.kill()
    return
  }
  try {
    process.kill(-proc.pid, "SIGKILL")
  } catch {
    proc.kill()
  }
}
