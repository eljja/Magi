import { Switch } from "@opencode-ai/ui/switch"
import { TextField } from "@opencode-ai/ui/text-field"
import { createMemo, type Component, type JSX } from "solid-js"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"

interface MagiSettingsRowProps {
  title: string | JSX.Element
  description: string | JSX.Element
  children: JSX.Element
}

const MagiSettingsRow: Component<MagiSettingsRowProps> = (props) => {
  return (
    <div class="flex flex-wrap items-center gap-4 py-3 border-b border-border-weak-base last:border-none sm:flex-nowrap">
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="text-14-medium text-text-strong">{props.title}</span>
        <span class="text-12-regular text-text-weak">{props.description}</span>
      </div>
      <div class="flex w-full justify-end sm:w-auto sm:shrink-0">{props.children}</div>
    </div>
  )
}

export const MagiSettingsRows: Component = () => {
  const language = useLanguage()
  const globalSync = useGlobalSync()

  const magi = createMemo(() => globalSync.data.config.magi ?? {})
  const selfImprovement = createMemo(() => magi().selfImprovement ?? {})
  const selfImprovementEnabled = createMemo(() => selfImprovement().enabled ?? selfImprovement().state === "on")
  const executorModel = createMemo(() => magi().models?.executor ?? "")
  const councilModel = createMemo(() => magi().models?.council ?? "")

  const updateMagiModel = (key: "executor" | "council", value: string) => {
    const trimmed = value.trim()
    const current = key === "executor" ? executorModel() : councilModel()
    if (trimmed === current) return
    void globalSync.updateConfig({
      magi: {
        models: {
          [key]: trimmed || undefined,
        },
      },
    })
  }

  const setSelfImprovementEnabled = (enabled: boolean) => {
    if (enabled === selfImprovementEnabled()) return
    void globalSync.updateConfig({
      magi: {
        selfImprovement: {
          enabled,
          state: enabled ? "on" : "off",
          mode: selfImprovement().mode ?? "suggest-and-execute",
          coreSelfEdit: selfImprovement().coreSelfEdit ?? "gated",
        },
      },
    })
  }

  return (
    <>
      <MagiSettingsRow
        title={language.t("settings.general.row.magiExecutorModel.title")}
        description={language.t("settings.general.row.magiExecutorModel.description")}
      >
        <TextField
          data-action="settings-magi-executor-model"
          label={language.t("settings.general.row.magiExecutorModel.title")}
          hideLabel
          defaultValue={executorModel()}
          onBlur={(event: FocusEvent & { currentTarget: HTMLInputElement }) =>
            updateMagiModel("executor", event.currentTarget.value)
          }
          placeholder="openai/gpt-5.2"
          variant="ghost"
          class="w-[220px]"
        />
      </MagiSettingsRow>

      <MagiSettingsRow
        title={language.t("settings.general.row.magiCouncilModel.title")}
        description={language.t("settings.general.row.magiCouncilModel.description")}
      >
        <TextField
          data-action="settings-magi-council-model"
          label={language.t("settings.general.row.magiCouncilModel.title")}
          hideLabel
          defaultValue={councilModel()}
          onBlur={(event: FocusEvent & { currentTarget: HTMLInputElement }) =>
            updateMagiModel("council", event.currentTarget.value)
          }
          placeholder="lmstudio/qwen/qwen3-coder-local"
          variant="ghost"
          class="w-[220px]"
        />
      </MagiSettingsRow>

      <MagiSettingsRow
        title={language.t("settings.general.row.magiSelfImprovement.title")}
        description={language.t("settings.general.row.magiSelfImprovement.description")}
      >
        <div data-action="settings-magi-self-improvement">
          <Switch checked={selfImprovementEnabled()} onChange={setSelfImprovementEnabled} />
        </div>
      </MagiSettingsRow>
    </>
  )
}
