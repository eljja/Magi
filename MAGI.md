# Magi

Magi is an OpenCode-based dual-LLM coding IDE experiment.

Magi-specific core logic lives in `packages/magi` so OpenCode upstream updates can be rebased with a small patch surface. See `UPSTREAM.md` for the update workflow.

## Model Roles

- `magi.models.executor` is the high-performance coding model. Use this for implementation, complex design, and large code changes.
- `magi.models.council` is the local council model. The default target is an LM Studio OpenAI-compatible server at `http://127.0.0.1:1234/v1`.

## Council Members

- `melchior` is MELCHIOR, the sovereign architect: gold, order, structure, principles, and synthesis.
- `balthasar` is BALTHASAR, the shadow strategist: myrrh, death, hidden cost, risk, and preservation.
- `casper` is CASPER, the visionary human: frankincense, spirit, desire, meaning, and product value.

The three members should debate through thesis, antithesis, and synthesis before falling back to majority vote. They must always be honest and must not concede without citing a concrete new fact, contradiction, test result, clearer purpose, or lower-risk alternative.

## Self Improvement

`magi.selfImprovement.enabled` controls whether Magi can create continuous improvement tasks.

- `off`: council review is allowed, but no autonomous improvement task is created.
- `on`: council can propose improvement tasks and approve them by vote.
- `paused`: no new work should start after the current improvement task finishes.

Public builds should default this setting to `off`. Personal experimental profiles can set it to `on`.

Core self-editing is controlled by `magi.selfImprovement.coreSelfEdit`:

- `disabled`: never execute tasks that edit core Magi/OpenCode governance code.
- `gated`: queue core edits behind test and rollback requirements.
- `allowed`: permit core edits under the active vote policy.
