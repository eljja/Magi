import path from "node:path"
import assert from "node:assert/strict"
import metadata from "../package.json"
import { evidence, packageRoot, run, sha256 } from "./evidence"

const log = await evidence("pack")
await (async () => {
  const env = { ...process.env, OMO_DISABLE_PROCESS_CLEANUP: "1", BUN_INSTALL_CACHE_DIR: path.join(log.root, "cache") }
  await run(log, "pack", [process.execPath, "pm", "pack", "--destination", log.root], { env })
  const archive = path.join(log.root, metadata.name + "-" + metadata.version + ".tgz")
  const directory = path.join(log.root, "consumer")
  await Bun.write(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: "openmagi-release-check",
      private: true,
      type: "module",
      dependencies: { [metadata.name]: "file:" + archive.replaceAll("\\", "/") },
    }),
  )
  await run(log, "install", [process.execPath, "install", "--ignore-scripts"], { cwd: directory, env })
  const installed = path.join(directory, "node_modules", metadata.name)
  assert.ok(
    !(await Bun.file(path.join(installed, "package.json")).text()).includes("catalog:"),
    "Published manifest must resolve workspace catalog versions",
  )
  const files = await Promise.all(
    [
      "package.json",
      "dist/server.js",
      "dist/cli.js",
      "README.md",
      "LICENSE",
      "THIRD-PARTY-NOTICES.md",
      "licenses/oh-my-opencode-SUL-1.0.md",
      "compatibility.json",
      "CHANGELOG.md",
    ].map(async (file) => ({ file, sha256: await sha256(path.join(installed, file)) })),
  )
  assert.ok(
    (
      await run(log, "cli", [process.execPath, path.join(installed, "dist/cli.js"), "--help"], { cwd: directory, env })
    ).stdout.includes(metadata.name),
  )
  await run(
    log,
    "plugin-export",
    [
      process.execPath,
      "-e",
      `const plugin = (await import(${JSON.stringify(metadata.name)})).default; if(plugin.id!==${JSON.stringify(metadata.name)} || typeof plugin.server!=="function")process.exit(1)`,
    ],
    { cwd: directory, env },
  )
  const release = {
    package: metadata.name,
    version: metadata.version,
    archive,
    sha256: await sha256(archive),
    installed,
    time: new Date().toISOString(),
    files,
    source: log.manifest.source,
    dependencyLock: { path: path.join(directory, "bun.lock"), sha256: await sha256(path.join(directory, "bun.lock")) },
    evidence: log.root,
  }
  await log.write("release.json", release)
  await Bun.write(path.join(packageRoot, "artifacts", "release.json"), JSON.stringify(release, null, 2))
  await log.finish("passed", release)
  console.log(JSON.stringify({ archive, sha256: release.sha256, installed, evidence: log.root }, null, 2))
})().catch(async (error: unknown) => {
  await log.finish("failed", String(error))
  throw error
})
