import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, For, Show } from "solid-js"
import { emptyMagiState, magiStatePath, type MagiRuntimeState } from "./state"
import { setAutonomousLoop } from "./continuation"

const id = "oh-my-magi-tui"

function dotColor(api: TuiPluginApi, position: string | undefined) {
  if (position === "approve") return api.theme.current.success
  if (position === "reject") return api.theme.current.error
  if (position === "revise") return api.theme.current.warning
  return api.theme.current.textMuted
}

function memberLabel(member: string) {
  if (member === "melchior") return "M"
  if (member === "balthasar") return "B"
  if (member === "casper") return "C"
  return "?"
}

function View(props: { api: TuiPluginApi; state: () => MagiRuntimeState }) {
  const theme = () => props.api.theme.current
  const topic = createMemo(() => props.state().topic || "Magi is idle. Type /magi.")
  const events = createMemo(() => props.state().events.slice(-5).toReversed())
  const members = ["melchior", "balthasar", "casper"] as const

  return (
    <box flexDirection="column" gap={1}>
      <box flexDirection="row" gap={1}>
        <text fg={theme().text}>
          <b>OH-MY-MAGI</b>
        </text>
        <text fg={props.state().status === "running" ? theme().warning : theme().textMuted}>
          [{props.state().status}]
        </text>
        <Show when={props.state().loopActive}>
          <text fg={theme().success}>LOOP ACTIVE</text>
        </Show>
        <Show when={props.state().currentCycle > 0}>
          <text fg={theme().textMuted}>#{props.state().currentCycle}</text>
        </Show>
      </box>
      <text fg={theme().textMuted}>{topic()}</text>
      <box flexDirection="row" gap={1}>
        <For each={members}>
          {(member) => (
            <text fg={dotColor(props.api, props.state().votes[member])}>
              ● {member.toUpperCase()}: {props.state().votes[member] ?? "pending"}
            </text>
          )}
        </For>
      </box>
      <Show when={props.state().selectedPrompt}>
        <text fg={theme().success}>✓ Approved prompt injected into session</text>
      </Show>
      <For each={events()}>
        {(event) => (
          <box flexDirection="column">
            <text fg={event.position ? dotColor(props.api, event.position) : theme().text}>
              {event.member ? `[${event.member.toUpperCase()}] ` : ""}
              {event.title}
            </text>
            <text fg={theme().textMuted}>{event.text.split("\n")[0]}</text>
          </box>
        )}
      </For>
    </box>
  )
}

async function read(directory: string): Promise<MagiRuntimeState> {
  const file = Bun.file(magiStatePath(directory))
  if (!(await file.exists())) return emptyMagiState()
  return (await file.json().catch(() => emptyMagiState())) as MagiRuntimeState
}

export const MagiTuiPlugin: TuiPlugin = async (api) => {
  const [state, setState] = createSignal<MagiRuntimeState>(emptyMagiState())

  const refresh = () => {
    void read(api.state.path.directory || process.cwd()).then(setState)
  }
  refresh()
  const timer = setInterval(refresh, 2000)
  api.lifecycle.onDispose(() => clearInterval(timer))

  api.command.register(() => {
    return [
      {
        title: "Show Magi Status",
        value: "magi.status",
        description: "Display current council debate status and active cycle",
        category: "Magi",
        onSelect: () => {
          api.ui.toast({
            variant: state().status === "error" ? "error" : "info",
            title: "Oh-My-Magi",
            message: `[Cycle #${state().currentCycle}] ${state().topic}`,
            duration: 4000,
          })
        },
      },
      {
        title: "Start Magi Autonomous Loop",
        value: "magi.start",
        description: "Turn on continuous autonomous completion loop",
        category: "Magi",
        onSelect: () => {
          void setAutonomousLoop(api.state.path.directory || process.cwd(), true)
          api.ui.toast({
            variant: "success",
            title: "Oh-My-Magi",
            message: "Autonomous loop started.",
            duration: 3000,
          })
          refresh()
        },
      },
      {
        title: "Stop Magi Autonomous Loop",
        value: "magi.stop",
        description: "Immediately halt continuous autonomous loop",
        category: "Magi",
        onSelect: () => {
          void setAutonomousLoop(api.state.path.directory || process.cwd(), false)
          api.ui.toast({
            variant: "info",
            title: "Oh-My-Magi",
            message: "Autonomous loop stopped.",
            duration: 3000,
          })
          refresh()
        },
      },
    ]
  })

  api.slots.register({
    order: 350,
    slots: {
      sidebar_content() {
        return <View api={api} state={state} />
      },
      home_bottom() {
        return <View api={api} state={state} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui: MagiTuiPlugin,
}

export default plugin
