// User-approved release trial: six real hours, with recovery in the second half.
export const soakPolicy = {
  id: "free-llm-6h-v1",
  minutes: 360,
  durationMs: 21600000,
  progressSpanMs: 10800000,
  hourlyReports: 5,
  criteria: [
    "workforceContinuity",
    "real6Hours",
    "progressAcross3Hours",
    "hourlyReports",
    "continuousIntent",
    "checkerIntegrity",
    "independentContract",
    "recovery",
    "lateChallenge",
    "reportedUsageZero",
    "noFreePolicyViolation",
    "withinRequestLimit",
  ],
} as const

export type SoakEvidence = {
  profile?: string
  requestedMinutes?: number
  elapsedMs?: number
  reports?: number
  verifiedAt?: number[]
  maxRequests?: number
  interrupted?: boolean
  requestLimitReached?: boolean
  recovery?: { time: number; recoveredProgress: boolean }
  challenge?: { time: number; recovered: boolean }
  criteria?: Record<string, boolean>
}

export function releaseSoakPassed(detail?: SoakEvidence) {
  if (!detail || detail.profile !== soakPolicy.id || !detail.verifiedAt?.length) return false
  const first = Math.min(...detail.verifiedAt)
  const last = Math.max(...detail.verifiedAt)
  return (
    (detail.requestedMinutes ?? 0) >= soakPolicy.minutes &&
    (detail.elapsedMs ?? 0) >= soakPolicy.durationMs &&
    (detail.reports ?? 0) >= soakPolicy.hourlyReports &&
    last - first >= soakPolicy.progressSpanMs &&
    (detail.maxRequests ?? 0) > 0 &&
    (detail.maxRequests ?? Infinity) <= 600 &&
    detail.interrupted === false &&
    detail.requestLimitReached === false &&
    detail.recovery?.recoveredProgress === true &&
    last > detail.recovery.time &&
    detail.challenge?.recovered === true &&
    detail.challenge.time - first >= soakPolicy.progressSpanMs &&
    last > detail.challenge.time &&
    soakPolicy.criteria.every((key) => detail.criteria?.[key] === true)
  )
}
