import type { PluginInput } from "@opencode-ai/plugin"

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
