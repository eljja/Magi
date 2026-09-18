import { expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { executionSettled } from "../src/workforce"

test("background completion waits for descendant activity and the parent's delayed reply", async () => {
  const clock = 100000
  const state = { childUpdated: clock - 1, notification: false }
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const route = new URL(request.url).pathname
      if (route === "/session/worker/children")
        return Response.json([{ id: "child", parentID: "worker", time: { updated: state.childUpdated } }])
      if (route.endsWith("/children")) return Response.json([])
      return Response.json([
        {
          info: { id: "launch", role: "assistant", time: { created: 1, completed: 2 } },
          parts: [{ type: "tool", tool: "task", state: { status: "completed", input: { run_in_background: true } } }],
        },
        {
          info: { id: "waiting", role: "assistant", time: { created: 3, completed: 4 } },
          parts: [{ type: "text", text: "Waiting for the background result" }],
        },
        ...(state.notification ? [{ info: { id: "wake", role: "user", time: { created: 5 } }, parts: [] }] : []),
      ])
    },
  })
  try {
    const client = createOpencodeClient({ baseUrl: server.url.toString() })
    const messages = await client.session.messages({ path: { id: "worker" } })
    expect(await executionSettled(client, "/project", "worker", messages.data!, clock)).toBe(false)
    state.childUpdated = clock - 30001
    expect(await executionSettled(client, "/project", "worker", messages.data!, clock)).toBe(true)
    state.notification = true
    const notified = await client.session.messages({ path: { id: "worker" } })
    expect(await executionSettled(client, "/project", "worker", notified.data!, clock)).toBe(false)
  } finally {
    server.stop(true)
  }
})
