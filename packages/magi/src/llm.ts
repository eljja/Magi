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

export async function callMagiJson(input: {
  config: MagiRuntimeConfig
  system: string
  prompt: string
  schema: MagiJsonSchema
}) {
  if (input.config.council.dryRun) return dryRun(input.schema)
  const key = apiKey(input.config)
  if (!key) return dryRun(input.schema, "No Magi API key env var was set; using dry-run output.")

  const models = [input.config.council.model, ...input.config.council.fallbacks]
  for (const model of models) {
    const result = await callGoogle({
      apiKey: key,
      model,
      endpoint: input.config.council.endpoint,
      system: input.system,
      prompt: input.prompt,
      schema: input.schema,
    })
    if (result) return result
  }
  return dryRun(input.schema, "All Magi LLM calls failed; using dry-run output.")
}

function apiKey(config: MagiRuntimeConfig) {
  return config.council.apiKeyEnv.map((name) => process.env[name]).find((value): value is string => Boolean(value))
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
