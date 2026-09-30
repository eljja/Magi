import { loadConfig, type Settings } from "./config"
import { applyControl, parseControl, statusText } from "./control"
import type { Store } from "./store"
import { redact } from "./views"

// The caller establishes human-session provenance. Receipt and mutation commit together.
export async function receiveHuman(
  store: Store,
  sessionID: string,
  text: string,
  id: string,
  model?: string,
  command = false,
) {
  const control = parseControl(text, command)
  const goal = text.replace(/^(?:\/magi\s+)?start(?:\s+|$)/i, "").trim()
  const apply = (settings?: Settings): string | undefined =>
    store.db
      .transaction(() => {
        const before = store.read()
        if (before.owner && before.owner !== sessionID && before.desiredState === "running")
          return "다른 대화가 이 프로젝트의 Magi 목표를 운영 중입니다. 기존 대화 또는 CLI에서 중지 후 이 대화에서 시작하세요."
        if (!control && !goal) return "Magi에게 작업 목표를 알려주세요."
        if (!control && before.desiredState === "stopped" && (!before.goal || command) && !settings) return
        if (!store.control(id, text)) return statusText(store)
        if (control) {
          if (control.type === "resume" && before.goal) store.update((state) => ({ ...state, owner: sessionID }))
          return applyControl(store, control)
        }
        if (before.desiredState === "running") {
          if (command)
            return "이미 목표를 운영 중입니다. 새 목표로 바꾸려면 /magi stop 후 /magi start 새 목표를 입력하세요."
          store.update((state) => ({
            ...state,
            guidance: [...state.guidance, { id, text: goal, time: Date.now() }].slice(-100),
          }))
          store.audit("human-guidance", { text: redact(goal) })
          return "대화를 원래 목표의 지침/질문으로 저장했습니다. 질문에는 현재 기록을 근거로 답하고 필요한 지침을 다음 회의에 반영합니다."
        }
        if (before.goal && !command)
          return "저장된 목표는 중지 상태입니다. /magi resume으로 재개하거나 /magi start 새 목표로 시작하세요."
        store.update((state) => ({
          ...state,
          desiredState: "running",
          phase: "planning",
          generation: crypto.randomUUID(),
          goal,
          owner: sessionID,
          model: settings!.council.model || model,
          cycle: 1,
          round: 1,
          topic: "",
          proposal: undefined,
          opening: {},
          votes: {},
          decision: undefined,
          guidance: [],
          progress: [],
          error: undefined,
          failures: 0,
          retryAt: undefined,
          resumePhase: undefined,
          reporting: {
            intervalMs: settings!.reporting.intervalMs,
            nextAt: Date.now() + settings!.reporting.intervalMs,
            manual: false,
          },
        }))
        store.audit("human-start", { goal: redact(goal), owner: sessionID })
        return (
          "목표를 저장하고 Magi council을 시작했습니다. 보고 간격은 " +
          settings!.reporting.intervalMs / 60000 +
          "분입니다. 개별 응답 완료와 무관하게 계속 운영합니다."
        )
      })
      .immediate()
  return apply() ?? apply(await loadConfig(store.directory))!
}
