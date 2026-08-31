# CLI and headless reference

This package targets Antigravity CLI 1.1.22. The tables below summarize the public documentation; inspect `agy --help` and `agy <command> --help` on the installed version before relying on an option not used by the runtime.

## Delegator runtime

The wrapper owns job state. Run it from the skill directory with `node scripts/antigravity-delegator.mjs`.

| Command | Purpose |
| --- | --- |
| `doctor` | Check Node, `agy`, authentication symptoms, state storage, models, agents, and the `permissions.allow` rules agy would apply. |
| `models` | Show discovered models, quota-family inference, and routes. |
| `delegate` | Start a tracked foreground or background task. Accepts `--model`, `--route`, `--add-dir` (repeatable), `--json-schema`, `--read-only`/`--write`, `--sandbox`. |
| `list` | List jobs scoped to the workspace. |
| `status [job-id]` | Show current state and next action. |
| `wait [job-id]` | Wait for a bounded interval or terminal state. |
| `logs [job-id]` | Read stored stream and diagnostic logs. |
| `send`, `steer` | Deliver an additive message or an interrupting correction. |
| `result [job-id]` | Return the normalized terminal record. |
| `resume`, `recover`, `cancel` | Continue a known conversation, reconcile stale state, or request safe cancellation. |

Every public command accepts `--json`. Prefer its returned job ID over a “latest” lookup.

## Documented `agy` headless protocol

`agy -p` (also `--print` or `--prompt`) runs one prompt and exits. `--output-format` accepts `text`, `json`, or `stream-json`; the last is NDJSON of `step_update` events ending with one `result`.

Observed on 1.1.22, against the documented shape:

- **There is no `init` event.** Every event nests its payload under its own name and carries `conversation_id` there: `{"event":"step_update","step_update":{"conversation_id":"...",...}}` and `{"event":"result","result":{"conversation_id":"...","status":"SUCCESS",...}}`. Read the conversation ID from whichever event arrives first, not from `init`.
- **Exit code is 0 on failure too**, including `status: ERROR` for an invalid flag combination, and including a run that produced nothing.
- **`stdout` is result data; diagnostics and permission notices are on `stderr`**, including the `jetski: no output produced` auto-deny notice.

Supported headless flags: `--input-format text|stream-json`, `--output-format text|json|stream-json`, `--json-schema`, `--model`, `--effort low|medium|high`, `--agent`, `--add-dir <path>` (repeatable), `--mode accept-edits|plan`, `--continue`/`-c`, `--conversation <id>`, `--print-timeout <duration>`, and `--sandbox`. `--input-format stream-json` requires streaming output and receives one `user` event per stdin line. Do not send TUI slash commands to that stream.

Two flag constraints the runtime enforces:

- **`--add-dir` is not optional in practice.** Without it agy searches the user's home directory rather than the cwd and reports that a repository file does not exist. The runtime passes the canonical workspace on every turn.
- **`--effort` cannot be combined with `--model`.** Every published slug already encodes its effort, so agy answers `invalid model selection (--model "..." --effort "high")` for both Gemini and Claude models. The runtime sends `--effort` only when no model is pinned.

`--mode` offers only `accept-edits` and `plan`. There is no read-only mode that executes; see [Permissions](permissions.md).

For tracked continuation, use `--conversation <recorded-id>`, never `--continue`: the latter chooses the workspace's most recent conversation. A zero exit code alone is insufficient: inspect terminal status and diagnostics, including permission notices.

## TUI slash-command catalog

The documented CLI 1.1.22 catalog is: `/add-dir <path>`, `/agents`, `/artifact`, `/btw <query>`, `/clear` (`/new`), `/config` (`/settings`), `/context`, `/copy`, `/credits`, `/diff`, `/exit` (`/quit`), `/fast`, `/feedback`, `/fork` (`/branch`), `/help`, `/hooks`, `/keybindings`, `/logout`, `/mcp`, `/model`, `/open <path>`, `/permissions`, `/planning`, `/rename <name>`, `/resume` (`/switch`, `/conversation`), `/rewind` (`/undo`), `/skills`, `/statusline`, `/tasks`, `/teamwork-preview <task>` (`/teamwork`), `/title [on/off]`, `/usage` (`/quota`), and `/voice` (`/record`). They are interactive-TUI controls, not wrapper subcommands.

## Sources and boundary

Documented behavior: [headless mode](https://antigravity.google/docs/cli/headless/), [CLI reference](https://antigravity.google/docs/cli/reference/), and [usage command](https://antigravity.google/docs/cli/commands/usage/). The wrapper's persistent jobs, normalized states, and interpretation of soft denials are runtime design inferences, not Antigravity CLI guarantees.
