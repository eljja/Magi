import { mkdir, stat } from "node:fs/promises"
import path from "node:path"

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

export async function safeReadFile(file: string): Promise<string | undefined> {
  try {
    if (!(await Bun.file(file).exists())) return undefined
    return await Bun.file(file).text()
  } catch {
    return undefined
  }
}

export async function safeWriteFile(file: string, content: string): Promise<void> {
  await ensureDirectory(path.dirname(file))
  await Bun.write(file, content)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
