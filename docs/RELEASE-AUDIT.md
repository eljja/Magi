# Public release audit

Audit date: **2026-09-08 (KST)**. Scope: the installable `packages/oh-my-magi` package, its documentation, and integration with current OpenCode. Existing uncommitted work was retained and reviewed. The requester confirmed that there was no external Implementation Plan to incorporate.

## Conclusion

The original checkout was **not ready for a public “fully autonomous, latest-OmO-based, all-clients-supported” claim**. It had a promising council loop, but several failure paths could fabricate approvals, lose control of the session, or report completion without evidence. Its README described functionality and installation that were not established by its implementation.

The revised default is a persistent **single-goal, unlimited** controller. No iteration cap is applied, including when an old configuration contains `maxCycles`. Initial milestone completion creates another research increment for the same goal. Request failures and council non-approval retry after a delay. Only explicit user stop, an explicitly selected finite-completion mode, or loss of the host/runtime prevents continuation.

This does not imply that an LLM can always solve a task, run while its host is off, bypass permissions, or provide guaranteed correct research.

## Upstream and OmO

| Component                                           | Observed at audit | Relationship                                               |
| --------------------------------------------------- | ----------------- | ---------------------------------------------------------- |
| OpenCode executable                                 | `1.18.29`         | Actual Windows CLI install and server smoke target         |
| `@opencode-ai/plugin` / `@opencode-ai/sdk`          | `1.18.29`         | Exact runtime/type dependencies for this package           |
| OpenTUI                                             | `0.4.5`           | Current plugin peer baseline used for the TUI build        |
| Existing monorepo OpenCode plugin workspace         | `1.14.40`         | Legacy fork; no claim that the entire monorepo was rebased |
| `oh-my-opencode` npm `latest`                       | `4.19.4`          | Upstream stable channel; not installed by Magi             |
| `oh-my-opencode` npm `beta` / GitHub latest release | `5.0.0-beta.48`   | Upstream beta channel; not installed by Magi               |
| `oh-my-magi` npm                                    | 404/not published | Public registry installation remains a release gate        |

