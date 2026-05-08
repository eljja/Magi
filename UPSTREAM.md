# Upstream Update Strategy

Magi tracks OpenCode as an upstream base while keeping Magi-specific behavior isolated.

## Remotes

- `origin`: `https://github.com/eljja/Magi.git`
- `upstream`: `https://github.com/anomalyco/opencode.git`

## Update Flow

1. Fetch OpenCode updates.

```powershell
git fetch upstream
```

2. Rebase Magi's `dev` branch onto upstream `dev` when available. If upstream does not publish `dev`, rebase onto upstream `main`.

```powershell
git rebase upstream/dev
```

3. Resolve conflicts in the small Magi integration points first.

- `packages/opencode/src/config/config.ts`: config schema hook for `magi`
- `packages/opencode/src/server/routes/instance/httpapi/api.ts`: registers the Magi HTTP API group
- `packages/opencode/src/server/routes/instance/httpapi/server.ts`: registers Magi handlers
- `packages/opencode/src/server/routes/instance/httpapi/groups/magi.ts`: Magi API contract
- `packages/opencode/src/server/routes/instance/httpapi/handlers/magi.ts`: thin runtime bridge into OpenCode sessions
- `packages/app/src/components/settings-general.tsx`: renders `MagiSettingsRows`
- `packages/app/src/components/session/session-header.tsx`: renders `MagiSelfImprovementToggle`
- `packages/app/src/i18n/en.ts`: Magi UI labels
- `.opencode/opencode.jsonc`: default LM Studio and Magi config

4. Re-run validation.

```powershell
npx --yes bun --cwd packages/magi test
npx --yes bun --cwd packages/magi typecheck
npx --yes bun --cwd packages/opencode test test/config/config.test.ts
npx --yes bun --cwd packages/opencode typecheck
npx --yes bun packages/sdk/js/script/build.ts
npx --yes bun --cwd packages/sdk/js typecheck
npx --yes bun --cwd packages/app typecheck
```

5. Push Magi.

```powershell
git push origin dev
```

## Isolation Rules

- Keep Magi council logic in `packages/magi`.
- Keep app UI glue in `packages/app/src/components/magi-*.tsx`.
- Keep OpenCode file edits limited to schema registration, API registration, thin handler bridging, and component mounting.
- Do not place Magi runtime behavior directly inside OpenCode session code unless there is no stable API boundary.
- When OpenCode adds a native extension point, move Magi integration to that extension point and remove direct patches.
