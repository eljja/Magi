import path from "node:path"

export type MagiCouncilProvider = "google" | "openai" | "anthropic" | "opencode"

export type MagiMemberRuntimeConfig = {
  provider?: MagiCouncilProvider
  model?: string
  fallbacks?: string[]
  apiKeyEnv?: string[]
  endpoint?: string
}

export type MagiRuntimeConfig = {
  council: {
    provider: MagiCouncilProvider
    model: string
    fallbacks: string[]
    apiKeyEnv: string[]
    endpoint?: string
    dryRun: boolean
    melchior?: MagiMemberRuntimeConfig
    balthasar?: MagiMemberRuntimeConfig
    casper?: MagiMemberRuntimeConfig
  }
  loop: {
    maxRounds: number
    injectApprovedPrompt: boolean
  }
  display: {
    transcriptLimit: number
  }
  router: {
    fastTrack: boolean
    maxFastTrackChars: number
  }
  safety: {
    branchSelfImprovement: boolean
    branchPrefix: string
    writeRunReport: boolean
  }
  context: {
    enabled: boolean
    maxChars: number
  }
}

export const MagiRuntimeDefault = {
  council: {
    provider: "google" as const,
    model: "gemini-3.1-flash-lite-preview",
    fallbacks: ["gemini-3.1-flash-lite", "gemini-3-flash-preview", "gemini-3.1-pro-preview"],
    apiKeyEnv: ["MAGI_GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
    dryRun: false,
  },
  loop: {
    maxRounds: 1,
    injectApprovedPrompt: true,
  },
  display: {
    transcriptLimit: 24,
  },
  router: {
    fastTrack: true,
    maxFastTrackChars: 220,
  },
  safety: {
    branchSelfImprovement: true,
    branchPrefix: "magi/self-improve/",
    writeRunReport: true,
  },
  context: {
    enabled: true,
    maxChars: 6000,
  },
} satisfies MagiRuntimeConfig

export function magiConfigPath(directory: string) {
  return path.join(directory, ".magi", "config.jsonc")
}

export async function loadMagiRuntimeConfig(directory: string): Promise<MagiRuntimeConfig> {
  const local = await readConfig(await findMagiConfigPath(directory))
  const envDryRun = process.env.MAGI_DRY_RUN === "1" || process.env.MAGI_DRY_RUN === "true"
  return {
    council: {
      provider: local.council?.provider ?? MagiRuntimeDefault.council.provider,
      model: local.council?.model ?? process.env.MAGI_COUNCIL_MODEL ?? MagiRuntimeDefault.council.model,
      fallbacks: local.council?.fallbacks ?? MagiRuntimeDefault.council.fallbacks,
      apiKeyEnv: local.council?.apiKeyEnv ?? MagiRuntimeDefault.council.apiKeyEnv,
      endpoint: local.council?.endpoint,
      dryRun: envDryRun || (local.council?.dryRun ?? MagiRuntimeDefault.council.dryRun),
      melchior: parseMemberConfig(local.council?.melchior),
      balthasar: parseMemberConfig(local.council?.balthasar),
      casper: parseMemberConfig(local.council?.casper),
    },
    loop: {
      maxRounds: positiveInt(local.loop?.maxRounds, MagiRuntimeDefault.loop.maxRounds),
      injectApprovedPrompt: local.loop?.injectApprovedPrompt ?? MagiRuntimeDefault.loop.injectApprovedPrompt,
    },
    display: {
      transcriptLimit: positiveInt(local.display?.transcriptLimit, MagiRuntimeDefault.display.transcriptLimit),
    },
    router: {
      fastTrack: process.env.MAGI_FAST_TRACK === "0" ? false : (local.router?.fastTrack ?? MagiRuntimeDefault.router.fastTrack),
      maxFastTrackChars: positiveInt(local.router?.maxFastTrackChars, MagiRuntimeDefault.router.maxFastTrackChars),
    },
    safety: {
      branchSelfImprovement:
        process.env.MAGI_BRANCH_SELF_IMPROVEMENT === "0"
          ? false
          : (local.safety?.branchSelfImprovement ?? MagiRuntimeDefault.safety.branchSelfImprovement),
      branchPrefix: local.safety?.branchPrefix ?? MagiRuntimeDefault.safety.branchPrefix,
      writeRunReport: local.safety?.writeRunReport ?? MagiRuntimeDefault.safety.writeRunReport,
    },
    context: {
      enabled: process.env.MAGI_CONTEXT === "0" ? false : (local.context?.enabled ?? MagiRuntimeDefault.context.enabled),
      maxChars: positiveInt(local.context?.maxChars, MagiRuntimeDefault.context.maxChars),
    },
  }
}

export async function findMagiConfigPath(directory: string): Promise<string> {
  const root = path.parse(path.resolve(directory)).root
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    const file = magiConfigPath(current)
    if (await Bun.file(file).exists()) return file
    if (current === root) return magiConfigPath(directory)
  }
}

async function readConfig(file: string) {
  if (!(await Bun.file(file).exists())) return {}
  return parseJsonc(await Bun.file(file).text()) as Partial<MagiRuntimeConfig>
}

export function parseJsonc(input: string) {
  return JSON.parse(
    input
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
      .replace(/,\s*([}\]])/g, "$1"),
  ) as unknown
}

function positiveInt(value: number | undefined, fallback: number) {
  return Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback
}

function parseMemberConfig(val: unknown): MagiMemberRuntimeConfig | undefined {
  if (typeof val !== "object" || val === null) return undefined
  const obj = val as Record<string, unknown>
  return {
    provider: typeof obj.provider === "string" ? (obj.provider as MagiCouncilProvider) : undefined,
    model: typeof obj.model === "string" ? obj.model : undefined,
    fallbacks: Array.isArray(obj.fallbacks) ? obj.fallbacks.filter((x): x is string => typeof x === "string") : undefined,
    apiKeyEnv: Array.isArray(obj.apiKeyEnv) ? obj.apiKeyEnv.filter((x): x is string => typeof x === "string") : undefined,
    endpoint: typeof obj.endpoint === "string" ? obj.endpoint : undefined,
  }
}
