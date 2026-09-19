import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, For, Show } from "solid-js"
import { emptyMagiState, readMagiState, type MagiRuntimeState } from "./state"
import { openMagiMonitor } from "./monitor"

const id = "oh-my-magi-tui"

function dotColor(api: TuiPluginApi, position: string | undefined) {
  const theme = api.theme.current
  if (position === "approve") return theme.success
  if (position === "reject") return theme.error
  if (position === "revise") return theme.warning
  return theme.textMuted
}

function memberLabel(member: string) {
  if (member === "melchior") return "M"
  if (member === "balthasar") return "B"
  if (member === "casper") return "C"
  return "?"
}

function View(props: { api: TuiPluginApi; state: () => MagiRuntimeState }) {
  const theme = () => props.api.theme.current
  const topic = createMemo(() => props.state().topic || "Select magi and describe your goal.")
  const events = createMemo(() => props.state().events.slice(-5).toReversed())
  const requests = createMemo(() =>
    Object.entries(props.state().councilActivity ?? {})
      .filter(([, activity]) => activity.status !== "completed")
      .slice(-4),
  )
  const members = ["melchior", "balthasar", "casper"] as const
  const votes = () => props.state().councilOpinions?.votes

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
      <For each={requests()}>
        {([stage, activity]) => (
          <text fg={activity.status === "failed" ? theme().error : theme().textMuted}>
            {stage}: {activity.status} · attempt {activity.attempt}
          </text>
        )}
      </For>
      <text fg={theme().textMuted}>{topic()}</text>
      <text fg={theme().textMuted}>Execution authorization</text>
      <box flexDirection="row" gap={1}>
        <For each={members}>
          {(member) => (
            <text fg={dotColor(props.api, votes()?.[member]?.position ?? props.state().votes[member])}>
              ● {member.toUpperCase()}: {votes()?.[member]?.position ?? props.state().votes[member] ?? "pending"}
            </text>
          )}
        </For>
      </box>
      <For each={members}>
        {(member) => (
          <Show when={votes()?.[member] ?? props.state().councilOpinions?.opening?.[member]}>
            {(opinion) => (
              <text fg={theme().textMuted}>
                [{member.toUpperCase()}] {opinion().rationale}
              </text>
            )}
          </Show>
        )}
      </For>
      <text fg={theme().textMuted}>
        진행 보고: 기본 4시간 / 주요 변화 3인 합의 · 가동 {Math.floor((props.state().reporting?.activeMs ?? 0) / 60000)}
        분
      </text>
      <Show when={props.state().reporting?.latest}>
        <text fg={theme().success}>최근 보고: .magi/LATEST-REPORT.md</text>
      </Show>
      <Show when={props.state().pendingVerification?.review}>
        <text fg={theme().textMuted}>Completion review #{props.state().pendingVerification?.review?.cycle ?? "?"}</text>
        <box flexDirection="row" gap={1}>
          <For each={members}>
            {(member) => (
              <text fg={dotColor(props.api, props.state().pendingVerification?.review?.votes?.[member]?.position)}>
                ● {member.toUpperCase()}:{" "}
                {props.state().pendingVerification?.review?.votes?.[member]?.position ?? "pending"}
              </text>
            )}
          </For>
        </box>
      </Show>
      <Show when={props.state().telemetry && (props.state().telemetry?.toolCallCount ?? 0) > 0}>
        <text fg={theme().textMuted}>
          Workforce: {props.state().telemetry?.toolCallCount} ops | Last: {props.state().telemetry?.lastTool ?? "none"}
          <Show when={(props.state().telemetry?.modifiedFiles.length ?? 0) > 0}>
            {" "}
            | Files: {props.state().telemetry?.modifiedFiles.length}
          </Show>
        </text>
      </Show>
      <Show when={props.state().observations && (props.state().observations?.length ?? 0) > 0}>
        <For each={props.state().observations!.slice(-2).toReversed()}>
          {(obs) => (
            <text fg={obs.member === "balthasar" ? theme().warning : theme().textMuted}>
              👁 [{obs.member.toUpperCase()}]: {obs.observation}
            </text>
          )}
        </For>
      </Show>
      <Show when={props.state().awaitingExecution}>
        <text fg={theme().success}>Approved task awaiting execution / verification</text>
      </Show>
      <Show when={props.state().error}>
        <text fg={theme().error}>{props.state().error}</text>
      </Show>
      <text fg={theme().textMuted}>Minutes: .magi/COUNCIL.md | Monitor: .magi/index.html</text>
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
  try {
    return await readMagiState(directory)
  } catch {
    // Bun.file() may not be available in all runtimes
    return emptyMagiState()
  }
}

export const MagiTuiPlugin: TuiPlugin = async (api) => {
  const [state, setState] = createSignal<MagiRuntimeState>(emptyMagiState())

  const refresh = () => {
    void read(api.state.path.directory || process.cwd())
      .then(setState)
      .catch(() => {
        /* ignore read errors */
      })
  }
  refresh()
  const timer = setInterval(refresh, 2000)
  api.lifecycle.onDispose(() => clearInterval(timer))

  // Also refresh on session status events for faster updates
  const unsubscribe = api.event.on("session.status", refresh)
  api.lifecycle.onDispose(unsubscribe)

  const control = async (command: "resume" | "stop") => {
    const sessionID =
      state().sessionID || (api.route.current.name === "session" ? api.route.current.params?.sessionID : undefined)
    if (typeof sessionID !== "string" || !sessionID) {
      api.ui.toast({ variant: "info", title: "Magi", message: "Select magi in a session and send your goal." })
      return
    }
    if (command === "stop") await api.client.session.abort({ sessionID, directory: api.state.path.directory })
    const result = await api.client.session.command({
      sessionID,
      directory: api.state.path.directory,
      command: "magi",
      arguments: command,
    })
    api.ui.toast({
      variant: result.error ? "error" : "info",
      title: "Magi",
      message: result.error ? "Control request failed. Inspect the session." : "Magi " + command + " request handled.",
    })
    refresh()
  }
  api.keymap.registerLayer({
    commands: [
      {
        name: "magi.monitor",
        namespace: "palette",
        title: "Open Magi Live Monitor",
        category: "Magi",
        async run() {
          await openMagiMonitor(api.state.path.directory || process.cwd()).catch((error) => {
            api.ui.toast({
              variant: "error",
              title: "Magi",
              message: "Open .magi/index.html in a browser: " + String(error),
            })
          })
        },
      },
      {
        name: "magi.status",
        namespace: "palette",
        title: "Show Magi Status",
        category: "Magi",
        run() {
          api.ui.toast({
            variant: "info",
            title: "Magi",
            message: "Cycle #" + state().currentCycle + ": " + state().topic,
          })
        },
      },
      {
        name: "magi.resume",
        namespace: "palette",
        title: "Resume Magi Goal",
        category: "Magi",
        run: () => control("resume"),
      },
      {
        name: "magi.stop",
        namespace: "palette",
        title: "Stop Magi Goal",
        category: "Magi",
        run: () => control("stop"),
      },
    ],
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
