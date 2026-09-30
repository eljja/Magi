import path from "node:path"
import { readdir, mkdir, realpath } from "node:fs/promises"
import assert from "node:assert/strict"
import { redact } from "../src/views"
import { spawnWithRetry } from "../src/process"

export const packageRoot = path.resolve(import.meta.dirname, "..")
export async function sha256(file: string) {
  return new Bun.CryptoHasher("sha256").update(await Bun.file(file).arrayBuffer()).digest("hex")
}

export async function sourceIdentity() {
  const files = [
    "package.json",
    "tsconfig.json",
    "bunfig.toml",
    "README.md",
    "CHANGELOG.md",
    "compatibility.json",
    "LICENSE",
    "THIRD-PARTY-NOTICES.md",
  ]
  for (const directory of ["src", "bin", "test", "script", "licenses"]) {
    const visit = async (relative: string): Promise<void> => {
      for (const entry of await readdir(path.join(packageRoot, relative), { withFileTypes: true })) {
        const file = path.posix.join(relative, entry.name)
        if (entry.isDirectory()) await visit(file)
        if (entry.isFile()) files.push(file)
      }
    }
    await visit(directory)
  }
  const entries = await Promise.all(
    files.sort().map(async (file) => ({ file, sha256: await sha256(path.join(packageRoot, file)) })),
  )
  return { sha256: new Bun.CryptoHasher("sha256").update(JSON.stringify(entries)).digest("hex"), files: entries }
}

export async function evidence(kind: string) {
  const root = path.join(
    packageRoot,
    "artifacts",
    "runs",
    new Date().toISOString().replaceAll(/[:.]/g, "-") + "-" + kind + "-" + crypto.randomUUID().slice(0, 8),
  )
  await mkdir(root, { recursive: true })
  const manifest = {
    kind,
    startedAt: new Date().toISOString(),
    cwd: packageRoot,
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    source: await sourceIdentity(),
  }
  await Bun.write(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2))
  const events = Bun.file(path.join(root, "events.jsonl")).writer()
  const event = (kind: string, data: unknown) => {
    events.write(redact(JSON.stringify({ time: new Date().toISOString(), kind, data })) + "\n")
    events.flush()
  }
  return {
    root,
    manifest,
    event,
    async write(name: string, value: unknown) {
      await Bun.write(path.join(root, name), redact(JSON.stringify(value, null, 2)))
    },
    async finish(status: "passed" | "failed" | "incomplete", detail: unknown) {
      event("finished", { status, detail })
      await Bun.write(
        path.join(root, "result.json"),
        redact(JSON.stringify({ ...manifest, endedAt: new Date().toISOString(), status, detail }, null, 2)),
      )
      await events.end()
    },
  }
}
export type Evidence = Awaited<ReturnType<typeof evidence>>

export async function run(
  log: Evidence,
  name: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {},
) {
  const start = Date.now()
  log.event("command-start", { name, args, cwd: options.cwd || packageRoot })
  const child = await spawnWithRetry(
    () =>
      Bun.spawn(args, {
        cwd: options.cwd || packageRoot,
        env: options.env || process.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      }),
    { onRetry: (attempt, error) => log.event("command-spawn-retry", { name, attempt, error: String(error) }) },
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  await Promise.all([
    Bun.write(path.join(log.root, name + ".stdout.log"), redact(stdout)),
    Bun.write(path.join(log.root, name + ".stderr.log"), redact(stderr)),
  ])
  log.event("command-end", { name, code, elapsedMs: Date.now() - start })
  if (code && !options.allowFailure) throw new Error(name + " failed (" + code + "): " + redact(stderr.slice(-4000)))
  return { code, stdout, stderr }
}

export async function releaseIdentity(installed?: string) {
  const release = (await Bun.file(path.join(packageRoot, "artifacts", "release.json")).json()) as {
    archive: string
    sha256: string
    installed: string
    time: string
    source?: { sha256: string }
    files?: { file: string; sha256: string }[]
    dependencyLock?: { path: string; sha256: string }
  }
  assert.equal(await sha256(release.archive), release.sha256, "Release archive was modified after packing")
  assert.ok(release.files?.length, "Run pack:check to create a release with installed file hashes")
  assert.ok(release.dependencyLock, "Release dependency lock evidence is required")
  assert.equal(
    await sha256(release.dependencyLock.path),
    release.dependencyLock.sha256,
    "Release dependency lock changed",
  )
  const location = await realpath(installed || release.installed)
  for (const file of release.files)
    assert.equal(await sha256(path.join(location, file.file)), file.sha256, "Installed release mismatch: " + file.file)
  return { ...release, installed: location }
}
