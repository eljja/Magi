import { describe, expect, test } from "bun:test"
import { executeResilientPrompt, discoverAvailableModels } from "../src/resilience"
import { openCodeFixture } from "./fixture"
import { createOpencodeClient } from "@opencode-ai/sdk"

describe("Resilience using the real OpenCode SDK over HTTP", () => {
  test("requires native structured output instead of accepting unvalidated text as a vote", async () => {
    const bodies: Record<string, unknown>[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const route = new URL(request.url).pathname
        if (route === "/session") return Response.json({ id: "review" })
        if (route.endsWith("/message")) {
          bodies.push(await request.json())
          return Response.json({ info: {}, parts: [{ type: "text", text: '{"position":"approve"}' }] })
        }
        return Response.json(true)
      },
    })
    try {
      await expect(
        executeResilientPrompt({
          client: createOpencodeClient({ baseUrl: server.url.toString() }),
          directory: "/project",
          system: "Vote",
          prompt: "Evidence",
          schema: { type: "object" },
          maxRetries: 0,
        }),
      ).rejects.toThrow("no validated structured decision")
      expect(bodies[0]?.format).toEqual({ type: "json_schema", schema: { type: "object" }, retryCount: 0 })
      expect(bodies[0]?.tools).toEqual({ "*": false, StructuredOutput: true })
    } finally {
      server.stop(true)
    }
  })
  test("scopes create, prompt, abort, and deletion to the project", async () => {
    const fixture = openCodeFixture({ reply: async () => "Council response" })
    try {
      expect(
        await executeResilientPrompt({
          client: fixture.client,
          system: "Review",
          prompt: "Evidence",
          directory: "/project",
          maxRetries: 0,
        }),
      ).toBe("Council response")
      expect(fixture.requests.every((item) => item.directory === "/project")).toBe(true)
      expect(fixture.requests.some((item) => item.path.endsWith("/abort"))).toBe(true)
      expect(fixture.requests.some((item) => item.method === "DELETE")).toBe(true)
      expect(fixture.requests.find((item) => item.path.endsWith("/message"))?.body.agent).toBe("magi-reviewer")
    } finally {
      fixture.stop()
    }
  })
  test("zero retries still makes one attempt, then falls back to an explicitly configured model", async () => {
    const fixture = openCodeFixture({
      reply: async (body) =>
        (body.model as { modelID: string }).modelID === "first" ? undefined : "Fallback response",
    })
    try {
      expect(
        await executeResilientPrompt({
          client: fixture.client,
          system: "",
          prompt: "",
          directory: "/project",
          primaryModel: "local/first",
          fallbackChain: ["local/second"],
          maxRetries: 0,
        }),
      ).toBe("Fallback response")
      expect(fixture.requests.filter((item) => item.path.endsWith("/message")).length).toBe(2)
    } finally {
      fixture.stop()
    }
  })
  test("times out and cleans up server work", async () => {
    const fixture = openCodeFixture({
      reply: async () => {
        await Bun.sleep(100)
        return "Too late"
      },
    })
    try {
      expect(
        await executeResilientPrompt({
          client: fixture.client,
          system: "",
          prompt: "",
          directory: "/project",
          timeoutMs: 25,
          maxRetries: 0,
        }),
      ).toBeUndefined()
      expect(fixture.requests.some((item) => item.path.endsWith("/abort"))).toBe(true)
    } finally {
      fixture.stop()
    }
  })
  test("reads the actual provider list shape and excludes disconnected providers", async () => {
    const fixture = openCodeFixture()
    try {
      expect(await discoverAvailableModels(fixture.client)).toEqual(["local/model"])
    } finally {
      fixture.stop()
    }
  })
})
