import type { OpencodeClientInstance } from "./bridge"

export type ReviewProgress = {
  status: "requesting" | "completed" | "retrying" | "failed"
  model?: string
  attempt: number
  detail: string
}

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
  agent?: string
  schema?: Record<string, unknown>
  onProgress?: (event: ReviewProgress) => Promise<void>
  onFallback?: (event: { fromModel?: string; toModel?: string; reason: string }) => void
}

const activeReviews = new Map<string, Set<AbortController>>()

export function abortMagiReviews(directory: string) {
  activeReviews.get(directory)?.forEach((controller) => controller.abort())
}

export async function executeResilientPrompt(options: ResilientExecutionOptions): Promise<string | undefined> {
  const controller = new AbortController()
  const active = activeReviews.get(options.directory) ?? new Set<AbortController>()
  active.add(controller)
  activeReviews.set(options.directory, active)
  try {
    return await executeReview({
      ...options,
      signal: AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]),
    })
  } finally {
    active.delete(controller)
    if (!active.size) activeReviews.delete(options.directory)
  }
}

async function executeReview(options: ResilientExecutionOptions): Promise<string | undefined> {
  if (!options.client) return undefined
  const candidates = [...new Set([options.primaryModel || undefined, ...(options.fallbackChain ?? [])])]
  const retries = options.maxRetries ?? 2
  const failure: { configuration?: string; reason?: string } = {}
  for (const [index, model] of candidates.entries()) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (options.signal?.aborted) return undefined
      await options.onProgress?.({
        status: "requesting",
        model,
        attempt: attempt + 1,
        detail: "Waiting for a model decision",
      })
      const response = await attemptSinglePrompt({ ...options, client: options.client, primaryModel: model }).catch(
        (error) => {
          if (!(error instanceof ReviewRequestError)) throw error
          failure.reason = error.message
          failure.configuration = error.configuration ? error.message : undefined
          return undefined
        },
      )
      if (response?.trim()) {
        await options.onProgress?.({
          status: "completed",
          model,
          attempt: attempt + 1,
          detail: "Model decision received",
        })
        return response
      }
      await options.onProgress?.({
        status: "failed",
        model,
        attempt: attempt + 1,
        detail: failure.reason ?? "No final decision returned",
      })
      if (failure.configuration) break
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 4000)))
    }
    if (candidates[index + 1])
      options.onFallback?.({
        fromModel: model,
        toModel: candidates[index + 1],
        reason: "Request failed or timed out after " + (retries + 1) + " attempts",
      })
  }
  if (failure.configuration) throw new Error(failure.configuration)
  if (failure.reason && options.schema) throw new Error(failure.reason)
  return undefined
}

class ReviewRequestError extends Error {
  constructor(
    message: string,
    readonly configuration = false,
  ) {
    super(message)
  }
}

async function attemptSinglePrompt(options: ResilientExecutionOptions & { client: OpencodeClientInstance }) {
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? 60000),
    ...(options.signal ? [options.signal] : []),
  ])
  const created = await options.client.session
    .create({
      query: { directory: options.directory },
      body: { title: "Magi Council (internal) · " + (options.agent ?? "reviewer") },
      signal,
    })
    .catch(() => undefined)
  if (!created?.data?.id) throw new ReviewRequestError("Could not create the isolated review session")
  const path = { id: created.data.id }
  const query = { directory: options.directory }
  try {
    // The plugin client still exposes SDK v1 types. The native >=1.18.29
    // /session/:id/message endpoint supports this SDK v2 format field.
    const body = {
      agent: options.agent ?? "magi-reviewer",
      system:
        options.system +
        (options.schema
          ? "\nSubmit exactly one StructuredOutput tool call with your final decision, then stop. Do not emit multiple or parallel copies of the decision."
          : ""),
      model: parseModel(options.primaryModel),
      parts: [{ type: "text" as const, text: options.prompt }],
      ...(options.schema
        ? {
            format: { type: "json_schema" as const, schema: options.schema, retryCount: 0 },
            tools: { "*": false, StructuredOutput: true },
          }
        : {}),
    }
    const response = await options.client.session
      .prompt({
        path,
        query,
        signal,
        body,
      })
      .catch(() => undefined)
    if (signal.aborted)
      throw new ReviewRequestError(
        "Review request timed out or was cancelled after " + (options.timeoutMs ?? 60000) + " ms",
      )
    if (!response) throw new ReviewRequestError("OpenCode review request failed before a final response")
    const error = response?.data?.info.error ?? response?.error
    if (error) {
      const detail = JSON.stringify(error)
      if (/ProviderAuthError|401|403|invalid.api.key|authentication|unauthorized/i.test(detail))
        throw new ReviewRequestError(
          "Magi configuration required: provider authentication failed. Update OpenCode provider credentials, then resume the goal.",
          true,
        )
      if (/ModelNotFound|model.not.found|unknown.model/i.test(detail))
        throw new ReviewRequestError(
          "Magi configuration required: selected model is unavailable. Update model settings, then resume the goal.",
          true,
        )
      if (/429|rate.limit|quota/i.test(detail))
        throw new ReviewRequestError("Provider rate limit or free-model quota reached (HTTP 429); waiting before retry")
      if (/doom_loop|PermissionDenied|RejectedError|prevents you from using/i.test(detail))
        throw new ReviewRequestError(
          "OpenCode blocked a repeated or disallowed decision tool call. No vote was accepted; retrying a single structured decision with permissions unchanged.",
        )
      if (/StructuredOutput|schema/i.test(detail))
        throw new ReviewRequestError("Model did not return a valid structured decision; no vote or task was authorized")
      throw new ReviewRequestError("OpenCode or the provider rejected the review request; inspect provider logs")
    }
    if (options.schema) {
      const info = response.data?.info as { structured?: unknown } | undefined
      if (info?.structured === undefined)
        throw new ReviewRequestError(
          "OpenCode returned no validated structured decision; check the selected model and OpenCode version",
        )
      return JSON.stringify(info.structured)
    }
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
