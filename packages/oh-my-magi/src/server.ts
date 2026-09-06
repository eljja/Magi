import type { Plugin } from "@opencode-ai/plugin"
import type { Part } from "@opencode-ai/sdk"
import { createBuiltinAgents } from "./agents"
import { loadMagiConfig } from "./config"
import { handleSessionIdleEvent, runMagiCycle, setAutonomousLoop } from "./continuation"
import { readMagiState } from "./state"

export const MagiServerPlugin: Plugin = async ({ directory, client }) => {
  return {
    config: async (config: Record<string, unknown>) => {
      const magiConfig = await loadMagiConfig(directory)
      const currentModel = typeof config.model === "string" ? config.model : undefined
      const builtinAgents = createBuiltinAgents(currentModel, {
        councilModel: magiConfig.roles.council,
        sisyphusModel: magiConfig.roles.sisyphus,
        specialistModel: magiConfig.roles.specialists,
      })
      if (!config.agent || typeof config.agent !== "object") {
        config.agent = {}
      }
      const agents = config.agent as Record<string, unknown>
      for (const [name, agentDef] of Object.entries(builtinAgents)) {
        if (!agents[name]) {
          agents[name] = agentDef
        }
      }
      if (!config.default_agent) {
        config.default_agent = "magi"
      }
    },

    "command.execute.before": async (input, output) => {
      if (input.command === "ultrawork") {
        await setAutonomousLoop(directory, true)
        const result = await runMagiCycle({
          directory,
          sessionID: input.sessionID,
          client,
          userPrompt: input.arguments.trim() || undefined,
        })
        if (result.injected && result.prompt) {
          setOutputText(output.parts, result.prompt)
        }
        return
      }

      if (input.command !== "magi") return

      const args = input.arguments.trim()

      if (args === "stop") {
        await setAutonomousLoop(directory, false)
        setOutputText(output.parts, "Magi autonomous self-improvement loop has been stopped by user command.")
        return
      }

      if (args === "status") {
        const state = await readMagiState(directory)
        const summary = [
          "**Oh-My-Magi Status**",
          `- Status: \`${state.status}\``,
          `- Autonomous Loop Active: \`${state.loopActive}\``,
          `- Current Cycle: \`#${state.currentCycle} / ${state.maxCycles}\``,
          `- Active Topic: ${state.topic}`,
          state.votes.melchior ? `- Melchior Vote: ${state.votes.melchior}` : undefined,
          state.votes.balthasar ? `- Balthasar Vote: ${state.votes.balthasar}` : undefined,
          state.votes.casper ? `- Casper Vote: ${state.votes.casper}` : undefined,
        ]
          .filter((line): line is string => line !== undefined)
          .join("\n")
        setOutputText(output.parts, summary)
        return
      }

      const shouldEnableLoop = args === "start" || args.startsWith("start ")
      if (shouldEnableLoop) {
        await setAutonomousLoop(directory, true)
      }

      const userDirective = shouldEnableLoop ? args.replace(/^start\s*/, "") : args
      const result = await runMagiCycle({
        directory,
        sessionID: input.sessionID,
        client,
        userPrompt: userDirective || undefined,
      })

      if (result.injected && result.prompt) {
        setOutputText(output.parts, result.prompt)
        return
      }

      setOutputText(output.parts, result.stopped ? result.prompt : "Magi council did not produce an injectable task.")
    },

    event: async ({ event }) => {
      const isIdleStatus =
        event.type === "session.status" &&
        isRecord(event.properties) &&
        isRecord(event.properties.status) &&
        event.properties.status.type === "idle"

      const isLegacyIdle = event.type === "session.idle"

      if (!isIdleStatus && !isLegacyIdle) return

      const sessionID =
        isRecord(event.properties) && typeof event.properties.sessionID === "string"
          ? event.properties.sessionID
          : undefined

      if (!sessionID) return

      await handleSessionIdleEvent({
        directory,
        sessionID,
        client,
      })
    },

    "experimental.session.compacting": async (_input, output) => {
      const state = await readMagiState(directory)
      if (state.currentCycle > 0) {
        output.context.push(
          `[OH-MY-MAGI CONTEXT] Active cycle: #${state.currentCycle}. Topic: ${state.topic}. Loop active: ${state.loopActive}.`,
        )
      }
    },
  }
}

function setOutputText(parts: Part[], text: string) {
  parts.splice(0, parts.length, { type: "text", text } as Part)
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val)
}

const plugin = {
  id: "oh-my-magi",
  server: MagiServerPlugin,
}

export default plugin
