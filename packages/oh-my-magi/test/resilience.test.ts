import { describe, expect, it } from "bun:test"
import { executeResilientPrompt, discoverAvailableModels } from "../src/resilience"
import type { OpencodeClientInstance } from "../src/bridge"
import { loadMagiConfig } from "../src/config"

describe("Resilience & Model Fallback Engine", () => {
  it("executes prompt successfully on first attempt", async () => {
    const mockClient = {
      session: {
        create: async () => ({ data: { id: "sess-1" } }),
        prompt: async () => ({
          data: {
            parts: [{ type: "text", text: "Council consensus reached." }],
          },
        }),
        delete: async () => ({}),
      },
    } as unknown as OpencodeClientInstance

    const result = await executeResilientPrompt({
      client: mockClient,
      system: "system",
      prompt: "prompt",
      directory: process.cwd(),
      primaryModel: "zai/glm-5.2:max",
      timeoutMs: 1000,
      maxRetries: 2,
    })

    expect(result).toBe("Council consensus reached.")
  })

  it("retries and recovers when first attempt returns empty", async () => {
    let callCount = 0
    const mockClient = {
      session: {
        create: async () => ({ data: { id: "sess-1" } }),
        prompt: async () => {
          callCount++
          if (callCount === 1) {
            return { data: { parts: [] } } // empty/hang
          }
          return { data: { parts: [{ type: "text", text: "Recovered on attempt 2" }] } }
        },
        delete: async () => ({}),
      },
    } as unknown as OpencodeClientInstance

    const result = await executeResilientPrompt({
      client: mockClient,
      system: "system",
      prompt: "prompt",
      directory: process.cwd(),
      primaryModel: "zai/glm-5.2:max",
      timeoutMs: 1000,
      maxRetries: 2,
    })

    expect(result).toBe("Recovered on attempt 2")
    expect(callCount).toBe(2)
  })

  it("smoothly falls back from max to pro when max fails all retries", async () => {
    const fallbackEvents: { fromModel?: string; toModel?: string; reason: string }[] = []
    const modelsUsed: string[] = []

    const mockClient = {
      session: {
        create: async () => ({ data: { id: "sess-1" } }),
        prompt: async (params: { body: { model?: { providerID: string; modelID: string } } }) => {
          const modelStr = params.body.model ? `${params.body.model.providerID}/${params.body.model.modelID}` : undefined
          if (modelStr) modelsUsed.push(modelStr)

          if (modelStr === "zai/glm-5.2:max") {
            // max times out or fails
            return { data: undefined }
          }
          // pro succeeds
          return { data: { parts: [{ type: "text", text: "Success via GLM Pro!" }] } }
        },
        delete: async () => ({}),
      },
    } as unknown as OpencodeClientInstance

    const result = await executeResilientPrompt({
      client: mockClient,
      system: "system",
      prompt: "prompt",
      directory: process.cwd(),
      primaryModel: "zai/glm-5.2:max",
      fallbackChain: ["zai/glm-5.2:max", "zai/glm-5.2:pro", "zai/glm-5.2"],
      timeoutMs: 500,
      maxRetries: 2,
      onFallback: (ev) => fallbackEvents.push(ev),
    })

    expect(result).toBe("Success via GLM Pro!")
    expect(fallbackEvents.length).toBeGreaterThan(0)
    expect(fallbackEvents[0]?.fromModel).toBe("zai/glm-5.2:max")
    expect(fallbackEvents[0]?.toModel).toBe("zai/glm-5.2:pro")
  })

  it("discovers available models from OpenCode client", async () => {
    const mockClient = {
      session: {
        create: async () => ({ data: { id: "1" } }),
        prompt: async () => ({ data: {} }),
        delete: async () => ({}),
      },
      provider: {
        list: async () => ({
          data: [
            {
              id: "zai",
              connected: true,
              models: [{ id: "glm-5.2:max" }, { id: "glm-5.2:pro" }],
            },
          ],
        }),
      },
    } as unknown as OpencodeClientInstance

    const models = await discoverAvailableModels(mockClient)
    expect(models).toEqual(["zai/glm-5.2:max", "zai/glm-5.2:pro"])
  })

  it("loads default resilience and role configurations", async () => {
    const config = await loadMagiConfig(process.cwd())
    expect(config.roles.council).toBe("zai/glm-5.2:max")
    expect(config.roles.sisyphus).toBe("zai/glm-5.2:pro")
    expect(config.resilience.timeoutMs).toBe(60000)
    expect(config.resilience.maxRetries).toBe(2)
    expect(config.resilience.fallbackChain).toContain("zai/glm-5.2:pro")
  })
})
