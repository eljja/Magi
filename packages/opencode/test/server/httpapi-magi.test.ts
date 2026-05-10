import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Server } from "../../src/server/server"
import * as Log from "@opencode-ai/core/util/log"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

const original = Flag.OPENCODE_EXPERIMENTAL_HTTPAPI

function app() {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = true
  return Server.Default().app
}

afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = original
  await disposeAllInstances()
  await resetDatabase()
})

describe("Magi HttpApi", () => {
  test("serves status with resolved dual models and max cycle limits", async () => {
    await using tmp = await tmpdir({
      config: {
        formatter: false,
        lsp: false,
        magi: {
          models: {
            executor: "google/gemini-3.1-pro-preview",
            council: "google/gemini-3.1-flash-lite-preview",
            councilFallbacks: ["google/gemini-3.1-flash-lite", "google/gemini-3-flash-preview"],
          },
          selfImprovement: {
            enabled: false,
            state: "off",
            intervalMinutes: 1,
            maxCycles: 2,
          },
        },
      },
    })

    const response = await app().request("/magi", {
      headers: {
        "x-opencode-directory": tmp.path,
      },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      executorModel: "google/gemini-3.1-pro-preview",
      councilModel: "google/gemini-3.1-flash-lite-preview",
      councilModels: [
        "google/gemini-3.1-flash-lite-preview",
        "google/gemini-3.1-flash-lite",
        "google/gemini-3-flash-preview",
      ],
      selfImprovement: {
        enabled: false,
        state: "off",
        intervalMinutes: 1,
        maxCycles: 2,
      },
    })
  })

  test("does not create autonomous work when self-improvement is off", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        formatter: false,
        lsp: false,
        magi: {
          selfImprovement: {
            enabled: false,
            state: "off",
            intervalMinutes: 1,
            maxCycles: 1,
          },
        },
      },
    })

    const response = await app().request("/magi/self_improve_async", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-directory": tmp.path,
      },
      body: JSON.stringify({ recentWork: "No autonomous work should start." }),
    })

    expect(response.status).toBe(204)
    expect(await Bun.file(path.join(tmp.path, ".magi-memory.json")).exists()).toBe(false)
  })
})
