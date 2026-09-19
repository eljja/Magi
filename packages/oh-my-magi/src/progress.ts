import path from "node:path"
import type { OpencodeClientInstance } from "./bridge"
import { loadMagiConfig } from "./config"
import { MagiCouncilMembers, type MagiDecision } from "./council"
import { redact } from "./context"
import { atomicWriteFile, ensureDirectory } from "./fs"
import { mutateMagiState, readMagiState, type MagiRuntimeState } from "./state"

export async function recordSignificantProgress(directory: string, runID: string, decisions: MagiDecision[]) {
  if (
    !MagiCouncilMembers.every(
      (member) =>
        decisions.filter((vote) => vote.member === member && vote.significantProgress?.evidence.length).length === 1,
    )
  )
    return
  await mutateMagiState(directory, (state) => {
    if (
      !state.loopActive ||
      state.runID !== runID ||
      !state.progress ||
      state.progress.time <= (state.reporting?.lastReportedProgressAt ?? 0)
    )
      return state
    return {
      ...state,
      reporting: {
        activeMs: 0,
        tickAt: Date.now(),
        ...state.reporting,
        significant: {
          progressAt: state.progress.time,
          votes: Object.fromEntries(decisions.map((vote) => [vote.member, vote.significantProgress!])) as Record<
            (typeof MagiCouncilMembers)[number],
            { reason: string; evidence: string[] }
          >,
        },
      },
    }
  })
}

