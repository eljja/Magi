import path from "node:path"
import assert from "node:assert/strict"
import { evidence, releaseIdentity, run } from "./evidence"

const log = await evidence("dependency-audit")
await (async () => {
  const release = await releaseIdentity()
  const directory = path.dirname(path.dirname(release.installed))
  const result = await run(log, "audit", [process.execPath, "audit", "--json"], { cwd: directory, allowFailure: true })
  assert.ok(result.code === 0 || result.code === 1, "Dependency audit did not complete")
  const data: unknown = JSON.parse(result.stdout)
  assert.ok(data && typeof data === "object" && !Array.isArray(data), "Registry did not return advisory data")
  await log.write("advisories.json", data)
  await run(log, "dependency-tree", [process.execPath, "pm", "ls", "--all"], { cwd: directory })
  const entries = Object.entries(data).flatMap(([name, value]) => {
    assert.ok(Array.isArray(value), "Invalid advisory list for " + name)
    return value.map((advisory: unknown) => {
      assert.ok(advisory && typeof advisory === "object", "Invalid advisory")
      return { name, severity: String(Reflect.get(advisory, "severity")), url: String(Reflect.get(advisory, "url")) }
    })
  })
  assert.ok(result.code === 0 || entries.length > 0, "Audit failed without advisory results")
  const unexpected = entries.filter(
    (item) =>
      !(
        item.name === "@babel/core" &&
        item.severity === "low" &&
        item.url === "https://github.com/advisories/GHSA-4x5r-pxfx-6jf8"
      ),
  )
  assert.equal(unexpected.length, 0, "Unreviewed advisories: " + JSON.stringify(unexpected))
  const detail = {
    release: { sha256: release.sha256, archive: release.archive, installed: release.installed },
    advisories: entries,
    disposition: entries.length ? "Known upstream Low exception remains unpatched" : "No registry advisories returned",
    reachability: "This registry check does not establish absence of runtime exploit paths",
    enforcement: "Fails this audit command on new advisories; not a guarantee against unknown vulnerabilities",
  }
  await log.finish("passed", detail)
  console.log(JSON.stringify({ ...detail, evidence: log.root }, null, 2))
})().catch(async (error: unknown) => {
  await log.finish("failed", String(error))
  throw error
})
