# OMM integration and release audit

Audit date: **2026-09-09**. Scope: `omm` branch, `packages/oh-my-magi`. This supersedes the earlier audit of the independent OmO-inspired implementation.

## Intended architecture and result

The requested system is Magi governance **above the real OmO execution system**: one persistent goal, unlimited research/development iterations, specialist delegation, verifiable progress, visible meetings/reports and user intervention.

The plugin now declares an exact `oh-my-opencode@4.19.4` dependency and initializes its actual default server plugin. `omo-runtime.ts` composes upstream hooks/tools/lifecycle with Magi. It does not recreate Sisyphus or specialist prompts. Built-in Magi agents are limited to governance and review; OmO supplies the execution agents and full upstream tool implementation.

## The five previously identified gaps

| Gap                                        | Resolution                                                                                                                                                                                                       | Evidence                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| OMM installation did not supply OmO        | Real pinned production dependency; one registered OMM server loads upstream. Native package installation detects server/TUI targets.                                                                             | Package metadata/lockfile and actual OpenCode smoke                           |
| Detection only checked config strings      | Startup initializes the upstream module and requires its primary agent and `task` tool; dispatch checks the live agent API. Missing executor fails explicitly.                                                   | `omo-runtime.ts`, `omo-bridge.ts`, resolver regression and real agent listing |
| First task ran through Magi instead of OmO | The command config uses the upstream executor's exact display name before OpenCode selects its agent. Subsequent dispatch/recovery uses live agent resolution.                                                   | Smoke asserts first assistant agent and a completed upstream `task`           |
| Continuation harmonization was unused      | Both installer and runtime invoke harmonization on canonical `.omo/omo.jsonc`; disabled hooks cover todo, goal and Atlas macro scheduling. Existing settings/profiles are preserved and changed files backed up. | Configuration preservation/idempotence tests and actual startup               |
| No actual OmO integration test             | Smoke loads the real official dependency and real OpenCode binary; deterministic provider drives Sisyphus → native OmO task → explore child → read.                                                              | Parent and child message evidence, repeated cycles, stop/resume               |

**Distribution:** the initial npm 404 was caused by an unpublished package, independently of the public GitHub repository. The final publication and public installation record is appended below.

## Upstream and OmO

| Component                   | Observed version | Integration choice                                               |
| --------------------------- | ---------------- | ---------------------------------------------------------------- |
| `opencode-ai` npm latest    | `1.18.30`        | Tested official Windows binary and exact SDK/plugin dependencies |
| `oh-my-opencode` npm latest | `4.19.4`         | Exact production dependency, actual server runtime               |
| `oh-my-opencode` npm beta   | `5.0.0-beta.49`  | Not selected or claimed compatible                               |
| `oh-my-magi` npm            | Not published    | Source/tarball release preparation                               |

