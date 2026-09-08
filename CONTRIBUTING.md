# Contributing to Magi

The public plugin is `packages/oh-my-magi`. The rest of this repository contains the retained OpenCode fork and legacy integration. Keep changes scoped to the relevant implementation and describe which one a pull request affects.

## Plugin development

Install Bun 1.3.13+ and Git. From the repository root, run `bun install --ignore-scripts`. Then run all plugin checks from the package directory:

```sh
cd packages/oh-my-magi
bun test
bun typecheck
bun run build
bun run smoke
bun pm pack
```

The smoke test runs current OpenCode against an isolated deterministic provider. It does not use real provider credentials. For a local executable, set `MAGI_OPENCODE_BIN` before running it.

Never run tests or typechecking from the monorepo root. Follow [AGENTS.md](AGENTS.md), including package-specific instructions when editing the fork. Use `dev` or `origin/dev` for baseline comparisons.

## Review expectations

Explain the defect, changed behavior, and checks performed. Preserve unrelated user changes and existing agent/provider settings. Add behavioral regression tests for scheduling, stop/restart, permission, installation, and verification defects. Prefer actual SDK/file/process behavior over mocks.

The default autonomous mode must preserve one goal without an iteration cap. Do not turn missing LLM evidence, empty verification, or a failed request into an approval. User stop must remain effective during pending council work.

Update the [release audit](docs/RELEASE-AUDIT.md) when changing compatibility claims. A typecheck is not a desktop/web end-to-end test. An OmO-inspired agent name is not an upstream harness integration.

## Publishing

Build and inspect the tarball from the plugin package. Verify that runtime dependencies contain no `workspace:` or `catalog:` specifiers, that separate `./server` and `./tui` exports load, and that installation works outside this monorepo. Confirm npm ownership and run real-provider and interactive-client release gates before publication.

Do not publish tokens, local configuration, research inputs, or generated runtime reports. Follow [Security](SECURITY.md) for vulnerability reporting.
