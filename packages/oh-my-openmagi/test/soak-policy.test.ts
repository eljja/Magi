import { test, expect } from "bun:test"
import { releaseSoakPassed, type SoakEvidence } from "../script/soak-policy"

function complete(): SoakEvidence {
  return {
    profile: "free-llm-6h-v1",
    requestedMinutes: 360,
    elapsedMs: 21600000,
    reports: 5,
    verifiedAt: [1000, 20000, 10861000],
    maxRequests: 600,
    interrupted: false,
    requestLimitReached: false,
    recovery: { time: 10000, recoveredProgress: true },
    challenge: { time: 10801000, recovered: true },
    criteria: {
      workforceContinuity: true,
      real6Hours: true,
      progressAcross3Hours: true,
      hourlyReports: true,
      continuousIntent: true,
      checkerIntegrity: true,
      independentContract: true,
      recovery: true,
      lateChallenge: true,
      reportedUsageZero: true,
      noFreePolicyViolation: true,
      withinRequestLimit: true,
    },
  }
}

test("the approved six-hour profile requires full duration and real observations", () => {
  expect(releaseSoakPassed(complete())).toBe(true)
  expect(releaseSoakPassed({ ...complete(), elapsedMs: 21599999 })).toBe(false)
  expect(releaseSoakPassed({ ...complete(), reports: 4 })).toBe(false)
  expect(releaseSoakPassed({ ...complete(), verifiedAt: [1000, 2000] })).toBe(false)
})

test("omitting crash or late regression evidence cannot pass the release gate", () => {
  expect(releaseSoakPassed({ ...complete(), recovery: undefined })).toBe(false)
  expect(releaseSoakPassed({ ...complete(), challenge: undefined })).toBe(false)
  expect(releaseSoakPassed({ ...complete(), challenge: { time: 5000, recovered: true } })).toBe(false)
  expect(releaseSoakPassed({ ...complete(), challenge: { time: 10801000, recovered: false } })).toBe(false)
})

test("old profiles, incomplete runs and empty or missing criteria cannot pass", () => {
  expect(releaseSoakPassed({ ...complete(), profile: undefined })).toBe(false)
  expect(releaseSoakPassed({ ...complete(), interrupted: true })).toBe(false)
  expect(releaseSoakPassed({ ...complete(), requestLimitReached: true })).toBe(false)
  expect(releaseSoakPassed({ ...complete(), maxRequests: 601 })).toBe(false)
  expect(releaseSoakPassed({ ...complete(), criteria: {} })).toBe(false)
  const missing = complete()
  delete missing.criteria!.checkerIntegrity
  expect(releaseSoakPassed(missing)).toBe(false)
})
