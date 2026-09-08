import type { AgentConfig } from "@opencode-ai/sdk"
import { createMagiAgent } from "./magi"
import { MagiPrompts } from "../council"
import { buildThinkingConfig } from "./types"

export type AgentRoleModels = {
  councilModel?: string
  melchiorModel?: string
  balthasarModel?: string
  casperModel?: string
}

export function createMelchiorAgent(model?: string): AgentConfig {
  const thinkingConfig = buildThinkingConfig(model)
  return {
    description: "Melchior-1: Council Architect & Scientist. Evaluates theoretical soundness, structural integrity, modularity, and system health.",
    mode: "subagent",
    model,
    temperature: 0.2,
    ...thinkingConfig,
    prompt: `# MELCHIOR-1 (COUNCIL ARCHITECT & SCIENTIST)

${MagiPrompts.melchior}

## Focus Areas:
- System design, architectural decoupling, and modular contracts
- Clean abstractions, type soundness, and code maintainability
- Evaluating proposals from a first-principles theoretical perspective
`,
  }
}

export function createBalthasarAgent(model?: string): AgentConfig {
  const thinkingConfig = buildThinkingConfig(model)
  return {
    description: "Balthasar-2: Council Risk & Flaw Auditor. Holds unilateral safety veto against destructive changes, regressions, or unsafe autonomy.",
    mode: "subagent",
    model,
    temperature: 0.2,
    ...thinkingConfig,
    prompt: `# BALTHASAR-2 (COUNCIL RISK & FLAW AUDITOR)

${MagiPrompts.balthasar}

## Focus Areas:
- Devil's advocate: finding hidden assumptions, edge case failures, and security vulnerabilities
- Regression auditing and test suite verification
- Safety veto: blocking destructive changes or unsafe autonomous loops
`,
  }
}

export function createCasperAgent(model?: string): AgentConfig {
  const thinkingConfig = buildThinkingConfig(model)
  return {
    description: "Casper-3: Council Practical Realist & Human Intent Advocate. Evaluates user value, deliverables, and pragmatic execution.",
    mode: "subagent",
    model,
    temperature: 0.2,
    ...thinkingConfig,
    prompt: `# CASPER-3 (COUNCIL PRACTICAL REALIST)

${MagiPrompts.casper}

## Focus Areas:
- User value, practical deliverables, and usability
- Ensuring real progress toward the user's intent rather than over-engineering
- Balancing Melchior's idealism with pragmatic milestone delivery
`,
  }
}

export function createBuiltinAgents(defaultModel?: string, roles?: AgentRoleModels): Record<string, AgentConfig> {
  const councilModel = roles?.councilModel || defaultModel
  const melchiorModel = roles?.melchiorModel || councilModel
  const balthasarModel = roles?.balthasarModel || councilModel
  const casperModel = roles?.casperModel || councilModel

  return {
    magi: createMagiAgent(councilModel),
    melchior: createMelchiorAgent(melchiorModel),
    balthasar: createBalthasarAgent(balthasarModel),
    casper: createCasperAgent(casperModel),
  }
}
