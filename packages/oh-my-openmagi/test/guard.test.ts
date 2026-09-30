import { test, expect } from "bun:test"
import { protectControl } from "../src/guard"
import { redact } from "../src/views"

test("workers cannot invoke human controls or edit their runtime config", () => {
  expect(() =>
    protectControl("bash", { command: "bunx oh-my-openmagi stop" }, "/project", "/private/openmagi"),
  ).toThrow()
  expect(() => protectControl("edit", { filePath: ".magi/openmagi.jsonc" }, "/project", "/private/openmagi")).toThrow()
  expect(() =>
    protectControl("read", { filePath: "/private/openmagi/connection.json" }, "/project", "/private/openmagi"),
  ).toThrow()
  expect(() =>
    protectControl(
      "edit",
      { filePath: "src/server.ts", newString: 'const text = "/magi stop"' },
      "/project",
      "/private/openmagi",
    ),
  ).not.toThrow()
  expect(() =>
    protectControl("read", { filePath: ".magi/VOTES-LATEST.md" }, "/project", "/private/openmagi"),
  ).not.toThrow()
})
test("common tokens and authorization headers are redacted", () => {
  expect(redact("Authorization: Bearer secret-token")).not.toContain("secret-token")
  expect(redact("Authorization: Basic bG9jYWw6c2VjcmV0")).not.toContain("bG9jYWw6c2VjcmV0")
  expect(redact("sk-abcdefghijklmnopqrstuvwx")).toBe("[REDACTED]")
})

test("control guards recognize versioned commands and move targets without blocking sibling paths", () => {
  for (const name of ["oh-my-magi", "oh-my-openmagi", "omm"])
    expect(() =>
      protectControl("bash", { command: `bunx ${name}@0.2.0 stop` }, "/project", "/private/openmagi"),
    ).toThrow()
  expect(() =>
    protectControl("bash", { command: "bunx oh-my-openmagi@0.1.0 stop" }, "/project", "/private/openmagi"),
  ).toThrow()
  expect(() =>
    protectControl(
      "apply_patch",
      { patchText: "*** Update File: src/a.ts\n*** Move to: .magi/openmagi.jsonc" },
      "/project",
      "/private/openmagi",
    ),
  ).toThrow()
  expect(() =>
    protectControl("edit", { filePath: "/private/openmagi-not-runtime/source.ts" }, "/project", "/private/openmagi"),
  ).not.toThrow()
})