function reportText(state: MagiRuntimeState, reason: "periodic" | "significant", now: number) {
  const reporting = state.reporting!
  return redact(
    [
      `# Magi 자동 진행 보고 · ${reason === "periodic" ? "정기 보고" : "세 인격이 합의한 주요 변화"}`,
      `시각: ${new Date(now).toISOString()}`,
      `목표: ${state.goal}`,
      `목표는 계속 유지됩니다. 완료 승인이나 작업 중지 요청이 아닙니다.`,
      `현재: ${state.topic} · 회의 #${state.currentCycle} · ${state.awaitingExecution ? "OmO 실행 중" : "의회 검토 중"}`,
      `지난 보고 이후 가동 시간: ${Math.floor(reporting.activeMs / 60000)}분 · 도구 작업: ${Math.max(0, (state.telemetry?.toolCallCount ?? 0) - (reporting.lastToolCount ?? 0))}회 · 진행 기록: ${reporting.checkpointCount ?? 0}건`,
      "## 실행 보고와 검사 결과",
      ...(reporting.checkpoints?.length
        ? reporting.checkpoints.map(
            (item) =>
              `- 작업 #${item.cycle}: ${item.summary}\n  검사: ${item.passed ? "통과" : "실패 또는 미설정 — 후속 해결 필요"}\n  산출물: ${item.artifacts.join(", ") || "기록 없음"}`,
          )
        : ["아직 새로운 진행 기록이 없습니다. 도구 호출 수나 경과 시간만으로 성과를 판단하지 않습니다."]),
      (reporting.checkpointCount ?? 0) > (reporting.checkpoints?.length ?? 0)
        ? "최근 24건을 표시합니다. 전체 기록은 COUNCIL.md에 보존됩니다."
        : "",
      ...(reason === "significant" && reporting.significant
        ? [
            "## 세 인격의 보고 근거",
            ...MagiCouncilMembers.map(
              (member) =>
                `${member.toUpperCase()}: ${reporting.significant!.votes[member].reason}\n근거: ${reporting.significant!.votes[member].evidence.join("; ")}`,
            ),
          ]
        : []),
      state.error ? "현재 문제: " + state.error : "",
      ...(state.awaitingExecution
        ? [
            "## 진행 중인 실행",
            `최근 도구: ${state.telemetry?.lastTool ?? "기록 없음"} · 누적 변경 관측 파일: ${state.telemetry?.modifiedFiles.join(", ") || "기록 없음"}`,
            "이 활동은 아직 다음 회의에 넘긴 결과가 아닙니다. 현재 실행을 멈추지 않고 관측된 상태만 보고합니다.",
          ]
        : []),
      "## 다음 진행",
      "실패·미해결 사항과 사용자 대화를 다음 회의에 반영해 같은 목표를 이어갑니다. 질문이나 우선순위 변경은 이 대화에 그대로 말씀해주세요.",
      `감시 페이지: ${path.join(".magi", "index.html")} · 전체 회의록: .magi/COUNCIL.md · 보고 보관: .magi/reports/`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  )
}

// Called independently of model requests. A durable outbox lets delivery retry
// without stopping development or spending another model request on a report.
export async function tickProgressReports(directory: string, client?: OpencodeClientInstance, now = Date.now()) {
  const config = await loadMagiConfig(directory)
  const state = await mutateMagiState(directory, (current) => {
    if (!current.goal) return current
    const previous = current.reporting ?? { activeMs: 0, tickAt: now }
    // Count observed host uptime, excluding pauses and gaps after host shutdown.
    const elapsed =
      current.loopActive && now >= previous.tickAt && now - previous.tickAt <= 60000 ? now - previous.tickAt : 0
    const reporting = {
      ...previous,
      intervalMs: config.reporting.intervalMs,
      tickAt: now,
      activeMs: previous.activeMs + elapsed,
    }
    const reason =
      current.loopActive && (!reporting.latest || reporting.latest.notified)
        ? reporting.significant && reporting.significant.progressAt > (reporting.lastReportedProgressAt ?? 0)
          ? ("significant" as const)
          : reporting.activeMs >= config.reporting.intervalMs
            ? ("periodic" as const)
            : undefined
        : undefined
    if (!reason) return { ...current, reporting }
    const latest = {
      id: "msg_" + now.toString(16) + crypto.randomUUID().replaceAll("-", ""),
      time: now,
      reason,
      text: reportText({ ...current, reporting }, reason, now),
    }
    return {
      ...current,
      reporting: {
        ...reporting,
        activeMs: 0,
        lastReportAt: now,
        lastReportedProgressAt: current.progress?.time ?? reporting.lastReportedProgressAt,
        lastToolCount: current.telemetry?.toolCallCount ?? 0,
        significant: undefined,
        checkpoints: [],
        checkpointCount: 0,
        latest,
      },
    }
  })
  const report = state.reporting?.latest
  if (!report || report.notified) return
  await ensureDirectory(path.join(directory, ".magi", "reports"))
  await atomicWriteFile(path.join(directory, ".magi", "reports", report.id + ".md"), report.text)
  await atomicWriteFile(path.join(directory, ".magi", "LATEST-REPORT.md"), report.text)
  if (config.reporting.notifySession && client && state.sessionID) {
    const current = await readMagiState(directory)
    if (!current.loopActive || current.runID !== state.runID) return
    // Reuse the saved ID and check for a prior delivery after ambiguous failures.
    const existing = await client.session
      .message({
        path: { id: state.sessionID, messageID: report.id },
        query: { directory },
        signal: AbortSignal.timeout(10000),
      })
      .catch(() => undefined)
    if (existing?.data?.info?.id !== report.id) {
      const sent = await client.session
        .prompt({
          path: { id: state.sessionID },
          query: { directory },
          signal: AbortSignal.timeout(10000),
          body: {
            messageID: report.id,
            agent: "magi",
            noReply: true,
            parts: [
              { id: "prt_" + report.id.slice(4), type: "text", text: report.text, metadata: { magiOrigin: "report" } },
            ],
          },
        })
        .catch(() => undefined)
      if (!sent || sent.error) {
        await mutateMagiState(directory, (current) =>
          current.reporting?.latest?.id === report.id
            ? {
                ...current,
                reporting: {
                  ...current.reporting,
                  deliveryError: "대화 보고 전달을 재시도합니다. LATEST-REPORT.md에서 보고를 확인할 수 있습니다.",
                },
              }
            : current,
        )
        return
      }
    }
  } else if (config.reporting.notifySession) return
  await mutateMagiState(directory, (current) =>
    current.reporting?.latest?.id === report.id
      ? {
          ...current,
          reporting: {
            ...current.reporting,
            deliveryError: undefined,
            latest: { ...current.reporting.latest, notified: true },
          },
        }
      : current,
  )
}
