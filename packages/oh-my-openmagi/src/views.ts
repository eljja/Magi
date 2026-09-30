import path from "node:path"
import { mkdir, rename } from "node:fs/promises"
import { members, type State } from "./types"
import type { Store } from "./store"

export function redact(text: string) {
  return text
    .replace(/\b(sk-[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9]{12,})\b/g, "[REDACTED]")
    .replace(/(authorization["'\s:=]+(?:(?:bearer|basic)\s+)?)[^\s"',}]+/gi, "$1[REDACTED]")
}
export async function atomic(file: string, text: string) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = file + "." + crypto.randomUUID() + ".tmp"
  await Bun.write(temporary, text)
  await rename(temporary, file)
}
const line = (text: string) => redact(text.replace(/[\r\n]+/g, " ").replaceAll("|", "¦"))
export function voteBlock(state: State, time: number) {
  return (
    `### 회의 #${state.cycle} · 라운드 ${state.round} · ${new Date(time).toISOString()}\n\n` +
    [
      `주제: ${line(state.topic || "안건 준비 중")}`,
      ...members.map((member) => {
        const vote = state.votes[member]
        const icon = !vote
          ? "대기"
          : vote.position === "approve"
            ? "🟢 찬성"
            : vote.position === "reject"
              ? "🔴 반대"
              : "🟡 보완 요청"
        return `${member.toUpperCase()}: ${vote ? line(vote.summary) : state.opening[member] ? "초기 의견 수신 · 최종 표 대기" : "응답 대기"} — ${icon}`
      }),
    ].join("  \n") +
    `\n\n의결: ${state.decision || "미확정"} · 진행: ${state.phase}\n`
  )
}
const archived = new WeakMap<Store, string>()
const backups = new WeakMap<Store, Promise<void>>()
export async function preserveDocuments(store: Store) {
  const pending = backups.get(store)
  if (pending) return pending
  const saving = preserve(store).finally(() => backups.delete(store))
  backups.set(store, saving)
  return saving
}
async function preserve(store: Store) {
  const state = store.read()
  if (!store.db.query("SELECT id FROM controls WHERE id='openmagi-document-backup'").get()) {
    await Promise.all(
      ["COUNCIL.md", "VOTES.md", "VOTES-LATEST.md", "LATEST-REPORT.md"].map(async (name) => {
        const file = Bun.file(path.join(store.directory, ".magi", name))
        if (await file.exists())
          await atomic(
            path.join(store.directory, ".magi", "backups", "documents-" + state.generation, name),
            await file.text(),
          )
      }),
    )
    store.control("openmagi-document-backup", "Preserved pre-existing project documents before first rendering")
  }
}
export async function writeViews(store: Store) {
  await preserveDocuments(store)
  const state = store.read()
  const records = store.recentMeetings()
  const previous = records.at(-1)?.state
  const preparing =
    (state.phase === "planning" || state.resumePhase === "planning") && Object.keys(state.votes).length > 0
  const displayed = preparing && previous ? { ...previous, phase: state.phase } : state
  await atomic(
    path.join(store.directory, ".magi", "VOTES-LATEST.md"),
    "# Magi 현재 투표\n\n" +
      voteBlock(displayed, Date.now()) +
      (preparing ? "\n위 표는 직전 확정 회의입니다. 다음 안건을 준비하고 있습니다.\n" : "") +
      (state.error ? "\n대기/오류: " + redact(state.error) + "\n" : "") +
      "\n이 파일은 마지막 저장 시점의 상태입니다.\n",
  )
  const archiveKey = String(records.length) + ":" + (records.at(-1)?.id || "")
  const rebuild = archived.get(store) !== archiveKey
  const days = store.meetingDays()
  if (rebuild)
    for (const day of archived.has(store) ? days.slice(-1) : days) {
      const from = Date.parse(day + "T00:00:00.000Z")
      const items = store.meetings(from, from + 86400000)
      await atomic(
        path.join(store.directory, ".magi", "history", day + ".md"),
        items.map((item) => voteBlock(item.state, item.time)).join("\n"),
      )
      await atomic(
        path.join(store.directory, ".magi", "history", day + "-council.md"),
        items
          .map(
            (item) =>
              voteBlock(item.state, item.time) +
              "\n\`\`\`json\n" +
              redact(
                JSON.stringify(
                  {
                    id: item.id,
                    proposal: item.state.proposal,
                    opening: item.state.opening,
                    votes: item.state.votes,
                    progress: item.state.progress.slice(-1),
                  },
                  null,
                  2,
                ),
              ) +
              "\n\`\`\`\n",
          )
          .join("\n"),
      )
    }
  if (rebuild)
    await atomic(
      path.join(store.directory, ".magi", "VOTES.md"),
      "# Magi 투표 이력\n\n최근 200개 회의 · 전체 누적 이력은 날짜별 문서에 보존됩니다.\n\n" +
        days.map((day) => `- [${day}](history/${day}.md)`).join("\n") +
        "\n\n" +
        records.map((item) => voteBlock(item.state, item.time)).join("\n"),
    )
  archived.set(store, archiveKey)
  await atomic(
    path.join(store.directory, ".magi", "COUNCIL.md"),
    "# Magi 상세 회의록\n\n" +
      days.map((day) => `- [${day}](history/${day}-council.md)`).join("\n") +
      "\n\n현재 초기 의견/최종 표:\n\n\`\`\`json\n" +
      redact(
        JSON.stringify({ opening: state.opening, votes: state.votes, progress: state.progress.slice(-8) }, null, 2),
      ) +
      "\n\`\`\`\n",
  )
}
