#!/usr/bin/env bun

import path from "path"

const repo = path.resolve(import.meta.dirname, "..")
const opencode = path.join(repo, "packages/opencode")
const args = process.argv.slice(2)
const targetArgs = args.length === 0 ? [process.cwd()] : args

const proc = Bun.spawn(
  [process.execPath, "run", "--cwd", opencode, "--conditions=browser", "src/index.ts", ...targetArgs],
  {
    stdio: ["inherit", "inherit", "inherit"],
  },
)

process.exit(await proc.exited)
