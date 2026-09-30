import path from "node:path"
const root = path.resolve(import.meta.dirname, "..")
for (const [source, naming] of [
  ["src/server.ts", "server.js"],
  ["bin/cli.ts", "cli.js"],
] as const) {
  const result = await Bun.build({
    entrypoints: [path.join(root, source)],
    outdir: path.join(root, "dist"),
    naming,
    target: "bun",
    format: "esm",
    packages: "external",
  })
  if (!result.success) throw new AggregateError(result.logs, "oh-my-magi build failed")
}