Primary sources: [OpenCode release](https://github.com/anomalyco/opencode/releases/tag/v1.18.29), [OpenCode plugin specification](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/specs/tui-plugins.md), [OmO beta release](https://github.com/code-yeongyu/oh-my-openagent/releases/tag/v5.0.0-beta.48), [OmO registry metadata](https://registry.npmjs.org/oh-my-opencode), [OpenCode plugin registry metadata](https://registry.npmjs.org/@opencode-ai/plugin/1.18.29).

Magi has local council/executor/specialist implementations. It does not import or vendor the upstream OmO engine, background-agent scheduler, tool suite, or workflow hooks. Preserving existing agent definitions is an interoperability provision, not proof of harness parity or coexistence. Upstream package metadata declares `SUL-1.0`; any future vendoring/distribution needs an explicit provenance and license review. Do not relabel this independent MIT package as a current OmO fork.

A future full OmO integration should pin a chosen channel, define which controller owns idle/continuation events, isolate shared agent/command names, preserve third-party notices, and test against that exact harness. That integration has **not** been represented as implemented.

## Defects addressed

| Severity | Original defect                                                                            | Change / evidence                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Critical | Missing council responses produced fallback “approve” votes and generic tasks              | Missing/malformed proposals and votes cannot authorize execution                                                            |
| Critical | No tests / unavailable or invalid judge could still approve completion                     | At least one successful check plus independent valid review and executor evidence are required                              |
| High     | Memory-only global session set was lost on restart and shared across projects              | Goal, session, run generation, execution evidence and ownership persist in project state                                    |
| High     | Multiple servers/duplicate idle events could contend for one project                       | Process scheduling lease, cycle guard, message deduplication, owner-session check                                           |
| High     | Stop raced with pending LLM results                                                        | Stop invalidates the run generation; stale council work cannot inject; owner session abort requested                        |
| High     | 50-cycle default stopped research and state overrode configured budgets                    | Unlimited default; old iteration-limit settings ignored                                                                     |
| High     | Completed roadmap stopped research                                                         | Continuous mode appends a research increment under the original goal                                                        |
| High     | Trivial/repair “fast-track” routing bypassed the autonomous council/cycle bookkeeping      | Autonomous execution always follows council authorization; routing helper is no longer used by the loop                     |
| High     | Verification ran arbitrary root scripts, hung indefinitely, and lacked diagnostic evidence | Explicit project-relative commands, monorepo root auto-detection disabled, timeouts, bounded output, judge receives reports |
| High     | Empty `tools: {}` did not disable internal-session tools                                   | Dedicated read-only reviewer agent with deny-by-default permissions                                                         |
| High     | Timed-out review sessions could continue and deletion omitted directory                    | HTTP abort signal, server abort, awaited project-scoped deletion                                                            |
| High     | Execution-dispatch errors were swallowed                                                   | Error state and retry path; failures are no longer presented as successful injection                                        |
| High     | Package relied on unpublished workspace dependency specifiers and raw TUI TSX              | Exact public SDK dependencies, compiled separate server/TUI entrypoints, build/prepack scripts                              |
| High     | Installer appended `/tui` to npm specs and used incorrect palette triggers                 | Same package spec for both targets; current keymap commands call actual SDK session commands                                |
| High     | JSONC regex modified string contents and malformed configs could be overwritten            | `jsonc-parser` parsing/editing; comments/options preserved; malformed inputs rejected                                       |
| High     | Legacy Magi plugin and local auto-load wrappers collide with new controller                | Conflict reproduced against actual OpenCode; recognized registrations/templates/wrappers migrated with backups              |
| Medium   | Default agent/models were overwritten or hardcoded in docs                                 | User agent/default/provider settings retained; exact user-configured model IDs                                              |
| Medium   | Provider discovery used a fabricated API shape                                             | Actual `all/models/connected` SDK response with disconnected providers excluded                                             |
| Medium   | State JSON could be partially observed or lose same-process updates                        | Serialized read/modify/write and atomic JSON replacement                                                                    |
| Medium   | Device-specific default milestones appeared in unrelated projects                          | Goal-specific general research/development milestones                                                                       |
| Medium   | Agent prompts could claim that selection or roleplay starts a real council                 | Control tools and server responsibilities documented in the agent prompt                                                    |
| Medium   | English word-boundary routing broke Korean requests                                        | Unicode-aware boundaries                                                                                                    |
| Medium   | README conflated fork widgets, upstream OmO, and plugin support                            | Canonical English/Korean/plugin docs rewritten; legacy translations marked                                                  |

## Validation performed

- Baseline: 43 tests, 4 failures; local workspace typecheck passed but did not establish latest SDK compatibility.
- Revised unit/contract suite (54 passing tests): real SDK over a local HTTP fixture; unlimited cycles, persistent ownership, stop during deliberation, duplicate events, configuration preservation, timeout behavior, and verification rejection cases.
- Latest SDK package typecheck and OpenTUI compilation passed.
- Actual OpenCode `1.18.29` on Windows detected both package targets, loaded Magi agents, verified two executor turns and entered the third cycle with a deterministic local provider, and persisted stop.
- The isolated actual-server test also exposed legacy plugin conflicts during development; the final passing run isolates configuration and installs into its own temporary Git project.
- A package tarball was built and installed into an isolated consumer with production dependencies. Both the server/root exports and packaged CLI loaded successfully; packed dependency metadata contains no workspace/catalog specifiers.

Run from `packages/oh-my-magi`:

```sh
bun test
bun typecheck
bun run build
bun run smoke
bun pm pack
```

The fixture is intentionally deterministic. It verifies transport, plugin hooks, and scheduling, not the quality of actual LLM decisions. The test ends after its assertions; production research has no corresponding iteration limit.

## Client support and remaining release gates

| Gate                                                                  | Status / required action                                                                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Local source installation into current OpenCode                       | Passed on Windows 1.18.29                                                                                                       |
| Actual server continuation and stop                                   | Passed with deterministic local provider                                                                                        |
| TUI rendering and keyboard/palette actions                            | Current API types/build verified; manual interactive QA still required                                                          |
| Desktop GUI session selection, slash commands, tool controls, restart | Shared backend design; full application QA still required                                                                       |
| Browser/web navigation, reconnection, live command handling           | Browser project/session navigation, Magi agent selection, and /magi status passed; full reconnection/long-run QA remains        |
| Remote terminal Magi panel                                            | Unsupported: panel reads local state files; shared server tools remain available                                                |
| Cross-platform runtime                                                | CI matrix added; only Windows run was observed in this audit                                                                    |
| Real local/hosted model endurance                                     | Required: prolonged operation, context compaction, provider throttling/outage, tool permission requests, actual reproducibility |
| Full upstream OmO integration/coexistence                             | Not implemented/certified; independent engine is accurately documented                                                          |
| npm namespace ownership and publication                               | Required; no npm publish was performed                                                                                          |
| Global/custom legacy configuration migration                          | Exact generated local artifacts migrated; inspect custom/global sources                                                         |
| Dedicated OS daemon/service                                           | Not implemented; use a supervised persistent OpenCode server                                                                    |
| Very long-run storage management                                      | Run reports and milestone history grow; archive/rotation policy remains operational work                                        |

Before announcing general availability, run the application/provider checks above and record versions and results. Never turn a successful synthetic test into a claim of perfect or indefinitely reliable autonomous research.

## Local installation result

The existing global OpenCode installation was 1.15.3. It was updated to the official stable 1.18.29 package and the executable version was verified. This checkout was migrated to relative compiled oh-my-magi entrypoints; old generated commands, agents and wrappers were backed up under .opencode/magi-migration. The project doctor passed. Restart existing OpenCode processes to pick up both changes.

Windows directory creation was also tested against this checkout. Existing read-only-attribute directories can produce EEXIST in Bun, so runtime/installer directory creation now checks existing directories before creation.
