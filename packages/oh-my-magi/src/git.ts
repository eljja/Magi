// Git enriches evidence when available; it is never a prerequisite for a goal.
export async function optionalGit(directory: string, args: string[]) {
  const executable = Bun.which("git")
  if (!executable) return { code: 127, stdout: "", stderr: "Git is unavailable; continue in the current folder." }
  const proc = await Promise.resolve()
    .then(() =>
      Bun.spawn([executable, ...args], {
        cwd: directory,
        stdout: "pipe",
        stderr: "pipe",
      }),
    )
    .catch(() => undefined)
  if (!proc) return { code: 127, stdout: "", stderr: "Git could not start; continue in the current folder." }
  const timer = setTimeout(() => proc.kill(), 10000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { code, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}
