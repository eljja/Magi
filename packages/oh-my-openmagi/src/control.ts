import type { Store } from "./store"
import { configSchema } from "./config"

export type Control =
  | { type: "stop" | "resume" | "status" | "report-now" | "report-status" }
  | { type: "interval"; ms: number }
  | { type: "invalid"; reason: string }
export function parseControl(text: string, command = false): Control | undefined {
  const value = text
    .trim()
    .replace(/^\/magi\s+/i, "")
    .replace(/[.!。]+$/, "")
    .trim()
  if (
    /^(?:stop|stop working|중지|중단해|정지해|그만해|이제 그만해|멈춰|멈춰줘|멈춰주세요|중지해|중지해줘|작업을?\s*중지해(?:줘)?|magi\s+stop|마기\s*중지)$/i.test(
      value,
    )
  )
    return { type: "stop" }
  if (/^(?:resume|재개|재개해|재개해줘|다시\s*시작해(?:줘)?|계속해(?:줘)?)$/i.test(value)) return { type: "resume" }
  if (/^(?:status|상태)$/i.test(value)) return { type: "status" }
  if (/^(?:report\s+now|지금\s*(?:진행\s*)?상황\s*(?:알려줘|보고해(?:줘)?)|지금\s*보고해(?:줘)?)$/i.test(value))
    return { type: "report-now" }
  if (/^(?:report\s+status|보고\s*간격(?:이?\s*(?:얼마야|어떻게\s*돼))?)$/i.test(value))
    return { type: "report-status" }
  const direct = value.match(/^report\s+interval\s+(\d+(?:\.\d+)?)\s*(m|h|d)$/i)
  const natural =
    /보고/.test(value) &&
    !/["'`“”‘’]/.test(value) &&
    !/(?:하지\s*마|말고|말아|않|아니)/.test(value) &&
    !/[?？]/.test(value) &&
    /(?:보고해|보고해줘|보고해도\s*돼|줄여|늘려|바꿔|설정해|변경해)/.test(value)
      ? value.match(/(\d+(?:\.\d+)?|한|두|세|네|반)\s*(분|시간|일)/)
      : undefined
  const match = direct || natural
  if (match) {
    const number = ({ 한: 1, 두: 2, 세: 3, 네: 4, 반: 0.5 } as Record<string, number>)[match[1]!] ?? Number(match[1])
    const unit = match[2]!.toLowerCase()
    const ms = number * (["m", "분"].includes(unit) ? 60000 : ["h", "시간"].includes(unit) ? 3600000 : 86400000)
    if (!configSchema.shape.reporting.safeParse({ intervalMs: ms }).success)
      return { type: "invalid", reason: "보고 간격은 0보다 크고 31일 이하여야 합니다." }
    return { type: "interval", ms }
  }
  if (/^report\s+interval\b/i.test(value) || natural === null || (command && !/^(start)(?:\s|$)/i.test(value)))
    return {
      type: "invalid",
      reason:
        "사용법: /magi report interval 30m 또는 1h, /magi report now, /magi report status, /magi stop, /magi resume",
    }
}
export function applyControl(store: Store, control: Control, now = Date.now()) {
  if (control.type === "invalid") return control.reason
  if (control.type === "status") return statusText(store)
  if (control.type === "report-status") return reportStatus(store)
  if (control.type === "stop") {
    store.update((state) => ({
      ...state,
      desiredState: "stopped",
      phase: "stopped",
      generation: crypto.randomUUID(),
      retryAt: undefined,
      resumePhase: undefined,
      reporting: { ...state.reporting, nextAt: undefined, manual: false },
    }))
    store.audit("user-stop", {})
    return "Magi를 중지했습니다. 목표와 이력은 보존되며 명시적 재개 전까지 계속 중지됩니다."
  }
  if (control.type === "resume") {
    if (store.read().desiredState === "running") return "이미 운영 중입니다. " + reportStatus(store)
    if (!store.read().goal) return "재개할 목표가 없습니다. Magi에게 목표를 알려주세요."
    store.update((state) => ({
      ...state,
      desiredState: "running",
      phase: "planning",
      generation: crypto.randomUUID(),
      round: state.round + 1,
      opening: {},
      votes: {},
      proposal: undefined,
      decision: undefined,
      error: undefined,
      failures: 0,
      retryAt: undefined,
      resumePhase: undefined,
      reporting: { ...state.reporting, nextAt: now + state.reporting.intervalMs },
    }))
    return "저장된 목표를 재개했습니다. " + reportStatus(store)
  }
  if (control.type === "interval") {
    store.update((state) => ({
      ...state,
      reporting: {
        ...state.reporting,
        intervalMs: control.ms,
        nextAt: state.desiredState === "running" ? now + control.ms : undefined,
      },
    }))
    return "보고 간격을 변경했습니다. " + reportStatus(store)
  }
  store.update((state) => ({ ...state, reporting: { ...state.reporting, manual: true } }))
  return "현재 상황의 즉시 보고를 요청했습니다."
}
export function reportStatus(store: Store) {
  const state = store.read()
  return `보고 간격: ${state.reporting.intervalMs / 60000}분 · 다음 보고: ${state.reporting.nextAt ? new Date(state.reporting.nextAt).toISOString() : "목표 중지 중"}`
}
export function statusText(store: Store) {
  const state = store.read()
  return `목표: ${state.goal || "없음"}\n운영: ${state.desiredState} · 상태: ${state.phase}\n업무: ${state.topic || "없음"}\n회의 #${state.cycle} / 라운드 ${state.round}\n${state.error || ""}\n${reportStatus(store)}`
}
