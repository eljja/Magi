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
  onFallback?: (event: { fromModel?: string; toModel?: string; reason: string }) => void
}

export async function executeResilientPrompt(options: ResilientExecutionOptions): Promise<string | undefined> {
  const client = options.client
  if (!client) return undefined

  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 60000
  const maxRetries = options.maxRetries && options.maxRetries > 0 ? options.maxRetries : 2
  const fallbackList = options.fallbackChain ?? ["zai/glm-5.2:max", "zai/glm-5.2:pro", "zai/glm-5.2"]

  const candidates: Array<string | undefined> = []
  if (options.primaryModel) candidates.push(options.primaryModel)
  for (const model of fallbackList) {
    if (!candidates.includes(model)) {
      candidates.push(model)
    }
  }
  if (candidates.length === 0) candidates.push(undefined)

  for (let cIdx = 0; cIdx < candidates.length; cIdx++) {
    const currentModel = candidates[cIdx]
    const nextModel = candidates[cIdx + 1]

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const response = await attemptSinglePrompt({
        client,
        system: options.system,
        prompt: options.prompt,
        directory: options.directory,
        model: currentModel,
        timeoutMs,
      })

      if (response && response.trim().length > 0) {
        return response
      }

      if (attempt < maxRetries) {
        await sleep(Math.min(1000 * Math.pow(2, attempt - 1), 4000))
      }
    }

    if (nextModel && options.onFallback) {
      options.onFallback({
        fromModel: currentModel,
        toModel: nextModel,
        reason: `Model ${currentModel ?? "default"} failed or timed out after ${maxRetries} attempts`,
      })
    }
  }

  return undefined
}

async function attemptSinglePrompt(input: {
  client: OpencodeClientInstance
  system: string
  prompt: string
  directory: string
  model?: string
  timeoutMs: number
}): Promise<string | undefined> {
  const sessionRes = await input.client.session
    .create({
      body: { title: "Magi Resilient Deliberation" },
      query: { directory: input.directory },
    })
    .catch(() => undefined)

  const sessionID = sessionRes?.data?.id
  if (!sessionID) return undefined

  const modelPayload = parseModel(input.model)

  const promptPromise = input.client.session.prompt({
    path: { id: sessionID },
    query: { directory: input.directory },
    body: {
      system: input.system,
      tools: {},
      model: modelPayload,
      parts: [{ type: "text", text: input.prompt }],
    },
  })

  const timeoutPromise = new Promise<{ data?: undefined }>((resolve) =>
    setTimeout(() => resolve({ data: undefined }), input.timeoutMs),
  )

  const promptRes = await Promise.race([promptPromise, timeoutPromise]).catch(() => undefined)

  void input.client.session.delete({ path: { id: sessionID } }).catch(() => undefined)

  if (!promptRes?.data?.parts) return undefined

  const textOutput = promptRes.data.parts
    .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
    .join("\n")

  return textOutput.trim().length > 0 ? textOutput : undefined
}

export async function discoverAvailableModels(client?: OpencodeClientInstance): Promise<string[]> {
  const providerClient = client as unknown as {
    provider?: {
      list?: () => Promise<{
        data?: Array<{
          id: string
          connected?: boolean
          models?: Array<{ id: string; name?: string }>
        }>
      }>
    }
  }
  if (!providerClient?.provider?.list) return []
  const listRes = await providerClient.provider.list().catch(() => undefined)
  if (!listRes?.data) return []

  return listRes.data
    .filter((p) => p.connected !== false)
    .flatMap((provider) =>
      (provider.models ?? []).map((m) => `${provider.id}/${m.id}`),
    )
}

function parseModel(model?: string): { providerID: string; modelID: string } | undefined {
  if (!model || !model.includes("/")) return undefined
  const parts = model.split("/")
  return {
    providerID: parts[0] ?? "",
    modelID: parts.slice(1).join("/"),
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
