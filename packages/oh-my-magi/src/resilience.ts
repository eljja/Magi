import type { OpencodeClientInstance } from "./bridge"

export type ResilientExecutionOptions = {
  client?: OpencodeClientInstance
  system: string
  prompt: string
  directory: string
  primaryModel?: string
  fallbackChain?: string[]
  timeoutMs?: number
  maxRetries?: number
  signal?: AbortSignal
  onFallback?: (event: { fromModel?: string; toModel?: string; reason: string }) => void
}

export async function executeResilientPrompt(options: ResilientExecutionOptions): Promise<string | undefined> {
  if (!options.client) return undefined
  const candidates = [...new Set([options.primaryModel || undefined, ...(options.fallbackChain ?? [])])]
  const retries = options.maxRetries ?? 2
  for (const [index, model] of candidates.entries()) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (options.signal?.aborted) return undefined
      const response = await attemptSinglePrompt({ ...options, client: options.client, primaryModel: model })
      if (response?.trim()) return response
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 4000)))
    }
    if (candidates[index + 1])
      options.onFallback?.({
        fromModel: model,
        toModel: candidates[index + 1],
        reason: "Request failed or timed out after " + (retries + 1) + " attempts",
      })
  }
  return undefined
}

async function attemptSinglePrompt(options: ResilientExecutionOptions & { client: OpencodeClientInstance }) {
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? 60000),
    ...(options.signal ? [options.signal] : []),
  ])
  const created = await options.client.session
    .create({
      query: { directory: options.directory },
      body: { title: "Magi Council (internal)" },
      signal,
    })
    .catch(() => undefined)
  if (!created?.data?.id) return undefined
  const path = { id: created.data.id }
  const query = { directory: options.directory }
  try {
    const response = await options.client.session
      .prompt({
        path,
        query,
        signal,
        body: {
          agent: "magi-reviewer",
          system: options.system,
          model: parseModel(options.primaryModel),
          parts: [{ type: "text", text: options.prompt }],
        },
      })
      .catch(() => undefined)
    if (response?.data?.info.error) return undefined
    return response?.data?.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
  } finally {
    // Abort server-side work as well as the HTTP request before deleting the isolated review session.
    await options.client.session.abort({ path, query, signal: AbortSignal.timeout(5000) }).catch(() => undefined)
    await options.client.session.delete({ path, query, signal: AbortSignal.timeout(5000) }).catch(() => undefined)
  }
}

export async function discoverAvailableModels(client?: OpencodeClientInstance): Promise<string[]> {
  if (!client) return []
  const result = await client.provider.list().catch(() => undefined)
  if (!result?.data) return []
  return result.data.all
    .filter((provider) => result.data!.connected.includes(provider.id))
    .flatMap((provider) => Object.values(provider.models).map((model) => provider.id + "/" + model.id))
}

function parseModel(model?: string) {
  if (!model) return undefined
  const slash = model.indexOf("/")
  if (slash <= 0 || slash === model.length - 1) throw new Error("Model must be provider/model: " + model)
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
}
