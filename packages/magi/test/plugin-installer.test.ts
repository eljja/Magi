import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { installMagiPlugin } from "../src/plugin-installer"

const repo = path.resolve(import.meta.dirname, "..", "..", "..")
const plugin = path.join(repo, "packages", "magi-opencode-plugin")

describe("Magi plugin installer", () => {
  test("installs server and TUI plugin config plus /magi command idempotently", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "magi-plugin-install-"))
    try {
      await Bun.write(
        path.join(dir, ".opencode", "opencode.jsonc"),
        JSON.stringify({
          provider: {
            google: {
              models: {},
            },
          },
          plugin: [plugin],
        }),
      )

      await installMagiPlugin({ project: dir, plugin })
      await installMagiPlugin({ project: dir, plugin })

      const opencode = await Bun.file(path.join(dir, ".opencode", "opencode.jsonc")).json()
      const tui = await Bun.file(path.join(dir, ".opencode", "tui.json")).json()
      expect(opencode.provider.google.models).toEqual({})
      expect(opencode.plugin).toEqual([plugin])
      expect(tui.plugin).toEqual([plugin])
      expect(await Bun.file(path.join(dir, ".opencode", "command", "magi.md")).text()).toContain("$ARGUMENTS")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
