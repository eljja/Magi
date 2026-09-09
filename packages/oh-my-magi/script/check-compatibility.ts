import compatibility from "../compatibility.json"
const packages = ["opencode-ai", "@opencode-ai/plugin", "@opencode-ai/sdk", "oh-my-opencode"]
const versions = await Promise.all(
  packages.map(async (name) => {
    const response = await fetch("https://registry.npmjs.org/" + name + "/latest", {
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) throw new Error(name + ": " + response.status)
    const data = (await response.json()) as { version: string }
    return [name, data.version]
  }),
)
console.log(
  JSON.stringify(
    {
      tested: compatibility,
      registry: Object.fromEntries(versions),
      next: "Run MAGI_OPENCODE_VERSION=latest bun run smoke. Upgrade SDK/plugin together, rerun typecheck/tests, then update compatibility.json after actual integration passes.",
    },
    null,
    2,
  ),
)
