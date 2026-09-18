import type { PluginInput } from "@opencode-ai/plugin"

type ExecutionMessages = NonNullable<Awaited<ReturnType<PluginInput["client"]["session"]["messages"]>>["data"]>

// OmO delivers background results after an idle event and can wake the parent
// several seconds later. That idle gap is not an execution completion boundary.
export async function executionSettled(
  client: PluginInput["client"],
  directory: string,
  owner: string,
  messages: ExecutionMessages,
  now = Date.now(),
) {
  const latest = messages.at(-1)
  if (!latest || latest.info.role !== "assistant" || !latest.info.time.completed) return false
  const background = messages.some((message) =>
    message.parts.some(
      (part) => part.type === "tool" && part.tool === "task" && part.state.input.run_in_background === true,
    ),
  )
  if (!background) return true
  return now - Math.max(latest.info.time.completed, await lastChildActivity(client, directory, owner)) >= 30000
}

async function lastChildActivity(client: PluginInput["client"], directory: string, owner: string): Promise<number> {
  const children = await client.session.children({
    path: { id: owner },
    query: { directory },
    signal: AbortSignal.timeout(10000),
  })
  if (children.error || !children.data) throw new Error("Cannot inspect background execution completion")
  const activity = await Promise.all(
    children.data.map(async (child) =>
      Math.max(child.time.updated, await lastChildActivity(client, directory, child.id)),
    ),
  )
  return Math.max(0, ...activity)
}

export async function isWorkforceSession(
  client: PluginInput["client"],
  directory: string,
  sessionID: string,
  owner: string,
) {
  const seen = new Set<string>()
  for (let id: string | undefined = sessionID; id && !seen.has(id); ) {
    if (id === owner) return true
    seen.add(id)
    const result: { data?: { parentID?: string }; error?: unknown } = await client.session.get({
      path: { id },
      query: { directory },
      signal: AbortSignal.timeout(10000),
    })
    if (result.error) return false
    id = result.data?.parentID
  }
  return false
}

export async function workforceBusy(client: PluginInput["client"], directory: string, owner: string) {
  const result = await client.session.status({ query: { directory } })
  if (result.error) throw new Error("Cannot determine workforce activity")
  const busy = Object.entries(result.data ?? {}).filter(
    ([, status]) => status.type === "busy" || status.type === "retry",
  )
  const descendants = await Promise.all(busy.map(([id]) => isWorkforceSession(client, directory, id, owner)))
  return descendants.some(Boolean)
}

export async function abortWorkforceExecution(client: PluginInput["client"], directory: string, execution: string) {
  const result = await client.session.status({ query: { directory }, signal: AbortSignal.timeout(10000) })
  if (result.error) throw new Error("Cannot inspect stopped workforce sessions")
  const results = await Promise.all(
    Object.entries(result.data ?? {}).map(async ([id, status]) => {
      if (status.type === "idle" || !(await isWorkforceSession(client, directory, id, execution))) return
      return client.session.abort({ path: { id }, query: { directory }, signal: AbortSignal.timeout(10000) })
    }),
  )
  if (results.some((result) => result?.error)) throw new Error("Could not stop a running workforce child")
}
