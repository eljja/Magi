// OpenCode validates these through its native StructuredOutput tool. Council
// sessions have no operational tools: missing evidence becomes a proposed
// workforce investigation, never an endless read loop or invented approval.
export const proposalSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "prompt", "rationale"],
  properties: {
    title: { type: "string", minLength: 1 },
    prompt: {
      type: "string",
      minLength: 1,
      description:
        "Direct instructions for the OmO executor to perform the approved work and produce evidence. This is the task itself, not instructions to generate another proposal, JSON object, or prompt.",
    },
    rationale: { type: "string", minLength: 1 },
    terminal: { type: "boolean" },
    memory: { type: "string" },
  },
}

export const judgmentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["position", "rationale"],
  properties: {
    position: { type: "string", enum: ["approve", "revise", "reject"] },
    rationale: { type: "string", minLength: 1 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    evidence: { type: "array", items: { type: "string" } },
    requiredChange: { type: "string" },
    newEvidence: { type: "boolean" },
    safetyCritical: { type: "boolean" },
  },
}

export const verdictSchema = {
  type: "object",
  additionalProperties: false,
  required: ["approved", "critique"],
  properties: {
    approved: { type: "boolean" },
    critique: { type: "string", minLength: 1 },
    recommendations: { type: "array", items: { type: "string" } },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
}
