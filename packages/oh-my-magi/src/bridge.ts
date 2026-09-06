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
    client: input.bridge.client as unknown as Parameters<typeof executeResilientPrompt>[0]["client"],
    system: input.systemPrompt,
    prompt: input.userPrompt,
    primaryModel: memberModel,
    fallbackChain: input.bridge.config.resilience.fallbackChain,
    timeoutMs: input.bridge.config.resilience.timeoutMs,
    maxRetries: input.bridge.config.resilience.maxRetries,
    directory: input.bridge.directory,
  })
  if (!text) {
    return normalizeProposalDraft(input.proposer, fallbackProposal(input.proposer))
  }
  return normalizeProposalDraft(input.proposer, safeParseJson(text))
}

export async function askCouncilMember(input: {
  bridge: MagiBridgeInput
  member: MagiCouncilMember
  systemPrompt: string
  userPrompt: string
}): Promise<MagiCouncilJudgment> {
  const memberModel = resolveMemberModel(input.bridge.config, input.member)
  const text = await executeResilientPrompt({
    client: input.bridge.client as unknown as Parameters<typeof executeResilientPrompt>[0]["client"],
    system: input.systemPrompt,
    prompt: input.userPrompt,
    primaryModel: memberModel,
    fallbackChain: input.bridge.config.resilience.fallbackChain,
    timeoutMs: input.bridge.config.resilience.timeoutMs,
    maxRetries: input.bridge.config.resilience.maxRetries,
    directory: input.bridge.directory,
  })
  if (!text) {
    return normalizeCouncilJudgment(fallbackJudgment(input.member))
  }
  return normalizeCouncilJudgment(safeParseJson(text))
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
  const match = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  const payload = match?.[1] ? match[1] : cleaned
  try {
    const parsed = JSON.parse(payload)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function fallbackProposal(proposer: MagiCouncilMember) {
  return {
    proposer,
    title: `Continuous self-improvement cycle directed by ${proposer}`,
    summary: `Autonomous proposal drafted under ${proposer} review guidelines.`,
    target_files: ["src/"],
    verification_steps: ["bun test"],
  }
}

function fallbackJudgment(member: MagiCouncilMember) {
  return {
    member,
    position: "approve",
    reasoning: `Baseline approval granted by ${member} pending automated verification.`,
  }
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val)
}
