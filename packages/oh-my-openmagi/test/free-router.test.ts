import { test, expect } from "bun:test"
import { enduranceRequestInterval, freeRouter, verifiedFreeModel } from "../script/free-router"

const free = {
  id: "audit/model:free",
  pricing: { prompt: "0", completion: "0", request: "0" },
  supported_parameters: ["tools"],
  context_length: 32000,
}

test("endurance pacing reserves free requests across the full observation window", () => {
  const interval = enduranceRequestInterval(6 * 3600000, 600)
  expect(interval).toBe(40000)
  expect(Math.floor((6 * 3600000) / interval) + 1).toBeLessThan(600)
  expect(enduranceRequestInterval(60000, 600)).toBe(6000)
  expect(() => enduranceRequestInterval(0, 600)).toThrow()
  expect(() => enduranceRequestInterval(60000, 0)).toThrow()
})

test("shared pacing spaces concurrent requests and stop prevents queued dispatch", async () => {
  const received: number[] = []
  const provider = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      if (new URL(request.url).pathname === "/models") return Response.json({ data: [free] })
      received.push(Date.now())
      return Response.json({ choices: [], usage: { cost: 0 } })
    },
  })
  // Scale only the interval for a real, offline HTTP exercise of the production queue.
  const interval = enduranceRequestInterval(6 * 3600000, 600) / 200
  const gateway = await freeRouter({
    key: "test",
    models: [free.id],
    maxRequests: 10,
    minIntervalMs: interval,
    event() {},
    testEndpoint: provider.url.toString().replace(/\/$/, ""),
  })
  const send = () =>
    fetch(gateway.url + "/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + gateway.token, "content-type": "application/json" },
      body: JSON.stringify({ model: free.id, messages: [] }),
    })
  try {
    const responses = await Promise.all(Array.from({ length: 4 }, send))
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200])
    expect(received).toHaveLength(4)
    expect(received[3]! - received[0]!).toBeGreaterThanOrEqual(interval * 3 - 30)
    expect(received.slice(1).every((time, i) => time - received[i]! >= interval - 30)).toBe(true)
    const pending = send().then(
      (response) => response.status,
      () => 0,
    )
    await Bun.sleep(30)
    gateway.stop()
    await pending
    await Bun.sleep(interval + 30)
    expect(received).toHaveLength(4)
    expect(gateway.state.requests).toBe(4)
    expect(gateway.state.violation).toBe("")
  } finally {
    gateway.stop()
    provider.stop(true)
  }
})

test("free model validation rejects paid prices, ambiguous auto routing and missing tool support", () => {
  expect(verifiedFreeModel(free)).toBe(true)
  expect(verifiedFreeModel({ ...free, id: "openrouter/auto:free" })).toBe(false)
  expect(verifiedFreeModel({ ...free, pricing: { ...free.pricing, request: "0.001" } })).toBe(false)
  expect(verifiedFreeModel({ ...free, pricing: { prompt: "0" } })).toBe(false)
  expect(verifiedFreeModel({ ...free, supported_parameters: [] })).toBe(false)
})

test("pricing discovery works without a full catalog and rejects approximate model matches", async () => {
  const state = { substitute: false, calls: 0 }
  const provider = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url)
      if (
        url.pathname !== "/models" ||
        url.searchParams.get("q") !== free.id ||
        !url.searchParams.has("limit") ||
        Number(url.searchParams.get("limit")) > 100
      )
        return new Response("Full catalog unavailable", { status: 503 })
      state.calls++
      return Response.json({ data: [{ ...free, id: state.substitute ? "audit/other:free" : free.id }] })
    },
  })
  const options = {
    key: "test",
    models: [free.id],
    maxRequests: 1,
    event() {},
    testEndpoint: provider.url.toString().replace(/\/$/, ""),
  }
  try {
    const gateway = await freeRouter(options)
    expect(gateway.models.map((model) => model.id)).toEqual([free.id])
    expect(gateway.state.requests).toBe(0)
    gateway.stop()
    state.substitute = true
    await expect(freeRouter(options)).rejects.toThrow("not a verified free tool model")
    expect(state.calls).toBe(2)
  } finally {
    provider.stop(true)
  }
})

test("HTTP gateway enforces free routing, private credentials and an atomic request ceiling", async () => {
  const received: Record<string, unknown>[] = []
  const provider = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (new URL(request.url).pathname === "/models") return Response.json({ data: [free] })
      expect(request.headers.get("authorization")).toBe("Bearer private-test-key")
      received.push((await request.json()) as Record<string, unknown>)
      return Response.json({
        id: "answer",
        model: free.id,
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
      })
    },
  })
  const gateway = await freeRouter({
    key: "private-test-key",
    models: [free.id],
    maxRequests: 1,
    minIntervalMs: 0,
    event() {},
    testEndpoint: provider.url.toString().replace(/\/$/, ""),
  })
  const send = (body: unknown, token: string = gateway.token) =>
    fetch(gateway.url + "/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  const body = { model: free.id, messages: [{ role: "user", content: "Test" }] }
  try {
    expect((await send(body, "wrong")).status).toBe(401)
    expect((await send({ ...body, model: "paid/model" })).status).toBe(403)
    expect((await send({ ...body, plugins: [{ id: "web" }] })).status).toBe(403)
    expect(
      (await send({ ...body, messages: [{ role: "user", content: [{ type: "image_url", image_url: "example" }] }] }))
        .status,
    ).toBe(403)
    const responses = await Promise.all([send({ ...body, provider: { max_price: { prompt: 100 } } }), send(body)])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 429])
    expect(received).toHaveLength(1)
    expect(received[0]!.provider).toEqual({
      max_price: { prompt: 0, completion: 0, request: 0, image: 0 },
      allow_fallbacks: false,
    })
    expect(gateway.state.usage[0]?.cost).toBe(0)
  } finally {
    gateway.stop()
    provider.stop(true)
  }
})

