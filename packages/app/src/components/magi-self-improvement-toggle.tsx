import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { createEffect, createMemo, type Component } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"

const showRequestError = (language: ReturnType<typeof useLanguage>, err: unknown) => {
  showToast({
    variant: "error",
    title: language.t("common.requestFailed"),
    description: err instanceof Error ? err.message : String(err),
  })
}

export const MagiSelfImprovementToggle: Component = () => {
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const language = useLanguage()
  let running = false

  const state = createMemo(() => {
    const self = globalSync.data.config.magi?.selfImprovement
    if (self?.state) return self.state
    return self?.enabled ? "on" : "off"
  })
  const enabled = createMemo(() => state() === "on")
  const label = createMemo(() => {
    if (state() === "paused") return language.t("magi.selfImprovement.toggle.paused")
    return language.t(enabled() ? "magi.selfImprovement.toggle.on" : "magi.selfImprovement.toggle.off")
  })

  const runSelfImprovement = () => {
    if (running) return
    running = true
    void globalSDK.client.magi
      .selfImproveAsync({
        recentWork: "Self Improvement is enabled from the Magi UI toggle.",
      })
      .catch((err: unknown) => showRequestError(language, err))
      .finally(() => {
        running = false
      })
  }

  createEffect(() => {
    if (!enabled()) return
    runSelfImprovement()
  })

  const toggle = () => {
    const next = !enabled()
    void globalSync
      .updateConfig({
        magi: {
          selfImprovement: {
            enabled: next,
            state: next ? "on" : "off",
            mode: globalSync.data.config.magi?.selfImprovement?.mode ?? "suggest-and-execute",
            coreSelfEdit: globalSync.data.config.magi?.selfImprovement?.coreSelfEdit ?? "gated",
          },
        },
      })
      .then(() => {
        showToast({
          variant: "success",
          icon: next ? "brain" : "stop",
          title: language.t(next ? "magi.selfImprovement.toast.on.title" : "magi.selfImprovement.toast.off.title"),
          description: language.t(
            next ? "magi.selfImprovement.toast.on.description" : "magi.selfImprovement.toast.off.description",
          ),
        })
      })
      .catch((err: unknown) => showRequestError(language, err))
  }

  return (
    <Tooltip placement="bottom" value={label()}>
      <Button
        variant="ghost"
        class="group/magi-self-improvement titlebar-icon w-8 h-6 p-0 box-border shrink-0"
        classList={{
          "text-icon-strong": enabled(),
        }}
        onClick={toggle}
        aria-label={label()}
        aria-pressed={enabled()}
        data-action="magi-self-improvement-toggle"
      >
        <Icon size="small" name={enabled() ? "brain" : "stop"} />
      </Button>
    </Tooltip>
  )
}
