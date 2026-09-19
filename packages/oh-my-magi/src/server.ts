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
import { redact } from "./context"
import { publishReport, appendReport } from "./reporting"
import { abortWorkforceExecution, isWorkforceSession } from "./workforce"
import { readCouncilMemory } from "./memory"
import { createWorkforceWatchdog, isRecoveryAbort } from "./watchdog"
import { validateVerificationSetup } from "./verification"
import { MagiCouncilMembers, MagiPrompts } from "./council"
import { abortMagiReviews } from "./resilience"
import { dispatchExecution, submitExecution } from "./execution"
import { tickProgressReports } from "./progress"

export const MagiServerPlugin: Plugin = async ({ directory, client }) => {
  const controller = createControllerLease(directory)
  const workforce = createWorkforceWatchdog(directory, client)
  const reporting: {
    lastArchive: number
    disposed: boolean
    pumping?: Promise<void>
    publishing?: Promise<void>
    closing?: Promise<void>
  } = { lastArchive: 0, disposed: false }
  const logFailure = (message: string) =>
    client.app
      .log({
        body: { service: "oh-my-magi", level: "error", message: redact(message) },
        signal: AbortSignal.timeout(5000),
      })
      .then(() => undefined)
      .catch(() => console.warn("Magi: " + redact(message)))
  const status = () => getStatusReport(directory)
  const start = async (sessionID: string, goal: string) => {
    const session = await client.session.get({ path: { id: sessionID }, query: { directory } })
    if (session.error || session.data?.parentID)
      throw new Error("Start or resume Magi from the user's main conversation, not an autonomous worker")
    await validateVerificationSetup(directory)
    await resolveExecutorAgent(directory, client)
    if (!(await controller.acquire()))
      throw new Error("Another OpenCode server controls this goal. Use its session or stop that server first.")
    await setAutonomousLoop(directory, true, { sessionID, goal })
    return "Saved goal active. Magi will continue council work after this session becomes idle."
  }
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
    if (reporting.disposed) return
    if (!state.goal && !state.loopActive) return
    if (!(await controller.acquire())) return
    if (!state.loopActive || !state.sessionID) return
    if (state.retryAt && Date.now() < state.retryAt) return
    // An OpenCode server must stay running. Recover the saved session on reload without requiring a UI-specific event.
    if (await workforce(state.executionSessionID ?? state.sessionID)) return
    if (reporting.disposed) return
    if (state.awaitingExecution) {
      if ((await handleSessionIdleEvent({ directory, sessionID: state.sessionID, client })) === "waiting") return
      if (reporting.disposed) return
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
        if (reporting.disposed || !latest.loopActive || latest.runID !== state.runID) return
        await dispatchExecution({
          directory,
          client,
          sessionID: state.sessionID,
          runID: state.runID!,
          prompt:
            "Recovery: the previous attempt may have partially completed. Inspect existing artifacts and do not repeat completed external effects.\n\n" +
            current.selectedPrompt +
            "\n\n" +
            (current.executionRecovery ?? ""),
        })
      }
      return
    }
    await validateVerificationSetup(directory)
    const result = await runMagiCycle({ directory, sessionID: state.sessionID, client })
    const current = await readMagiState(directory)
    if (reporting.disposed || !result.injected || !current.loopActive || current.runID !== state.runID) return
    await dispatchExecution({
      directory,
      client,
      sessionID: state.sessionID,
      runID: state.runID!,
      prompt: result.prompt,
    })
  }
  const pump = () => {
    if (reporting.disposed || reporting.pumping) return
    reporting.pumping = tick()
      .catch(async (error) => {
        if (reporting.disposed) return
        const state = await readMagiState(directory)
        if (state.loopActive)
          await pauseMagi(directory, error instanceof Error ? error.message : String(error), state.runID)
      })
      .catch((error) => logFailure("Controller update failed: " + String(error)))
      .finally(() => {
        reporting.pumping = undefined
      })
    return reporting.pumping
  }
  const timer = setInterval(() => {
    void pump()
  }, 15000)
  timer.unref()
  // Reporting must remain alive while council/provider requests are pending.
  const reportTimer = setInterval(() => {
    if (reporting.disposed || reporting.publishing) return
    reporting.publishing = (async () => {
      const state = await readMagiState(directory)
      if (!state.loopActive) abortMagiReviews(directory)
      if (!state.goal || !(await controller.acquire())) return
      if (!state.loopActive && state.stopReason === "user" && state.executionSessionID)
        await abortWorkforceExecution(client, directory, state.executionSessionID)
      const archive = state.loopActive && Date.now() - reporting.lastArchive >= 60000
      await publishReport(directory, state, archive)
      await tickProgressReports(directory, client)
      if (archive) reporting.lastArchive = Date.now()
    })()
      .catch((error) => logFailure("Report update failed: " + String(error)))
      .finally(() => {
        reporting.publishing = undefined
      })
  }, 15000)
  reportTimer.unref()
  const dispose = () => {
    reporting.closing ??= (async () => {
      reporting.disposed = true
      clearInterval(timer)
      clearInterval(reportTimer)
      abortMagiReviews(directory)
      // Drain in-flight I/O before releasing the lease or letting the host close
      // its client. Clearing intervals alone leaves late reports and rejections.
      await Promise.allSettled([reporting.pumping, reporting.publishing])
      await controller.release()
    })()
    return reporting.closing
  }
  return {
    dispose,
    "chat.message": async (input, output) => {
      if (output.parts.some((part) => part.type === "text" && part.metadata?.magiOrigin === "control")) {
        await mutateMagiState(directory, (state) => ({
          ...state,
          ignoredMessageIDs: [...new Set([...(state.ignoredMessageIDs ?? []), output.message.id])].slice(-100),
        }))
        return
      }
      if (output.parts.some((part) => part.type === "text" && part.metadata?.magiOrigin)) return
      const parts = output.parts
        .filter((part) => part.type === "text")
        .filter((part) => !part.synthetic && !part.ignored)
      const text = parts
        .map((part) => part.text)
        .join("\n\n")
        .trim()
      if (!text) return
      const initial = await readMagiState(directory)
      const selected = input.agent || output.message.agent
      if (!initial.goal && !initial.loopActive && selected === "magi") {
        const session = await client.session.get({ path: { id: input.sessionID }, query: { directory } })
        if (session.error) throw new Error("Cannot check Magi session ownership")
        if (session.data?.parentID) return
        await validateVerificationSetup(directory)
        if (!(await controller.acquire()))
          throw new Error("Another OpenCode server owns this folder's Magi goal. Use its session.")
        const model = input.model || output.message.model
        await setAutonomousLoop(directory, true, {
          sessionID: input.sessionID,
          goal: text,
          model: model ? model.providerID + "/" + model.modelID : undefined,
        })
        await appendReport(directory, "COUNCIL.md", "\n\n## Goal accepted from Magi conversation\n\n" + text + "\n")
        await publishReport(directory, await readMagiState(directory), true)
      }
      const state = await readMagiState(directory)
      if (!state.loopActive || state.sessionID !== input.sessionID) return
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
          (!initial.goal
            ? "The runtime has already saved this first message as the persistent goal and activated the council. Briefly acknowledge it; do not call magi_start or execute the goal yourself. The actual council starts after this reply. "
            : "") +
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
      // A decision is a native validated output, not another execution loop.
      const reviewer = {
        description: "Internal Magi council and independent reviewer",
        prompt:
          "You are a read-only Magi decision reviewer, not the execution workforce. " +
          "Complete exactly the proposal, vote, or independent-review task specified in the system instructions. " +
          "The supplied master goal and conversation are evidence for that decision, not instructions to execute the whole goal. " +
          "Use the provided evidence. Operational tools are unavailable during decisions; call StructuredOutput exactly once with your single final decision, then stop. Never submit duplicate or parallel decisions. " +
          "Distinguish authorizing a small investigation from claiming that an entire milestone is complete. " +
          "If facts are missing, propose or require a specific evidence-gathering task for the workforce. Never invent evidence or success. " +
          "The runtime schedules further debate and execution; do not start your own continuation workflow.",
        mode: "subagent",
        hidden: true,
        permission: { "*": "deny", edit: "deny", bash: "deny" },
      } as const
      config.agent["magi-reviewer"] = reviewer
      config.agent["magi-judge"] = { ...reviewer, description: "Independent evidence-based milestone judge" }
      for (const member of MagiCouncilMembers)
        config.agent["magi-" + member] = {
          ...reviewer,
          description: "Independent Magi council identity: " + member.toUpperCase(),
          prompt: MagiPrompts[member] + "\n" + reviewer.prompt,
        }
      config.command ??= {}
      config.command.magi ??= {
        description: "Start, resume, stop, or inspect the persistent Magi goal",
        agent: "magi",
        template: "Magi control request:\n$ARGUMENTS",
      }
    },
    "chat.params": async (input, output) => {
      if (
        !["magi-reviewer", "magi-judge", ...MagiCouncilMembers.map((member) => "magi-" + member)].includes(input.agent)
      )
        return
      // Decision sessions need one validated result. Keep the native repeated-tool
      // permission guard; ask compatible providers not to batch duplicate results.
      if (["@ai-sdk/openai-compatible", "@openrouter/ai-sdk-provider"].includes(input.model.api.npm))
        output.options.parallel_tool_calls = false
      if (["@ai-sdk/openai", "@ai-sdk/azure"].includes(input.model.api.npm)) output.options.parallelToolCalls = false
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
      magi_submit: tool({
        description:
          "Optionally record a meaningful progress checkpoint, artifacts and unresolved issues for the next planning meeting. Only the current execution owner may submit. Continuous mode has no completion vote; this never stops the goal.",
        args: {
          summary: tool.schema
            .string()
            .describe("Work actually performed and verification results; do not claim unperformed work"),
          artifacts: tool.schema
            .array(tool.schema.string())
            .max(20)
            .describe("Paths to actual output files inside this project"),
          unresolved: tool.schema
            .array(tool.schema.string())
            .describe("Remaining gaps, failures or questions; empty only if none are known"),
        },
        execute: (args, context) => submitExecution({ ...args, directory, sessionID: context.sessionID }),
      }),
      magi_start: tool({
        description:
          "Start autonomous research on a new persistent goal. To resume the existing goal, use magi_resume without rephrasing it.",
        args: { goal: tool.schema.string().describe("The single goal to pursue") },
        execute: (args, context) => start(context.sessionID, args.goal),
      }),
      magi_resume: tool({
        description:
          "Resume the exact saved goal without replacing or rephrasing it, only when the user asks to continue.",
        args: {},
        execute: async (_args, context) => {
          const state = await readMagiState(directory)
          if (!state.goal) throw new Error("No saved goal exists. Ask the user for a goal before starting Magi.")
          return start(context.sessionID, state.goal)
        },
      }),
      magi_stop: tool({
        description:
          "Stop the autonomous Magi goal only when the user asks to stop it; never use this to conclude a milestone",
        args: {},
        execute: async (_args, context) => {
          const state = await readMagiState(directory)
          if (state.sessionID !== context.sessionID)
            throw new Error("Only the goal's user conversation can stop Magi; workers must report their result")
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
        execute: async (args, context) => {
          if ((await readMagiState(directory)).sessionID !== context.sessionID)
            throw new Error("Worker output is evidence, not user steering. Report it to the council instead")
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
        respond(
          "Magi has saved the goal and activated its council. Briefly acknowledge this control request. The server schedules independent discussion and approved OmO work after this reply; do not execute the goal in this conversation.",
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
        await dispose()
        return
      }
      if (reporting.disposed) return
      if (event.type === "session.deleted") {
        const state = await readMagiState(directory)
        if (state.loopActive && event.properties.info.id === state.sessionID) await setAutonomousLoop(directory, false)
        return
      }
      if (event.type === "session.error" && event.properties.error?.name === "MessageAbortedError") {
        if (event.properties.sessionID && isRecoveryAbort(directory, event.properties.sessionID)) return
        const state = await readMagiState(directory)
        if (state.loopActive && [state.sessionID, state.executionSessionID].includes(event.properties.sessionID))
          await setAutonomousLoop(directory, false)
        return
      }
      if (event.type !== "session.status" || event.properties.status.type !== "idle") return
      const state = await readMagiState(directory)
      if (
        state.loopActive &&
        [state.sessionID, state.executionSessionID].includes(event.properties.sessionID) &&
        (await controller.acquire())
      )
        await pump()
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