test("provider quota waits block retries without forwarding more traffic", async () => {
  const hits = { count: 0 }
  const provider = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      if (new URL(request.url).pathname === "/models") return Response.json({ data: [free] })
      hits.count++
      return Response.json({ error: "quota" }, { status: 429, headers: { "retry-after": "3600" } })
    },
  })
  const gateway = await freeRouter({
    key: "test",
    models: [free.id],
    maxRequests: 10,
    minIntervalMs: 0,
    event() {},
    testEndpoint: provider.url.toString().replace(/\/$/, ""),
  })
  const send = () =>
    fetch(gateway.url + "/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + gateway.token, "content-type": "application/json" },
      body: JSON.stringify({ model: free.id, messages: [] }),
    })
  try {
    expect((await send()).status).toBe(429)
    expect((await send()).status).toBe(429)
    expect(hits.count).toBe(1)
    expect(gateway.state.retryAt).toBeGreaterThan(Date.now() + 3500000)
  } finally {
    gateway.stop()
    provider.stop(true)
  }
})

test.each(["stream", "json", "http"])(
  "provider overload in %s responses blocks queued and new retries",
  async (format) => {
    const hits = { count: 0 }
    const provider = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        if (new URL(request.url).pathname === "/models") return Response.json({ data: [free] })
        hits.count++
        await Bun.sleep(30)
        const error = { error: { code: 503, message: "Service temporarily overloaded" } }
        if (format === "stream")
          return new Response("data: " + JSON.stringify(error) + "\n\ndata: [DONE]\n\n", {
            headers: { "content-type": "text/event-stream" },
          })
        return Response.json(error, { status: format === "http" ? 503 : 200, headers: { "retry-after": "120" } })
      },
    })
    const gateway = await freeRouter({
      key: "test",
      models: [free.id],
      maxRequests: 10,
      minIntervalMs: 200,
      event() {},
      testEndpoint: provider.url.toString().replace(/\/$/, ""),
    })
    const send = async () => {
      const response = await fetch(gateway.url + "/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + gateway.token, "content-type": "application/json" },
        body: JSON.stringify({ model: free.id, messages: [], stream: format === "stream" }),
      })
      return { status: response.status, text: await response.text(), retryAfter: response.headers.get("retry-after") }
    }
    try {
      const responses = await Promise.all([send(), send()])
      expect(responses.map((response) => response.status).sort()).toEqual(format === "http" ? [429, 503] : [200, 429])
      expect(responses.some((response) => response.text.includes("Service temporarily overloaded"))).toBe(true)
      expect((await send()).status).toBe(429)
      expect(hits.count).toBe(1)
      expect(gateway.state.requests).toBe(1)
      expect(gateway.state.responses).toBe(1)
      expect(gateway.state.usage).toHaveLength(0)
      expect(gateway.state.retryAt).toBeGreaterThan(Date.now() + (format === "http" ? 110000 : 50000))
      expect(gateway.state.closed).toBe(false)
      expect(gateway.state.violation).toBe("")
      // Advance the exposed local cooldown only; recovery still uses the real HTTP gateway.
      gateway.state.retryAt = 0
      const resumed = await send()
      expect(resumed.status).toBe(format === "http" ? 503 : 200)
      expect(hits.count).toBe(2)
      expect(gateway.state.retryAt).toBeGreaterThan(Date.now() + 50000)
    } finally {
      gateway.stop()
      provider.stop(true)
    }
  },
)

test("streamed nonzero usage closes the gateway and paid catalogs fail before opening", async () => {
  const fixture = { paid: false }
  const provider = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      if (new URL(request.url).pathname === "/models")
        return Response.json({
          data: [{ ...free, pricing: fixture.paid ? { prompt: "1", completion: "1" } : free.pricing }],
        })
      return new Response('data: {"id":"sse","usage":{"cost":0.01}}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  const options = {
    key: "test",
    models: [free.id],
    maxRequests: 2,
    minIntervalMs: 0,
    event() {},
    testEndpoint: provider.url.toString().replace(/\/$/, ""),
  }
  const gateway = await freeRouter(options)
  try {
    const response = await fetch(gateway.url + "/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + gateway.token, "content-type": "application/json" },
      body: JSON.stringify({ model: free.id, messages: [], stream: true }),
    })
    await response.text()
    expect(gateway.state.closed).toBe(true)
    expect(gateway.state.violation).toContain("non-zero")
    fixture.paid = true
    await expect(freeRouter(options)).rejects.toThrow("not a verified free")
  } finally {
    gateway.stop()
    provider.stop(true)
  }
})
