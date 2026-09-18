# Oh-My-Magi

**One persistent goal. The real OmO workforce. A council you can observe and guide.**

<p align="center">
  <img src="assets/magi-execution.svg" alt="Original Magi concept artwork showing council votes and continuous self-improvement" width="900">
</p>

[한국어](README.ko.md) · [Installation and configuration](packages/oh-my-magi/README.md) · [Engineering audit](docs/RELEASE-AUDIT.md) · [Contributing](CONTRIBUTING.md)

**Real-model qualification:** live OpenRouter free-model trials through OpenCode exposed repeated investigation and provider 429 errors. A complete real-model debate → implementation → verification → next meeting has **not passed**. Read the [live-model audit (Korean)](docs/REAL-MODEL-AUDIT.ko.md) before relying on unattended operation.

Oh-My-Magi (OMM) adds continuous research and development governance to [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) (OmO) on OpenCode. It loads the official `oh-my-opencode@4.19.4` server plugin as a dependency, including its agent factories, tools, skills, MCP integration and background task manager. These are upstream implementations, not recreated agent prompts.

Magi maintains one goal, proposes the next step, obtains independent council votes, delegates approved work to the OmO workforce, and verifies the result. **There is no iteration limit.** Completing the initial roadmap leads to another research or improvement increment within the same goal.

The three council perspectives are **Melchior** (architecture and scientific reasoning), **Balthasar** (risk and safety veto), and **Casper** (practical value and user intent). Their model-generated decisions are recorded separately from automatic tool telemetry.

<p align="center">
  <img src="assets/magi-council.svg" alt="Magi three-member council concept: MELCHIOR-1, BALTHASAR-2 and CASPER-3" width="760">
</p>

_Original Magi concept artwork: three minds deliberate, the workforce acts, and one goal keeps advancing. OMM carries this identity into its OmO-based plugin._

## Install

**0.1.1 is prepared but awaiting npm publication.** The npm command below becomes available after release; use the source-build instructions below in the meantime. Published version 0.1.0 does not include these fixes.

Run this in your operating-system terminal, then restart OpenCode:

```sh
opencode plugin oh-my-magi@0.1.1 --global
```

The npm package is **oh-my-magi**; `omm` names an unrelated package. Use `--global` for availability across folders. Only OMM needs registration; it loads its pinned OmO dependency. Existing recognized OmO registrations are backed up and migrated while preserving model and agent settings. If migration occurs at startup, restart OpenCode once to load the new configuration without duplicate managers.

To use the current source with Bun **1.3.13+** and OpenCode **1.18.29+** (current target: **1.18.31**):

```sh
git clone --branch omm https://github.com/eljja/Magi.git
cd Magi
bun install --ignore-scripts
cd packages/oh-my-magi
bun run build
bun bin/cli.ts install --local --project /absolute/path/to/your/project
```

Alternatively, run `opencode plugin /absolute/path/to/Magi/packages/oh-my-magi` in the target project after building. OpenCode detects the server and optional TUI targets. The OMM installer additionally backs up and migrates recognized legacy registrations.

Connect a model in OpenCode, select **magi**, and send your goal. The runtime starts automatically; Git is optional and missing verification checks can be established by the first approved task:

```text
Continuously improve the reproducibility and accuracy of this research pipeline
/magi status
Prioritize reproducibility before adding new experiments.
Why did you choose this approach? Just explain it.
/magi stop
/magi resume
```

