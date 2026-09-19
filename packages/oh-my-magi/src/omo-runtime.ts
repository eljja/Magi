import type { Config, Hooks, Plugin, PluginInput } from "@opencode-ai/plugin"
import { containsOmOSpec, forgetOmORuntime, harmonizeOmOConfig, registerOmORuntime } from "./omo-bridge"
import { readMagiState } from "./state"
import { migrateOmORegistrations } from "./migration"
import { isRecoveryAbort } from "./watchdog"
import { isWorkforceSession } from "./workforce"
import { repairWindowsRuntime } from "./windows"
import { createMagiAgent } from "./agents/magi"
import { redact } from "./context"

export function createMagiSetupHooks(reason: string): Hooks {
  const permission = { "*": "deny", edit: "deny", bash: "deny" } as const
  return {
    config: async (config) => {
      config.agent ??= {}
      config.agent.magi = {
        ...createMagiAgent(),
        description: "Magi setup: restart or repair required",
        permission,
        prompt:
          "Explain this Magi setup issue in the user's language. Do not claim the council is running or perform the goal.\n" +
          reason,
      }
    },
    "chat.message": async (input, output) => {
      if ((input.agent || output.message.agent) !== "magi") return
      // Surface the exact startup issue even before a model/provider is connected.
      throw new Error(reason)
    },
  }
}

// Keep unknown/future upstream hooks, tool definitions and lifecycle methods intact.
export function composeHooks(upstream: Hooks, council: Hooks): Hooks {
  const result: Record<string, unknown> = { ...upstream, ...council, tool: { ...upstream.tool, ...council.tool } }
  for (const key of new Set([...Object.keys(upstream), ...Object.keys(council)])) {
    const first = Reflect.get(upstream, key)
    const second = Reflect.get(council, key)
    if (typeof first !== "function" || typeof second !== "function") continue
    result[key] = async (...args: unknown[]) => {
      if (key === "dispose") {
        const results = await Promise.allSettled([
          Reflect.apply(first, upstream, args),
          Reflect.apply(second, council, args),
        ])
        const errors = results.flatMap((item) => (item.status === "rejected" ? [item.reason] : []))
        if (errors.length) throw new AggregateError(errors, "Plugin disposal failed")
        return
      }
      // Capture the human's original parts before upstream prompt augmentation.
      if (key === "chat.message") {
        await Reflect.apply(second, council, args)
        return Reflect.apply(first, upstream, args)
      }
      await Reflect.apply(first, upstream, args)
      return Reflect.apply(second, council, args)
    }
  }
  return result as Hooks
}

export async function createOmOMagi(input: PluginInput, councilPlugin: Plugin): Promise<Hooks> {
  return initializeOmOMagi(input, councilPlugin).catch((error) => {
    const reason =
      "Magi could not initialize OmO: " +
      String(error) +
      ". Repair the plugin/provider configuration and restart OpenCode. Install with: opencode plugin oh-my-magi (omm is a different npm package)."
    console.warn(reason)
    return createMagiSetupHooks(reason)
  })
}

