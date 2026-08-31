# Antigravity Delegator Design

**Date:** 2026-08-27  
**Status:** approved design, pending implementation  
**Target:** Antigravity CLI 1.1.22 or newer; Node.js 18.18 or newer; Windows, Linux, and macOS

## Purpose

Build a portable delegation package that lets Codex, Claude Code, and other console agents hand bounded work to Antigravity CLI, observe it, send follow-up instructions, recover interrupted conversations, and collect the final result.

The package must support research, documentation, code changes, tests, reviews, and other tasks that fit the permissions granted by the user. It must preserve the superior agent's authority boundaries: delegating a task does not grant Antigravity permission to perform unrelated work or bypass confirmations.

## Deliverables

The repository will contain:

1. A self-contained `antigravity-delegator` skill with its runtime scripts.
2. A Claude Code plugin that exposes thin commands and a forwarding agent backed by the same skill runtime.
3. Codex metadata and installation instructions for using the canonical skill directly.
4. Reference documents for runtime commands, Antigravity CLI behavior, model routing, permissions, and recovery.
5. Automated unit and integration tests using a deterministic fake `agy` executable.

The runtime will use only Node.js standard-library modules. This avoids package installation during delegation and keeps the bundle portable.

## Package layout

```text
plugins/antigravity/
|-- .claude-plugin/plugin.json
|-- agents/antigravity-runner.md
|-- commands/
|   |-- cancel.md
|   |-- delegate.md
|   |-- doctor.md
|   |-- recover.md
|   |-- result.md
|   |-- send.md
|   |-- status.md
|   `-- wait.md
`-- skills/antigravity-delegator/
    |-- SKILL.md
    |-- agents/openai.yaml
    |-- scripts/
    |   |-- antigravity-delegator.mjs
    |   `-- lib/*.mjs
    |-- references/
    |   |-- cli-reference.md
    |   |-- host-integration.md
    |   |-- model-routing.md
    |   |-- permissions.md
    |   `-- recovery.md
    `-- schemas/job-result.schema.json

tests/
|-- fixtures/fake-agy.mjs
`-- *.test.mjs
```

The plugin contains the canonical skill instead of a second copy. Claude commands resolve it through `${CLAUDE_PLUGIN_ROOT}`. Codex users install or link the `skills/antigravity-delegator` directory.

## Public runtime interface

All commands accept `--json` for machine-readable output. Human-readable output remains compact and includes the next useful command.

| Command | Responsibility |
| --- | --- |
| `doctor` | Check Node, `agy`, version, authentication symptoms, writable state storage, available models and agents. |
| `models` | List discovered models, inferred quota families, and routing order. |
| `delegate` | Start a fresh foreground or background task. |
| `list` | List current and recent jobs for the workspace. |
| `status [job-id]` | Show lifecycle state, current step, model attempt, heartbeat, and latest progress. |
| `wait [job-id]` | Wait for a state change or terminal result with a bounded timeout. |
| `logs [job-id]` | Read stored NDJSON events and diagnostic output. |
| `send <job-id> <message>` | Queue a follow-up turn without discarding conversation context. |
| `steer <job-id> <message>` | Interrupt the current turn through the authenticated worker and resume with corrective instructions. |
| `result [job-id]` | Return the complete stored result and artifacts. |
| `resume <job-id> [message]` | Continue a completed or interrupted Antigravity conversation. |
| `recover [job-id]` | Reconcile stale jobs and relaunch recoverable work. |
| `cancel [job-id]` | Ask the authenticated worker to stop its Antigravity child process. |

`delegate` accepts the following controls:

- execution: `--background`, `--wait`, `--timeout`;
- task access: `--read-only`, `--write`, `--sandbox`;
- selection: `--model`, `--agent`, `--effort`, `--route`;
- continuation: `--conversation`;
- storage and targeting: `--cwd`, `--state-dir`.

The runtime will not expose a shortcut that silently enables `--dangerously-skip-permissions`.

## Superior-agent workflow

The skill instructs the superior agent to:

1. Decide whether delegation is useful. Small tasks that the superior can finish quickly stay local.
2. Preserve the user's request while adding a compact execution contract: scope, expected deliverable, write authority, verification command, and stopping condition.
3. Run `doctor` when readiness is unknown.
4. Start one tracked job and report its ID.
5. Use `wait` or `status` instead of unbounded polling.
6. Send corrections through `send` or `steer` while the job remains recoverable.
7. Read the complete result without erasing uncertainty, errors, file paths, or test output.
8. Independently inspect changes and verification evidence before claiming completion.

The Claude forwarding agent stays thin. It may shape the task prompt and call the runtime once, but it must not inspect the repository, solve the delegated task itself, or replace a failed Antigravity run with invented output.

## Job state and storage

State lives outside the target repository by default:

- Windows: `%LOCALAPPDATA%/antigravity-delegator/`
- Linux and macOS: `$XDG_STATE_HOME/antigravity-delegator/` or `~/.local/state/antigravity-delegator/`

The runtime hashes the canonical workspace path and creates a workspace-specific directory. `--state-dir` overrides this location for tests or controlled deployments.

Each job has an immutable ID and a directory containing:

- `job.json`: current state and metadata;
- `events.ndjson`: append-only Antigravity stream events;
- `stderr.log`: diagnostics and permission notices;
- `messages.ndjson`: queued or delivered superior-agent messages;
- `attempts.ndjson`: model attempts, failures, and fallback decisions;
- `result.json`: terminal response and normalized metadata;
- `heartbeat.json`: worker identity and last activity.

Metadata writes use a temporary sibling file followed by an atomic rename. Append-only logs tolerate a truncated final line. The runtime validates stored data before using it and preserves corrupt files for diagnosis.

## Lifecycle

The runtime uses these states:

| State | Meaning |
| --- | --- |
| `queued` | Job record exists but no worker owns it yet. |
| `starting` | Worker is initializing storage and Antigravity. |
| `running` | An Antigravity turn is active. |
| `waiting` | The conversation is idle and can accept a follow-up. |
| `retrying` | A recoverable transport, quota, or model error triggered another attempt. |
| `succeeded` | The requested turn produced a successful result. |
| `failed` | No configured retry or recovery path remains. |
| `canceled` | The superior agent or user canceled the work. |
| `interrupted` | Antigravity reported an interrupted terminal state. |
| `orphaned` | Persistent state claims activity, but the owning worker is gone or stale. |

Antigravity terminal statuses are retained unchanged beside the normalized job state: `SUCCESS`, `ERROR`, `CANCELED`, `INTERRUPTED`, `INVALID`, `WAITING`, and `RUNNING`.

## Worker and control channel

A background job starts a detached Node worker with hidden-window behavior on Windows. The worker starts `agy` directly without invoking an intermediate shell. Arguments are passed as an array so prompts and paths with spaces do not require shell escaping.

The worker binds an authenticated control endpoint to `127.0.0.1` on an ephemeral port. A random job token authenticates `send`, `steer`, and `cancel`. This avoids killing a process based only on a possibly reused PID.

The worker records a heartbeat while active. If its control endpoint disappears, commands fall back to the persistent message queue. `recover` starts a replacement worker only after the previous heartbeat is stale and the endpoint cannot be authenticated.

## Antigravity protocol

The worker launches Antigravity in headless streaming mode:

```text
agy --print <prompt> --output-format stream-json [selection and permission flags]
```

It reads `stdout` line by line and records `init`, `step_update`, and `result` events. It extracts:

- `conversation_id` as soon as `init` arrives;
- current tool, step, state, and text deltas;
- per-step and cumulative usage;
- terminal response, status, and error.

Diagnostics remain separate on `stderr`. A zero exit code does not prove success because headless permission requests may be soft-denied. The runtime inspects the terminal status, stderr notices, missing expected tool activity, and the task result before classifying the job.

Follow-up turns use `--conversation <conversation-id>`. `--continue` is not used for tracked work because it resolves a workspace's most recent conversation and could select the wrong job.

## Model routing and quota fallback

The runtime discovers current model slugs with `agy models` and classifies them into two independent quota families:

- `gemini`;
- `third-party`, covering Claude and GPT models.

Routes are named `auto`, `quality`, `balanced`, `fast`, `gemini-first`, and `third-party-first`. Users can also provide an ordered list of exact model slugs. Ranking uses discovered metadata and conservative name patterns; an unavailable exact model fails loudly.

The first `auto` attempt may leave `--model` unset so Antigravity uses the user's configured default. A quota or rate-limit error identifies the exhausted family when possible. The next attempt selects a discovered model from the other family and resumes the same `conversation_id`.

Fallback rules:

1. Preserve the original prompt, conversation ID, workspace, access profile, and agent.
2. Record every transition and its evidence.
3. Retry transport failures with bounded exponential backoff.
4. Change model family only for quota, rate-limit, unavailability, or an explicit superior-agent request.
5. Never retry authentication, invalid arguments, denied permissions, or deterministic task failures as quota errors.
6. Stop after the configured attempt limit and return the complete failure history.

Antigravity documents separate five-hour and weekly quota buckets for Gemini and Claude/GPT. It does not document a headless quota-percentage API. Automatic switching is therefore reactive to supported CLI errors. The runtime will not scrape private cache formats.

## Permissions

The access profiles are:

| Profile | Antigravity behavior |
| --- | --- |
| `read-only` | Use plan mode and instruct the worker not to change files. |
| `write` | Use accept-edits mode within the active workspace and the user's configured permissions. |
| `sandbox` | Add `--sandbox` and retain the requested read/write mode. |

The runtime inherits Antigravity settings from `~/.gemini/antigravity-cli/settings.json`. It may diagnose missing rules, but it must not change global settings, enable credit overages, install plugins, authenticate accounts, or bypass permissions without explicit user approval.

Prompts must not convert review requests into edits. A review result stops at findings unless the user separately authorizes fixes.

## Recovery behavior

`recover` reconciles the stored state with the heartbeat and control endpoint.

- If the worker responds, no replacement starts.
- If the worker is gone and a conversation ID exists, the runtime marks the job `orphaned` and can resume it with a recovery prompt.
- If no conversation ID exists, the runtime can restart from the original prompt and records that continuity could not be preserved.
- Network failures retry with the same conversation before changing models.
- A queued follow-up remains durable until a worker acknowledges it.
- A canceled job never restarts automatically.

Automatic recovery is bounded. The runtime does not create a permanent daemon or schedule itself at operating-system startup. A superior agent or user runs `recover` after reopening a session.

## Claude Code integration

The plugin mirrors the useful interaction pattern from `openai/codex-plugin-cc`:

- commands are thin wrappers;
- the forwarding agent delegates through one runtime call;
- background jobs return immediately with a stable ID;
- status and result commands render stored state;
- follow-up work resumes the most recent compatible job only when the choice is unambiguous;
- failures remain failures instead of triggering an unrequested Claude-side implementation.

The plugin will not implement a stop-time review loop in the first release. Such a loop can consume both Antigravity quota pools and can prevent the superior agent from stopping. The runtime primitives leave room for an explicit, user-enabled gate later.

## Codex integration

Codex loads the canonical `SKILL.md` and calls the Node runtime through its shell tool. `agents/openai.yaml` provides the display name, short description, and default invocation prompt. Automatic skill discovery remains enabled.

The skill uses relative paths resolved from its own directory. It does not depend on Claude-specific environment variables when used from Codex.

## Testing strategy

Tests use Node's built-in test runner and a fake `agy` process. The fixture accepts the production command-line shape and can emit controlled NDJSON streams, stderr notices, delays, exit codes, and conversation IDs.

Required test groups:

1. Argument parsing and safe process spawning on paths with spaces.
2. NDJSON parsing, partial lines, malformed events, and terminal status mapping.
3. Atomic state updates and recovery from truncated logs.
4. Foreground and detached background lifecycle.
5. Authenticated `send`, `steer`, and `cancel` control.
6. Heartbeat reconciliation and orphan recovery.
7. Conversation continuation across worker restarts.
8. Gemini-to-third-party and third-party-to-Gemini quota fallback.
9. No fallback for authentication, permission, or invalid-model failures.
10. Headless soft-denial detection when the process exits zero.
11. Claude command wrappers and Codex skill path resolution.
12. Skill behavior scenarios for delegation choice, authority preservation, result handling, and independent verification.

Tests that launch a real authenticated Antigravity task remain opt-in because they consume quota and may modify a workspace. `doctor` and dry-run tests provide the default local verification path.

## Acceptance criteria

The implementation is accepted when:

- a superior agent can start a tracked job and receive its ID immediately;
- `status`, `wait`, `logs`, and `result` work from a later shell session;
- a follow-up message resumes the correct Antigravity conversation;
- a simulated process or machine interruption produces an `orphaned` job that `recover` can continue;
- quota failure in either model family switches to the other family without losing the recorded conversation;
- retries are bounded and their reasons are visible;
- cancellation targets the authenticated worker instead of an unverified PID;
- no default path bypasses Antigravity permissions or enables paid credits;
- fake-CLI tests pass on Windows and use only portable Node APIs for Linux and macOS;
- the skill passes the Codex skill validator and the Claude plugin passes its available structural validation;
- user-facing documentation contains the exact setup, delegation, monitoring, recovery, and troubleshooting commands.

## Explicit exclusions

This version will not:

- call undocumented Antigravity services or scrape private quota caches;
- guarantee continuation when Antigravity never issued a conversation ID;
- switch accounts or purchase/enable credits;
- run as a permanent system daemon;
- synchronize a live Antigravity TUI subagent with the external runtime;
- auto-apply findings from read-only reviews;
- promise that every third-party agent host supports the Claude plugin interface.

## Sources

- [Antigravity CLI headless mode](https://antigravity.google/docs/cli/headless/)
- [Antigravity CLI agents command](https://antigravity.google/docs/cli/commands/agents/)
- [Background tasks and subagents](https://antigravity.google/docs/cli/subagents/)
- [Asynchronous subagents](https://antigravity.google/docs/subagents)
- [Managing and resuming conversations](https://antigravity.google/docs/cli/commands/resume/)
- [Antigravity models and quota families](https://antigravity.google/docs/models/)
- [Antigravity CLI reference](https://antigravity.google/docs/cli/reference/)
- [Antigravity CLI best practices](https://antigravity.google/docs/cli/best-practices/)
- [OpenAI Codex plugin for Claude Code](https://github.com/openai/codex-plugin-cc)
