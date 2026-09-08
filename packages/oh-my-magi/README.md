# oh-my-magi

Persistent, unlimited research and development for one goal inside OpenCode.

## Installation

Requires Bun 1.3.13+ and OpenCode 1.18.29. The npm package is not published as of the 2026-09-08 audit. After publication:

```sh
opencode plugin oh-my-magi
```

OpenCode reads the package's separate `./server` and `./tui` exports and registers both targets. Use the **same package specifier** in both configuration files; do not append `/tui` to an npm package name.

From this repository:

```sh
# Repository root
bun install --ignore-scripts
cd packages/oh-my-magi
bun run build
bun bin/cli.ts install --local --project /absolute/path/to/project
bun bin/cli.ts doctor --project /absolute/path/to/project
```

For a fresh project you can also run `opencode plugin /absolute/path/to/Magi/packages/oh-my-magi` after building it. The dedicated installer additionally migrates recognized legacy Magi entries and wrappers. Restart OpenCode after installation.

The source installer preserves JSONC comments, unrelated plugins, and plugin options. It refuses malformed configuration. It registers commands and agents through the server hook, so new installations need no copied Markdown templates. `doctor` checks project configuration; it does not certify provider availability or load a desktop application.

## Start, steer, stop, resume

```text
/magi start A single concrete research or development goal
/magi status
/magi Focus the next experiment on reproducibility
/magi stop
/magi resume
```

- Start persists the goal and owning OpenCode session. The goal is not silently replaced by later directives.
- The default mode has **no iteration limit**. Old `maxCycles` settings are ignored.
- Completed initial milestones lead to new research increments under the same goal.
- Council rejection/revision and transient errors produce a visible state entry and delayed reconsideration, rather than fabricated success.
- The controller checks the saved state every 15 seconds. Retry proposals wait at least 60 seconds after the last state update.
- Stop invalidates pending council work and asks OpenCode to abort the owner session. External effects of an already running tool cannot be rolled back.
- Resume uses the existing goal and grants ownership to the current session if the previous run was stopped. The cycle counter is preserved.
- To deliberately replace the goal, stop first and archive `.magi/roadmap.json`, `.magi/ROADMAP.md`, and `.magi/runtime`, then start with a new goal.

The `magi` agent can use `magi_start`, `magi_status`, and `magi_stop` tools. Merely selecting it does not activate the loop. The slash command dispatches execution to `sisyphus`. Existing user agents/defaults are preserved.

For an emergency from another terminal:

```sh
bun bin/cli.ts stop --project /absolute/path/to/project
```

This stops continuation through the persisted state, including if configuration is malformed. Use the OpenCode interrupt control to stop any currently running tool.

## Models and local LLMs

Magi uses OpenCode's configured providers and default model. Council members, execution, and specialists can use different exact `provider/model` identifiers:

```jsonc
{
  "roles": {
    "council": "your-provider/your-model",
    "sisyphus": "your-provider/your-model",
    "specialists": "your-provider/your-model",
  },
  "resilience": {
    "timeoutMs": 60000,
    "maxRetries": 2,
    "fallbackChain": [],
  },
}
```

Save this as `.magi/config.jsonc` in the project. Omit `roles` to inherit OpenCode defaults. `maxRetries: 0` means one attempt; this is a per-request retry setting, never a limit on the research loop. Model fallbacks occur only among models explicitly configured by the user. Reasoning options remain in OpenCode provider configuration.

There are no required Magi API keys, no built-in model account, and no default hosted provider. An internal/local LLM works when it is configured as an OpenCode provider and supports the needed context, structured responses, and tools. Offline literature access requires locally available sources or separately configured research tools.

## Verification

A milestone advances only after at least one successful verification command **and** an independent LLM review of the milestone, executor report, and command evidence. Review sessions have a read-only tool allowlist. Missing, malformed, or failed reviews cannot approve completion.

For a single-package Bun project, Magi detects `typecheck`, `test`, and `lint` scripts. For a monorepo or research project, configure explicit commands and working directories:

```jsonc
{
  "verification": {
    "timeoutMs": 120000,
    "commands": [
      {
        "name": "package tests",
        "cwd": "packages/my-project",
        "command": ["bun", "test"],
      },
      {
        "name": "reproduce experiment",
        "command": ["python", "research/verify_results.py"],
      },
    ],
  },
}
```

Adapt this example to actual files and installed tools. Commands run locally as argument arrays, with bounded captured output and a timeout. They do not go through OpenCode's permission dialog; treat this configuration and repository scripts as executable code. Verification working directories must stay inside the project. No root test command is automatically selected for a workspace/monorepo.

