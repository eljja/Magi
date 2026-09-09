import { createOpencodeClient } from "@opencode-ai/sdk"

export function openCodeFixture(
  options: { reply?: (body: Record<string, unknown>) => Promise<string | undefined> } = {},
) {
  const requests: { method: string; path: string; directory: string | null; body: Record<string, unknown> }[] = []
  const messages: { info: Record<string, unknown>; parts: { type: string; text: string }[] }[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body =
        request.method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {}
      requests.push({ method: request.method, path: url.pathname, directory: url.searchParams.get("directory"), body })
      if (url.pathname === "/agent") return Response.json([{ name: "sisyphus", mode: "primary" }])
      if (url.pathname === "/provider")
        return Response.json({
          all: [
            { id: "local", models: { model: { id: "model" } } },
            { id: "offline", models: { hidden: { id: "hidden" } } },
          ],
          connected: ["local"],
          default: {},
        })
      if (url.pathname === "/session" && request.method === "POST")
        return Response.json({ id: "internal-" + requests.length })
      if (url.pathname.endsWith("/message") && request.method === "GET") return Response.json(messages)
      if (url.pathname.endsWith("/message")) {
        const system = String(body.system)
        const text = options.reply
          ? await options.reply(body)
          : system.includes("proposal owner")
            ? JSON.stringify({
                title: "Evidence step",
                prompt: "Produce evidence for the saved goal",
                rationale: "Advance the milestone",
              })
            : system.includes("independent milestone reviewer")
              ? JSON.stringify({
                  approved: true,
                  critique: "Fixture artifact and command evidence match the milestone",
                  confidence: 0.9,
                })
              : JSON.stringify({ position: "approve", rationale: "Fixture evidence supports this step" })
        return Response.json({ info: {}, parts: text ? [{ type: "text", text }] : [] })
      }
      if (url.pathname.endsWith("/prompt_async")) return new Response(null, { status: 204 })
      return Response.json(true)
    },
  })
  return {
    client: createOpencodeClient({ baseUrl: server.url.toString() }),
    requests,
    complete(text = "Produced the fixture artifact; verification can inspect it.", parentID?: string) {
      messages.push({
        info: {
          role: "assistant",
          parentID,
          id: "result-" + messages.length,
          time: { created: Date.now(), completed: Date.now() },
        },
        parts: [{ type: "text", text }],
      })
    },
    stop: () => server.stop(true),
  }
}
