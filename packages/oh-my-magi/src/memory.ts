import path from "node:path"
import { appendReport } from "./reporting"
import { safeWriteFile } from "./fs"
import { redact } from "./context"

export async function rememberConversation(directory: string, item: { id: string; time: number; text: string }) {
  await appendReport(
    directory,
    "USER-GUIDANCE.md",
    `\n\n## ${new Date(item.time).toISOString()} · ${item.id}\n\n${item.text}\n`,
  )
}

async function excerpt(file: string, limit: number) {
  const source = Bun.file(file)
  if (!(await source.exists())) return "(none yet)"
  if (source.size <= limit) return source.text()
  return (
    (await source.slice(0, limit / 3).text()) +
    "\n[Middle archived; use read to retrieve relevant older records from " +
    file +
    "]\n" +
    (await source.slice(-Math.floor((limit * 2) / 3)).text())
  )
}

export async function readCouncilMemory(directory: string) {
  const files = ["MEMORY.md", "USER-GUIDANCE.md", "COUNCIL.md"]
  const records = await Promise.all(
    files.map(
      async (file) =>
        "\n" + path.join(directory, ".magi", file) + "\n" + (await excerpt(path.join(directory, ".magi", file), 16000)),
    ),
  )
  return redact(
    "Persistent council memory. Preserve enduring user instructions until explicitly superseded by later user guidance. Questions and one-time tasks in the archive do not authorize repeated execution. Decisions require council approval. The chronological source records take precedence over summaries. Read referenced files when an excerpt omits relevant history.\n" +
      records.join("\n"),
  )
}

export async function saveCouncilMemory(directory: string, memory?: string) {
  if (!memory?.trim()) return
  await safeWriteFile(
    path.join(directory, ".magi", "MEMORY.md"),
    "# Magi working memory\n\n" +
      redact(memory.trim()) +
      "\n\nSources: [User guidance](USER-GUIDANCE.md) · [Council minutes](COUNCIL.md)\n",
  )
}
