import assert from "node:assert/strict"
import path from "node:path"
import { evidence, releaseIdentity, sha256 } from "./evidence"

// npm can acknowledge a publish before that version is publicly downloadable.
// Check anonymously and compare the public bytes with the qualified archive.
const log = await evidence("public-registry")
await (async () => {
  const release = await releaseIdentity()
  const metadata = (await Bun.file(path.join(release.installed, "package.json")).json()) as {
    name: string
    version: string
  }
  assert.equal(metadata.name, "oh-my-magi")
  const integrity =
    "sha512-" + new Bun.CryptoHasher("sha512").update(await Bun.file(release.archive).arrayBuffer()).digest("base64")
  const deadline = Date.now() + 10 * 60 * 1000
  while (true) {
    const response = await fetch(`https://registry.npmjs.org/${metadata.name}/${metadata.version}`, {
      signal: AbortSignal.timeout(30000),
    })
    assert.ok(response.ok || response.status === 404, "Public registry lookup failed: " + response.status)
    if (response.ok) {
      const published = (await response.json()) as {
        name: string
        version: string
        dist: { integrity: string; tarball: string }
      }
      assert.equal(published.name, metadata.name)
      assert.equal(published.version, metadata.version)
      assert.equal(published.dist.integrity, integrity, "Public archive differs from the qualified release")
      assert.equal(new URL(published.dist.tarball).origin, "https://registry.npmjs.org")
      const tags = await fetch(`https://registry.npmjs.org/-/package/${metadata.name}/dist-tags`, {
        signal: AbortSignal.timeout(30000),
      })
      assert.ok(tags.ok, "Could not read public dist-tags")
      if (((await tags.json()) as { latest?: string }).latest === metadata.version) {
        const download = await fetch(published.dist.tarball, { signal: AbortSignal.timeout(60000) })
        assert.ok(download.ok, "Public tarball is not downloadable")
        const archive = path.join(log.root, `${metadata.name}-${metadata.version}.tgz`)
        await Bun.write(archive, await download.arrayBuffer())
        assert.equal(await sha256(archive), release.sha256, "Downloaded archive hash differs")
        await log.finish("passed", { name: metadata.name, version: metadata.version, sha256: release.sha256 })
        console.log(`Public ${metadata.name}@${metadata.version} matches the qualified archive.`)
        return
      }
    }
    if (Date.now() >= deadline)
      throw new Error(`Public ${metadata.name}@${metadata.version} is not ready; do not republish the same version.`)
    log.event("propagation-pending", { version: metadata.version, visible: response.ok })
    await Bun.sleep(15000)
  }
})().catch(async (error: unknown) => {
  await log.finish("failed", String(error))
  throw error
})
