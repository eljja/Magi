import assert from "node:assert/strict"

export type FreeModel = {
  id: string
  pricing: Record<string, string>
  supported_parameters?: string[]
  context_length: number
}
export function verifiedFreeModel(model: FreeModel) {
  return (
    (model.id === "openrouter/free" || (model.id.endsWith(":free") && !model.id.startsWith("openrouter/auto"))) &&
    model.pricing.prompt !== undefined &&
    model.pricing.completion !== undefined &&
    Object.values(model.pricing).every((value) => value.trim() !== "" && Number(value) === 0) &&
    Boolean(model.supported_parameters?.includes("tools"))
  )
}

export function enduranceRequestInterval(durationMs: number, maxRequests: number) {
  assert.ok(Number.isFinite(durationMs) && durationMs > 0)
  assert.ok(Number.isSafeInteger(maxRequests) && maxRequests > 0)
  // Spread the finite free allowance across the run, reserving 10% for timing overhead.
  return Math.max(6000, Math.ceil(durationMs / (maxRequests * 0.9)))
}

export async function freeRouter(options: {
  key: string
  models: string[]
  maxRequests: number
  minIntervalMs?: number
  event: (kind: string, data: unknown) => void
  // Only loopback endpoints are accepted here for offline regression tests.
  testEndpoint?: string
}) {
  assert.ok(
    options.key && options.models.length && Number.isSafeInteger(options.maxRequests) && options.maxRequests > 0,
  )
  const base = options.testEndpoint || "https://openrouter.ai/api/v1"
  if (options.testEndpoint) assert.equal(new URL(base).hostname, "127.0.0.1")
  const token = crypto.randomUUID()
  const state = {
    requests: 0,
    responses: 0,
    nextAt: 0,
    retryAt: 0,
    closed: false,
    violation: "",
    usage: [] as { id?: string; model?: string; promptTokens?: number; completionTokens?: number; cost?: number }[],
  }
  const catalog = { time: 0, data: [] as FreeModel[] }
  const refresh = async () => {
    if (Date.now() - catalog.time < 300000) return
    // Search the live catalog for each permitted ID instead of downloading every model.
    // Search is approximate; exact identity and all zero-price checks remain mandatory.
    catalog.data = await Promise.all(
      options.models.map(async (id) => {
        const response = await fetch(base + "/models?" + new URLSearchParams({ q: id, limit: "10" }), {
          signal: AbortSignal.timeout(20000),
          redirect: "error",
        })
        assert.ok(response.ok, "Unable to verify current free-model pricing")
        const value = (await response.json()) as { data: FreeModel[] }
        const model = value.data.find((model) => model.id === id)
        assert.ok(model && verifiedFreeModel(model), "Model is not a verified free tool model: " + id)
        return model
      }),
    )
    catalog.time = Date.now()
    options.event("free-pricing-verified", { models: catalog.data, time: catalog.time })
  }
  await refresh()
  const defer = (status: number, retryAfter: string | null = null) => {
    if (status !== 429 && !(status >= 500 && status <= 599)) return
    const delay = retryAfter
      ? Number.isFinite(Number(retryAfter))
        ? Number(retryAfter) * 1000
        : Date.parse(retryAfter) - Date.now()
      : 60000
    state.retryAt = Math.max(state.retryAt, Date.now() + Math.max(60000, Number.isFinite(delay) ? delay : 60000))
    options.event(status === 429 ? "provider-quota-wait" : "provider-overload-wait", { status, retryAt: state.retryAt })
  }
  const record = (data: unknown) => {
    if (!data || typeof data !== "object") return
    const value = data as {
      id?: string
      model?: string
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }
      error?: unknown
    }
    if (value.error) {
      options.event("provider-stream-error", { error: value.error })
      if (typeof value.error === "object") defer(Number(Reflect.get(value.error, "code")))
    }
    if (!value.usage) return
    const usage = {
      id: value.id,
      model: value.model,
      promptTokens: value.usage.prompt_tokens,
      completionTokens: value.usage.completion_tokens,
      cost: value.usage.cost,
    }
    state.usage.push(usage)
    options.event("provider-usage", usage)
    if (usage.cost !== undefined && (!Number.isFinite(usage.cost) || usage.cost !== 0)) {
      state.violation = "Provider reported non-zero or invalid cost"
      state.closed = true
      options.event("free-policy-violation", { reason: state.violation })
    }
  }
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 255,
    maxRequestBodySize: 4 * 1024 * 1024,
    async fetch(request) {
      if (request.headers.get("authorization") !== "Bearer " + token)
        return new Response("Unauthorized", { status: 401 })
      if (new URL(request.url).pathname !== "/v1/chat/completions" || request.method !== "POST")
        return new Response("Not found", { status: 404 })
      if (state.closed || state.requests >= options.maxRequests)
        return Response.json(
          { error: { message: "Audit request limit or stop reached" } },
          { status: 429, headers: { "retry-after": "3600" } },
        )
      return (async () => {
        const body = (await request.json()) as Record<string, unknown>
        if (typeof body.model !== "string" || !options.models.includes(body.model))
          return Response.json(
            { error: { message: "Only explicitly allowed free models are permitted" } },
            { status: 403 },
          )
        // Never forward paid routing, plugins, server tools or modality options.
        if (body.models || body.plugins || body.route || body.modalities || body.web_search_options)
          return Response.json(
            { error: { message: "Paid or alternative routing features are forbidden" } },
            { status: 403 },
          )
        if (!Array.isArray(body.messages))
          return Response.json({ error: { message: "messages required" } }, { status: 400 })
        if (
          (body.messages as unknown[]).some((message) => {
            if (!message || typeof message !== "object") return true
            const content: unknown = Reflect.get(message, "content")
            return (
              Array.isArray(content) &&
              (content as unknown[]).some(
                (part) => !part || typeof part !== "object" || Reflect.get(part, "type") !== "text",
              )
            )
          })
        )
          return Response.json({ error: { message: "Text-only audit" } }, { status: 403 })
        if (Date.now() < state.retryAt)
          return Response.json(
            { error: { message: "Waiting for the free provider retry window" } },
            { status: 429, headers: { "retry-after": String(Math.ceil((state.retryAt - Date.now()) / 1000)) } },
          )
        await refresh()
        const wait = Math.max(0, state.nextAt - Date.now())
        state.nextAt = Date.now() + wait + (options.minIntervalMs ?? 6000)
        if (wait) await Bun.sleep(wait)
        if (request.signal.aborted || state.closed || state.requests >= options.maxRequests)
          return new Response("Stopped before dispatch", { status: 429, headers: { "retry-after": "3600" } })
        if (Date.now() < state.retryAt)
          return new Response("Waiting for free provider retry window", {
            status: 429,
            headers: { "retry-after": String(Math.ceil((state.retryAt - Date.now()) / 1000)) },
          })
        const allowed = [
          "model",
          "messages",
          "tools",
          "tool_choice",
          "temperature",
          "top_p",
          "stop",
          "response_format",
          "presence_penalty",
          "frequency_penalty",
          "seed",
          "parallel_tool_calls",
          "reasoning",
        ]
        const forwarded = {
          ...Object.fromEntries(allowed.filter((key) => body[key] !== undefined).map((key) => [key, body[key]])),
          stream: body.stream === true,
          max_tokens: Math.min(
            typeof body.max_tokens === "number" && body.max_tokens > 0 ? body.max_tokens : 8192,
            16384,
          ),
          provider: { max_price: { prompt: 0, completion: 0, request: 0, image: 0 }, allow_fallbacks: false },
          usage: { include: true },
          ...(body.stream === true ? { stream_options: { include_usage: true } } : {}),
        }
        state.requests++
        const number = state.requests
        const started = Date.now()
        options.event("provider-request", {
          number,
          model: body.model,
          freePriceCeiling: 0,
          started,
          inputBytes: JSON.stringify(body.messages).length,
        })
        const response = await fetch(base + "/chat/completions", {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(240000)]),
          headers: {
            authorization: "Bearer " + options.key,
            "content-type": "application/json",
            "X-OpenRouter-Title": "OpenMagi free-only qualification",
          },
          body: JSON.stringify(forwarded),
        })
        state.responses++
        options.event("provider-response", { number, status: response.status, elapsedMs: Date.now() - started })
        defer(response.status, response.headers.get("retry-after"))
        if (!response.ok)
          return new Response(await response.text(), {
            status: response.status,
            headers: {
              "content-type": "application/json",
              "retry-after": String(Math.max(60, Math.ceil((state.retryAt - Date.now()) / 1000))),
            },
          })
        if (!body.stream) {
          const json: unknown = await response.json()
          record(json)
          return Response.json(json)
        }
        const decoder = new TextDecoder()
        let pending = ""
        const observe = (text: string) => {
          pending += text
          const lines = pending.split("\n")
          pending = lines.pop() || ""
          for (const line of lines) {
            if (!line.startsWith("data:") || line.trim() === "data: [DONE]") continue
            const payload: unknown = JSON.parse(line.slice(5))
            record(payload)
          }
          if (pending.length > 4 * 1024 * 1024) throw new Error("Provider stream frame exceeded audit limit")
        }
        return new Response(
          response.body!.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                observe(decoder.decode(chunk, { stream: true }))
                controller.enqueue(chunk)
              },
              flush() {
                observe(decoder.decode() + "\n")
              },
            }),
          ),
          { headers: { "content-type": "text/event-stream" } },
        )
      })().catch((error: unknown) => {
        options.event("proxy-error", { error: String(error) })
        return Response.json(
          { error: { message: "Free-only audit gateway unavailable; no paid fallback" } },
          { status: 503, headers: { "retry-after": "60" } },
        )
      })
    },
  })
  return {
    url: proxy.url.toString() + "v1",
    token,
    state,
    models: catalog.data,
    stop() {
      state.closed = true
      proxy.stop(true)
    },
  }
}