For research, checks should validate actual artifacts, provenance, reproducibility, and success criteria. A test that only prints “success” does not establish scientific correctness. LLM judgments can be wrong; this is an automation and evidence-recording system.

## CLI, desktop, and web

| Surface                             | Shared engine                       | Dedicated Magi panel                           | Validation                                                             |
| ----------------------------------- | ----------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------- |
| Interactive `opencode` TUI          | Yes, while its server runs          | Local TUI panel                                | Latest types/build; full interactive QA pending                        |
| `opencode serve` + attached clients | Yes                                 | Depends on attached client                     | Actual 1.18.29 server smoke passed on Windows                          |
| One-shot `opencode run`             | Only while its process/server lives | No                                             | Use an attached persistent server for unattended work                  |
| OpenCode desktop                    | Server agents/tools/commands        | No desktop widget                              | Manual integration QA pending                                          |
| `opencode web` / browser            | Server agents/tools/commands        | No browser widget                              | Browser project/session view, Magi selection and /magi status verified |
| Remote TUI attachment               | Remote server engine                | Local-file panel is not remote-state transport | Dedicated remote panel unsupported                                     |

For unattended execution, keep a server running from the project:

```sh
opencode serve --hostname 127.0.0.1 --port 4096
```

Attach a terminal client to that server and start the goal in its session. Desktop/web clients must use the same project and server to observe/control the same goal. Loading the project after a restart recovers the persisted session; starting an empty server alone does not initialize every project's plugin.

One scheduling lease prevents two OpenCode server processes from running the same project goal simultaneously. Stale leases from exited processes can be reclaimed. Independent concurrent goals require separate project directories/worktrees.

Closing all server processes, shutting down the computer, or losing access to the model stops progress. Magi does not install a daemon, bypass permission requests, purchase capacity, or guarantee eventual success.

## Files

| Path                            | Purpose                                                                   |
| ------------------------------- | ------------------------------------------------------------------------- |
| `.magi/config.jsonc`            | Models and verification configuration                                     |
| `.magi/roadmap.json`            | Canonical goal and verified milestone ledger                              |
| `.magi/ROADMAP.md`              | Generated human-readable roadmap; Markdown edits do not change the ledger |
| `.magi/runtime/state.json`      | Active session, generation ID, cycle count, votes, recent errors          |
| `.magi/runtime/controller.json` | Process scheduling lease                                                  |
| `.magi/runtime/memory.json`     | Proposal rotation and prior outcome                                       |
| `.magi/runs/*/plan.json`        | Council decisions and execution directives                                |

State and roadmap JSON are replaced atomically. Run reports and the roadmap grow over time; archive them deliberately when needed. Do not commit private prompts, reports, credentials, or research material unintentionally.

## Migrating from the legacy Magi plugin

The old `@magi/opencode-plugin` / `packages/magi-opencode-plugin` uses the same command and runtime paths. Simultaneous loading was reproduced as a real conflict.

Run the source installer above. It replaces recognized legacy/local Magi registrations, removes duplicate Magi entries within that configuration, and backs up exact known wrappers/templates to `.opencode/magi-migration/<timestamp>/`. Custom edits are preserved for manual inspection. Also inspect global configuration, other project config files, and custom auto-loaded wrappers; project installation cannot silently fix every global source.

Back up a pre-existing legacy `.magi/runtime` before switching engines. The older OpenCode fork, its GUI council widgets, and its configuration schema are separate from this package.

## Relationship to oh-my-openagent

This is an independent implementation inspired by OmO role names and orchestration ideas. It does not vendor, import, or install the full upstream harness, background-agent manager, tool suite, or continuation hooks. Installing it does not mean the latest OmO engine is present.

Existing agent definitions are preserved for interoperability, but coexistence with OmO's own continuation systems is **not certified**. Do not enable multiple autonomous controllers for the same session. See the [upstream/version audit](https://github.com/eljja/Magi/blob/dev/docs/RELEASE-AUDIT.md#upstream-and-omo) before describing the project as an OmO-based distribution.

## Development and release

Run from `packages/oh-my-magi`:

```sh
bun test
bun typecheck
bun run build
bun run smoke
bun pm pack
```

The smoke test downloads/runs OpenCode 1.18.29 with isolated configuration and a deterministic local OpenAI-compatible fixture. Set `MAGI_OPENCODE_BIN` to a downloaded executable to avoid redownloading it. It does not use real model credentials. Test artifacts remain in its printed temporary directory for inspection.

See [release gates and known limitations](https://github.com/eljja/Magi/blob/dev/docs/RELEASE-AUDIT.md). npm publication and interactive/real-provider QA are separate from building a tarball.
