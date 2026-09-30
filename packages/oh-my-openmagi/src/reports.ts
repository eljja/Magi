import path from "node:path"
import type { Store } from "./store"
import type { Host, State } from "./types"
import { atomic, redact, preserveDocuments } from "./views"

export const messageID = () => "msg_" + Date.now().toString(16) + crypto.randomUUID().replaceAll("-", "")
export function reportText(state: State, now: number) {
  return redact(
    [
      "# Magi 진행 보고",
      "시각: " + new Date(now).toISOString(),
      "목표: " + state.goal,
      `현재: ${state.desiredState} / ${state.phase} · 회의 #${state.cycle}, 라운드 ${state.round}`,
      `업무: ${state.topic || "안건 준비 중"} · 담당: ${state.phase === "executing" ? state.proposal?.executor : "Magi council"}`,
      "최근 의결: " + (state.decision || "아직 미확정"),
      "확인된 실행 기록:",
      ...state.progress
        .filter((item) => item.time > (state.reporting.lastAt || 0))
        .map(
          (item) =>
            `- #${item.cycle}: ${item.summary}\n` +
            (item.checks.length
              ? item.checks
                  .map((check) => `  - ${check.name}: ${check.passed ? "통과" : "실패"} (exit ${check.exitCode})`)
                  .join("\n")
              : "  - 독립 기계 검증 미설정; 실행 에이전트의 보고를 성공 검증으로 간주하지 않습니다."),
        ),
      state.progress.some((item) => item.time > (state.reporting.lastAt || 0))
        ? ""
        : "지난 보고 이후 새로 확인된 실행 결과가 없습니다.",
      state.error ? "장애/대기: " + state.error : "",
      state.presentationError ? "문서 생성 오류(원본 기록 보존): " + state.presentationError : "",
      state.reporting.fileError ? "보고 문서 저장 오류(원본 기록 보존): " + state.reporting.fileError : "",
      state.reporting.deliveryError ? "보고 전달 상태: " + state.reporting.deliveryError : "",
      state.retryAt ? "다음 재시도/재평가: " + new Date(state.retryAt).toISOString() : "",
      "다음 진행: 현재 업무의 근거·검증 결과를 검토하고 원래 목표 안에서 다음 개선을 심의합니다.",
      "다음 정기 보고: " + (state.reporting.nextAt ? new Date(state.reporting.nextAt).toISOString() : "중지 중"),
      "투표: .magi/VOTES-LATEST.md · 누적: .magi/VOTES.md · 상세: .magi/COUNCIL.md",
    ]
      .filter(Boolean)
      .join("\n\n"),
  )
}
export class Reporter {
  private deliveryAt = 0
  private readonly token = crypto.randomUUID()
  private writing = false
  constructor(
    readonly store: Store,
    readonly host: Host,
  ) {}
  async tick(now = Date.now()) {
    if (this.writing || !this.store.lease("reporter", this.token, Date.now(), 20000)) return
    this.writing = true
    await this.run(now).finally(() => {
      this.writing = false
      this.store.release("reporter", this.token)
    })
  }
  private async run(now: number) {
    const state = this.store.read()
    const due = state.desiredState === "running" && Boolean(state.reporting.nextAt && state.reporting.nextAt <= now)
    if (state.goal && (due || state.reporting.manual)) {
      const next = {
        ...state,
        reporting: { ...state.reporting, nextAt: due ? now + state.reporting.intervalMs : state.reporting.nextAt },
      }
      const report = {
        id: messageID(),
        time: now,
        text: reportText(next, now),
        delivered: false,
        owner: state.owner,
        generation: state.generation,
        manual: state.reporting.manual,
      }
      // Saving the outbox and advancing the schedule is one crash-safe transaction.
      this.store.db
        .transaction(() => {
          const fresh = this.store.read()
          if (
            fresh.generation !== state.generation ||
            (!fresh.reporting.manual &&
              !(fresh.desiredState === "running" && fresh.reporting.nextAt && fresh.reporting.nextAt <= now))
          )
            return
          this.store.report(report)
          this.store.update(
            (current) => ({
              ...current,
              reporting: { ...current.reporting, lastAt: now, nextAt: next.reporting.nextAt, manual: false },
            }),
            state.generation,
          )
        })
        .immediate()
    }
    await this.project().catch((error) => {
      this.store.update((state) => ({ ...state, reporting: { ...state.reporting, fileError: redact(String(error)) } }))
    })
    const current = this.store.read()
    const unsent = this.store.reports(true)
    unsent
      .filter((report) => report.generation !== current.generation || report.owner !== current.owner)
      .forEach((report) => this.store.updateReport(report.id, { superseded: true }))
    const pending = unsent.filter(
      (report) => report.generation === current.generation && report.owner === current.owner,
    )
    const latest = pending.at(-1)
    if (!latest) return
    if (!current.owner || now < this.deliveryAt || (current.desiredState === "stopped" && !latest.manual)) return
    this.deliveryAt = now + 30000
    const delivery =
      pending.length > 1
        ? {
            ...latest,
            text:
              latest.text +
              `\n\n연결 공백 동안 저장된 보고 ${pending.length}건을 최신 상황으로 묶었습니다. 전체 기록: .magi/reports/\n`,
          }
        : latest
    await this.host.report(current.owner, delivery).then(
      () => {
        this.store.db
          .transaction(() => pending.forEach((report) => this.store.updateReport(report.id, { delivered: true })))
          .immediate()
        this.store.update(
          (current) => ({ ...current, reporting: { ...current.reporting, deliveryError: undefined } }),
          current.generation,
        )
      },
      (error) => {
        this.store.update(
          (current) => ({
            ...current,
            reporting: { ...current.reporting, deliveryError: redact(String(error)) },
          }),
          current.generation,
        )
      },
    )
  }
  private async project() {
    if (!this.store.latestReport()) return
    await preserveDocuments(this.store)
    for (const report of this.store.reportFiles()) {
      await atomic(path.join(this.store.directory, ".magi", "reports", report.id + ".md"), report.text)
      this.store.updateReport(report.id, { projected: true })
    }
    const latest = this.store.latestReport()!
    const file = path.join(this.store.directory, ".magi", "LATEST-REPORT.md")
    if (
      (await Bun.file(file)
        .text()
        .catch(() => undefined)) !== latest.text
    )
      await atomic(file, latest.text)
    if (this.store.read().reporting.fileError)
      this.store.update((state) => ({ ...state, reporting: { ...state.reporting, fileError: undefined } }))
  }
}
