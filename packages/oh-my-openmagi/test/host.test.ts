import { expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { createHost } from "../src/host"
import type { Job } from "../src/types"

test("SDK host finds older parents/messages and follows children beyond the 100-session listing", async () => {
  const calls: string[] = []
  const aborted: string[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      calls.push(request.method + " " + url.pathname)
      if (url.pathname === "/session/status") return Response.json({ grandchild: { type: "busy" } })
      if (url.pathname === "/session" && request.method === "GET")
        return Response.json(
          url.searchParams.has("search")
            ? [{ id: "old-root", title: url.searchParams.get("search") }]
            : Array.from({ length: 100 }, (_, index) => ({ id: "unrelated-" + index, title: "Unrelated" })),
        )
      if (url.pathname === "/session" && request.method === "POST") {
        const body = (await request.json()) as { parentID?: string }
        expect(body.parentID).toBe("old-owner")
        return Response.json({ id: "new-session" })
      }
      if (url.pathname.endsWith("/children")) {
        if (url.pathname === "/session/old-root/children") return Response.json([{ id: "child", parentID: "old-root" }])
        if (url.pathname === "/session/child/children") return Response.json([{ id: "grandchild", parentID: "child" }])
        return Response.json([])
      }
      if (url.pathname.endsWith("/abort")) {
        aborted.push(url.pathname.split("/")[2]!)
        return Response.json(true)
      }
      if (url.pathname === "/session/old-root/message/old-message")
        return Response.json({ info: { id: "old-message" }, parts: [] })
      if (url.pathname === "/session/old-root/message")
        return Response.json([
          {
            info: { id: "assistant", role: "assistant", parentID: "old-message", time: { created: 1, completed: 2 } },
            parts: [{ type: "text", text: "Parent completed" }],
          },
        ])
      if (url.pathname === "/session/deleted")
        return Response.json({ name: "NotFoundError", data: { message: "deleted" } }, { status: 404 })
      return Response.json({ id: url.pathname.split("/")[2] })
    },
  })
  await (async () => {
    const host = createHost(createOpencodeClient({ baseUrl: server.url.toString() }), "/project")
    expect(await host.create("new", "old-owner")).toBe("new-session")
    expect(await host.find("old-title")).toBe("old-root")
    expect(await host.hasMessage("old-root", "old-message")).toBe(true)
    expect(calls).toContain("GET /session/old-root/message/old-message")
    const job: Job = {
      id: "job",
      generation: "generation",
      cycle: 1,
      round: 1,
      kind: "execution",
      agent: "sisyphus",
      attempt: 1,
      session: "old-root",
      message: "old-message",
      prompt: "work",
      startedAt: 1,
      status: "running",
    }
    expect((await host.inspect(job)).busy).toBe(true)
    await host.abort("old-root")
    expect(aborted.sort()).toEqual(["child", "grandchild", "old-root"])
    const deleted = await host.inspect({ ...job, session: "deleted" })
    expect(deleted.busy).toBe(false)
    expect(deleted.error).toContain("deleted")
  })().finally(() => server.stop(true))
})
