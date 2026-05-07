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

2. Rebase Magi onto upstream `main`.

```powershell
git rebase upstream/main
```

3. Resolve conflicts in the small Magi integration points first.

- `packages/opencode/src/config/config.ts`: config schema hook for `magi`
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
npx --yes bun --cwd packages/app typecheck
```

5. Push Magi.

```powershell
git push origin main
```

## Isolation Rules

- Keep Magi council logic in `packages/magi`.
- Keep app UI glue in `packages/app/src/components/magi-*.tsx`.
- Keep OpenCode file edits limited to schema registration and one-line component mounting.
- Do not place Magi runtime behavior directly inside OpenCode session code unless there is no stable API boundary.
- When OpenCode adds a native extension point, move Magi integration to that extension point and remove direct patches.
