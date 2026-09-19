import path from "node:path"
import { realpath } from "node:fs/promises"
import { redact } from "./context"

// A shared, fresh file snapshot lets all three identities review actual results
// even without Git. Worker prose alone cannot stand in for artifact contents.
export async function collectArtifactEvidence(directory: string, files: string[]) {
  const root = await realpath(directory)
  return Promise.all(
    [...new Set(files)].slice(0, 20).map(async (name) => {
      const target = await realpath(path.resolve(root, name)).catch(() => undefined)
      const relative = target && path.relative(root, target)
      if (
        !target ||
        !relative ||
        relative === ".." ||
        relative.startsWith(".." + path.sep) ||
        path.isAbsolute(relative)
      )
        return { path: name, error: "Artifact missing or outside the project" }
      const file = Bun.file(target)
      if (file.size > 16 * 1024 * 1024)
        return {
          path: relative,
          error: "Artifact exceeds snapshot size; provide a reproducible check for this artifact",
        }
      const bytes = await file.arrayBuffer().catch(() => undefined)
      if (!bytes) return { path: relative, error: "Artifact could not be read" }
      return {
        path: relative,
        sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
        excerpt: redact(new TextDecoder().decode(bytes.slice(0, 4096))),
        truncated: bytes.byteLength > 4096,
      }
    }),
  )
}
