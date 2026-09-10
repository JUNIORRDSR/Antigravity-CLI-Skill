---
name: delegate
description: Use when starting a bounded, tracked Antigravity task that must return a job ID.
argument-hint: "<task and runtime options>"
allowed-tools: Task
---

Delegate this request to the `antigravity:antigravity-runner` agent. Its task is exactly `$ARGUMENTS`. Do not perform the requested work locally and do not add permission-bypass flags.
 
The `antigravity:antigravity-runner` agent defaults to Gemini 3.8 Flash (`gemini-3.8-flash`) with high reasoning effort (`effort: high`) so delegated tasks receive deep thinking and high-quality results. Its turn limit defaults to 3 (`maxTurns: 3`), but `maxTurns` can be modified in the agent configuration to maintain an optimal, fluid execution flow on complex delegations.

## Choosing a model

`--model <slug>` pins one model. `--route <name>` picks one from `agy models` at run time. Without either, Antigravity uses its own default, which is not the strongest available model.

| Route | Picks | Use for |
| --- | --- | --- |
| `quality` | opus-class first, then pro/sonnet/gpt-5 | Audits, reviews, anything whose output will be trusted without re-checking |
| `balanced` | sonnet/flash/medium | Ordinary implementation and research |
| `fast` | flash/haiku/mini | Mechanical, low-stakes passes |
| `gemini-first` / `third-party-first` | family preference | Working around a per-model quota limit |

**Use `--route quality` for audit and review tasks.** Measured on a real audit run: the default model returned correct verdicts anchored to lines that did not contain the cited code, and marked resolved items "not verifiable" without opening the file. The same task on an opus-class model returned two findings that both held up on inspection.

Antigravity quota is **per model, not per account**. When one model reports `Individual quota reached ... Resets in <time>`, the runtime reports state `failed` with the reset time and switches family once if the route allows it; every switch is printed as a `Retry:` line, never applied silently. Another model is usually still available.

Do not pass `--effort` together with `--model`: agy rejects the combination, because every published model slug already encodes its reasoning effort. The runtime drops `--effort` when a model is pinned.

## Choosing an access profile

| Profile | Flag | Runtime behaviour |
| --- | --- | --- |
| read-only (default) | none | `agy --mode plan`. Cannot edit workspace files. |
| write | `--write` | `agy --mode accept-edits`. Can edit workspace files. |
| sandbox | `--sandbox` | Adds `--sandbox` on top of either. |

**Antigravity has no read-only mode that executes.** `--mode` accepts only `plan` and `accept-edits`; `plan` is "draft a plan and wait for approval", and headless runs can never deliver that approval. So the read-only profile is safe but reluctant: on anything that looks like multi-step work it writes a plan and asks to proceed.

The runtime handles this two ways, and both matter:

- Every delegated prompt carries a headless directive telling the model not to plan, not to announce, and to finish in this turn.
- A turn that still ends in a plan is reported as job state **`awaiting-approval`**, never `succeeded`, with the plan file named.

For read-only audits that stay in the executing lane:

- **One target per job.** Batches of five or six documents reliably produce a plan; single-file jobs execute. Fan out across jobs instead of batching inside one.
- Ask for the finding, not for the procedure. "Report whether X holds, quoting file and line" executes; "audit these documents" plans.
- Pass `--json-schema "${CLAUDE_PLUGIN_ROOT}/skills/antigravity-delegator/schemas/audit-findings.schema.json"` so each verdict must carry the file, line, and verbatim quote it rests on.

Never pass `--dangerously-skip-permissions`; the runtime rejects it.

## Workspace visibility

The runtime passes the canonical workspace as `--add-dir` on every turn. Without it agy searches the user's home directory instead of the repository and reports that the file does not exist, even when the cwd is correct. Add `--add-dir <path>` (repeatable) for any extra directory the task must read.

## When a job produces nothing

A denied tool makes agy exit 0 with an empty response, sometimes reporting `SUCCESS`. The runtime reports that as `failed` with the denied permission named, because headless mode cannot prompt for a permission and auto-denies it. See `references/permissions.md` for what to add under `permissions.allow`.
