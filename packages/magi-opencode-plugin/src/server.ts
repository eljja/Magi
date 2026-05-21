import type { Plugin } from "@opencode-ai/plugin"
import { runMagiOnce } from "@magi/core"

export const MagiServerPlugin: Plugin = async ({ directory }) => {
  return {
    "command.execute.before": async (input, output) => {
      if (input.command !== "magi") return
      const result = await runMagiOnce({
        directory,
        sessionID: input.sessionID,
        arguments: input.arguments,
      })
      output.parts.splice(0, output.parts.length, ...([{ type: "text", text: result.prompt }] as typeof output.parts))
    },
  }
}

const plugin = {
  id: "magi-server",
  server: MagiServerPlugin,
}

export default plugin
