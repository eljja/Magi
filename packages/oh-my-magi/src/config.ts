import path from "node:path"
import type { MagiVotePolicy, MagiVetoPolicy } from "./council"

export type ResilienceConfig = {
  timeoutMs: number
  maxRetries: number
  fallbackChain: string[]
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
  }
  display: {
    transcriptLimit: number
  }
}

export const MagiConfigDefault: MagiConfig = {
  council: {
    votePolicy: "majority",
    vetoPolicy: "safety-critical",
    maxDebateRounds: 1,
  },
  roles: {
    council: "zai/glm-5.2:max",
    sisyphus: "zai/glm-5.2:pro",
  },
  resilience: {
    timeoutMs: 60000,
    maxRetries: 2,
    fallbackChain: ["zai/glm-5.2:max", "zai/glm-5.2:pro", "zai/glm-5.2"],
  },
  selfImprovement: {
    enabled: false,
    maxCycles: 50,
  },
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
      maxDebateRounds: positiveInt(local.council?.maxDebateRounds, MagiConfigDefault.council.maxDebateRounds),
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
      timeoutMs: positiveInt(local.resilience?.timeoutMs, MagiConfigDefault.resilience.timeoutMs),
      maxRetries: positiveInt(local.resilience?.maxRetries, MagiConfigDefault.resilience.maxRetries),
      fallbackChain: Array.isArray(local.resilience?.fallbackChain)
        ? (local.resilience.fallbackChain.filter((item): item is string => typeof item === "string") as string[])
        : MagiConfigDefault.resilience.fallbackChain,
    },
    selfImprovement: {
      enabled: local.selfImprovement?.enabled ?? MagiConfigDefault.selfImprovement.enabled,
      maxCycles: positiveInt(local.selfImprovement?.maxCycles, MagiConfigDefault.selfImprovement.maxCycles),
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
  let insideString = false
  let escaped = false
  let result = ""
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    const next = text[i + 1]
    if (insideString) {
      result += char
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === '"') {
        insideString = false
      }
      continue
    }
    if (char === '"') {
      insideString = true
      result += char
      continue
    }
    if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n" && text[i] !== "\r") {
        i++
      }
      result += text[i] ?? ""
      continue
    }
    if (char === "/" && next === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        i++
      }
      i++
      continue
    }
    result += char
  }
  const clean = result.replace(/,(\s*[}\]])/g, "$1")
  try {
    return JSON.parse(clean)
  } catch {
    return {}
  }
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback
}
