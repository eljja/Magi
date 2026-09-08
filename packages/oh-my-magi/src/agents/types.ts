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
  // Provider reasoning settings belong to OpenCode configuration; model names do not define capabilities.
  return {}
}

export function createToolRestrictions(denyTools: string[] = [], allowTools: string[] = []) {
  const result: Record<string, unknown> = {}
  if (denyTools.length > 0) {
    result.tools = Object.fromEntries(denyTools.map((tool) => [tool, false]))
    result.permission = {
      "*": "deny",
      edit: "deny",
      bash: "deny",
      read: "allow",
      glob: "allow",
      grep: "allow",
      webfetch: "allow",
      websearch: "allow",
    }
  }
  if (allowTools.length > 0) {
    result.tools = {
      ...(result.tools as Record<string, unknown> | undefined),
      ...Object.fromEntries(allowTools.map((tool) => [tool, true])),
    }
  }
  return result
}
