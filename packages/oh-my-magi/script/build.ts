import solidPlugin from "@opentui/solid/bun-plugin"

const result = await Bun.build({
  entrypoints: ["./src/server.ts", "./src/tui.tsx"],
  outdir: "./dist",
  target: "bun",
  format: "esm",
  packages: "external",
  plugins: [solidPlugin],
})
if (!result.success) throw new AggregateError(result.logs, "oh-my-magi build failed")
