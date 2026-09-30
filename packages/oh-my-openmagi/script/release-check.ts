import path from "node:path"
import { readdir } from "node:fs/promises"
import assert from "node:assert/strict"
import { packageRoot, releaseIdentity, sourceIdentity } from "./evidence"
import { releaseSoakPassed, type SoakEvidence } from "./soak-policy"

const release = await releaseIdentity()
assert.equal(
  (await sourceIdentity()).sha256,
  release.source?.sha256,
  "Source changed since packing; rerun qualification",
)
const runs = path.join(packageRoot, "artifacts", "runs")
const results = await Promise.all(
  (await readdir(runs, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const file = path.join(runs, entry.name, "result.json")
      if (!(await Bun.file(file).exists())) return undefined
      return (await Bun.file(file).json()) as {
        kind: string
        status: string
        detail?: SoakEvidence & { release?: { sha256: string } }
      }
    }),
)
const passed = results
  .filter((result) => result !== undefined)
  .filter((result) => result.status === "passed" && result.detail?.release?.sha256 === release.sha256)
assert.ok(
  passed.some((result) => result.kind === "qualification"),
  "This exact tarball needs bun run verify",
)
assert.ok(
  passed.some((result) => result.kind === "free-llm-soak" && releaseSoakPassed(result.detail)),
  "This exact tarball still needs a passing real free-LLM 6-hour soak with hourly reports and both recovery checks; fixture tests or short pilots are insufficient",
)
console.log(
  JSON.stringify(
    { readyForNpmAuthenticationAndPublish: true, archive: release.archive, sha256: release.sha256 },
    null,
    2,
  ),
)
