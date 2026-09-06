import type { MagiRuntimeConfig } from "./config"

export type MagiJsonSchema = "proposal" | "judgment"

export type MagiLlmResult = {
  model: string
  text: string
  json: unknown
}

type GoogleResponse = {
  candidates?: {
    content?: {
      parts?: {
        text?: string
      }[]
    }
  }[]
}

type OpenAiResponse = {
  choices?: {
    message?: {
      content?: string
    }
  }[]
}

type AnthropicResponse = {
  content?: {
    type?: string
    text?: string
  }[]
}

function defaultApiKeyEnv(provider: string): string[] {
  if (provider === "openai") return ["MAGI_OPENAI_API_KEY", "OPENAI_API_KEY"]
  if (provider === "anthropic") return ["MAGI_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"]
  return ["MAGI_GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"]
}

export async function callMagiJson(input: {
  config: MagiRuntimeConfig
  system: string
  prompt: string
  schema: MagiJsonSchema
  member?: "melchior" | "balthasar" | "casper"
}) {
  if (input.config.council.dryRun) return dryRun(input.schema)

  const memberConfig = input.member ? input.config.council[input.member] : undefined
  const provider = memberConfig?.provider ?? input.config.council.provider
  const model = memberConfig?.model ?? input.config.council.model
  
  if (provider === "opencode") {
    return dryRun(input.schema, "opencode provider selected in standalone mode; using dry-run output.")
  }

  const fallbacks = memberConfig?.fallbacks ?? 
    (provider === input.config.council.provider ? input.config.council.fallbacks : [])

  const apiKeyEnv = memberConfig?.apiKeyEnv ?? defaultApiKeyEnv(provider)
  const endpoint = memberConfig?.endpoint ?? 
    (provider === input.config.council.provider ? input.config.council.endpoint : undefined)

  const key = apiKeyEnv.map((name) => process.env[name]).find((value): value is string => Boolean(value))
  if (!key) return dryRun(input.schema, `No Magi API key env var was set for provider ${provider}; using dry-run output.`)

  const models = [model, ...fallbacks]
  for (const currentModel of models) {
    let result: MagiLlmResult | undefined
    if (provider === "openai") {
      result = await callOpenAi({
        apiKey: key,
        model: currentModel,
        endpoint,
        system: input.system,
        prompt: input.prompt,
        schema: input.schema,
      })
    } else if (provider === "anthropic") {
      result = await callAnthropic({
        apiKey: key,
        model: currentModel,
        endpoint,
        system: input.system,
        prompt: input.prompt,
        schema: input.schema,
      })
    } else {
      result = await callGoogle({
        apiKey: key,
        model: currentModel,
        endpoint,
        system: input.system,
        prompt: input.prompt,
        schema: input.schema,
      })
    }
    if (result) return result
  }
  return dryRun(input.schema, `All Magi LLM calls failed for provider ${provider}; using dry-run output.`)
}

async function callOpenAi(input: {
  apiKey: string
  model: string
  endpoint?: string
  system: string
  prompt: string
  schema: MagiJsonSchema
}): Promise<MagiLlmResult | undefined> {
  try {
    const url = `${input.endpoint ?? "https://api.openai.com/v1"}/chat/completions`
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify({
        model: input.model,
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: `${input.prompt}\n\nReturn only JSON matching this shape:\n${shape(input.schema)}` },
        ],
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
    })
    if (!response.ok) return
    const data = (await response.json()) as OpenAiResponse
    const text = data.choices?.[0]?.message?.content
    if (!text) return
    return { model: input.model, text, json: parseJson(text) }
  } catch {
    return
  }
}

async function callAnthropic(input: {
  apiKey: string
  model: string
  endpoint?: string
  system: string
  prompt: string
  schema: MagiJsonSchema
}): Promise<MagiLlmResult | undefined> {
  try {
    const url = `${input.endpoint ?? "https://api.anthropic.com/v1"}/messages`
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": input.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: input.model,
        system: input.system,
        messages: [
          { role: "user", content: `${input.prompt}\n\nReturn only JSON matching this shape:\n${shape(input.schema)}` },
        ],
        max_tokens: 4000,
        temperature: 0.2,
      }),
    })
    if (!response.ok) return
    const data = (await response.json()) as AnthropicResponse
    const text = data.content?.find((part) => part.type === "text")?.text
    if (!text) return
    return { model: input.model, text, json: parseJson(text) }
  } catch {
    return
  }
}

async function callGoogle(input: {
  apiKey: string
  model: string
  endpoint?: string
  system: string
  prompt: string
  schema: MagiJsonSchema
}): Promise<MagiLlmResult | undefined> {
  const response = await fetch(
    `${input.endpoint ?? "https://generativelanguage.googleapis.com/v1beta"}/models/${input.model}:generateContent?key=${input.apiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: input.system }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: `${input.prompt}\n\nReturn only JSON matching this shape:\n${shape(input.schema)}` }],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
        },
      }),
    },
  )
  if (!response.ok) return
  const data = (await response.json()) as GoogleResponse
  const text = data.candidates?.flatMap((candidate) => candidate.content?.parts ?? []).find((part) => part.text)?.text
  if (!text) return
  return { model: input.model, text, json: parseJson(text) }
}

function parseJson(text: string) {
  const trimmed = text.trim()
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as unknown
  const match = trimmed.match(/\{[\s\S]*\}/)
  if (!match) return {}
  return JSON.parse(match[0]) as unknown
}

function shape(schema: MagiJsonSchema) {
  if (schema === "proposal") {
    return JSON.stringify({
      title: "short task title",
      prompt: "executor prompt to inject into OpenCode",
      rationale: "why this is the next useful improvement",
      requiresCoreSelfEdit: false,
      terminal: false,
    })
  }
  return JSON.stringify({
    position: "approve | revise | reject",
    rationale: "short grounded rationale",
    confidence: 0.75,
    evidence: ["specific evidence"],
    requiredChange: "exact executor prompt or amendment",
    newEvidence: true,
    safetyCritical: false,
  })
}

function dryRun(schema: MagiJsonSchema, reason?: string): MagiLlmResult {
  if (schema === "proposal") {
    const prompt = reason
      ? "Inspect the Magi OpenCode plugin onboarding path and improve the smallest missing piece that makes /magi easier to discover, run, or verify. Keep the change narrow and testable."
      : "Reply with exactly: MAGI_PLUGIN_OK. Do not inspect files, do not edit files, and do not call tools."
    const json = {
      title: reason ? "Improve Magi plugin onboarding" : "Verify Magi plugin injection",
      prompt,
      rationale: reason ?? "Dry-run proposal used for local plugin verification.",
      requiresCoreSelfEdit: false,
      terminal: false,
    }
    return { model: "dry-run", text: JSON.stringify(json), json }
  }
  const json = {
    position: "approve",
    rationale: reason ?? "Dry-run judgment approves the narrow testable improvement.",
    confidence: 0.7,
    evidence: ["The task is small, reversible, and aligned with Magi onboarding."],
    requiredChange: reason
      ? "Inspect the Magi OpenCode plugin onboarding path and improve the smallest missing piece that makes /magi easier to discover, run, or verify. Keep the change narrow and testable."
      : "Reply with exactly: MAGI_PLUGIN_OK. Do not inspect files, do not edit files, and do not call tools.",
    newEvidence: true,
    safetyCritical: false,
  }
  return { model: "dry-run", text: JSON.stringify(json), json }
}
