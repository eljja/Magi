export type MagiRoute = "council" | "fast-track"

export type MagiRouteDecision = {
  route: MagiRoute
  title: string
  reason: string
  prompt?: string
}

export type MagiRouteInput = {
  arguments?: string
  fastTrack: boolean
  maxFastTrackChars?: number
}

const CouncilHints = [
  "architecture",
  "architectural",
  "security",
  "auth",
  "database",
  "migration",
  "refactor",
  "multi-file",
  "self-improve",
  "self improvement",
  "major",
  "breaking",
  "schema",
  "api",
  "permission",
  "parallel",
  "자가",
  "아키텍처",
  "보안",
  "마이그레이션",
  "리팩터",
]

const FastTrackHints = [
  "typo",
  "spelling",
  "format",
  "comment",
  "rename",
  "copy",
  "lint",
  "small",
  "minor",
  "문구",
  "오타",
  "맞춤법",
  "주석",
  "이름",
]

export function routeMagiRequest(input: MagiRouteInput): MagiRouteDecision {
  const request = input.arguments?.trim() ?? ""
  const normalized = request.toLowerCase()
  const maxFastTrackChars = input.maxFastTrackChars ?? 220

  if (!input.fastTrack) {
    return {
      route: "council",
      title: "Magi council",
      reason: "Fast-track routing is disabled.",
    }
  }

  if (!request) {
    return {
      route: "council",
      title: "Magi council self-improvement",
      reason: "No explicit user task was provided, so Magi should propose and vote on the next improvement.",
    }
  }

  if (normalized.includes("--fast-track")) {
    return fastTrack(request.replace(/--fast-track/g, "").trim(), "The user explicitly requested Magi fast-track.")
  }

  if (
    normalized.includes("--council") ||
    request.includes("\n") ||
    CouncilHints.some((hint) => new RegExp(`(?<![\\p{L}\\p{N}_])${hint}(?![\\p{L}\\p{N}_])`, "u").test(normalized))
  ) {
    return {
      route: "council",
      title: "Magi council",
      reason: "The request appears architectural, risky, or explicitly council-gated.",
    }
  }

  if (
    request.length <= maxFastTrackChars &&
    FastTrackHints.some((hint) => new RegExp(`(?<![\\p{L}\\p{N}_])${hint}(?![\\p{L}\\p{N}_])`, "u").test(normalized))
  ) {
    return fastTrack(
      request,
      "The request appears small and low-risk, so the executor can handle it without convening the council.",
    )
  }

  return {
    route: "council",
    title: "Magi council",
    reason: "The request is not clearly trivial, so MELCHIOR, BALTHASAR, and CASPER must vote by majority.",
  }
}

function fastTrack(request: string, reason: string): MagiRouteDecision {
  return {
    route: "fast-track",
    title: "Magi fast-track",
    reason,
    prompt: [
      "Magi fast-track selected this low-risk task without convening the three-persona council.",
      "Keep the change minimal, verify it directly, and do not expand scope.",
      "",
      "Task:",
      request,
    ].join("\n"),
  }
}
