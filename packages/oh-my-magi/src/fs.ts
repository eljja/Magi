import { mkdir, stat, writeFile, rename, unlink } from "node:fs/promises"
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

export async function atomicWriteFile(file: string, content: string) {
  await ensureDirectory(path.dirname(file))
  const temporary = file + "." + crypto.randomUUID() + ".tmp"
  await writeFile(temporary, content, "utf8")
  try {
    for (let attempt = 0; ; attempt++) {
      const error = await rename(temporary, file).then(
        () => undefined,
        (error: NodeJS.ErrnoException) => error,
      )
      if (!error) return
      // Windows readers/antivirus may briefly hold the destination. Keep the
      // existing state intact while retrying; never unlink it as a workaround.
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code || "") || attempt >= 20)
        throw error
      await Bun.sleep(Math.min(150, 10 * (attempt + 1)))
    }
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
