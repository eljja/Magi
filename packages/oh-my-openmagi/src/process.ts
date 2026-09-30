import type { Subprocess } from "bun"
import { windowsProcessApi } from "./windows-process"

export async function spawnWithRetry<T extends Subprocess>(
  launch: () => T,
  options: { active?: () => boolean; onRetry?: (attempt: number, error: unknown) => void } = {},
) {
  const start = async (attempt = 0): Promise<T> => {
    if (options.active?.() === false) throw new DOMException("Process launch cancelled", "AbortError")
    return Promise.resolve()
      .then(launch)
      .catch(async (error: unknown) => {
        const code = error && typeof error === "object" ? Reflect.get(error, "code") : undefined
        // Retry only a launch that failed before returning a child, never a command's exit status.
        if (attempt >= 3 || !["EPERM", "EACCES", "EBUSY"].includes(String(code))) throw error
        options.onRetry?.(attempt + 1, error)
        await Bun.sleep(1000 * 2 ** attempt)
        return start(attempt + 1)
      })
  }
  return start()
}

const lifetimes = new WeakMap<Subprocess, { started: number; exited?: number }>()
const terminating = new WeakMap<Subprocess, Promise<void>>()
export function owned<T extends Subprocess>(child: T, started = Date.now()) {
  const lifetime = { started, exited: undefined as number | undefined }
  lifetimes.set(child, lifetime)
  void child.exited.then(() => {
    lifetime.exited = Date.now()
  })
  return child
}
export function terminate(child: Subprocess): Promise<void> {
  const pending = terminating.get(child)
  if (pending) return pending
  const stopping = terminateTree(child).finally(() => terminating.delete(child))
  terminating.set(child, stopping)
  return stopping
}
async function terminateTree(child: Subprocess) {
  if (process.platform !== "win32") {
    const group = await Promise.resolve()
      .then(() => process.kill(-child.pid, "SIGKILL"))
      .catch(() => false)
    if (!group && child.exitCode === null) child.kill("SIGKILL")
    return
  }
  const lifetime = lifetimes.get(child)
  if (child.exitCode !== null && !lifetime) return
  const start = lifetime ? new Date(lifetime.started - 1000).toISOString() : "1970-01-01T00:00:00.000Z"
  const end = new Date(lifetime?.exited || Date.now()).toISOString()
  // Discover descendants even after an owned launcher exits. Creation bounds prevent following
  // a reused parent PID; each target is checked again immediately before termination.
  const script = `
$ErrorActionPreference='Stop'
[Console]::Out.WriteLine('cleanup started')
${windowsProcessApi}
$tree=@([MagiProcesses]::Snapshot())
[Console]::Out.WriteLine('process snapshot collected')
$start=[datetime]::Parse('${start}').ToUniversalTime()
$end=[datetime]::Parse('${end}').ToUniversalTime()
$root=[MagiProcesses]::Inspect(${child.pid})
$targets=[System.Collections.Generic.List[object]]::new()
$ids=[System.Collections.Generic.HashSet[int]]::new()
[void]$ids.Add(${child.pid})
if ($root) {
  if ($root.ParentProcessId -ne ${process.pid} -or $root.CreationDate.ToUniversalTime() -lt $start -or $root.CreationDate.ToUniversalTime() -gt $end) { throw 'Owned process PID was reused; refusing termination' }
  $targets.Add($root)
}
do {
  $count=$ids.Count
  foreach($candidate in $tree) {
    if ($ids.Contains([int]$candidate.ProcessId) -or !$ids.Contains([int]$candidate.ParentProcessId)) { continue }
    $item=[MagiProcesses]::Inspect($candidate.ProcessId)
    if ($item -and $item.ParentProcessId -eq $candidate.ParentProcessId -and $item.CreationDate.ToUniversalTime() -ge $start -and ($item.ParentProcessId -ne ${child.pid} -or $item.CreationDate.ToUniversalTime() -le $end)) {
      [void]$ids.Add([int]$item.ProcessId)
      $targets.Add($item)
    }
  }
} while($count -ne $ids.Count)
$targets.Reverse()
[Console]::Out.WriteLine('owned targets: '+$targets.Count)
foreach($item in $targets) {
  [MagiProcesses]::Stop($item.ProcessId,$item.CreationDate)
}
`
  const kill = await spawnWithRetry(() =>
    Bun.spawn(
      [
        (process.env.SystemRoot || "C:/Windows") + "/System32/WindowsPowerShell/v1.0/powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-Command",
        script,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true },
    ),
  )
  const started = Date.now()
  const timeout = setTimeout(() => kill.kill(), 20000)
  const result = await Promise.all([kill.exited, bounded(kill.stdout), bounded(kill.stderr)]).finally(() =>
    clearTimeout(timeout),
  )
  if (result[0] !== 0)
    throw new Error(
      `Could not terminate the owned process tree (exit ${result[0]}, signal ${kill.signalCode}, ${Date.now() - started} ms): ` +
        result.slice(1).join("\n"),
    )
}
export async function bounded(stream: ReadableStream<Uint8Array>, limit = 32000) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let length = 0
  while (true) {
    const item = await reader.read()
    if (item.done) break
    chunks.push(decoder.decode(item.value, { stream: true }))
    length += chunks.at(-1)!.length
    while (length > limit && chunks.length > 1) length -= chunks.shift()!.length
  }
  return chunks.join("").slice(-limit)
}
