import { describe, expect, it } from "bun:test"
import {
  createBuiltinAgents,
  createMagiAgent,
  createSisyphusAgent,
  createExploreAgent,
  createLibrarianAgent,
} from "../src/agents"
import { MagiServerPlugin } from "../src/server"

describe("Magi & OmO Agent System", () => {
  it("creates builtin agents with proper modes and count", () => {
    const agents = createBuiltinAgents()

    expect(agents.magi).toBeDefined()
    expect(agents.sisyphus).toBeDefined()
    expect(agents.hephaestus).toBeDefined()
    expect(agents.atlas).toBeDefined()
    expect(agents.explore).toBeDefined()
    expect(agents.librarian).toBeDefined()
    expect(agents.oracle).toBeDefined()
    expect(agents.metis).toBeDefined()
    expect(agents.momus).toBeDefined()
    expect(agents["multimodal-looker"]).toBeDefined()

    // Execution specialists must be callable through task delegation.
    expect(agents.magi?.mode).toBe("primary")
    expect(agents.sisyphus?.mode).toBe("primary")
    expect(agents.hephaestus?.mode).toBe("subagent")
    expect(agents.atlas?.mode).toBe("subagent")

    // Specialist Subagents
    expect(agents.explore?.mode).toBe("subagent")
    expect(agents.librarian?.mode).toBe("subagent")
    expect(agents.oracle?.mode).toBe("subagent")
    expect(agents.metis?.mode).toBe("subagent")
    expect(agents.momus?.mode).toBe("subagent")
    expect(agents["multimodal-looker"]?.mode).toBe("subagent")
  })

  it("configures Magi Supreme Council prompt with governance and roadmap protocol", () => {
    const magi = createMagiAgent()
    expect(magi.prompt).toContain("MAGI SUPREME COUNCIL")
    expect(magi.prompt).toContain("MELCHIOR-1")
    expect(magi.prompt).toContain("BALTHASAR-2")
    expect(magi.prompt).toContain("CASPER-3")
    expect(magi.prompt).toContain(".magi/ROADMAP.md")
    expect(magi.prompt).toContain("[EXECUTIVE DIRECTIVE FOR SISYPHUS]")
    expect(magi.prompt).toContain("STOP_SELF_IMPROVEMENT")
  })

  it("configures Sisyphus lead execution prompt with milestone completion protocol", () => {
    const sisyphus = createSisyphusAgent()
    expect(sisyphus.prompt).toContain("SISYPHUS - LEAD EXECUTION ORCHESTRATOR")
    expect(sisyphus.prompt).toContain("[MILESTONE_COMPLETE:")
    expect(sisyphus.prompt).toContain("explore")
    expect(sisyphus.prompt).toContain("librarian")
    expect(sisyphus.prompt).toContain("oracle")
  })

  it("enforces tool restrictions on read-only exploration specialists", () => {
    const explore = createExploreAgent()
    const tools = (explore as unknown as { tools: Record<string, boolean> }).tools
    expect(tools.write).toBe(false)
    expect(tools.edit).toBe(false)
    expect(tools.apply_patch).toBe(false)

    const librarian = createLibrarianAgent()
    const libTools = (librarian as unknown as { tools: Record<string, boolean> }).tools
    expect(libTools.write).toBe(false)
    expect(libTools.edit).toBe(false)
  })

  it("config hook registers agents without replacing the user's default", async () => {
    const pluginInstance = await MagiServerPlugin({
      directory: process.cwd(),
    } as unknown as Parameters<typeof MagiServerPlugin>[0])

    const configRecord: Record<string, unknown> = {}
    if (pluginInstance.config) {
      await pluginInstance.config(configRecord)
    }

    expect(configRecord.default_agent).toBeUndefined()
    const registeredAgents = configRecord.agent as Record<string, unknown>
    expect(registeredAgents).toBeDefined()
    expect(registeredAgents.magi).toBeDefined()
    expect(registeredAgents.sisyphus).toBeDefined()
    expect(registeredAgents.hephaestus).toBeDefined()
    expect(registeredAgents.atlas).toBeDefined()
    expect(registeredAgents.explore).toBeDefined()
    expect(registeredAgents.librarian).toBeDefined()
  })

  it("respects user pre-configured default_agent if already set", async () => {
    const pluginInstance = await MagiServerPlugin({
      directory: process.cwd(),
    } as unknown as Parameters<typeof MagiServerPlugin>[0])

    const configRecord: Record<string, unknown> = {
      default_agent: "sisyphus",
    }
    if (pluginInstance.config) {
      await pluginInstance.config(configRecord)
    }

    expect(configRecord.default_agent).toBe("sisyphus")
  })
})