async function initializeOmOMagi(input: PluginInput, councilPlugin: Plugin): Promise<Hooks> {
  await repairWindowsRuntime(input.directory, process.env, true)
  const migrated = await migrateOmORegistrations(input.directory)
  if (migrated.length) {
    // OpenCode may already have initialized the old plugin from its config snapshot.
    // Never create a second workforce in that process. The next startup uses OMM.
    const message =
      "Magi preserved your OmO settings and migrated duplicate plugin registrations. Restart OpenCode once to activate OMM. Backups: .magi/backups. Updated: " +
      migrated.join(", ")
    console.warn(message)
    return createMagiSetupHooks(message)
  }
  await harmonizeOmOConfig(input.directory)
  const module = await import("oh-my-opencode")
  const upstream = await (module.default.server as unknown as Plugin)(input)
  const council = await councilPlugin(input)
  const composed = composeHooks(upstream, council)
  const resumeWorkforce = async (sessionID: string) => {
    await repairWindowsRuntime(input.directory)
    // Pinned upstream exposes its continuation reset through the start-work skill
    // pre-hook. Run only the pre-hook: do not launch a competing plan workflow.
    await upstream["tool.execute.before"]?.(
      { tool: "skill", sessionID, callID: "magi-resume-" + crypto.randomUUID() },
      { args: { name: "start-work" } },
    )
  }
  const stopWorkforce = async (skipAbort?: string) => {
    await repairWindowsRuntime(input.directory)
    const state = await readMagiState(input.directory)
    if (!state.sessionID) return
    await upstream["command.execute.before"]?.(
      { command: "stop-continuation", sessionID: state.sessionID, arguments: "" },
      { parts: [] },
    ).catch(async (error) => {
      const message = redact(
        "Upstream stop hook failed; continuing durable stop and session abortion: " + String(error),
      )
      await input.client.app
        .log({
          body: { service: "oh-my-magi", level: "warn", message },
          signal: AbortSignal.timeout(5000),
        })
        .catch(() => console.warn("Magi: " + message))
    })
    const sessions = await input.client.session
      .status({ query: { directory: input.directory }, signal: AbortSignal.timeout(10000) })
      .catch(() => undefined)
    await Promise.all(
      Object.keys(sessions?.data ?? {}).map(async (id) => {
        if (id === skipAbort) return
        if (await isWorkforceSession(input.client, input.directory, id, state.sessionID!))
          await input.client.session
            .abort({ path: { id }, query: { directory: input.directory }, signal: AbortSignal.timeout(10000) })
            .catch(() => undefined)
      }),
    )
  }
  const configure = async (config: Config) => {
    // Keep the user's entry point visible even if OmO has no usable executor yet.
    await council.config?.(config)
    if (config.plugin?.some(containsOmOSpec))
      throw new Error(
        "oh-my-magi already loads OmO. Remove the separate oh-my-opencode/oh-my-openagent server plugin entry to prevent duplicate managers.",
      )
    const problem = await Promise.resolve()
      .then(() => upstream.config?.(config))
      .then(
        () => undefined,
        (error) => String(error),
      )
    if (problem) {
      await createMagiSetupHooks(
        "OmO configuration failed: " + problem + ". Review your provider/model settings and restart OpenCode.",
      ).config?.(config)
      return
    }
    const agents = Object.entries(config.agent ?? {})
    const preferred = agents.find(
      ([name, agent]) =>
        name === Reflect.get(config, "default_agent") &&
        agent &&
        agent.mode !== "subagent" &&
        /sisyphus|hephaestus/i.test(name),
    )
    const executor =
      preferred ?? agents.find(([name, agent]) => /^sisyphus(?:\s|$)/i.test(name) && agent && agent.mode !== "subagent")
    await council.config?.(config)
    if (!executor || !upstream.tool?.task) {
      console.warn(
        "Magi is available, but OmO has no primary executor/task tool yet. Connect a model and review .omo/omo.jsonc, then restart.",
      )
      return
    }
    registerOmORuntime(input.directory, executor[0], Object.keys(upstream.tool))
    // Control stays in the human conversation; approved work uses fresh OmO children.
    config.command!.magi!.agent = "magi"
  }
  return {
    ...composed,
    tool: {
      ...composed.tool,
      magi_start: {
        ...council.tool!.magi_start!,
        execute: async (args, context) => {
          const result = await council.tool!.magi_start!.execute(args, context)
          try {
            await resumeWorkforce(context.sessionID)
          } catch (error) {
            await council.tool!.magi_stop!.execute({}, context)
            throw error
          }
          return result
        },
      },
      magi_stop: {
        ...council.tool!.magi_stop!,
        execute: async (args, context) => {
          const result = await council.tool!.magi_stop!.execute(args, context)
          await stopWorkforce(context.sessionID)
          return result
        },
      },
    },
    config: configure,
    "chat.message": async (request, output) => {
      if (output.parts.some((part) => part.type === "text" && part.metadata?.magiOrigin === "report")) return
      const before = await readMagiState(input.directory)
      await council["chat.message"]?.(request, output)
      const after = await readMagiState(input.directory)
      if (!before.loopActive && after.loopActive && after.sessionID === request.sessionID)
        await resumeWorkforce(request.sessionID)
      await upstream["chat.message"]?.(request, output)
    },
    "command.execute.before": async (request, output) => {
      const state = await readMagiState(input.directory)
      if (
        state.loopActive &&
        state.sessionID === request.sessionID &&
        ["goal", "start-work", "ralph-loop", "ulw-loop"].includes(request.command)
      )
        throw new Error(
          "Magi owns this session's goal. Talk normally in this session to guide it, or /magi stop before starting another workflow.",
        )
      if (request.command === "magi" && request.arguments.trim() === "stop") {
        await council["command.execute.before"]?.(request, output)
        await stopWorkforce()
        return
      }
      if (request.command === "magi" && /^(start(?:\s|$)|resume$)/.test(request.arguments.trim()))
        await resumeWorkforce(request.sessionID)
      if (request.command === "stop-continuation" && state.sessionID === request.sessionID)
        await council["command.execute.before"]?.({ ...request, command: "magi", arguments: "stop" }, output)
      await composed["command.execute.before"]?.(request, output)
    },
    event: async (event) => {
      if (event.event.type === "session.error" && event.event.properties.error?.name === "MessageAbortedError") {
        if (event.event.properties.sessionID && isRecoveryAbort(input.directory, event.event.properties.sessionID))
          return
        const state = await readMagiState(input.directory)
        if (
          state.loopActive &&
          [state.sessionID, state.executionSessionID].includes(event.event.properties.sessionID)
        ) {
          await council.event?.(event)
          await stopWorkforce()
        }
      }
      await composed.event?.(event)
    },
    dispose: async () => {
      try {
        await composed.dispose?.()
      } finally {
        forgetOmORuntime(input.directory)
      }
    },
  }
}
