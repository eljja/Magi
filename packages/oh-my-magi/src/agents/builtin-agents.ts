import type { AgentConfig } from "@opencode-ai/sdk"
import { createMagiAgent } from "./magi"
import { createSisyphusAgent } from "./sisyphus"
import {
  createExploreAgent,
  createLibrarianAgent,
  createOracleAgent,
  createHephaestusAgent,
  createAtlasAgent,
  createMetisAgent,
  createMomusAgent,
  createMultimodalLookerAgent,
} from "./specialists"

export type AgentRoleModels = {
  councilModel?: string
  sisyphusModel?: string
  specialistModel?: string
}

export function createBuiltinAgents(defaultModel?: string, roles?: AgentRoleModels): Record<string, AgentConfig> {
  const councilModel = roles?.councilModel || defaultModel
  const sisyphusModel = roles?.sisyphusModel || defaultModel
  const specialistModel = roles?.specialistModel || defaultModel

  return {
    magi: createMagiAgent(councilModel),
    sisyphus: createSisyphusAgent(sisyphusModel),
    hephaestus: createHephaestusAgent(sisyphusModel),
    atlas: createAtlasAgent(councilModel),
    explore: createExploreAgent(specialistModel),
    librarian: createLibrarianAgent(specialistModel),
    oracle: createOracleAgent(councilModel),
    metis: createMetisAgent(specialistModel),
    momus: createMomusAgent(specialistModel),
    "multimodal-looker": createMultimodalLookerAgent(specialistModel),
  }
}
