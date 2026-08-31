---
name: antigravity-delegator
description: Use when delegating bounded research, documentation, coding, testing, review, or recovery work to Antigravity CLI requires persistent job tracking, follow-up messages, model-quota fallback, or continuation after interruption.
---

# Antigravity Delegator

Use the tracked runtime, not a raw `agy -p` invocation. Resolve `<skill-dir>` as the directory containing this file, then run exactly one runtime command at a time:

```text
node <skill-dir>/scripts/antigravity-delegator.mjs <command> [arguments] --json
```

## Decide and authorize

Keep work local when it is small, immediate, or needs the superior agent's context. Delegate bounded work with a clear deliverable, especially when it benefits from persistence or an independent pass. Delegation does not expand authority.

State the workspace, scope, expected deliverable, write authority, verification command, and stopping condition. Use `--read-only` for research or review; do not turn a review into edits. Use `--write` only when the user authorized changes. `--sandbox` adds containment; it does not authorize writes. Never add `--dangerously-skip-permissions` to overcome a denial.

## Run and follow up

When readiness is unknown, run `doctor`. Start one `delegate` job and report its returned ID. Choose foreground for short work whose output is needed now; choose `--background` for longer work. Use `wait` with a bounded timeout or a single `status`, never continuous polling.

```text
node <skill-dir>/scripts/antigravity-delegator.mjs delegate --read-only "..." --json
node <skill-dir>/scripts/antigravity-delegator.mjs status <job-id> --json
node <skill-dir>/scripts/antigravity-delegator.mjs send <job-id> "..." --json
node <skill-dir>/scripts/antigravity-delegator.mjs result <job-id> --json
```

Use `send` for additive information and `steer` for a correction that must interrupt and continue the recorded conversation. Use `recover` only after inspecting the job state and its conversation ID; canceled jobs do not restart automatically. Read the full result, inspect the diff, and run or inspect independent verification before claiming success.

## Read details only when needed

- Runtime commands, headless protocol, and the TUI catalog: [CLI reference](references/cli-reference.md).
- Codex and Claude installation, paths, and host boundaries: [Host integration](references/host-integration.md).
- Models, quotas, and fallback evidence: [Model routing](references/model-routing.md).
- Access profiles and permission denials: [Permissions](references/permissions.md).
- Stale workers, continuation, messages, and cancellation: [Recovery](references/recovery.md).
