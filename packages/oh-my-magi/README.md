# oh-my-magi 🧙‍♂️ (OMM)

> **Autonomous multi-agent council plugin for OpenCode**, powered by the triumvirate of **Melchior**, **Balthasar**, and **Casper**, governing the **Sisyphus** lead execution engine and the full **OmO** specialist workforce.

Inspired by the `oh-my-openagent` (OmO) architecture and elevated by Magi's tripartite governance, **oh-my-magi** (`omm`) transforms OpenCode into an executive-directed, self-steering autonomous engineering and scientific research team. It operates directly through your configured OpenCode LLM providers with zero hardcoded API keys.

---

## 🏛️ Executive-Manager Hierarchy

```mermaid
graph TB
    subgraph "Supreme Council (Magi)"
        M[MELCHIOR: Theory & Architecture] <--> B[BALTHASAR: Risk, Flaws & Safety Veto]
        B <--> C[CASPER: Product Value & User Intent]
        M <--> C
    end

    subgraph "Lead PM & Orchestrator"
        S[Sisyphus (OmO)]
    end

    subgraph "Specialist Workforce (OmO Sub-agents)"
        E[Explore: Fast Grep & Search]
        L[Librarian: Papers & Documentation]
        O[Oracle: Deep Architecture & Intractable Debugging]
        H[Hephaestus: Refactoring Artisan]
        A[Atlas: System Architecture]
    end

    User[User Goal / Task] -->|Agent: magi or /magi start| M
    Magi -->|Approved Milestones & Directives (.magi/ROADMAP.md)| S
    S -->|Delegates Search| E
    S -->|Delegates Docs/Research| L
    S -->|Delegates Deep Reasoning| O
    S -->|Delegates Refactoring| H
    S -->|Executes, Edits Code, Verifies| S
    S -->|Milestone Complete Signal (session.idle)| Magi
    Magi -->|Balthasar Flaw Check / Test Runner / Corrective Orders / STOP| S
```

---

## 🤖 Built-in Agent Roster

### Primary Agents (Directly Selectable in OpenCode UI)
1. **`magi` (Default / Supreme Council)**:
   - 3-Member Council (Melchior, Balthasar, Casper) providing multi-perspective debate, master roadmap management (`.magi/ROADMAP.md`), and closed-loop verification over Sisyphus.
   - Configured by default with **`zai/glm-5.2:max`** for maximum reasoning depth.
2. **`sisyphus` (Lead Execution PM)**:
   - Full-throttle lead execution engine. Dispatches specialized subagents (`explore`, `librarian`, `oracle`) and coordinates complex file editing, tool execution, and verification.
   - Configured by default with **`zai/glm-5.2:pro`** for rapid, balanced execution.
3. **`hephaestus` (Refactoring & Evolution Artisan)**:
   - Autonomous refactoring specialist. Decomposes monolithic files, eliminates technical debt, and modernizes legacy codebases without regressions.
4. **`atlas` (System Architecture Orchestrator)**:
   - Master orchestrator for large-scale multi-phase system architecture and roadmap tracking.

### On-Demand Specialist Subagents
- **`explore`**: High-speed, read-only codebase grep & search specialist (`mode: subagent`).
- **`librarian`**: External documentation, NPM/Python packages, open-source codebases, and literature research specialist (`mode: subagent`).
- **`oracle`**: Strategic technical advisor and deep reasoning consultant for high-stakes decisions and subtle bugs (`mode: subagent`).
- **`metis`**: Pre-planning consultant; analyzes intent and flags ambiguities before work begins (`mode: subagent`).
- **`momus`**: Pragmatic plan reviewer; ensures plans are executable without blockers (`mode: subagent`).
- **`multimodal-looker`**: Visual QA specialist for inspecting UI screenshots, diagrams, and rendered assets (`mode: subagent`).

---

## 🛡️ Resilience, Model Fallbacks & Role Routing

To prevent hangs and maintain an unstoppable development loop even when models disconnect or become slow:

1. **Timeout Guard & Exponential Backoff**:
   - Each LLM request is protected by a 60-second timeout guard.
   - If a request drops or stalls, it automatically retries with exponential backoff (1s, 2s).
2. **Auto-Degradation Fallback Chain**:
   - If `glm-5.2:max` times out or fails all retries, the engine smoothly downgrades to `glm-5.2:pro` and continues without stopping.
3. **Custom Configuration (`.magi/config.jsonc`)**:

```jsonc
{
  "roles": {
    "council": "zai/glm-5.2:max", // Deep reasoning for council deliberations
    "sisyphus": "zai/glm-5.2:pro"  // High speed for execution and test cycles
  },
  "resilience": {
    "timeoutMs": 60000,
    "maxRetries": 2,
    "fallbackChain": [
      "zai/glm-5.2:max",
      "zai/glm-5.2:pro",
      "zai/glm-5.2"
    ]
  }
}
```

---

## 🧭 Intermediate Steering & Human-in-the-Loop

OpenCode is fully interactive. While Magi and Sisyphus are running:
- **Immediate Input**: Simply type any instruction or correction into the chat. It is immediately registered as top-priority user guidance for the next cycle.
- **Urgent Council Redirection**: Type `/magi <new direction>` at any point to immediately convene Melchior, Balthasar, and Casper to revise the active milestone and update `.magi/ROADMAP.md`.
- **Halt Anytime**: Run `/magi stop` to pause the loop immediately for manual inspection.

---

## 🚀 Quick Start

### Installation

Inside any project with an `.opencode` directory (or a new project):

```bash
# Global install / CLI usage
bunx oh-my-magi install

# Or install with local repo path
bun run bin/cli.ts install --local

# Check installation health
bun run bin/cli.ts doctor

# Check current council status
bun run bin/cli.ts status
```

### Slash Commands in OpenCode

- `/magi`: Convenes Melchior, Balthasar, and Casper to deliberate on the next step or custom directive.
- `/magi start` (or `/ultrawork`): Enables the continuous autonomous self-improvement loop.
- `/magi stop`: Immediately halts the autonomous loop.
- `/magi status`: Displays current council state, vote history, and active cycle count.

---

## 🧪 Testing & Type Checking

Run from `packages/oh-my-magi`:

```bash
# Run unit test suite (43 passing tests across 12 suites)
bun test

# Run type checker
bun run typecheck
```
