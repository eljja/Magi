import { tool, type Plugin } from "@opencode-ai/plugin"
import { createBuiltinAgents } from "./agents"
import { loadMagiConfig } from "./config"
import { handleSessionIdleEvent, pauseMagi, runMagiCycle, setAutonomousLoop } from "./continuation"
import { mutateMagiState, readMagiState, updateMagiState } from "./state"
import { createControllerLease } from "./controller"
import { getStatusReport } from "./installer"
import { recordToolExecution } from "./observer"
import { resolveExecutorAgent } from "./omo-bridge"
import { createOmOMagi } from "./omo-runtime"
import { queueSteering } from "./steering"
import { publishReport, appendReport } from "./reporting"
import { isWorkforceSession, workforceBusy } from "./workforce"
import { readCouncilMemory } from "./memory"
import { createWorkforceWatchdog, isRecoveryAbort } from "./watchdog"
import { validateVerificationSetup } from "./verification"

export const MagiServerPlugin: Plugin = async ({ directory, client }) => {
  const controller = createControllerLease(directory)
  const workforce = createWorkforceWatchdog(directory, client)
  const reporting = { lastArchive: 0, ticking: false, publishing: false }
  const status = () => getStatusReport(directory)
  const stop = async () => {
    const state = await readMagiState(directory)
    await setAutonomousLoop(directory, false)
    if (state.sessionID)
      await client.session.abort({ path: { id: state.sessionID }, query: { directory } }).catch(() => undefined)
    await appendReport(directory, "COUNCIL.md", `\n\n## User stop · ${new Date().toISOString()}\n\nGoal preserved.\n`)
    await publishReport(directory, await readMagiState(directory), true)
    return "Magi stopped by user. The saved goal is preserved. Use /magi resume to continue."
  }
  const tick = async () => {
    const state = await readMagiState(directory)
    if (!state.goal && !state.loopActive) return
    if (!(await controller.acquire())) return
    if (!state.loopActive || !state.sessionID) return
    if (state.retryAt && Date.now() < state.retryAt) return
    // An OpenCode server must stay running. Recover the saved session on reload without requiring a UI-specific event.
    if (await workforce(state.sessionID)) return
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
        const executorAgent = await resolveExecutorAgent(directory, client)
        const response = await client.session.promptAsync({
          path: { id: state.sessionID },
          query: { directory },
          body: {
            ...(executorAgent ? { agent: executorAgent } : {}),
            parts: [
              {
                type: "text",
                synthetic: true,
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
    await validateVerificationSetup(directory)
    const result = await runMagiCycle({ directory, sessionID: state.sessionID, client })
    const current = await readMagiState(directory)
    if (!result.injected || !current.loopActive || current.runID !== state.runID) return
    const executorAgent = await resolveExecutorAgent(directory, client)
    const response = await client.session.promptAsync({
      path: { id: state.sessionID },
      query: { directory },
      body: {
        ...(executorAgent ? { agent: executorAgent } : {}),
        parts: [{ type: "text", text: result.prompt, synthetic: true }],
      },
    })
    if (response.error)
      await pauseMagi(directory, "Executor dispatch failed: " + JSON.stringify(response.error), state.runID)
  }
  const timer = setInterval(() => {
    if (reporting.ticking) return
    reporting.ticking = true
    void tick()
      .catch(async (error) => {
        const state = await readMagiState(directory)
        if (state.loopActive)
          await pauseMagi(directory, error instanceof Error ? error.message : String(error), state.runID)
      })
      .finally(() => {
        reporting.ticking = false
      })
  }, 15000)
  timer.unref()
  // Reporting must remain alive while council/provider requests are pending.
  const reportTimer = setInterval(() => {
    if (reporting.publishing) return
    reporting.publishing = true
    void (async () => {
      const state = await readMagiState(directory)
      if (!state.goal || !(await controller.acquire())) return
      const archive = state.loopActive && Date.now() - reporting.lastArchive >= 60000
      await publishReport(directory, state, archive)
      if (archive) reporting.lastArchive = Date.now()
    })()
      .catch((error) =>
        client.app.log({
          body: { service: "oh-my-magi", level: "error", message: "Report update failed: " + String(error) },
        }),
      )
      .finally(() => {
        reporting.publishing = false
      })
  }, 15000)
  reportTimer.unref()
  return {
    dispose: async () => {
      clearInterval(timer)
      clearInterval(reportTimer)
      await controller.release()
    },
    "chat.message": async (input, output) => {
      if (output.parts.some((part) => part.type === "text" && part.metadata?.magiOrigin === "control")) {
        await mutateMagiState(directory, (state) => ({
          ...state,
          ignoredMessageIDs: [...new Set([...(state.ignoredMessageIDs ?? []), output.message.id])].slice(-100),
        }))
        return
      }
      if (output.parts.some((part) => part.type === "text" && part.metadata?.magiOrigin)) return
      const state = await readMagiState(directory)
      if (!state.loopActive || state.sessionID !== input.sessionID) return
      const parts = output.parts
        .filter((part) => part.type === "text")
        .filter((part) => !part.synthetic && !part.ignored)
      const text = parts
        .map((part) => part.text)
        .join("\n\n")
        .trim()
      if (!text) return
      const item = await queueSteering(directory, text, { sessionID: input.sessionID, messageID: output.message.id })
      if (!item) return
      output.parts.push({
        ...parts[0]!,
        id: "prt_" + crypto.randomUUID().replaceAll("-", ""),
        type: "text",
        synthetic: true,
        text:
          "[Magi conversation receipt: " +
          item.id +
          "]\n" +
          "The user's message above is already saved for the next council deliberation. Respond naturally in the user's language. " +
          "Answer questions as questions; do not treat them as authorization for changes. For guidance, briefly acknowledge receipt without claiming it has already been applied. " +
          "Do not call magi_steer again for this message or start a separate task. Preserve the existing goal and let the council schedule changes. " +
          "If the user explicitly asks to stop, call magi_stop. Use magi_status when current progress is needed.",
      })
    },
    config: async (config) => {
      const settings = await loadMagiConfig(directory)
      const agents = createBuiltinAgents(config.model, {
        councilModel: settings.roles.council,
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
        agent: "magi",
        template: "Magi control request:\n$ARGUMENTS",
      }
    },
    "tool.execute.after": async (input, output) => {
      const state = await readMagiState(directory)
      if (
        state.loopActive &&
        state.sessionID &&
        (await isWorkforceSession(client, directory, input.sessionID, state.sessionID))
      ) {
        await recordToolExecution(directory, {
          tool: input.tool,
          sessionID: input.sessionID,
          callID: input.callID,
          args: input.args,
          title: output.title,
          output: output.output,
          runID: state.runID,
        })
      }
    },
    tool: {
      magi_start: tool({
        description:
          "Start autonomous research on one persistent goal. The server keeps advancing it until the user stops it.",
        args: { goal: tool.schema.string().describe("The single goal to pursue") },
        execute: async (args, context) => {
          await validateVerificationSetup(directory)
          await resolveExecutorAgent(directory, client)
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
      magi_steer: tool({
        description:
          "Record explicit user guidance when it has not already been captured. Ordinary conversation in the active goal session is recorded automatically; never duplicate its receipt.",
        args: {
          directive: tool.schema.string().describe("User steering directive or priority guidance for the council"),
        },
        execute: async (args) => {
          await queueSteering(directory, args.directive)
          return `Magi Council recorded steering directive: "${args.directive}". It will be prioritized in the next deliberation cycle.`
        },
      }),
      magi_status: tool({ description: "Read the goal, votes, cycle, and latest error", args: {}, execute: status }),
    },
    "command.execute.before": async (input, output) => {
      // Preserve provenance through OpenCode's command -> chat.message pipeline,
      // without a session-wide flag that could consume an unrelated concurrent message.
      output.parts.forEach((part) => {
        if (part.type === "text") part.metadata = { ...part.metadata, magiOrigin: "command" }
      })
      if (input.command !== "magi") return
      const args = input.arguments.trim()
      const respond = (text: string, origin = "control") => {
        const part = output.parts.find((part) => part.type === "text")
        if (part?.type === "text") {
          part.text = text
          part.metadata = { ...part.metadata, magiOrigin: origin }
          output.parts.splice(0, output.parts.length, part)
          return
        }
        // The hook runs before OpenCode assigns message/part IDs to new input parts.
        output.parts.splice(0, output.parts.length, {
          type: "text",
          text,
          metadata: { magiOrigin: origin },
        } as unknown as (typeof output.parts)[number])
      }
      if (args === "stop") {
        respond(await stop())
        return
      }
      if (args === "status") {
        respond("Report this saved Magi status without starting work:\n" + (await status()))
        return
      }
      if (args.startsWith("steer ") || args.startsWith("feedback ")) {
        const directive = args.slice(args.indexOf(" ") + 1).trim()
        await queueSteering(directory, directive)
        respond(
          `Magi Supreme Council noted your directive:\n> "${directive}"\nMelchior, Balthasar, and Casper will prioritize this steering in the next deliberation round. Check .magi/COUNCIL.md for minutes.`,
        )
        return
      }
      try {
        if (!(await controller.acquire()))
          throw new Error("Another OpenCode server controls this goal. Use its session or stop that server first.")
        if (args === "start" || args.startsWith("start ") || args === "resume") {
          await validateVerificationSetup(directory)
          await resolveExecutorAgent(directory, client)
          const existing = await readMagiState(directory)
          if (existing.loopActive && existing.sessionID === input.sessionID) {
            if (existing.error && !existing.awaitingExecution)
              await mutateMagiState(directory, (state) => ({ ...state, retryAt: undefined, failureCount: 0 }))
            respond(
              "Magi is already pursuing the saved goal. Talk normally in this session to guide it; no duplicate cycle was started.\n" +
                (await status()),
            )
            return
          }
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
        if (directive) {
          await queueSteering(directory, directive)
          respond(
            "Magi recorded this guidance for the next council cycle. Do not execute a separate task:\n" + directive,
          )
          return
        }
        const result = await runMagiCycle({ directory, sessionID: input.sessionID, client, userPrompt: directive })
        respond(
          result.prompt || "Council has not authorized an execution task. Magi will reconsider after a delay.",
          result.injected ? "execution" : "control",
        )
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
        clearInterval(reportTimer)
        await controller.release()
        return
      }
      if (event.type === "session.deleted") {
        const state = await readMagiState(directory)
        if (state.loopActive && event.properties.info.id === state.sessionID) await setAutonomousLoop(directory, false)
        return
      }
      if (event.type === "session.error" && event.properties.error?.name === "MessageAbortedError") {
        if (event.properties.sessionID && isRecoveryAbort(directory, event.properties.sessionID)) return
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
        await readCouncilMemory(directory),
      )
    },
  }
}

export const OhMyMagiPlugin: Plugin = (input) => createOmOMagi(input, MagiServerPlugin)
export default { id: "oh-my-magi", server: OhMyMagiPlugin }