Sources: [OpenCode registry](https://registry.npmjs.org/opencode-ai/latest), [OmO registry](https://registry.npmjs.org/oh-my-opencode), [OpenCode plugin documentation](https://opencode.ai/docs/plugins/), [upstream repository](https://github.com/code-yeongyu/oh-my-openagent). Configuration loading, agent naming, stop/resume hooks and package exports were additionally inspected in the actual `oh-my-opencode@4.19.4` npm tarball.

This stable OmO release reads canonical `.omo/omo.jsonc`/`.omo/omo.json`, including user/parent/harness/profile layers. Writing only a root `oh-my-openagent.jsonc` was insufficient. Runtime compatibility is pinned rather than inferred from a moving GitHub default branch.

Upstream retains SUL-1.0 and its bundled third-party notices. OMM retains MIT for its own source. The build leaves upstream external; its implementation source is not vendored or relicensed. The full upstream license is included in the plugin's `licenses/` directory.

## Additional defects corrected

- **Missing rejected decisions:** withheld approvals and terminal/revision decisions are now archived; their user guidance stays pending.
- **Wrong meeting outcome association:** outcomes append with cycle/run identifiers instead of replacing the first generic waiting marker. Actual milestone IDs are recorded.
- **Unbounded ledger rewrite cost:** appends no longer read/rewrite the entire historical ledger for every cycle. File writes are serialized.
- **Swallowed record failures:** council/outcome persistence failures surface as runtime failures rather than silently losing the audit trail.
- **Lost steering during LLM calls:** guidance uses an atomic ID-based queue; only the items incorporated into an approved step are consumed. Repair instructions do not displace user guidance.
- **Misleading live judgments:** tool activity is labeled as automatic telemetry. A returned tool is not described as a completed safety review or proven success.
- **Missing child activity:** tool observations include descendant sessions. Final verification/recovery waits while descendant sessions are busy/retrying.
- **False file modifications:** read paths are no longer counted as modified files. Native `filePath` arguments are recognized.
- **Broken repeated-tool detection:** full argument fingerprints replace comparison against truncated arguments; raw argument bodies are not kept in telemetry.
- **Reporting blocked by council work:** a separate report timer keeps snapshots current during long requests. HTML refreshes every 15 seconds and active snapshots archive every minute.
- **Lost intermediate decisions:** daily JSONL event history retains proposals/status, votes and errors beyond bounded UI state.
- **Control responses mistaken for execution:** status/steering message IDs are excluded from executor evidence.
- **Repeated start resetting active work:** start/resume preserves an already active goal's generation and pending execution.
- **Offline stop overwritten by stale state:** separate durable stop markers keep scheduling disabled even if another process writes an old active state. Explicit resume only acknowledges markers that existed before it started, preserving a concurrent later stop.
- **Hook/lifecycle loss during composition:** upstream hooks and tools are retained; both disposers run even if one fails. Controller/report timers are cleaned up.
- **Duplicate engine registration:** installer removes recognized separate OmO entries with a backup; runtime rejects recognizable duplicates in effective config. Recognized global/project registrations migrate before composition; startup migration requires one restart. Custom wrappers require manual inspection.
- **Resume after upstream stop:** OMM coordinates the pinned upstream cancellation and continuation guard reset without launching an independent plan workflow.
- **Accidental report publication:** startup adds generated records/backups to `.magi/.gitignore`; maintainers can explicitly version reviewed documents.
- **Conflicting public docs:** root English/Korean and package README now describe the real dependency integration, canonical config, one-package installation, ownership and release limits consistently.

## What OMM preserves and replaces

All upstream agent factories, tool definitions, specialists, category/skill behavior, MCP integration and background task manager are loaded from the official plugin. User configuration can still disable capabilities, and provider/model/platform constraints still apply. This is not proof that every feature works with every model.

OMM owns project-level autonomous continuation and disables `todo-continuation-enforcer`, `goal`, and `atlas` hooks. Atlas remains an upstream agent; its separate plan loop is replaced. Upstream TUI self-registration is disabled because OMM supplies a dedicated panel. Upstream security/permission hooks are retained. Do not run another autonomous workflow in the same owned session.

## Verification

Run from `packages/oh-my-magi`:

```sh
bun test
bun typecheck
bun run build
bun pm pack
bun run smoke
```

Observed integration runs used OpenCode **1.18.29** on Windows and actual upstream **4.19.4**, isolated project/home/config directories and a deterministic local OpenAI-compatible provider. No real provider credentials were used.

Before conversational steering, local checks passed **69 tests, 246 assertions across 18 files**, type checking, frozen-lockfile installation, build and tarball creation. That **86 KB** tarball (39 entries) was installed into a separate consumer with production dependencies only and install scripts disabled. Its published server entry imported successfully, and the real OpenCode/OmO integration smoke passed using that consumer's installed package. The monitor was visually inspected in a browser with real smoke state.

The conversational steering update passed **73 tests, 0 failures, 268 assertions across 19 files**, type checking and a rebuilt-package smoke against the same OpenCode/OmO versions. The smoke sends an ordinary `/session/{id}/message` request, verifies its conversation receipt and queued guidance, excludes internal council prompts from that queue, and then checks stop/resume. Unit coverage also checks Korean guidance reaching the council, replay deduplication before and after consumption, upstream prompt augmentation, concurrent command/message ordering, inactive/other/child sessions, and exclusion of conversational replies from execution evidence. Natural-language interpretation is instructed through the model; these deterministic tests do not certify every model's response quality.

The stronger smoke run checked:

1. Native `opencode plugin <built package directory>` installation and server/TUI detection.
2. Real upstream primary/specialist registration plus Magi council agents.
3. The first assistant uses Sisyphus; an actual upstream task returns child evidence.
4. The explore child invokes a real read tool against a fixture file.
5. At least two verified executor turns enter a third cycle on the same goal.
6. Natural conversational steering, explicit stop and resume preserving/advancing that goal.
7. Meeting history, latest status and monitor artifacts exist.

The deterministic provider controls model outputs to make integration reproducible. It tests runtime plumbing and controller behavior, not the intelligence or long-term research quality of a real model.

## Remaining release gates and operational limits

- Public installation status is recorded below; publication is verified separately from source availability.
- Execute the Linux/macOS/Windows CI matrix remotely and retain its results. Windows local tests alone do not certify the other platforms.
- Run a sustained real local/hosted model trial, including interrupted networking, provider timeouts, context compaction and server/process restart. A finite smoke run cannot prove infinite uptime.
- Complete interactive desktop, terminal rendering and remote reconnect QA against the versions shipped. Backend compatibility does not prove every UI integration.
- The terminal panel reads local report state; remote file synchronization is not provided. The standalone monitor is a read-only local document, not an authenticated remote management server.
- OpenCode must remain alive and load the project. OMM does not install an OS daemon or restart a powered-off host. Permissions and unavailable models may require user intervention.
- Daily reports/events and meeting history accumulate intentionally. Establish external archival/storage monitoring for long-lived deployments. Reports can contain confidential project material despite common-pattern redaction.
- Custom duplicate plugin wrappers and inline environment configuration cannot all be inferred from their names. Remove independent OmO/legacy Magi loading paths when using the composed plugin.

These are explicit release/operating conditions, not claims that the implementation is already perfect or all interfaces/providers have been certified.

## Prelaunch hardening verification — 2026-09-09

The final source check passed **81 tests, 327 assertions, 20 files, zero failures**, plus package type checking and build. A fresh actual **OpenCode 1.18.30 / OmO 4.19.4** Windows run passed the complete integration scenario, including existing global OmO registration migration, backup creation, actual process restart, upstream agents, Sisyphus → task → explore → read, three continuous cycles, ordinary conversational steering, durable stop/resume and report generation. Local evidence: `.tmp/omm-integration/magi-smoke-O6dqNP/` (ignored; not distributed).

Additional regression coverage includes nine rounds of one meeting despite a legacy limit of one, archived guidance after queue consumption, malformed multi-file migration preserving originals, damaged lease metadata with a live owner, stalled workforce recovery, actionable authentication failures without same-provider request storms, and verification process-tree termination.

- Meetings persist their cycle/round and revise proposals after objections, with no round ceiling. Recent-round context is bounded; the full archive is retained.
- `MEMORY.md`, `USER-GUIDANCE.md` and `COUNCIL.md` are consumed by future meetings and compaction. Model-generated summaries are subordinate to original chronological guidance.
- The watchdog detects unchanged messages/tools; retry backoff does not impose a whole-goal retry limit. Missing verification commands are diagnosed before deliberation.
- A loopback OS socket owns the controller lease; process death releases ownership independently of JSON diagnostics and PID reuse.
- OpenCode 1.18.30 exposed the Windows ReadOnly-directory Bun regression described in [Bun #34413](https://github.com/oven-sh/bun/issues/34413). Known runtime directory attributes are repaired at plugin startup and continuation control. `doctor --repair-windows` handles failures occurring before plugin loading. The migration smoke explicitly runs this repair before rebooting its isolated host.
- Durable stop is saved before the upstream stop hook; an upstream hook failure cannot erase the stop request.
- Exact dependency pins, `compatibility.json`, the registry comparison script, minimum/latest OpenCode CI across three OSes and a trusted-publishing workflow make upgrades reviewable. Remote CI results and trusted-publisher account configuration are separate from local validation. Weekly schedules run only after the workflow reaches GitHub's default branch.

These results establish a finite, reproducible integration baseline. They do not certify indefinite real-model uptime, every native desktop/TUI screen, or future releases before testing.

## Publication attempt

The reviewed `oh-my-magi@0.1.0` artifact is 101,586 bytes with SHA-1 `63ba3561174fe36be0389db51eeafa1b9abf834a`. Its runtime matches the production-dependencies-only consumer that passed actual OpenCode 1.18.30 integration (`magi-smoke-I1Ut07`); the final tarball additionally updates README qualification wording. `npm publish --dry-run` passed.

Actual publication on 2026-09-09 returned **E403**: npm requires two-factor authentication or a granular token with bypass-2FA permission. Account authentication succeeded, but the supplied credential cannot publish under this policy. No public npm release is claimed until registry verification succeeds. The reviewed tarball remains available locally at `.tmp/omm-integration/release-final/oh-my-magi-0.1.0.tgz` for authenticated publication.
