import path from "node:path"
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser"
import type { MagiVotePolicy, MagiVetoPolicy } from "./council"

export type ResilienceConfig = {
  timeoutMs: number
  maxRetries: number
  fallbackChain: string[]
  stallTimeoutMs?: number
}

export type RolesConfig = {
  council: string
  sisyphus: string
  specialists?: string
}

export type MagiConfig = {
  council: {
    votePolicy: MagiVotePolicy
    vetoPolicy: MagiVetoPolicy
    maxDebateRounds: number
    model?: string
    melchiorModel?: string
    balthasarModel?: string
    casperModel?: string
  }
  roles: RolesConfig
  resilience: ResilienceConfig
  selfImprovement: {
    enabled: boolean
    maxCycles: number
    mode: "complete" | "continuous"
  }
  verification: {
    commands: { name: string; command: string[]; cwd?: string }[]
    timeoutMs: number
  }
  display: {
    transcriptLimit: number
  }
}

export const MagiConfigDefault: MagiConfig = {
  council: {
    votePolicy: "majority",
    vetoPolicy: "safety-critical",
    maxDebateRounds: 0,
  },
  roles: {
    council: "",
    sisyphus: "",
  },
  resilience: {
    timeoutMs: 60000,
    maxRetries: 2,
    fallbackChain: [],
    stallTimeoutMs: 1800000,
  },
  selfImprovement: {
    enabled: false,
    maxCycles: 0,
    mode: "continuous",
  },
  verification: { commands: [], timeoutMs: 120000 },
  display: {
    transcriptLimit: 24,
  },
}

export function magiConfigPath(directory: string) {
  return path.join(directory, ".magi", "config.jsonc")
}

export async function loadMagiConfig(directory: string): Promise<MagiConfig> {
  const local = await readConfigFile(await findConfigPath(directory))
  return {
    council: {
      votePolicy: local.council?.votePolicy === "unanimous" ? "unanimous" : MagiConfigDefault.council.votePolicy,
      vetoPolicy: local.council?.vetoPolicy === "none" ? "none" : MagiConfigDefault.council.vetoPolicy,
      // Kept for config compatibility. Meetings have no round limit.
      maxDebateRounds: 0,
      model: typeof local.council?.model === "string" ? local.council.model : undefined,
      melchiorModel: typeof local.council?.melchiorModel === "string" ? local.council.melchiorModel : undefined,
      balthasarModel: typeof local.council?.balthasarModel === "string" ? local.council.balthasarModel : undefined,
      casperModel: typeof local.council?.casperModel === "string" ? local.council.casperModel : undefined,
    },
    roles: {
      council: typeof local.roles?.council === "string" ? local.roles.council : MagiConfigDefault.roles.council,
      sisyphus: typeof local.roles?.sisyphus === "string" ? local.roles.sisyphus : MagiConfigDefault.roles.sisyphus,
      specialists: typeof local.roles?.specialists === "string" ? local.roles.specialists : undefined,
    },
    resilience: {
      stallTimeoutMs: positiveInt(local.resilience?.stallTimeoutMs, 1800000),
      timeoutMs: positiveInt(local.resilience?.timeoutMs, MagiConfigDefault.resilience.timeoutMs),
      maxRetries: nonNegativeInt(local.resilience?.maxRetries, MagiConfigDefault.resilience.maxRetries),
      fallbackChain: Array.isArray(local.resilience?.fallbackChain)
        ? (local.resilience.fallbackChain.filter((item): item is string => typeof item === "string") as string[])
        : MagiConfigDefault.resilience.fallbackChain,
    },
    selfImprovement: {
      enabled: local.selfImprovement?.enabled === true,
      maxCycles: 0,
      mode: local.selfImprovement?.mode === "complete" ? "complete" : "continuous",
    },
    verification: {
      commands: local.verification?.commands ?? [],
      timeoutMs: positiveInt(local.verification?.timeoutMs, MagiConfigDefault.verification.timeoutMs),
    },
    display: {
      transcriptLimit: positiveInt(local.display?.transcriptLimit, MagiConfigDefault.display.transcriptLimit),
    },
  }
}

async function findConfigPath(directory: string): Promise<string> {
  const root = path.parse(path.resolve(directory)).root
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    const file = magiConfigPath(current)
    if (await Bun.file(file).exists()) return file
    if (current === root) return magiConfigPath(directory)
  }
}

async function readConfigFile(file: string): Promise<Partial<MagiConfig>> {
  if (!(await Bun.file(file).exists())) return {}
  return parseJsonc(await Bun.file(file).text()) as Partial<MagiConfig>
}

export function parseJsonc(text: string): unknown {
  const errors: ParseError[] = []
  const result: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length)
    throw new Error(
      "Invalid JSONC: " + errors.map((error) => printParseErrorCode(error.error) + " at " + error.offset).join(", "),
    )
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Configuration must be an object")
  return result
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback
}

function nonNegativeInt(value: unknown, fallback: number): number {
  return value === 0 ? 0 : positiveInt(value, fallback)
}
