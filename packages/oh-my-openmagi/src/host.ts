import type { PluginInput } from "@opencode-ai/plugin"
import type { Host, Job } from "./types"

export function modelName(model?: string) {
  if (!model) return undefined
  const slash = model.indexOf("/")
  if (slash < 1 || slash === model.length - 1) throw new Error("Model must be provider/model: " + model)
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
}
export function createHost(client: PluginInput["client"], directory: string, waiting = new Set<string>()): Host {
  const options = () => ({ query: { directory }, signal: AbortSignal.timeout(10000), throwOnError: true as const })
  const messages = async (session: string) =>
    (await client.session.messages({ ...options(), path: { id: session } })).data!
  const sessionInfo = async (session: string) => {
    const response = await client.session.get({ ...options(), throwOnError: false, path: { id: session } })
    if (response.error && response.response.status !== 404) throw new Error(JSON.stringify(response.error))
    return response.data
  }
  const tree = async (session: string) => {
    const ids = new Set<string>()
    const visit = async (id: string): Promise<void> => {
      if (ids.has(id)) return
      ids.add(id)
      const children = (await client.session.children({ ...options(), path: { id } })).data!
      await Promise.all(children.map((child) => visit(child.id)))
    }
    await visit(session)
    return ids
  }
  return {
    async create(title, parent) {
      const exists = parent ? await sessionInfo(parent) : undefined
      return (await client.session.create({ ...options(), body: { title, ...(exists ? { parentID: parent } : {}) } }))
        .data!.id
    },
    async find(title) {
      // Search on the server: the default session listing is capped at 100.
      const query = { directory, search: title }
      return (await client.session.list({ ...options(), query })).data!.find((session) => session.title === title)?.id
    },
    async hasMessage(session, message) {
      const response = await client.session.message({
        ...options(),
        throwOnError: false,
        path: { id: session, messageID: message },
      })
      if (response.error && response.response.status !== 404) throw new Error(JSON.stringify(response.error))
      return response.data?.info.id === message
    },
    async send(job) {
      await client.session.promptAsync({
        ...options(),
        path: { id: job.session! },
        body: {
          messageID: job.message,
          agent: job.agent,
          model: modelName(job.model),
          ...(job.kind === "execution" ? {} : { tools: { "*": false } }),
          parts: [
            { type: "text", text: job.prompt, synthetic: true, metadata: { openmagiOrigin: "job", job: job.id } },
          ],
        },
      })
    },
    async inspect(job: Job) {
      if (!(await sessionInfo(job.session!)))
        return {
          busy: false,
          answered: false,
          text: "",
          evidence: "",
          activity: "deleted",
          error: "Owned session was deleted. Inspect the project before continuing.",
        }
      const [history, statuses, ids] = await Promise.all([
        messages(job.session!),
        client.session.status(options()),
        tree(job.session!),
      ])
      const assistants = history
        .slice(
          Math.max(
            0,
            history.findIndex((item) => item.info.id === job.message),
          ),
        )
        .filter((item) => item.info.role === "assistant")
      const last = assistants.at(-1)
      const tools = assistants.flatMap((item) => item.parts).filter((part) => part.type === "tool")
      const busy = [...ids].some((id) => statuses.data?.[id]?.type !== undefined && statuses.data[id]!.type !== "idle")
      const pending = tools.some((part) => part.state.status === "pending" || part.state.status === "running")
      const text = assistants
        .flatMap((item) => item.parts)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
      const evidence = tools
        .map((part) => JSON.stringify({ tool: part.tool, state: part.state }))
        .join("\n")
        .slice(-32000)
      return {
        busy: busy || pending,
        answered: Boolean(last?.info.role === "assistant" && last.info.time.completed && !pending),
        text,
        evidence,
        activity: JSON.stringify([
          last?.info.id,
          last?.info.time,
          tools.map((part) => part.state),
          text.length,
          [...ids].map((id) => statuses.data?.[id]),
        ]),
        error: last?.info.role === "assistant" && last.info.error ? JSON.stringify(last.info.error) : undefined,
        waiting:
          [...ids].some((id) => waiting.has(id)) ||
          tools.some((part) => part.tool === "question" && ["pending", "running"].includes(part.state.status)),
        settleMs: tools.some((part) => part.tool === "task" && part.state.input.run_in_background === true)
          ? 30000
          : 3000,
      }
    },
    async abort(session) {
      if (!(await sessionInfo(session))) return
      const ids = await tree(session)
      const results = await Promise.allSettled(
        [...ids].reverse().map((id) => client.session.abort({ ...options(), path: { id } })),
      )
      const errors = results.filter((result) => result.status === "rejected")
      if (errors.length)
        throw new AggregateError(
          errors.map((result) => result.reason),
          "Could not confirm abortion of owned jobs",
        )
    },
    async agents() {
      return (await client.app.agents(options())).data!.map((agent) => ({
        name: agent.name,
        mode: agent.mode,
        model: agent.model ? agent.model.providerID + "/" + agent.model.modelID : undefined,
      }))
    },
    async report(owner, report) {
      if (await this.hasMessage(owner, report.id)) return
      await client.session.prompt({
        ...options(),
        path: { id: owner },
        body: {
          messageID: report.id,
          agent: "magi",
          noReply: true,
          parts: [
            {
              id: "prt_" + report.id.slice(4),
              type: "text",
              text: report.text,
              metadata: { openmagiOrigin: "report" },
            },
          ],
        },
      })
    },
  }
}
