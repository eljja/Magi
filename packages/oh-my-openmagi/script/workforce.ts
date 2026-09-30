import assert from "node:assert/strict"

const agents = [
  "sisyphus", "hephaestus", "prometheus", "atlas", "oracle", "explore", "librarian",
  "metis", "momus", "sisyphus-junior", "multimodal-looker",
]

export function auditOmoConfig(model: string, hephaestus = model) {
  return {
    // OmO 4.19.4 rejects a whole layer when harness-specific keys occur at its root.
    "[opencode]": {
      telemetry: false,
      auto_update: false,
      model_fallback: false,
      runtime_fallback: false,
      disabled_mcps: ["websearch", "context7", "grep_app"],
      disabled_hooks: ["auto-update-checker", "codegraph-bootstrap", "ast-grep-sg-provision"],
    },
    agents: Object.fromEntries(agents.map((name) => [name, { model: name === "hephaestus" ? hephaestus : model }])),
    categories: Object.fromEntries(
      ["visual-engineering", "ultrabrain", "deep", "artistry", "quick", "unspecified-low", "unspecified-high", "writing"]
        .map((name) => [name, { model, fallback_models: [] }]),
    ),
  }
}

export function verifyWorkforce(
  registered: { name: string; mode: string; model?: { providerID: string; modelID: string } }[],
  model: string,
  hephaestus?: string,
) {
  return agents.filter((name) => name !== "hephaestus" || hephaestus).map((name) => {
    const agent = registered.find((agent) => agent.name.toLowerCase() === name || agent.name.toLowerCase().startsWith(name + " -"))
    assert.ok(agent, "Required OmO agent is missing: " + name)
    assert.equal(agent.model && agent.model.providerID + "/" + agent.model.modelID, name === "hephaestus" ? hephaestus : model,
      "OmO model override did not take effect: " + name)
    assert.equal(agent.mode, ["sisyphus", "hephaestus", "prometheus", "atlas"].includes(name) ? "primary" : "subagent", name)
    return { name: agent.name, mode: agent.mode, model: agent.model }
  })
}