Local OpenCode-compatible LLM providers are supported; Magi uses OpenCode's existing authentication and provider settings. OmO's agent-specific model restrictions still apply. See the [configuration guide](packages/oh-my-magi/README.md#models-and-verification).

## Observe and intervene

Open **`.magi/index.html`** in a browser for the goal monitor. It refreshes every 15 seconds and shows the current goal, phase, council votes, recent decisions, tool activity and pending guidance. Talk normally in the OpenCode session running your goal to guide Magi, just as you would talk to Sisyphus. No steering command is required.

| Artifact                        | Purpose                                                                                                                     |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `.magi/COUNCIL.md`              | Accumulating meeting minutes: proposals, votes, rejected/revised decisions, approved directives, outcomes and user guidance |
| `.magi/STATUS.md`               | Latest readable progress report                                                                                             |
| `.magi/reports/YYYY-MM-DD.md`   | Progress snapshots every minute while active                                                                                |
| `.magi/events/YYYY-MM-DD.jsonl` | Durable council/controller events, including intermediate votes and failures                                                |
| `.magi/ROADMAP.md`              | Current milestones and verified progress                                                                                    |
| `.magi/runtime/`                | Saved goal, session ownership, pending guidance and recovery state                                                          |

Reporting continues while the council or executor is working. Tool telemetry includes descendant sessions; it does not pretend that a tool completion is an LLM judgment or a verified success. Ordinary messages in the active goal session are recorded in the meeting ledger and queued for the next council deliberation. Questions receive conversational answers; they are not new work authorization, and their replies cannot count as milestone completion. Guidance stays queued until an approved council step incorporates it. Messages in other sessions or while stopped do not steer or restart the goal. `/magi steer` remains an optional compatibility command.

Meetings have no round limit: unapproved proposals return with recorded objections for revision and further evidence. `USER-GUIDANCE.md` retains conversation history and `MEMORY.md` holds working memory; later meetings and context compaction read them alongside the council ledger. A watchdog detects stalled workforce attempts, and transient failures use increasing retry delays without imposing a goal iteration limit.

## How it works

```mermaid
flowchart TD
  User[User: one goal and guidance] --> Council[Magi: proposal and three independent votes]
  Council -->|Approved| OmO[Official OmO executor, specialists and tools]
  OmO --> Verify[Mechanical checks and independent review]
  Verify -->|Verified milestone or repair needed| Council
  Council -->|Revise, reject or transient error| Retry[Wait and reconsider the same goal]
  Retry --> Council
  Council --> Records[Minutes, progress reports and monitor]
  OmO --> Records
  Verify --> Records
  Records --> User
```

Magi owns the project's autonomous scheduling. Startup prepares `.omo/omo.jsonc` and disables OmO's competing `todo-continuation-enforcer`, `goal` and `atlas` scheduling hooks. **The upstream agents and tools remain available**, including Atlas as an agent; its independent continuation loop is replaced by Magi's council loop. Other configured OmO capabilities and permission controls remain in effect.

Keep an OpenCode server running for unattended work. The saved goal recovers when the server restarts and loads the project. OMM is a plugin, not an operating-system service: it cannot work while its host, machine or LLM is unavailable. It waits or retries rather than claiming unverified completion.

## Compatibility and release status

**0.1.1 update pending publication:** agent selection and ordinary goal entry start automatically; Git is optional and council members exchange arguments before final votes. The versioned command above requires the 0.1.1 release.

**Previously published:** [oh-my-magi 0.1.0](https://www.npmjs.com/package/oh-my-magi) is available on npm. Its registry artifact matches the reviewed release tarball. See the [publication record (Korean)](docs/RELEASE-AUDIT.md#publication-attempt).

- **Compatibility:** minimum OpenCode `1.18.29`, current SDK/target `1.18.31`, official OmO npm stable `4.19.4`. CI checks the minimum and moving latest versions. See the [upgrade procedure](packages/oh-my-magi/README.md#updating-compatibility).
- **Actual Windows integration (OpenCode 1.18.29 and 1.18.31):** global installation into a non-repository folder with Git absent from PATH, existing OmO migration/restart, selecting Magi and sending an ordinary goal, real `task → explore → read`, three consecutive cycles, conversational steering, stop/resume and reports passed with a deterministic local provider.
- **Cross-platform CI:** all six minimum/latest OpenCode jobs on Linux, macOS and Windows, plus the core regression job, passed. [0.1.1 validation run](https://github.com/eljja/Magi/actions/runs/35353297752).
- **Package validation:** the current source passes 85 automated tests (355 assertions), typechecking and build. The earlier release tarball passed deterministic integration after production-only installation into a separate consumer project; see the dated audits for its scope.
- **CLI, desktop and web:** share the server-side agents, tools and commands. The optional TUI panel is specific to the terminal; the file-based monitor works separately in a browser.
- **Remaining qualification checks:** a complete real-provider workflow (the free-model trials failed), endurance runs, full interactive desktop/TUI and reconnect QA. Short automated tests do not prove infinite uptime or every upstream feature/provider combination.

See the [0.1.1 user-flow audit (Korean)](docs/USER-FLOW-AUDIT.ko.md) and [historical 0.1.0 release audit](docs/RELEASE-AUDIT.md). The repository retains an older OpenCode fork and legacy Magi packages; the maintained plugin is `packages/oh-my-magi`.

## License

OMM's own code is MIT. **The OmO dependency is SUL-1.0, not MIT**, and retains its original notices and restrictions. See [third-party notices](packages/oh-my-magi/THIRD-PARTY-NOTICES.md) and [security](SECURITY.md). OMM is not an official upstream OmO product.
