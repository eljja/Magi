# Changelog

## 0.2.0

- Publish the latest durable council/OmO implementation as **oh-my-magi**, continuing the existing npm package.
- Provide the oh-my-magi CLI, omm alias and old oh-my-openmagi CLI alias; migrate recognized older plugin registrations with backups.
- Allow the unified package's own registration while rejecting duplicate OmO/Magi registrations. Protect human control commands under every CLI alias.
- Preserve the OpenMagi state/config paths and legacy documents. The 0.1.x goal state is not automatically resumed by the new runtime.
- Keep the old implementation as a private legacy workspace. Validation of this release is recorded separately; other projects' endurance results do not qualify this artifact.

The following 0.1.0 notes describe the former development package, not a separately published oh-my-openmagi release.

## 0.1.0

Initial oh-my-openmagi package, developed separately from the legacy oh-my-magi package.

- One Magi primary agent and three hidden council members over the pinned, unmodified OmO runtime.
- Persisted continuous intent, three final votes, majority approval and evidence-based risk reconsideration.
- Durable job IDs, retry waits, independent hourly reports, Korean/command controls and a recoverable report outbox.
- Existing Markdown viewers for current votes, cumulative history, full deliberations and report archives.
- Process supervision, user-service templates, backed-up installer migration and isolated native integration tests.

Pre-publication review hardening:

- Atomic human receipts and ownership checks; resume clears stale retry phases; slash controls preserve the selected model and execute once.
- Report generation fences, recoverable document writes, and preservation of pre-existing reports.
- Retained provenance for retried council sessions, correct proposal-model selection, and a fresh timeout after recovered dispatch.
- Retry failed supervisor launches; terminate remaining descendants after launcher exit; serialize process cleanup.
- Validate nested configuration and migrate local-file legacy registrations without removing unrelated plugins.
- Bound the main history to 200 meetings while retaining complete dated archives.
- Compare the actual upstream agent definitions in isolated native compatibility tests.
- Restrict proposals to available OmO primary agents and reconsider approval when the executor disappears before dispatch.
- Scope tests to the canonical test directory; preserve per-run logs, source/archive/installed hashes and dependency locks.
- Test real supervisor recovery using owned native process fault injection and private connection PID metadata.
- Add a free-only OpenRouter qualification gateway, disposable real-provider soak harness and an exact-artifact release evidence check.
- Correct audit interpretation: a documented upstream Low exception remains unpatched; deterministic smoke and short runs do not establish real endurance qualification.
- Reject goal submission when plugin configuration failed, including inherited legacy Magi agents; verify no model dispatch in native tests.
- Identify nested dependency registrations by their closest package name rather than an ancestor checkout's name.
- Give nested qualification projects their own Git discovery boundary and verify the active controller before real-provider calls.
- Support an explicit late regression challenge for endurance tests, keeping the independent checker unchanged and recording operator intervention.
- Retry temporary OS process-launch denials before a child starts; retain unavailable verification as a dependency wait, honor human stop, and never replay completed agent work or a command's nonzero exit.
- Adopt the user-approved six-hour release trial with five hourly reports, progress across three hours, native crash recovery and a regression repair after the midpoint; reject incomplete or missing recovery evidence.
- Isolate each supervised Windows host's LSP daemon and attest named-pipe/process ownership before cleanup, releasing server sockets held by a detached daemon after a native crash. Exercise actual LSP calls before native recovery tests and reject forged ownership records without stopping another daemon.
