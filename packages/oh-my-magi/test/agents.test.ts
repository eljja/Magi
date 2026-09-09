import { describe, expect, it } from "bun:test"
import {
  createBuiltinAgents,
  createMagiAgent,
  createMelchiorAgent,
  createBalthasarAgent,
  createCasperAgent,
} from "../src/agents"
import { MagiServerPlugin } from "../src/server"

describe("Magi Supreme Council Pure Governor System", () => {
  it("creates Supreme Council agents (magi, melchior, balthasar, casper)", () => {
    const agents = createBuiltinAgents()

    expect(agents.magi).toBeDefined()
    expect(agents.melchior).toBeDefined()
    expect(agents.balthasar).toBeDefined()
    expect(agents.casper).toBeDefined()

    // Magi is the primary orchestrator, members are subagents
    expect(agents.magi?.mode).toBe("primary")
    expect(agents.melchior?.mode).toBe("subagent")
    expect(agents.balthasar?.mode).toBe("subagent")
    expect(agents.casper?.mode).toBe("subagent")

    // Workforce clones are removed; OMM expects OmO to supply sisyphus and specialist subagents
    expect(agents.sisyphus).toBeUndefined()
    expect(agents.explore).toBeUndefined()
    expect(agents.librarian).toBeUndefined()
  })

  it("configures Magi Supreme Council prompt with governance protocol", () => {
    const magi = createMagiAgent()
    expect(magi.prompt).toContain("MAGI SUPREME COUNCIL")
    expect(magi.prompt).toContain("MELCHIOR-1")
    expect(magi.prompt).toContain("BALTHASAR-2")
    expect(magi.prompt).toContain("CASPER-3")
    expect(magi.prompt).toContain(".magi/ROADMAP.md")
  })

  it("configures Melchior, Balthasar, and Casper with distinct focus areas", () => {
    const melchior = createMelchiorAgent()
    expect(melchior.description).toContain("Architect & Scientist")

    const balthasar = createBalthasarAgent()
    expect(balthasar.description).toContain("Risk & Flaw Auditor")
    expect(balthasar.description).toContain("veto")

    const casper = createCasperAgent()
    expect(casper.description).toContain("Practical Realist")
  })

  it("config hook registers Council agents without replacing the user's default", async () => {
    const pluginInstance = await MagiServerPlugin({
      directory: process.cwd(),
      client: {
        session: {
          status: async () => ({ data: {} }),
          abort: async () => ({}),
          promptAsync: async () => ({}),
        },
      } as unknown,
    } as unknown as Parameters<typeof MagiServerPlugin>[0])

    const configRecord: Record<string, unknown> = {}
    if (pluginInstance.config) {
      await pluginInstance.config(configRecord)
    }

    expect(configRecord.default_agent).toBeUndefined()
    const registeredAgents = configRecord.agent as Record<string, unknown>
    expect(registeredAgents).toBeDefined()
    expect(registeredAgents.magi).toBeDefined()
    expect(registeredAgents.melchior).toBeDefined()
    expect(registeredAgents.balthasar).toBeDefined()
    expect(registeredAgents.casper).toBeDefined()
    await pluginInstance.dispose?.()
  })

  it("respects user pre-configured default_agent if already set", async () => {
    const pluginInstance = await MagiServerPlugin({
      directory: process.cwd(),
      client: {
        session: {
          status: async () => ({ data: {} }),
          abort: async () => ({}),
          promptAsync: async () => ({}),
        },
      } as unknown,
    } as unknown as Parameters<typeof MagiServerPlugin>[0])

    const configRecord: Record<string, unknown> = {
      default_agent: "sisyphus",
    }
    if (pluginInstance.config) {
      await pluginInstance.config(configRecord)
    }

    expect(configRecord.default_agent).toBe("sisyphus")
    await pluginInstance.dispose?.()
  })
})
