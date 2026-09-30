import { evidence, run, releaseIdentity } from "./evidence"

const log = await evidence("qualification")
await (async () => {
  const checks = await Promise.allSettled([
    run(log, "typecheck", [process.execPath, "run", "typecheck"]),
    run(log, "tests", [process.execPath, "run", "test"]),
  ])
  for (const check of checks) if (check.status === "rejected") throw check.reason
  await run(log, "pack", [process.execPath, "run", "pack:check"])
  await run(log, "audit", [process.execPath, "script/audit.ts"])
  const release = await releaseIdentity()
  for (const version of ["1.18.29", "1.18.31"]) {
    await run(log, "native-" + version, [process.execPath, "run", "smoke"], {
      env: {
        ...process.env,
        OPENMAGI_OPENCODE_VERSION: version,
        OPENMAGI_OPENCODE_BIN: process.env["OPENMAGI_OPENCODE_BIN_" + version.replaceAll(".", "_")],
        OPENMAGI_SMOKE_BACKGROUND: version === "1.18.29" ? "true" : "false",
        OPENMAGI_PLUGIN_PACKAGE: release.installed,
      },
    })
  }
  await log.finish("passed", {
    release: { archive: release.archive, sha256: release.sha256 },
    realLLM6Hours: "not tested by this command",
    platform: process.platform,
  })
  console.log("Local qualification evidence: " + log.root)
})().catch(async (error: unknown) => {
  await log.finish("failed", String(error))
  throw error
})
