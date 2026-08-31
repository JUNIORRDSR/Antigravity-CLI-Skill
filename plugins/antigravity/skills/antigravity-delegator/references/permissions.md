# Permissions and authority

Choose the smallest access profile that fits the user's authorization:

| Profile | Runtime intent |
| --- | --- |
| `read-only` | `agy --mode plan`; cannot edit workspace files. |
| `write` | `agy --mode accept-edits`; changes inside the active workspace, subject to the user's Antigravity settings and approvals. |
| `sandbox` | Adds `--sandbox` while preserving the requested read/write authority. |

The write barrier is the `--mode` flag, not a sentence in the prompt. A read-only job cannot edit files even if its prompt asks it to.

## There is no read-only mode that executes

`agy --help` (1.1.22) lists exactly two modes: `accept-edits` and `plan`. `plan` does not mean "read-only but active" — it means "draft an implementation plan and wait for approval". Headless runs cannot deliver that approval, so the turn ends with a plan file under `~/.gemini/antigravity-cli/brain/<conversation>/` and a request to proceed, reported by agy as `status: SUCCESS`.

Observed directly, single-step task, `--mode plan`:

```
"response": "I have created the implementation plan ... Please review and approve the plan to proceed with execution."
"status": "SUCCESS"
```

The runtime reports that outcome as job state `awaiting-approval`, never `succeeded`, and names the plan file. It also appends a headless directive to every delegated prompt telling the model not to plan and to finish in the turn. Neither of those changes what the model is allowed to write; only `--mode` does that.

## Headless permission denials

Headless mode cannot prompt for a tool permission, so it auto-denies and the run produces nothing:

```
jetski: no output produced — a tool required the "command" permission that headless
mode cannot prompt for, so it was auto-denied.
```

That message goes to **stderr**, and the result event on stdout is `status: SUCCESS` (sometimes `CANCELED`) with `"response": ""`. Exit code is 0 in both cases. The runtime treats an empty response, and any auto-deny notice, as a failure that names the denied permission — a job that produced nothing is never reported as success.

## Allow-rules

Rules live under `permissions.allow` in `~/.gemini/antigravity-cli/settings.json`:

```json
{
  "permissions": {
    "allow": ["read_file(*)", "command(*)"]
  }
}
```

Rule shape is `<kind>(<target>)`. The kinds agy 1.1.22 recognises are `command`, `read_file`, `write_file`, `read_url`, `execute_url`, `mcp`, and `unsandboxed`.

**What was verified, and what was not.** `command(*)` lifts the auto-deny: with it in place the same run that had been denied executed and consumed tokens, with no `jetski` notice. A narrower `command(git)` did **not** — the run was auto-denied exactly as with no rule at all. So the per-binary allow-list that a read-only audit would ideally use is not expressible with any target syntax confirmed here; `command(*)` is the only form shown to work, and it allows every command, not just the read-only ones.

Prefer, in order:

1. Scope the task so it does not need the tool at all. Most audits need file reads, not `git`.
2. Add `read_file(*)` alone when only file access is missing.
3. Add `command(*)` only when the task genuinely needs shell access, and understand that it is not a narrow grant.

`antigravity-delegator doctor` reports what `permissions.allow` currently contains and flags an absent or empty list. It never writes the file.

`--dangerously-skip-permissions` auto-approves every tool call. This package does not expose it, does not suggest it in any error message, and strips it from agy's own guidance before reporting a denial. The CLI rejects the flag outright.

## Authority

Write authority must be explicit. A review ends with findings; it does not apply fixes unless the user separately authorizes them. If a requested tool is denied, report the denial and ask for authority or adjust scope; do not retry with broader permissions.

The wrapper reports configuration problems but never changes global settings, authenticates, installs plugins, turns on credit overages, or bypasses permissions.

Source: [headless permissions and flags](https://antigravity.google/docs/cli/headless/) and [CLI permission settings](https://antigravity.google/docs/cli/reference/). The mapping from profiles to prompts and wrapper outcomes is package policy, not an Antigravity setting.
