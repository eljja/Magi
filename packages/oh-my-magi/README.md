# oh-my-magi

See the [installation, CLI and GUI evaluation](https://github.com/eljja/Magi/blob/omm/docs/END-TO-END-AUDIT.ko.md) for actual-provider results and remaining limitations. Public npm 0.1.1 and subsequent source fixes are tracked separately.

Continuous, single-goal research and development governance over the **official OmO runtime** in OpenCode.

**Real-model endurance qualification is incomplete.** Earlier free-model runs produced real council decisions, specialist reads, code repairs and preserved original test passes, but did not finish the then-required completion review. The current default removes that review and uses continuous progress checkpoints with four-hour/unanimous-significance reports. See the [current operation guide](https://github.com/eljja/Magi/blob/omm/docs/CONTINUOUS-OPERATION.ko.md) and [historical live-model audit](https://github.com/eljja/Magi/blob/omm/docs/REAL-MODEL-AUDIT.ko.md). Deterministic integration does not establish real-model endurance.

Magi's three identities use separate decision sessions and persistent judgment histories. Opening arguments are independent; final votes follow peer review. OpenCode validates proposals and votes through native `StructuredOutput`, so council models must support tool calling. All three valid final votes are required before applying majority/unanimous policy. Missing votes never imply approval. Partial meetings resume after transient failures without repeating completed judgments.

The user talks to Magi; a fresh official OmO child session executes each approved task. The executor can submit results, real artifact paths and unresolved issues through `magi_submit`, then end its response. Only the current approved executor may submit; submission never accepts a milestone or stops the goal. Existing workers that finish without this tool still undergo verification from their response and actual tool evidence.

**Continuous mode has no separate completion vote.** At a natural handoff, actual execution evidence and mechanical checks feed the next planning meeting, even when work remains or checks fail. `magi_submit` is optional. All three still debate and vote on the next action. They may include an evidence-backed `significantProgress` assessment in their final opinions; three such assessments about observed progress trigger an early user report. Approval of planned work alone does not trigger it. Explicit legacy `mode: "complete"` retains milestone completion review and file-snapshot validation.

The default roadmap describes the user's continuing goal. Council-approved increments determine how to advance it; a fixed setup/research phase does not hold implementation back. Existing roadmaps are preserved. Continuous mode records progress without marking milestones complete or waiting for a completion ceremony.

<p align="center"><img src="https://raw.githubusercontent.com/eljja/Magi/main/assets/magi-execution.svg" alt="Original Magi execution concept" width="900"></p>
<p align="center"><img src="https://raw.githubusercontent.com/eljja/Magi/main/assets/magi-council.svg" alt="MELCHIOR, BALTHASAR and CASPER: the Magi council concept" width="760"></p>

## Installation

**0.1.1 is published on npm.** The `latest` tag points to this release, and the downloaded package matches the verified release artifact. Use the versioned command below to install or update from 0.1.0.

Requires Bun 1.3.13+ and OpenCode 1.18.29+. The SDK and current compatibility target are 1.18.31. The package includes an exact dependency on `oh-my-opencode@4.19.4` (the official oh-my-openagent stable distribution). Register **only OMM**.

Run this in your operating-system terminal, then restart OpenCode. Global installation makes Magi available across folders:

```sh
opencode plugin oh-my-magi@0.1.1 --global
```

The package name is **oh-my-magi**, not `omm` (an unrelated npm package). Omit `--global` only for intentional project-local installation. Run installation in a terminal, not an AI conversation.

For development from this package directory:

```sh
bun run build
bun bin/cli.ts install --local --project /absolute/path/to/project
# Or run in your target project:
opencode plugin /absolute/path/to/Magi/packages/oh-my-magi
```

OpenCode detects `dist/server.js` and `dist/tui.js`. The server composes the actual upstream OmO plugin with Magi. The optional TUI uses the native OpenCode TUI plugin API. Restart OpenCode after changing plugin or OmO configuration.

Already using OmO? OMM recognizes its npm server/TUI registrations in global, ancestor/project and explicit OpenCode config files. It backs up their original contents and paths under `.magi/backups/`, replaces the registrations with OMM, and preserves model settings, comments, plugin options and unrelated plugins. If migration happens during OpenCode startup, **restart OpenCode once**: that process may already have loaded the old OmO, so OMM deliberately waits for the next startup before initializing its own workforce. During migration or startup failure, a visible Magi setup agent explains the issue instead of disappearing. Custom wrappers and inline environment configuration need explicit inspection. The CLI installer performs the migration before startup and also moves recognized legacy files under `.opencode/magi-migration/`.

On affected Windows/Bun builds, an existing ReadOnly runtime directory can prevent OpenCode from starting with `EEXIST` before any plugin loads. Run `bunx oh-my-magi doctor --repair-windows --project <project>` and restart. This repairs directory attributes on known runtime folders, without changing files or ACLs. See [Bun #34413](https://github.com/oven-sh/bun/issues/34413).

## Start, inspect, guide and stop

```text
Select the magi agent, then send your goal:
Continuously research this topic and improve the evidence.
/magi status
Prioritize reproducibility before adding new experiments.
Why did you choose this approach? Just explain it.
/magi stop
/magi resume
```

Talk normally in the session running the goal, just as you would talk to Sisyphus. The server records ordinary user messages before OmO augments the prompt, appends a conversation receipt to `COUNCIL.md`, and includes the message in the next council deliberation. Priorities and corrections guide the existing goal; questions receive normal answers and are not authorization to change work. Replies to these messages cannot be used as milestone completion evidence. Guidance stays pending until incorporated by an approved step, including when it arrives during an ongoing meeting. This does not interrupt an already running tool; changes are scheduled by the council.

Only the active goal's session is captured. Synthetic system prompts, child/reviewer sessions, slash-command templates and conversations while stopped are excluded. Replayed recent message IDs are deduplicated. `/magi steer <guidance>` and `/magi feedback <guidance>` remain optional compatibility commands.

`magi_start`, `magi_status`, `magi_steer` and `magi_stop` are also exposed as tools. Selecting Magi and sending the first ordinary message saves it as the goal and starts the runtime. Council/reviewer requests inherit the selected model unless explicitly configured otherwise. No slash command or model-generated start-tool call is required. Stopped goals stay stopped until explicitly resumed. Start/resume verifies that an actual upstream primary executor is available. Both the first approved slash-command task and subsequent tasks use the real upstream agent display name.

The saved goal is immutable during a run. Guidance is queued atomically, included in the next council proposal, and acknowledged only when an approved task incorporates it. Additional guidance arriving during a meeting survives that meeting. Stop preserves the goal. Repeating start/resume on an active goal does not create a duplicate cycle.

For offline control from this package:

```sh
bun bin/cli.ts status --project /absolute/path/to/project
bun bin/cli.ts doctor --project /absolute/path/to/project
bun bin/cli.ts stop --project /absolute/path/to/project
```

Offline stop disables future scheduling. A running Magi server also aborts the saved execution session and its descendants on its next reporting tick (within 15 seconds under normal operation). OpenCode's stop command or interrupt provides the immediate path. Doctor verifies dependency/registration health; it does not certify a running provider.

## Models and verification

Use OpenCode provider/auth configuration for local or hosted models. OmO agent models and capabilities belong in `.omo/omo.jsonc`, for example:

```jsonc
{
  "agents": {
    "sisyphus": { "models": ["your-provider/your-model"] },
    "explore": { "models": ["your-provider/your-model"] },
    "librarian": { "models": ["your-provider/your-model"] },
  },
  "categories": {
    "deep": { "models": ["your-provider/your-model"] },
    "quick": { "models": ["your-provider/your-model"] },
  },
}
```

Unspecified OmO agents use upstream model selection. Its model guards, permissions and user-disabled capabilities remain effective; installing the package does not make every model suitable for every agent. Configure additional agents/categories as needed using the pinned upstream schema. Legacy Magi `roles.sisyphus` and `roles.specialists` fields do not configure upstream OmO; migrate them to the OmO config.

OmO 4.19 stores OpenCode-only settings under the literal `"[opencode]"` key, including the brackets. OMM backs up and migrates older project settings, preserves explicit models/options and comments, and places its competing-loop exclusions in this namespace. Plain `"opencode"` and root-level plugin-only options can make the strict upstream loader reject the entire file. Use the canonical namespace in user-global OmO files as well; OMM does not rewrite those files.

Magi's `.magi/config.jsonc` controls its council and verification:

```jsonc
{
  "roles": { "council": "your-provider/your-model" },
  "selfImprovement": { "mode": "continuous" },
  "reporting": { "intervalMs": 14400000, "notifySession": true },
  "resilience": { "timeoutMs": 180000, "maxRetries": 2, "fallbackChain": [] },
  "verification": {
    "commands": [
      { "name": "tests", "command": ["bun", "test"], "cwd": "packages/your-package" },
      { "name": "types", "command": ["bun", "typecheck"], "cwd": "packages/your-package" },
    ],
    "timeoutMs": 120000,
  },
}
```

Git and Git repositories are optional; ordinary folders can run Magi. For research, supply commands that validate experiment artifacts, metrics, data integrity or reproducibility. Missing checks never count as success. Automatic script detection is deliberately conservative and does not run tests from a monorepo root. A working directory must remain inside the project.

Council members may use separate `council.melchiorModel`, `balthasarModel` and `casperModel` settings. They run through real OpenCode requests in isolated decision sessions. After mechanical checks, the next planning meeting uses observed progress and failures to choose useful work. No operational tools are available to council requests. Proposals can include concrete progress criteria; these do not require the entire goal to finish before another meeting.

Artifact snapshots work without Git and resolve paths inside the project. The shared evidence includes up to 20 files, their SHA-256 hashes and the first 4 KiB of each file, explicitly marking truncation. Files over 16 MiB require separate reproducible verification evidence. These are evidence-packing limits, not goal or meeting iteration limits.

`maxCycles` and `maxDebateRounds` are ignored, including in old configurations. Each round shares three opening assessments, then collects rebuttals and three final votes; both phases are archived. Meetings have no round ceiling: each scheduler turn saves one round, and an unapproved meeting resumes with its objections and a revised proposal. Recent rounds stay in prompt context while the full meeting archive remains on disk. Request retry limits and timeout intervals apply to individual operations, not the lifelong goal loop. Continuous mode adds another increment when the initial roadmap completes. Optional `mode: "complete"` stops after verified roadmap completion; use continuous mode for indefinite work.

`resilience.stallTimeoutMs` defaults to 1800000 (30 minutes without message/tool progress). The watchdog examines the owner and active descendants, waits for live progress, and aborts stalled attempts before recovering the approved task. Increase this interval for legitimately silent long-running work. Transient failures back off up to 30 minutes between retries, with no retry-count ceiling on the goal. Authentication/model configuration errors are reported explicitly; fix the configuration and resume. A folder without checks can start: the council asks the executor to establish meaningful reproducible checks first. Missing checks still never count as completion.

## Reports and meeting records

Use `oh-my-magi monitor --project <folder>` or the TUI palette's **Open Magi Live Monitor** to open the monitor. `--no-open` prints the local URL. Each opening argument and final vote appears as it arrives; with the server's 15-second publisher, browser display can lag by 15–30 seconds. The TUI reads every two seconds. Desktop/web users share the server and conversation reports; the TUI panel is not embedded in those clients.

User reports default to **four hours of observed active host time**, excluding paused/offline time. A unanimous significant-progress signal in an ordinary planning meeting can report earlier without a completion meeting or stopping execution. Reports are archived as `.magi/reports/msg_*.md`, copied to `.magi/LATEST-REPORT.md`, and delivered to the owner conversation as a labeled runtime record with `noReply`. No extra model call is needed, and the record is excluded from user steering. OpenCode may display it as a user-style conversation entry, not an assistant answer. Failed delivery retries from a durable outbox while work continues. Set `reporting.notifySession: false` to keep only local reports.

Open `.magi/index.html` directly in a local browser. It needs no external service or JavaScript framework. The page refreshes every 15 seconds; inspect the timestamp to tell whether the server is alive. It is a read-only monitor; issue control commands through OpenCode.

- `COUNCIL.md`: append-only human-readable proposals, all council decisions (including withheld authorization), directives, outcomes and user interventions. Outcomes identify their cycle/run instead of replacing an earlier meeting's text.
- `USER-GUIDANCE.md`: persistent chronological conversation source, retained after pending messages are consumed.
- `MEMORY.md`: model-maintained working memory saved with approved council proposals. New deliberations and session compaction read this memory, user guidance and the meeting ledger; original records take precedence over summaries. When excerpts are insufficient, the council must request a concrete workforce investigation; decision sessions cannot read additional files themselves.
- `STATUS.md`: latest status snapshot.
- `reports/YYYY-MM-DD.md`: cumulative one-minute snapshots while active.
- `events/YYYY-MM-DD.jsonl`: durable intermediate controller events, votes and errors, beyond the bounded TUI history.
- `ROADMAP.md` and `roadmap.json`: the roadmap and canonical milestone state.
- `runtime/`: saved goal, generation, owning session and pending guidance.

The controller uses an OS-owned local lease rather than trusting a PID file, so stale or malformed lease metadata cannot keep a dead process in control. OpenCode and the model server must still remain available; the plugin does not start the operating system or install a boot service.

## Updating compatibility

`compatibility.json` records minimum/tested OpenCode and upstream OmO versions. Run `bun script/check-compatibility.ts` to compare them with npm. Set `MAGI_OPENCODE_VERSION=latest` for the smoke test, update SDK and plugin dependencies together, then run package typecheck, tests and the real smoke before changing the tested version. The CI matrix checks minimum and moving latest OpenCode on Windows, Linux and macOS. Weekly scheduling becomes active when this workflow reaches the repository default branch. New upstream versions are tested before adoption; no blind automatic major upgrades are applied. `publish-oh-my-magi.yml` provides an npm trusted-publishing workflow after the package owner configures that trust on npm.

Reporting uses a separate timer so a long council call does not block updates. Automatic tool observations include descendant sessions and are explicitly labeled as telemetry. Raw tool arguments are fingerprinted rather than stored in telemetry; common credential patterns are redacted from report output. Reports may still contain project material and should be reviewed before sharing.

History is retained without deleting old meetings. Daily report/event files can be archived externally when disk usage grows. The HTML page contains bounded recent events so browsing does not require loading the complete archive.

## OmO integration and continuation ownership

`src/omo-runtime.ts` loads the actual upstream server plugin, preserves its hook surface and tool definitions, and composes Magi's hooks after upstream hooks. Startup verifies the upstream primary agent and `task` tool. Runtime dispatch verifies the available agent through the OpenCode API and never silently falls back to an unrelated default agent.

Startup prepares the **canonical upstream `.omo/omo.jsonc`**, preserves existing settings/comments and writes backups to `.magi/backups/` when changing an existing file. Recognized legacy project settings are carried forward. User and parent disabled hooks are retained, including profile overrides.

Magi replaces these project-level scheduling hooks:

| Upstream hook                | Ownership in OMM                                               |
| ---------------------------- | -------------------------------------------------------------- |
| `todo-continuation-enforcer` | Magi schedules the next approved task after verification       |
| `goal`                       | Magi owns the persistent single goal                           |
| `atlas`                      | Magi owns plan continuation; the Atlas agent remains available |

The upstream sidebar self-registration is disabled so it does not add another global TUI plugin; OMM supplies its own panel. Upstream telemetry defaults to disabled in generated configuration. No upstream agent/tool is disabled by OMM. Existing user-disabled features are not forcibly enabled.

Do not launch another autonomous goal/plan workflow in the same managed session. Stop first to switch workflows. User stop also signals upstream continuation cancellation; resume clears the pinned upstream continuation guard through its skill pre-hook without launching a separate plan.

## CLI, desktop, web and unattended use

All clients use the same server plugin, commands and tools. The optional terminal panel is not a desktop/web widget. The local monitor page can be opened independently; on a remote server the report files must be accessed on that server. Remote TUI file synchronization is not provided.

Keep `opencode serve` (or `opencode web`) running in the project for unattended execution. Connect clients to that server rather than running competing servers for the same project. Magi uses a project lease and saved session state to recover after server restarts when the project is loaded again. Permissions, unavailable credentials, offline models or a stopped host can prevent progress. Use a process supervisor outside the plugin if you require host-level restart policies.

The scheduler has no iteration cap. Council rejection and runtime failures trigger delayed reconsideration. While descendant sessions are busy/retrying, Magi defers final verification and dispatch recovery. It never marks a milestone complete solely because a model says it is done.

## Development and release

Run from this package directory:

```sh
bun test
bun typecheck
bun run build
bun pm pack
bun run smoke
```

`smoke` uses the actual OpenCode binary and actual OmO dependency with an isolated deterministic provider. It checks native plugin installation, agent registration, the first execution agent, real `task → explore → read` delegation, repeated cycles, steering, stop/resume and reports. `MAGI_OPENCODE_BIN` can select an already installed official binary. No provider credentials are needed for this test.

Regression coverage includes partial meetings, isolated execution, reviewer outages, control ownership and repeated-evidence stalls. Windows integration with actual OpenCode 1.18.29 / 1.18.31 and OmO 4.19.4 covers a non-Git folder with Git removed from PATH, global installation, existing-OmO migration, Magi selection plus an ordinary goal message, delegation and stop/resume. Real-model workflow reliability, endurance and full interactive UI checks remain qualification work; finite automated runs do not prove indefinite uptime. Review the dated audits, tarball and third-party notices for each release. Updating an upstream version requires rerunning these integration checks; beta compatibility is not implied by stable support.

From a source checkout, `bun run smoke:live` runs a separate real-provider qualification using `MAGI_LIVE_MODEL` and a hidden-input or environment-provided `OPENROUTER_API_KEY`. It only accepts current zero-price `:free` tool models, forwards real responses, and checks a protected original test suite. Its 20-minute / 80-request test allowance does not limit Magi's goal loop. See the [reproduction instructions](https://github.com/eljja/Magi/blob/omm/docs/AUTONOMY-DESIGN.ko.md#검증과-재현). Default decision timeout is three minutes; workforce stall timeout is thirty minutes. Repeated identical tool evidence does not count as fresh progress.

OMM code is MIT. OmO retains its **SUL-1.0** license. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) and the [engineering audit](../../docs/RELEASE-AUDIT.md).
