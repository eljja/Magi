# Security

Magi is an autonomous coding/research plugin. Starting a goal authorizes repeated model-selected work in the OpenCode execution environment until stopped. The default mode has no iteration limit.

## Execution boundaries

OpenCode and Magi are not operating-system sandboxes. Use an isolated checkout, container, VM, or otherwise appropriate environment when the task requires stronger isolation.

Council and independent-review sessions use a read-only tool allowlist. Execution agents retain the user's OpenCode permissions; Magi does not automatically approve permission prompts. Verification commands run directly as local processes from `.magi/config.jsonc` or detected package scripts, without an OpenCode permission dialog. Treat repository configuration and scripts as executable code.

A branch is not an isolation boundary. Magi does not silently switch the user's checkout during autonomous cycles. Prompt instructions to preserve files are not a substitute for filesystem permissions.

## Stop and recovery

`/magi stop` invalidates pending work and asks OpenCode to abort the owner session. The standalone CLI `stop` updates persisted continuation state even if Magi configuration is malformed. Neither operation reverses external effects of an already executing command.

State and process ownership are local to a project. Keep one controller per project directory. Restarting the server resumes a saved active goal only once that project's plugin is loaded again.

## Data and credentials

Configure providers through OpenCode. Never commit provider credentials. Runtime state and reports may contain goals, source excerpts, command outputs, or private research. Common token patterns are redacted in collected evidence, but redaction is not a comprehensive secret-detection guarantee.

Startup writes `.magi/.gitignore` for runtime, run artifacts, backups, reports, events, the monitor and meeting minutes. Decide explicitly which reviewed documents and non-secret configuration should be versioned for your project. Redaction is not a guarantee that reports are safe to publish.

The full upstream OmO plugin is loaded as a dependency and retains its own tools, hooks and permission behavior. Magi disables the three competing project-level scheduling hooks, not upstream security guards. Review `.omo/omo.jsonc` and the upstream SUL-1.0 license when deploying or distributing the combined system.

Keep servers on loopback unless remote access is intentional and appropriately authenticated. Follow the security documentation for the exact OpenCode version you deploy.

## Reporting

Report a reproducible vulnerability privately using this repository's GitHub security reporting feature if enabled. Do not place credentials, exploit details affecting others, or private research into a public issue. If private reporting is unavailable, open a minimal issue asking the maintainer for a private reporting channel.

Include affected versions, installation mode, reproduction steps, expected/actual behavior, and impact. Findings are evaluated on evidence regardless of which tools helped discover them.

See the [release audit](docs/RELEASE-AUDIT.md) for unverified client/runtime combinations and remaining release work.
