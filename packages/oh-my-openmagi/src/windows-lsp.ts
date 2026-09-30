import path from "node:path"
import os from "node:os"
import { readdir } from "node:fs/promises"
import { spawnWithRetry } from "./process"

// OmO's detached LSP daemon can retain a crashed Windows host's socket handles.
// Each supervised host gets a private namespace; never sweep the user's shared daemon.
export async function cleanupWindowsLsp(directory: string, env: NodeJS.ProcessEnv, started: number) {
  if (process.platform !== "win32") return
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^v[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.name))
      continue
    const folder = path.join(directory, entry.name)
    const ownerFile = path.join(folder, "daemon.owner")
    // A launch already in progress may finish publishing its owner after the native host exits.
    const deadline = Date.now() + 5000
    while (!(await Bun.file(ownerFile).exists()) && Date.now() < deadline) await Bun.sleep(100)
    if (!(await Bun.file(ownerFile).exists())) continue
    const digest = new Bun.CryptoHasher("sha256")
      .update(
        path.resolve(folder) + "\0win:" + os.userInfo().username + ":" + path.resolve(env.USERPROFILE || os.homedir()),
      )
      .digest("hex")
      .slice(0, 16)
    const pipe = "omo-lsp-" + entry.name.slice(1) + "-" + digest
    const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'"
    const script = `
$ErrorActionPreference='Stop'
$owner=Get-Content -LiteralPath ${literal(ownerFile)} -Raw | ConvertFrom-Json
$pidText=(Get-Content -LiteralPath ${literal(path.join(folder, "daemon.pid"))} -Raw).Trim()
if ($owner.pid -ne [int]$pidText -or $owner.pid -le 0 -or $owner.endpoint.kind -ne 'windows' -or $owner.endpoint.path -cne ('\\\\.\\pipe\\'+${literal(pipe)})) { throw 'LSP owner metadata does not match the private namespace' }
$root=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$owner.pid)
if (!$root) { exit 0 }
$start=[datetime]::Parse(${literal(new Date(started - 1000).toISOString())}).ToUniversalTime()
$birth=$root.CreationDate.ToUniversalTime()
$recorded=[datetime]::Parse([string]$owner.startedAt).ToUniversalTime()
if ($birth -lt $start -or [Math]::Abs(($birth-$recorded).TotalSeconds) -gt 2) { throw 'LSP owner PID was reused or predates this host' }
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles; public static class OpenMagiPipeOwner { [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid); }'
$pipe=[IO.Pipes.NamedPipeClientStream]::new('.',${literal(pipe)},[IO.Pipes.PipeDirection]::InOut)
try {
  $pipe.Connect(1500)
  $serverPid=[uint32]0
  if (![OpenMagiPipeOwner]::GetNamedPipeServerProcessId($pipe.SafePipeHandle,[ref]$serverPid) -or $serverPid -ne $owner.pid) { throw 'Private LSP pipe does not belong to the recorded process' }
} finally { $pipe.Dispose() }
$tree=@(Get-CimInstance Win32_Process)
$targets=[Collections.Generic.List[object]]::new()
$targets.Add($root)
$ids=[Collections.Generic.HashSet[int]]::new()
[void]$ids.Add([int]$root.ProcessId)
do {
  $count=$ids.Count
  foreach($item in $tree) {
    if (!$ids.Contains([int]$item.ProcessId) -and $ids.Contains([int]$item.ParentProcessId) -and $item.CreationDate.ToUniversalTime() -ge $birth) {
      [void]$ids.Add([int]$item.ProcessId)
      $targets.Add($item)
    }
  }
} while ($count -ne $ids.Count)
$targets.Reverse()
foreach($item in $targets) {
  $current=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$item.ProcessId)
  if ($current -and $current.CreationDate -eq $item.CreationDate) {
    $target=Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
    if ($target -and [Math]::Abs(($target.StartTime.ToUniversalTime()-$item.CreationDate.ToUniversalTime()).TotalSeconds) -lt 1) {
      $target.Kill()
      if (!$target.WaitForExit(5000)) { throw 'Private LSP process did not exit' }
    }
  }
}
`
    const child = await spawnWithRetry(() =>
      Bun.spawn(
        [
          (env.SystemRoot || "C:/Windows") + "/System32/WindowsPowerShell/v1.0/powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-WindowStyle",
          "Hidden",
          "-Command",
          script,
        ],
        { stdout: "ignore", stderr: "pipe", windowsHide: true },
      ),
    )
    const timer = setTimeout(() => child.kill(), 20000)
    const result = await Promise.all([child.exited, new Response(child.stderr).text()]).finally(() =>
      clearTimeout(timer),
    )
    if (result[0] !== 0) throw new Error("Could not clean the private LSP daemon: " + result[1])
  }
}
