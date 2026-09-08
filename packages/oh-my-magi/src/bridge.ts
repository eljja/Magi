import type { createOpencodeClient } from "@opencode-ai/sdk"
import type { MagiConfig } from "./config"
import {
  MagiCouncilMembers,
  MagiPrompts,
  normalizeCouncilJudgment,
  normalizeProposalDraft,
  type MagiCouncilJudgment,
  type MagiCouncilMember,
  type MagiProposalDraft,
} from "./council"
import { executeResilientPrompt } from "./resilience"

export type OpencodeClientInstance = ReturnType<typeof createOpencodeClient>

export type MagiBridgeInput = {
  client?: OpencodeClientInstance
  config: MagiConfig
  directory: string
}

export async function askCouncilDraft(input: {
  bridge: MagiBridgeInput
  proposer: MagiCouncilMember
  systemPrompt: string
  userPrompt: string
}): Promise<MagiProposalDraft> {
  const memberModel = resolveMemberModel(input.bridge.config, input.proposer)
  const text = await executeResilientPrompt({
    client: input.bridge.client,
    system: input.systemPrompt,
    prompt: input.userPrompt,
    primaryModel: memberModel,
    fallbackChain: input.bridge.config.resilience.fallbackChain,
    timeoutMs: input.bridge.config.resilience.timeoutMs,
    maxRetries: input.bridge.config.resilience.maxRetries,
    directory: input.bridge.directory,
  })
  if (!text) {
    throw new Error("Council proposer unavailable; no task was authorized")
  }
  const parsed = safeParseJson(text)
  if (typeof parsed.prompt !== "string" || !parsed.prompt.trim() || typeof parsed.title !== "string")
    throw new Error("Invalid council proposal")
  return normalizeProposalDraft(input.proposer, parsed)
}

export async function askCouncilMember(input: {
  bridge: MagiBridgeInput
  member: MagiCouncilMember
  systemPrompt: string
  userPrompt: string
}): Promise<MagiCouncilJudgment> {
  const memberModel = resolveMemberModel(input.bridge.config, input.member)
  const text = await executeResilientPrompt({
    client: input.bridge.client,
    system: input.systemPrompt,
    prompt: input.userPrompt,
    primaryModel: memberModel,
    fallbackChain: input.bridge.config.resilience.fallbackChain,
    timeoutMs: input.bridge.config.resilience.timeoutMs,
    maxRetries: input.bridge.config.resilience.maxRetries,
    directory: input.bridge.directory,
  })
  if (!text) {
    throw new Error(`Council member ${input.member} unavailable; no vote was recorded`)
  }
  const parsed = safeParseJson(text)
  if (!["approve", "revise", "reject"].includes(String(parsed.position)) || typeof parsed.rationale !== "string")
    throw new Error("Invalid council vote")
  return normalizeCouncilJudgment(parsed)
}

export async function deliberateProposal(input: {
  bridge: MagiBridgeInput
  proposer: MagiCouncilMember
  draft: MagiProposalDraft
  roundPromptBuilder: (member: MagiCouncilMember) => string
}): Promise<{ member: MagiCouncilMember; judgment: MagiCouncilJudgment }[]> {
  return Promise.all(
    MagiCouncilMembers.map(async (member) => {
      const judgment = await askCouncilMember({
        bridge: input.bridge,
        member,
        systemPrompt: MagiPrompts[member],
        userPrompt: input.roundPromptBuilder(member),
      })
      return { member, judgment }
    }),
  )
}

function resolveMemberModel(config: MagiConfig, member: MagiCouncilMember): string | undefined {
  if (member === "melchior" && config.council.melchiorModel) return config.council.melchiorModel
  if (member === "balthasar" && config.council.balthasarModel) return config.council.balthasarModel
  if (member === "casper" && config.council.casperModel) return config.council.casperModel
  return config.council.model ?? config.roles.council
}

function safeParseJson(text: string): Record<string, unknown> {
  const cleaned = text.trim()
  try {
    if (cleaned.startsWith("{") && cleaned.endsWith("}")) {
      const parsed = JSON.parse(cleaned)
      if (isRecord(parsed)) return parsed
    }
  } catch {
    /* continue to fallbacks */
  }
  const match = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (match?.[1]) {
    try {
      const parsed = JSON.parse(match[1])
      if (isRecord(parsed)) return parsed
    } catch {
      /* continue */
    }
  }
  const braceMatch = cleaned.match(/\{[\s\S]*\}/)
  if (braceMatch) {
    try {
      const parsed = JSON.parse(braceMatch[0])
      if (isRecord(parsed)) return parsed
    } catch {
      /* give up */
    }
  }
  return {}
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val)
}
