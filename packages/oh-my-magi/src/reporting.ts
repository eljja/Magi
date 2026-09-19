import path from "node:path"
import { appendFile } from "node:fs/promises"
import { atomicWriteFile, ensureDirectory } from "./fs"
import { redact } from "./context"
import type { MagiRuntimeState } from "./state"

const writes = new Map<string, Promise<unknown>>()
export async function serializeReport<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const key = path.resolve(directory)
  const pending = (writes.get(key) ?? Promise.resolve()).catch(() => undefined).then(action)
  writes.set(key, pending)
  try {
    return await pending
  } finally {
    if (writes.get(key) === pending) writes.delete(key)
  }
}

export async function appendReport(directory: string, filename: string, content: string) {
  await serializeReport(directory, async () => {
    const file = path.join(directory, ".magi", filename)
    await ensureDirectory(path.dirname(file))
    await appendFile(file, redact(content), "utf8")
  })
}

const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

export async function publishReport(directory: string, state: MagiRuntimeState, archive = false) {
  const timestamp = new Date().toISOString()
  const members = ["melchior", "balthasar", "casper"] as const
  const completion = state.pendingVerification?.review
  const opinions = state.councilOpinions ?? state.meeting?.pending
  const vote = (member: (typeof members)[number]) => opinions?.votes?.[member]?.position ?? state.votes[member]
  const phase = !state.loopActive
    ? state.status
    : state.awaitingExecution
      ? state.pendingVerification
        ? "Verification"
        : "Execution"
      : "Council"
  const summary = redact(
    [
      "# Magi progress report",
      "",
      "Updated: " + timestamp,
      "Goal: " + (state.goal ?? "No goal started"),
      `State: ${state.loopActive ? "active" : "stopped"} / ${state.status} · Cycle ${state.currentCycle} · No iteration limit`,
      "Current work: " + state.topic,
      "Current phase: " + phase,
      "Owner session: " + (state.sessionID ?? "none"),
      "OmO execution session: " + (state.executionSessionID ?? "none"),
      "Tool operations (cumulative): " + (state.telemetry?.toolCallCount ?? 0),
      "Last tool activity: " +
        (state.telemetry?.toolCallCount ? new Date(state.telemetry.lastActiveAt).toISOString() : "none"),
      state.error ? "Runtime issue (will retry while active): " + state.error : "",
      state.meeting ? "Completed debate rounds: " + state.meeting.round + " (no round limit)" : "",
      state.retryAt ? "Next retry: " + new Date(state.retryAt).toISOString() : "",
      "## Execution authorization votes",
      ...members.map(
        (member) =>
          `${member.toUpperCase()}: ${vote(member) ?? "pending"}\n독립 의견: ${opinions?.opening?.[member]?.rationale ?? "대기 중"}\n최종 의견: ${opinions?.votes?.[member]?.rationale ?? "대기 중"}\n주요 변화 보고 판단: ${opinions?.votes?.[member]?.significantProgress?.reason ?? "아직 합의하지 않음"}`,
      ),
      "## 사용자 보고",
      "가동 누적: " +
        Math.floor((state.reporting?.activeMs ?? 0) / 60000) +
        "분 · 기본 4시간 또는 세 인격의 주요 변화 합의 시 보고 · 완료 표결 없이 계속 진행",
      state.reporting?.latest
        ? "최근 보고: " + new Date(state.reporting.latest.time).toISOString() + " · LATEST-REPORT.md"
        : "아직 정기/주요 변화 보고가 없습니다.",
      state.reporting?.deliveryError ?? "",
      ...(completion
        ? [
            "## Completion review" + (completion.cycle ? " · cycle " + completion.cycle : ""),
            ...members.map((member) => {
              const vote = completion.votes?.[member]
              return `${member.toUpperCase()}: ${vote?.position ?? "pending"}${vote ? " — " + vote.rationale : ""}`
            }),
          ]
        : []),
      "",
      "## Live council requests (independent from workforce tools)",
      ...Object.entries(state.councilActivity ?? {}).map(
        ([stage, activity]) =>
          `- ${stage}: ${activity.status} · ${activity.model ?? "selected model"} · attempt ${activity.attempt} · ${activity.detail} · updated ${new Date(activity.updatedAt).toISOString()}`,
      ),
      "",
      "## Pending user guidance",
      ...(state.steeringQueue ?? []).map((item) => "- " + item.text),
      "",
      "## Latest council and execution events",
      ...state.events
        .slice(-12)
        .map((event) => `- ${new Date(event.time).toISOString()} ${event.title}: ${event.text}`),
      "",
      "## Workforce telemetry (automatic observations, not LLM judgments)",
      ...(state.observations ?? []).slice(-6).map((item) => "- " + item.observation),
      "",
      "## Intervention",
      "Guide Magi by talking normally in the OpenCode session running this goal. Controls: /magi status · /magi stop · /magi resume",
      "Meeting history: COUNCIL.md · Identity histories: members/ · Memory: MEMORY.md · User history: USER-GUIDANCE.md · Roadmap: ROADMAP.md · Periodic history: reports/",
      "Reports refresh while the OpenCode server is alive. Check the timestamp to detect a stopped host.",
    ]
      .filter(Boolean)
      .join("\n\n"),
  )
  const clean = (text: string) => escape(redact(text))
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="refresh" content="15"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Magi — Goal monitor</title>
<style>*{box-sizing:border-box}body{font:16px/1.6 system-ui;background:#0e1721;color:#e3eaf2;max-width:1100px;margin:32px auto;padding:0 24px}h1{font-size:36px;margin:8px 0}h2{font-size:20px}a{color:#a1d3ff}nav{display:flex;flex-wrap:wrap;gap:20px;margin:24px 0}.muted,small{color:#a8bace}.hero,.card,details{background:#182534;border:1px solid #2b3e51;border-radius:12px;padding:20px;margin:12px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px}.number{font-size:26px;font-weight:650}.badge{color:#9ee9c4}.error{border-left:4px solid #ffbb79}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.6 ui-monospace,monospace}summary{cursor:pointer;font-weight:600}code{color:#c2e1ff}li{margin:8px 0;overflow-wrap:anywhere}footer{margin-top:32px;font-size:13px;color:#a8bace}</style>
<header><small>OH-MY-MAGI / OMO WORKFORCE</small><h1>하나의 목표, 계속되는 연구와 개발.</h1><span class="badge">${state.loopActive ? "● 진행 중" : "○ 중지됨"}</span> · 갱신 ${timestamp}</header>
<nav><a href="COUNCIL.md">전체 회의록</a><a href="ROADMAP.md">목표와 로드맵</a><a href="STATUS.md">상세 상태</a>${state.reporting?.latest ? '<a href="LATEST-REPORT.md">최근 진행 보고</a>' : ""}<a href="reports/">보고 보관함</a></nav>
<section class="hero"><small>PERSISTENT GOAL</small><h2>${clean(state.goal ?? "No goal started")}</h2><p>${clean(state.topic)}</p></section>
<div class="grid"><div class="card"><small>회의 차수</small><div class="number">${state.currentCycle}</div>반복 한도 없음</div><div class="card"><small>도구 작업</small><div class="number">${state.telemetry?.toolCallCount ?? 0}</div>누적 활동 · 성과와는 별개</div><div class="card"><small>현재 단계</small><div class="number">${clean(phase)}</div>${state.awaitingExecution ? "실행 결과와 다음 회의 연결 중" : "다음 진행 방향 논의 중"}</div></div>
${state.error ? `<div class="card error"><h2>Needs attention</h2><p>${clean(state.error)}</p><small>${state.loopActive ? "The controller will retry. You can provide guidance below." : "Resume when ready."}</small></div>` : ""}
<h2>실시간 실행 표결 · Execution authorization votes</h2><p>독립 의견 → 상호 검토 → 최종 표결. 도착한 의견부터 표시하며, 목표 완료를 승인하는 표결이 아닙니다.</p><div class="grid">${members.map((member) => `<div class="card"><small>${member.toUpperCase()}</small><div class="number">${clean(vote(member) ?? "표결 대기")}</div><h3>독립 의견</h3><p>${clean(opinions?.opening?.[member]?.rationale ?? "응답 대기 중")}</p><h3>상호 검토 후 최종 의견</h3><p>${clean(opinions?.votes?.[member]?.rationale ?? "응답 대기 중")}</p><small>주요 변화 보고: ${clean(opinions?.votes?.[member]?.significantProgress?.reason ?? "아직 합의하지 않음")}</small></div>`).join("")}</div>
<section class="card"><h2>사용자 진행 보고</h2><p>기본 4시간 가동 또는 세 인격의 주요 변화 합의 시 보고합니다. 보고 때문에 개발을 중지하거나 완료 승인을 기다리지 않습니다.</p><p>지난 보고 이후 가동: ${Math.floor((state.reporting?.activeMs ?? 0) / 60000)}분</p>${state.reporting?.latest ? `<h3>${state.reporting.latest.reason === "significant" ? "세 인격이 합의한 주요 변화" : "정기 보고"}</h3><pre>${clean(state.reporting.latest.text)}</pre>` : "<p>아직 보고 시점이 아닙니다. 회의와 활동은 이 페이지에서 계속 확인할 수 있습니다.</p>"}${state.reporting?.deliveryError ? `<p>${clean(state.reporting.deliveryError)}</p>` : ""}</section>
${completion ? `<h2>Completion review${completion.cycle ? " · cycle " + completion.cycle : ""}</h2><div class="grid">${members.map((member) => `<div class="card"><small>${member.toUpperCase()}</small><div class="number">${clean(completion.votes?.[member]?.position ?? "Pending")}</div><p>${clean(completion.votes?.[member]?.rationale ?? "Awaiting independent final vote")}</p></div>`).join("")}</div>` : ""}
<h2>Live council requests</h2><div class="grid">${
    Object.entries(state.councilActivity ?? {})
      .map(
        ([stage, activity]) =>
          `<div class="card"><small>${clean(stage)}</small><p>${clean(activity.status)} · attempt ${activity.attempt}</p><p>${clean(activity.detail)}</p><small>${clean(activity.model ?? "Selected model")} · ${new Date(activity.updatedAt).toISOString()}</small></div>`,
      )
      .join("") || "<p>No decision requests yet.</p>"
  }</div>
<h2>Latest decisions and results</h2>${state.events
    .slice(-8)
    .toReversed()
    .map(
      (event) =>
        `<details><summary>${clean(event.title)}</summary><small>${new Date(event.time).toISOString()}</small><pre>${clean(event.text)}</pre></details>`,
    )
    .join("")}
<section class="card"><h2>Workforce activity</h2><small>Automatic telemetry. Council judgments appear in the meeting minutes.</small><ul>${
    (state.observations ?? [])
      .slice(-4)
      .map((item) => `<li>${clean(item.observation)}</li>`)
      .join("") || "<li>No tool activity recorded yet.</li>"
  }</ul></section>
<section class="card"><h2>Talk to Magi</h2><p>Talk normally in the OpenCode session running this goal. Your guidance goes to the next council meeting. Questions remain questions.</p><pre>Prioritize reproducibility before new experiments.\nWhy did you choose this approach?</pre><p>Controls: /magi status · /magi stop · /magi resume</p><h3>Pending conversation &amp; guidance</h3><ul>${(state.steeringQueue ?? []).map((item) => `<li>${clean(item.text)}</li>`).join("") || "<li>No pending guidance.</li>"}</ul></section>
<footer>Refreshes every 15 seconds while the OpenCode server is alive. A stale timestamp means reporting has stopped. Decisions and reports remain in .magi/. This local page does not send commands or data to external services.</footer></html>`
  await serializeReport(directory, async () => {
    await ensureDirectory(path.join(directory, ".magi"))
    for (const [name, content] of [
      ["STATUS.md", summary],
      ["index.html", html],
    ]) {
      const target = path.join(directory, ".magi", name!)
      await atomicWriteFile(target, content!)
    }
    if (archive) {
      await ensureDirectory(path.join(directory, ".magi", "reports"))
      await appendFile(
        path.join(directory, ".magi", "reports", timestamp.slice(0, 10) + ".md"),
        summary + "\n\n---\n\n",
        "utf8",
      )
    }
  })
}
