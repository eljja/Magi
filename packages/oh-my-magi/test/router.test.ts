import { describe, expect, test } from "bun:test"
import { routeMagiRequest } from "../src/router"

describe("Fast-Track Router", () => {
  test("fast-tracks trivial requests", () => {
    const typo = routeMagiRequest({
      arguments: "fix small typo in README",
      fastTrack: true,
    })
    expect(typo.route).toBe("fast-track")
    expect(typo.title).toBe("Magi fast-track")

    const comment = routeMagiRequest({
      arguments: "주석 추가",
      fastTrack: true,
    })
    expect(comment.route).toBe("fast-track")
  })

  test("routes architectural or security tasks to council", () => {
    const arch = routeMagiRequest({
      arguments: "refactor database schema for auth",
      fastTrack: true,
    })
    expect(arch.route).toBe("council")
    expect(arch.title).toBe("Magi council")

    const security = routeMagiRequest({
      arguments: "보안 취약점 개선 및 마이그레이션",
      fastTrack: true,
    })
    expect(security.route).toBe("council")
  })

  test("respects explicit flags", () => {
    const explicitCouncil = routeMagiRequest({
      arguments: "--council fix typo",
      fastTrack: true,
    })
    expect(explicitCouncil.route).toBe("council")

    const explicitFastTrack = routeMagiRequest({
      arguments: "--fast-track refactor entire core architecture",
      fastTrack: true,
    })
    expect(explicitFastTrack.route).toBe("fast-track")
  })
})
