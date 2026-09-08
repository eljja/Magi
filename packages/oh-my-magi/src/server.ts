import { tool, type Plugin } from "@opencode-ai/plugin"
import { createBuiltinAgents } from "./agents"
import { loadMagiConfig } from "./config"
import { handleSessionIdleEvent, pauseMagi, runMagiCycle, setAutonomousLoop } from "./continuation"
import { readMagiState, updateMagiState } from "./state"
import { createControllerLease } from "./controller"
import { getStatusReport } from "./installer"

export const MagiServerPlugin: Plugin = async ({ directory, client }) => {
  const controller = createControllerLease(directory)
  const status = () => getStatusReport(directory)
  const stop = async () => {
    const state = await readMagiState(directory)
    await setAutonomousLoop(directory, false)
    if (state.sessionID)
      await client.session.abort({ path: { id: state.sessionID }, query: { directory } }).catch(() => undefined)
    return "Magi stopped by user. The saved goal is preserved. Use /magi resume to continue."
  }
  const tick = async () => {
    const state = await readMagiState(directory)
    if (!state.loopActive || !state.sessionID) return
    if (!(await controller.acquire())) return
    // An OpenCode server must stay running. Recover the saved session on reload without requiring a UI-specific event.
    const statuses = await client.session.status({ query: { directory } })
    if (
      statuses.error ||
      statuses.data?.[state.sessionID]?.type === "busy" ||
      statuses.data?.[state.sessionID]?.type === "retry"
    )
      return
    if (state.awaitingExecution) {
      await handleSessionIdleEvent({ directory, sessionID: state.sessionID, client })
      const current = await readMagiState(directory)
      if (
        current.loopActive &&
        current.awaitingExecution &&
        current.runID === state.runID &&
        current.executionAfter === state.executionAfter &&
        current.selectedPrompt &&
        Date.now() - (current.executionAfter ?? current.updatedAt) > 60000
      ) {
        // Recover a crash between recording an approved task and dispatching it, or an interrupted idle execution.
        await updateMagiState(
          directory,
          {
            time: Date.now(),
            type: "continuation",
            title: "Recovering interrupted execution",
            text: "Inspect existing artifacts before resuming the approved step.",
          },
          { executionAfter: Date.now() },
          24,
          state.runID,
        )
        const latest = await readMagiState(directory)
        if (!latest.loopActive || latest.runID !== state.runID) return
        const response = await client.session.promptAsync({
          path: { id: state.sessionID },
          query: { directory },
          body: {
            agent: "sisyphus",
            parts: [
              {
                type: "text",
                text:
                  "Recovery: the previous attempt may have partially completed. Inspect existing artifacts and do not repeat completed external effects.\n\n" +
                  current.selectedPrompt,
              },
            ],
          },
        })
        if (response.error)
          await pauseMagi(directory, "Recovery dispatch failed: " + JSON.stringify(response.error), state.runID)
      }
      return
    }
    if (Date.now() - state.updatedAt < 60000) return
    const result = await runMagiCycle({ directory, sessionID: state.sessionID, client })
    const current = await readMagiState(directory)
    if (!result.injected || !current.loopActive || current.runID !== state.runID) return
    const response = await client.session.promptAsync({
      path: { id: state.sessionID },
      query: { directory },
      body: { agent: "sisyphus", parts: [{ type: "text", text: result.prompt }] },
    })
    if (response.error)
      await pauseMagi(directory, "Executor dispatch failed: " + JSON.stringify(response.error), state.runID)
  }
  const timer = setInterval(() => {
    void tick().catch(async (error) => {
      const state = await readMagiState(directory)
      if (state.loopActive)
        await pauseMagi(directory, error instanceof Error ? error.message : String(error), state.runID)
    })
  }, 15000)
  timer.unref()
  return {
    config: async (config) => {
      const settings = await loadMagiConfig(directory)
      const agents = createBuiltinAgents(config.model, {
        councilModel: settings.roles.council,
        sisyphusModel: settings.roles.sisyphus,
        specialistModel: settings.roles.specialists,
      })
      config.agent ??= {}
      Object.entries(agents).forEach(([name, agent]) => {
        config.agent![name] ??= agent
      })
      // Reviews run in separate sessions with read-only tools; {} would leave tools enabled.
      const reviewer = {
        description: "Internal Magi council and independent reviewer",
        mode: "subagent",
        hidden: true,
        permission: { "*": "deny", edit: "deny", bash: "deny", read: "allow", glob: "allow", grep: "allow" },
      } as const
      config.agent["magi-reviewer"] = reviewer
      config.command ??= {}
      config.command.magi ??= {
        description: "Start, resume, stop, or inspect the persistent Magi goal",
        agent: "sisyphus",
        template: "Magi control request:\n$ARGUMENTS",
      }
    },
    tool: {
      magi_start: tool({
        description:
          "Start autonomous research on one persistent goal. The server keeps advancing it until the user stops it.",
        args: { goal: tool.schema.string().describe("The single goal to pursue") },
        execute: async (args, context) => {
          if (!(await controller.acquire()))
            throw new Error("Another OpenCode server controls this goal. Use its session or stop that server first.")
          await setAutonomousLoop(directory, true, { sessionID: context.sessionID, goal: args.goal })
          return "Goal saved. Magi will schedule the first council cycle after this session becomes idle."
        },
      }),
      magi_stop: tool({
        description:
          "Stop the autonomous Magi goal only when the user asks to stop it; never use this to conclude a milestone",
        args: {},
        execute: async () => {
          // Do not await abortion of the very session whose tool is currently executing.
          await setAutonomousLoop(directory, false)
          return "Magi continuation stopped by user request. End this turn without further work."
        },
      }),
      magi_status: tool({ description: "Read the goal, votes, cycle, and latest error", args: {}, execute: status }),
    },
    "command.execute.before": async (input, output) => {
      if (input.command !== "magi") return
      const args = input.arguments.trim()
      const respond = (text: string) => {
        const part = output.parts.find((part) => part.type === "text")
        if (part?.type === "text") {
          part.text = text
          output.parts.splice(0, output.parts.length, part)
          return
        }
        // The hook runs before OpenCode assigns message/part IDs to new input parts.
        output.parts.splice(0, output.parts.length, { type: "text", text } as (typeof output.parts)[number])
      }
      if (args === "stop") {
        respond(await stop())
        return
      }
      if (args === "status") {
        respond("Report this saved Magi status without starting work:\n" + (await status()))
        return
      }
      try {
        if (!(await controller.acquire()))
          throw new Error("Another OpenCode server controls this goal. Use its session or stop that server first.")
        if (args === "start" || args.startsWith("start ") || args === "resume") {
          await setAutonomousLoop(directory, true, {
            sessionID: input.sessionID,
            goal: args.startsWith("start ") ? args.slice(6).trim() : undefined,
          })
        }
        const state = await readMagiState(directory)
        if (!state.loopActive || state.sessionID !== input.sessionID) {
          respond(
            "Start with /magi start <one goal>, or /magi resume for the existing goal. /magi status and /magi stop are also available.",
          )
          return
        }
        const directive = args === "resume" || args === "start" || args.startsWith("start ") ? undefined : args
        const result = await runMagiCycle({ directory, sessionID: input.sessionID, client, userPrompt: directive })
        respond(result.prompt || "Council has not authorized an execution task. Magi will reconsider after a delay.")
      } catch (error) {
        respond(
          "Magi: " +
            (error instanceof Error ? error.message : String(error)) +
            "\nDo not invent a council approval or execute unrelated work.",
        )
      }
    },
    event: async ({ event }) => {
      if (event.type === "server.instance.disposed") {
        if (event.properties.directory !== directory) return
        clearInterval(timer)
        await controller.release()
        return
      }
      if (event.type === "session.deleted") {
        const state = await readMagiState(directory)
        if (state.loopActive && event.properties.info.id === state.sessionID) await setAutonomousLoop(directory, false)
        return
      }
      if (event.type === "session.error" && event.properties.error?.name === "MessageAbortedError") {
        const state = await readMagiState(directory)
        if (state.loopActive && event.properties.sessionID === state.sessionID)
          await setAutonomousLoop(directory, false)
        return
      }
      if (event.type !== "session.status" || event.properties.status.type !== "idle") return
      const state = await readMagiState(directory)
      if (state.loopActive && event.properties.sessionID === state.sessionID && (await controller.acquire()))
        await handleSessionIdleEvent({ directory, sessionID: state.sessionID!, client })
    },
    "experimental.session.compacting": async (input, output) => {
      const state = await readMagiState(directory)
      if (input.sessionID !== state.sessionID) return
      output.context.push(
        "MAGI PERSISTENT GOAL: " + state.goal + "\nCycle: " + state.currentCycle + "\n" + state.selectedPrompt,
      )
    },
  }
}

export default { id: "oh-my-magi", server: MagiServerPlugin }
