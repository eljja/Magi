import { Tooltip } from "@opencode-ai/ui/tooltip"
import { createMemo, createSignal, onCleanup, onMount, Show, type Component } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"

type MagiVoteState = "pending" | "approve" | "revise" | "reject" | "error"
type MagiPosition = "approve" | "revise" | "reject"

type MagiActivityVote = {
  member: "melchior" | "balthasar" | "casper"
  state: MagiVoteState
  model?: string
  rationale?: string
  detail?: string
  error?: string
}

type MagiActivity = {
  state: "idle" | "debating" | "decided" | "executing" | "error"
  topic: string
  detail: string
  round: number
  decidedAt?: number
  finalPosition?: MagiPosition
  votes: MagiActivityVote[]
}

const voteColor = (state: MagiVoteState) => {
  if (state === "approve") return "#22c55e"
  if (state === "reject" || state === "error") return "#ef4444"
  if (state === "revise") return "#f59e0b"
  return "#8b949e"
}

const decisionColor = (position?: MagiPosition) => {
  if (position === "approve") return "rgba(34, 197, 94, 0.18)"
  if (position === "reject") return "rgba(239, 68, 68, 0.18)"
  if (position === "revise") return "rgba(245, 158, 11, 0.18)"
  return undefined
}

const voteDetail = (vote: MagiActivityVote) =>
  [
    vote.member.toUpperCase(),
    `state: ${vote.state}`,
    vote.model ? `model: ${vote.model}` : undefined,
    vote.detail ?? vote.rationale,
    vote.error ? `error: ${vote.error}` : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")

export const MagiCouncilVoteStatus: Component = () => {
  const globalSDK = useGlobalSDK()
  const [activity, setActivity] = createSignal<MagiActivity>()
  let timer: ReturnType<typeof setInterval> | undefined

  const refresh = () => {
    void globalSDK.client.magi
      .status()
      .then((result) => setActivity(result.data?.activity as MagiActivity | undefined))
      .catch(() => setActivity(undefined))
  }

  onMount(() => {
    refresh()
    timer = setInterval(refresh, 1_000)
  })

  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  const decidedRecently = createMemo(() => {
    const decidedAt = activity()?.decidedAt
    return decidedAt !== undefined && Date.now() - decidedAt < 10_000
  })
  const background = createMemo(() => (decidedRecently() ? decisionColor(activity()?.finalPosition) : undefined))

  return (
    <Show when={activity()} keyed>
      {(item) => (
        <div
          class="hidden lg:flex max-w-[460px] items-center gap-2 rounded-md px-2 py-1 text-12-regular text-text-base transition-colors"
          style={{ "background-color": background() }}
          data-action="magi-council-vote-status"
        >
          <Tooltip placement="bottom" value={[item.detail, `round: ${item.round}`, `state: ${item.state}`].join("\n")}>
            <div class="min-w-0 truncate">{item.topic}</div>
          </Tooltip>
          <div class="flex shrink-0 items-center gap-1 font-mono text-[13px] leading-none">
            {item.votes.map((vote) => (
              <Tooltip placement="bottom" value={voteDetail(vote)}>
                <span style={{ color: voteColor(vote.state) }}>O</span>
              </Tooltip>
            ))}
          </div>
        </div>
      )}
    </Show>
  )
}
