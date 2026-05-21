import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, For, Show } from "solid-js"
import { emptyMagiState, magiStatePath, type MagiRuntimeState } from "@magi/core"

const id = "magi-tui"

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
          <b>MAGI</b>
        </text>
        <text fg={props.state().status === "running" ? theme().warning : theme().textMuted}>
          {props.state().status}
        </text>
      </box>
      <text fg={theme().textMuted}>{topic()}</text>
      <box flexDirection="row" gap={1}>
        <For each={members}>
          {(member) => (
            <text fg={dotColor(props.api, props.state().votes[member])}>
              *{memberLabel(member)}
            </text>
          )}
        </For>
      </box>
      <Show when={props.state().selectedPrompt}>
        <text fg={theme().success}>Selected prompt is being injected into OpenCode.</text>
      </Show>
      <For each={events()}>
        {(event) => (
          <box flexDirection="column">
            <text fg={event.position ? dotColor(props.api, event.position) : theme().text}>
              {event.member ? `${event.member.toUpperCase()}: ` : ""}
              {event.title}
            </text>
            <text fg={theme().textMuted}>{event.text.split("\n")[0]}</text>
          </box>
        )}
      </For>
    </box>
  )
}

async function read(directory: string) {
  const file = Bun.file(magiStatePath(directory))
  if (!(await file.exists())) return emptyMagiState()
  return (await file.json()) as MagiRuntimeState
}

const tui: TuiPlugin = async (api) => {
  const [state, setState] = createSignal<MagiRuntimeState>(emptyMagiState())
  const refresh = () => {
    void read(api.state.path.directory || process.cwd()).then(setState)
  }
  refresh()
  const timer = setInterval(refresh, 1000)
  api.lifecycle.onDispose(() => clearInterval(timer))

  api.command.register(() => [
    {
      title: "Show Magi status",
      value: "magi.status",
      description: "Show the current Magi council state. Type /magi to run a cycle.",
      category: "Magi",
      slash: {
        name: "magi-status",
      },
      onSelect: () => {
        api.ui.toast({
          variant: state().status === "error" ? "error" : "info",
          title: "Magi",
          message: state().topic,
          duration: 4000,
        })
      },
    },
  ])

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
  tui,
}

export default plugin
