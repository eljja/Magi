import type { AgentConfig } from "@opencode-ai/sdk"

export type AgentMode = "primary" | "subagent" | "all"

export type AgentCategory = "council" | "orchestrator" | "exploration" | "advisor" | "utility" | "artisan"

export type AgentCost = "FREE" | "CHEAP" | "EXPENSIVE"

export interface DelegationTrigger {
  domain: string
  trigger: string
}

export interface AgentPromptMetadata {
  category: AgentCategory
  cost: AgentCost
  promptAlias: string
  keyTrigger?: string
  triggers: DelegationTrigger[]
  useWhen?: string[]
  avoidWhen?: string[]
}

export type AgentFactory = ((model?: string) => AgentConfig) & {
  mode: AgentMode
}

export function isClaudeModel(model?: string): boolean {
  if (!model) return false
  return /claude/i.test(model)
}

export function isGptModel(model?: string): boolean {
  if (!model) return false
  return /gpt|o1|o3|o4|codex/i.test(model)
}

export function isGeminiModel(model?: string): boolean {
  if (!model) return false
  return /gemini/i.test(model)
}

export function isKimiModel(model?: string): boolean {
  if (!model) return false
  return /kimi/i.test(model)
}

export function buildThinkingConfig(model?: string) {
  if (!model || !isClaudeModel(model)) return {}
  if (/opus-4\.[7-9]|opus-5|fable|mythos/i.test(model)) return {}
  return { thinking: { type: "enabled", budgetTokens: 32000 } }
}

export function createToolRestrictions(denyTools: string[] = [], allowTools: string[] = []) {
  const result: Record<string, unknown> = {}
  if (denyTools.length > 0) {
    result.tools = Object.fromEntries(denyTools.map((tool) => [tool, false]))
  }
  if (allowTools.length > 0) {
    result.tools = {
      ...(result.tools as Record<string, unknown> | undefined),
      ...Object.fromEntries(allowTools.map((tool) => [tool, true])),
    }
  }
  return result
}
