import { mkdir, stat } from "node:fs/promises"

export async function ensureDirectory(directory: string) {
  if (
    await stat(directory)
      .then((entry) => entry.isDirectory())
      .catch(() => false)
  )
    return
  await mkdir(directory, { recursive: true }).catch(async (error: NodeJS.ErrnoException) => {
    // Bun on Windows can report EEXIST for an existing directory with the read-only attribute.
    if (
      error.code === "EEXIST" &&
      (await stat(directory)
        .then((entry) => entry.isDirectory())
        .catch(() => false))
    )
      return
    throw error
  })
}
