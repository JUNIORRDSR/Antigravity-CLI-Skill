# Antigravity Delegator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a portable, persistent delegation runtime that lets Codex and Claude Code start, monitor, steer, recover, and finish Antigravity CLI jobs with bounded model-family fallback.

**Architecture:** A canonical `antigravity-delegator` skill owns a dependency-free Node.js runtime. The runtime launches `agy` in headless streaming mode, stores workspace-keyed job records, and gives superior agents a stable command interface. A Claude Code plugin wraps the same runtime; Codex uses the skill directly.

**Tech Stack:** Node.js 18.18+ standard library, ECMAScript modules, Node test runner, Markdown Agent Skills, Claude Code plugin manifests, Antigravity CLI 1.1.22+.

## Global Constraints

- Support Windows, Linux, and macOS without shell-specific process construction.
- Use no runtime npm dependencies.
- Pass subprocess arguments as arrays; never interpolate prompts into shell command strings.
- Never add `--dangerously-skip-permissions` automatically.
- Never modify Antigravity settings, authentication, plugins, or paid-credit settings without explicit user approval.
- Keep retries bounded and record the evidence for every retry or model switch.
- Use `--conversation <id>` for tracked continuation; do not use workspace-ambiguous `--continue`.
- Store runtime state outside the delegated workspace unless `--state-dir` is supplied.
- Treat `stdout`, `stderr`, Antigravity status, exit code, and expected tool activity as separate evidence.
- Preserve the complete delegated result. The superior agent verifies edits and tests independently.
- Do not add a permanent daemon or operating-system startup task.
- Target the approved design in `docs/superpowers/specs/2026-08-27-antigravity-delegator-design.md`.

## Planned file structure

```text
package.json
scripts/
`-- install-codex.mjs
plugins/antigravity/
|-- .claude-plugin/plugin.json
|-- agents/antigravity-runner.md
|-- commands/{cancel,delegate,doctor,recover,result,send,status,wait}.md
`-- skills/antigravity-delegator/
    |-- SKILL.md
    |-- agents/openai.yaml
    |-- schemas/job-result.schema.json
    |-- references/{cli-reference,host-integration,model-routing,permissions,recovery}.md
    `-- scripts/
        |-- antigravity-delegator.mjs
        `-- lib/
            |-- agy.mjs
            |-- args.mjs
            |-- constants.mjs
            |-- control.mjs
            |-- doctor.mjs
            |-- errors.mjs
            |-- jobs.mjs
            |-- model-routing.mjs
            |-- ndjson.mjs
            |-- prompt.mjs
            |-- render.mjs
            |-- state.mjs
            |-- worker.mjs
            `-- workspace.mjs
tests/
|-- fixtures/fake-agy.mjs
|-- helpers.mjs
|-- args-state.test.mjs
|-- ndjson-routing.test.mjs
|-- agy-runner.test.mjs
|-- background-control.test.mjs
|-- recovery.test.mjs
|-- cli.test.mjs
|-- package-contract.test.mjs
`-- skill-scenarios.md
```

---

### Task 1: Test harness and observable contracts

**Files:**

- Create: `package.json`
- Create: `tests/helpers.mjs`
- Create: `tests/fixtures/fake-agy.mjs`
- Create: `tests/args-state.test.mjs`
- Create: `tests/ndjson-routing.test.mjs`

**Interfaces:**

- Produces: `runNode(args, options)`, `makeTempWorkspace()`, `readJson(path)`, and a fake `agy` controlled by `FAKE_AGY_SCENARIO`.
- Produces: executable test commands `npm test` and `npm run test:unit`.

- [ ] **Step 1: Create the root test configuration**

Write `package.json`:

```json
{
  "name": "antigravity-delegator",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=18.18.0" },
  "scripts": {
    "test": "node --test",
    "test:unit": "node --test tests/args-state.test.mjs tests/ndjson-routing.test.mjs",
    "validate": "node --test tests/package-contract.test.mjs"
  }
}
```

- [ ] **Step 2: Write test helpers and the fake CLI**

`tests/helpers.mjs` must create isolated workspaces and state directories under the OS temporary directory, invoke Node without a shell, and remove only the exact temporary directory it created.

`tests/fixtures/fake-agy.mjs` must implement:

```text
--version                         -> 1.1.22
models                            -> deterministic model list
agents                            -> deterministic agent list
--output-format stream-json       -> init, step_update, result NDJSON
--conversation <id>               -> reuse the supplied ID
```

Supported scenarios: `success`, `slow-success`, `gemini-quota`, `third-party-quota`, `auth-error`, `soft-deny`, `interrupted`, `malformed-line`, and `no-conversation-id`.

- [ ] **Step 3: Write failing argument and state tests**

Include tests equivalent to:

```js
test("preserves prompts and cwd paths containing spaces", () => {
  const parsed = parseDelegateArgs([
    "--cwd", "C:/work/my project",
    "write docs for the parser"
  ]);
  assert.equal(parsed.cwd, "C:/work/my project");
  assert.equal(parsed.prompt, "write docs for the parser");
});

test("writes job metadata atomically", async () => {
  await writeJsonAtomic(jobPath, { id: "agy-test", state: "queued" });
  assert.deepEqual(await readJsonFile(jobPath), {
    id: "agy-test",
    state: "queued"
  });
  assert.deepEqual(
    (await fs.readdir(path.dirname(jobPath))).filter(name => name.startsWith("job.json.tmp-")),
    []
  );
});
```

- [ ] **Step 4: Write failing NDJSON and routing tests**

Cover partial input chunks, a truncated last line, known events, unknown future events, Gemini/third-party classification, exact-model failure, and bounded family fallback.

```js
test("switches quota family once and preserves conversation", () => {
  const next = chooseFallback({
    failedModel: "gemini-3.5-flash-medium",
    conversationId: "conv-1",
    availableModels: FIXTURE_MODELS,
    attempts: []
  });
  assert.equal(next.family, "third-party");
  assert.equal(next.conversationId, "conv-1");
});
```

- [ ] **Step 5: Run tests and verify RED**

Run: `npm run test:unit`

Expected: FAIL because the production modules do not exist.

- [ ] **Step 6: Commit the failing harness**

```bash
git add package.json tests
git commit -m "test: define delegator runtime contracts"
```

---

### Task 2: Arguments, workspace identity, and atomic storage

**Files:**

- Create: `plugins/antigravity/skills/antigravity-delegator/scripts/lib/constants.mjs`
- Create: `plugins/antigravity/skills/antigravity-delegator/scripts/lib/args.mjs`
- Create: `plugins/antigravity/skills/antigravity-delegator/scripts/lib/workspace.mjs`
- Create: `plugins/antigravity/skills/antigravity-delegator/scripts/lib/state.mjs`
- Modify: `tests/args-state.test.mjs`

**Interfaces:**

- Produces: `parseCli(argv)`, `parseDuration(value)`, `canonicalWorkspace(cwd)`, `defaultStateRoot(env, platform)`, `workspaceStateDir(root, workspace)`, `writeJsonAtomic(path, value)`, `appendNdjson(path, value)`, `readNdjson(path)`, `createJobRecord(input)`, `readJob(path)`, and `updateJob(path, mutate)`.
- State transitions use exported `JOB_STATES` and `TERMINAL_JOB_STATES`.

- [ ] **Step 1: Extend failing tests for platform storage and transitions**

Test Windows `LOCALAPPDATA`, Unix `XDG_STATE_HOME`, fallback to `~/.local/state`, canonical path hashing, immutable IDs, legal transitions, illegal terminal-state rewrites, and preservation of a corrupt metadata file.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test tests/args-state.test.mjs`

Expected: FAIL on missing exports.

- [ ] **Step 3: Implement minimal parsers and storage**

Use `crypto.randomUUID()` for job IDs and SHA-256 of the canonical workspace path for directory keys. Use a job-specific temporary filename containing the process ID and a random suffix before `rename()`.

Do not infer prompts from joined shell text after parsing. `parseCli()` receives the already-separated `process.argv` array.

- [ ] **Step 4: Verify GREEN**

Run: `node --test tests/args-state.test.mjs`

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/antigravity/skills/antigravity-delegator/scripts/lib tests/args-state.test.mjs
git commit -m "feat: add portable delegator state storage"
```

---

### Task 3: Stream parsing, failure classification, and model routing

**Files:**

- Create: `plugins/antigravity/skills/antigravity-delegator/scripts/lib/ndjson.mjs`
- Create: `plugins/antigravity/skills/antigravity-delegator/scripts/lib/errors.mjs`
- Create: `plugins/antigravity/skills/antigravity-delegator/scripts/lib/model-routing.mjs`
- Modify: `tests/ndjson-routing.test.mjs`

**Interfaces:**

- Produces: `NdjsonDecoder`, `normalizeAgyEvent(value)`, `classifyFailure(input)`, `parseModelList(text)`, `classifyModelFamily(model)`, `rankModels(models, route)`, and `chooseFallback(context)`.
- `classifyFailure()` returns `{ kind, retryable, switchFamily, evidence }`.

- [ ] **Step 1: Add failing classification cases**

Required kinds: `quota`, `rate-limit`, `transport`, `authentication`, `permission`, `invalid-model`, `task`, `protocol`, `interrupted`, and `unknown`.

Assert that authentication, permission, invalid-model, and deterministic task failures do not switch family.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test tests/ndjson-routing.test.mjs`

Expected: FAIL on missing classifiers.

- [ ] **Step 3: Implement the decoder and conservative classifiers**

The decoder buffers incomplete chunks and reports malformed complete lines without discarding later valid lines. Unknown event names remain stored but do not fail the stream.

Routing must use the models returned by `agy models`; hard-coded names are test fixtures and tie-breaker patterns, not the source of availability.

- [ ] **Step 4: Verify GREEN**

Run: `node --test tests/ndjson-routing.test.mjs`

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/antigravity/skills/antigravity-delegator/scripts/lib tests/ndjson-routing.test.mjs
git commit -m "feat: classify Antigravity failures and model routes"
```

---

### Task 4: Prompt contract and foreground Antigravity runner

**Files:**

- Create: `plugins/antigravity/skills/antigravity-delegator/scripts/lib/prompt.mjs`
- Create: `plugins/antigravity/skills/antigravity-delegator/scripts/lib/agy.mjs`
- Create: `tests/agy-runner.test.mjs`

**Interfaces:**

- Produces: `buildDelegationPrompt(task)`, `buildAgyArgs(run)`, `discoverModels(options)`, `discoverAgents(options)`, and `runAgyTurn(options)`.
- `runAgyTurn()` accepts injected `agyPath`, `cwd`, `prompt`, `model`, `agent`, `effort`, `conversationId`, `accessProfile`, `timeoutMs`, `signal`, and event callbacks.
- Returns `{ exitCode, signal, conversationId, status, response, error, usage, events, stderr, permissionNotices }`.

- [ ] **Step 1: Write failing runner tests**

Assert exact argument arrays for read-only, write, sandbox, effort, model, agent, timeout, and continuation. Verify that the raw prompt never passes through a shell.

Test successful streaming, malformed lines followed by success, non-zero error, zero-exit soft denial, timeout, and interruption.

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/agy-runner.test.mjs`

Expected: FAIL because `prompt.mjs` and `agy.mjs` are absent.

- [ ] **Step 3: Implement the prompt contract**

The prompt contains these slots in order:

```text
Task
Workspace and scope
Authorization: read-only or workspace-write
Expected deliverable
Verification command or evidence requirement
Stopping condition
Final response contract: summary, changed files, verification, open issues
```

Do not add requirements the superior agent did not request.

- [ ] **Step 4: Implement direct process spawning and event capture**

Use `child_process.spawn(agyPath, args, { cwd, shell: false, windowsHide: true })`. Read both streams concurrently. Abort through an `AbortSignal`, then wait for process closure before returning.

- [ ] **Step 5: Verify GREEN**

Run: `node --test tests/agy-runner.test.mjs`

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/antigravity/skills/antigravity-delegator/scripts/lib tests/agy-runner.test.mjs
git commit -m "feat: run tracked Antigravity turns"
```

---

### Task 5: Job orchestration and bounded retries

**Files:**

- Create: `plugins/antigravity/skills/antigravity-delegator/scripts/lib/jobs.mjs`
- Create: `tests/recovery.test.mjs`
- Modify: `tests/agy-runner.test.mjs`

**Interfaces:**

- Produces: `createJob(options)`, `runJob(jobId, options)`, `runAttempt(job, options)`, `resumeJob(jobId, message, options)`, `listJobs(context)`, `getJob(reference, context)`, and `reconcileJob(job, options)`.
- Attempts append `{ number, model, family, startedAt, endedAt, outcome, evidence }` to `attempts.ndjson`.

- [ ] **Step 1: Write failing orchestration tests**

Test fresh success, explicit model, exact conversation continuation, transport retry with bounded backoff, both quota-family fallback directions, exhausted routes, and no fallback for authentication or permission failures.

Use a fake clock or injected `sleep` so retry tests finish immediately.

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/recovery.test.mjs tests/agy-runner.test.mjs`

Expected: FAIL on missing job orchestration.

- [ ] **Step 3: Implement minimal orchestration**

Default limits:

```js
export const DEFAULT_RETRY_POLICY = {
  transportRetries: 2,
  familySwitches: 1,
  maxAttempts: 4,
  backoffMs: [1000, 3000]
};
```

Persist state before and after every attempt. Preserve the last known `conversationId` even when an attempt fails.

- [ ] **Step 4: Verify GREEN**

Run: `node --test tests/recovery.test.mjs tests/agy-runner.test.mjs`

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/antigravity/skills/antigravity-delegator/scripts/lib/jobs.mjs tests
git commit -m "feat: orchestrate recoverable Antigravity jobs"
```

---

### Task 6: Detached worker and authenticated control channel

**Files:**

- Create: `plugins/antigravity/skills/antigravity-delegator/scripts/lib/control.mjs`
- Create: `plugins/antigravity/skills/antigravity-delegator/scripts/lib/worker.mjs`
- Create: `tests/background-control.test.mjs`
- Modify: `plugins/antigravity/skills/antigravity-delegator/scripts/lib/jobs.mjs`

**Interfaces:**

- Produces: `startDetachedWorker(jobId, options)`, `runWorker(jobId, options)`, `startControlServer(context)`, `sendControl(job, action, payload)`, `writeHeartbeat(job, worker)`, and `isWorkerReachable(job)`.
- Control actions: `ping`, `send`, `steer`, and `cancel`.

- [ ] **Step 1: Write failing background tests**

Test immediate return from background start, heartbeat creation, authenticated ping, rejection of a wrong token, queued `send`, `steer` cancellation followed by continuation, and `cancel` without using a stored PID as sole authority.

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/background-control.test.mjs`

Expected: FAIL on missing worker and control modules.

- [ ] **Step 3: Implement the loopback control server**

Bind to `127.0.0.1` on port `0`. Compare the bearer token with `crypto.timingSafeEqual()` after length validation. Reject non-loopback peers. Limit JSON request bodies to 64 KiB.

- [ ] **Step 4: Implement detached startup and graceful shutdown**

Spawn the current Node executable with an internal `worker` command, `detached: true`, `windowsHide: true`, and file-backed stdio. Call `unref()` only after the job record contains the worker identity.

The worker closes the control server, stops heartbeat writes, waits for the Antigravity child to exit, and then records its terminal state.

- [ ] **Step 5: Verify GREEN**

Run: `node --test tests/background-control.test.mjs`

Expected: all tests PASS and no worker remains after the test.

- [ ] **Step 6: Commit**

```bash
git add plugins/antigravity/skills/antigravity-delegator/scripts/lib tests/background-control.test.mjs
git commit -m "feat: add persistent background job control"
```

---

### Task 7: Recovery, durable messaging, and safe cancellation

**Files:**

- Modify: `plugins/antigravity/skills/antigravity-delegator/scripts/lib/jobs.mjs`
- Modify: `plugins/antigravity/skills/antigravity-delegator/scripts/lib/worker.mjs`
- Modify: `plugins/antigravity/skills/antigravity-delegator/scripts/lib/control.mjs`
- Modify: `tests/recovery.test.mjs`
- Modify: `tests/background-control.test.mjs`

**Interfaces:**

- Produces: `queueMessage(jobId, message)`, `ackMessage(jobId, messageId)`, `steerJob(jobId, message)`, `cancelJob(jobId)`, `recoverJob(jobId, options)`, and `recoverWorkspace(options)`.

- [ ] **Step 1: Add failing recovery cases**

Cover stale heartbeat plus unreachable endpoint, responsive worker with an old heartbeat, missing conversation ID, durable message redelivery, canceled-job non-restart, PID reuse simulation, and two simultaneous recover calls.

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/recovery.test.mjs tests/background-control.test.mjs`

Expected: FAIL on unimplemented recovery branches.

- [ ] **Step 3: Implement compare-and-claim recovery**

Use an atomic claim file containing the job ID, claimant UUID, and timestamp. A second recovery process must report the active claim instead of launching another worker. Expired claims can be replaced only after the control endpoint fails authentication or cannot be reached.

- [ ] **Step 4: Implement durable messages**

Append every message before delivery. Record a separate acknowledgement event. Redeliver only unacknowledged messages, preserving order and message IDs.

- [ ] **Step 5: Implement safe cancellation and steering**

Use the authenticated endpoint while the worker is live. If it is unreachable, record a cancellation request and mark a stale job canceled without signaling its recorded PID. `steer` must record the correction, interrupt the current owned child, and resume by conversation ID.

- [ ] **Step 6: Verify GREEN**

Run: `node --test tests/recovery.test.mjs tests/background-control.test.mjs`

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add plugins/antigravity/skills/antigravity-delegator/scripts/lib tests
git commit -m "feat: recover and steer delegated jobs safely"
```

---

### Task 8: User-facing CLI, doctor, and rendering

**Files:**

- Create: `plugins/antigravity/skills/antigravity-delegator/scripts/lib/doctor.mjs`
- Create: `plugins/antigravity/skills/antigravity-delegator/scripts/lib/render.mjs`
- Create: `plugins/antigravity/skills/antigravity-delegator/scripts/antigravity-delegator.mjs`
- Create: `plugins/antigravity/skills/antigravity-delegator/schemas/job-result.schema.json`
- Create: `tests/cli.test.mjs`

**Interfaces:**

- Public commands: `doctor`, `models`, `delegate`, `list`, `status`, `wait`, `logs`, `send`, `steer`, `result`, `resume`, `recover`, `cancel`.
- Every public command supports `--json`; errors use stderr and a non-zero exit code.

- [ ] **Step 1: Write failing CLI tests**

Test help output, unknown commands, JSON stability, human status table, latest-job resolution scoped to the workspace, bounded `wait`, complete result output, actionable doctor failures, and no prompt leakage in status summaries.

```js
test("status JSON preserves actionable job fields", async () => {
  const value = await runCliJson(["status", jobId, "--state-dir", stateDir]);
  assert.equal(value.id, jobId);
  assert.equal(value.workspace, workspace);
  assert.ok(value.nextCommands.result);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/cli.test.mjs`

Expected: FAIL because the entrypoint and renderers do not exist.

- [ ] **Step 3: Implement doctor and public dispatch**

`doctor` checks `node`, `agy --version`, state-root writes, `agy models`, and `agy agents`. Authentication-like failures are reported as setup guidance, not silently retried.

The internal `worker` command must not appear as a normal user workflow in concise help, but must remain accepted by the entrypoint.

- [ ] **Step 4: Implement stable JSON and compact human output**

The JSON result schema includes job ID, state, Antigravity status, conversation ID, model attempts, response, changed files when reported, verification, errors, usage, and next commands.

- [ ] **Step 5: Verify GREEN**

Run: `node --test tests/cli.test.mjs`

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/antigravity/skills/antigravity-delegator/scripts plugins/antigravity/skills/antigravity-delegator/schemas tests/cli.test.mjs
git commit -m "feat: expose Antigravity delegation commands"
```

---

### Task 9: Skill instructions and reference material

**Files:**

- Create: `plugins/antigravity/skills/antigravity-delegator/SKILL.md`
- Create: `plugins/antigravity/skills/antigravity-delegator/agents/openai.yaml`
- Create: `plugins/antigravity/skills/antigravity-delegator/references/cli-reference.md`
- Create: `plugins/antigravity/skills/antigravity-delegator/references/host-integration.md`
- Create: `plugins/antigravity/skills/antigravity-delegator/references/model-routing.md`
- Create: `plugins/antigravity/skills/antigravity-delegator/references/permissions.md`
- Create: `plugins/antigravity/skills/antigravity-delegator/references/recovery.md`
- Create: `tests/skill-scenarios.md`
- Create: `tests/package-contract.test.mjs`

**Interfaces:**

- `SKILL.md` routes the superior agent to one runtime command at a time and links conditional details to references.
- `agents/openai.yaml` names `$antigravity-delegator` in its default prompt and keeps implicit invocation enabled.

- [ ] **Step 1: Record baseline behavior scenarios before writing the skill**

`tests/skill-scenarios.md` must define fresh-context prompts that tempt an agent to:

1. delegate a trivial task unnecessarily;
2. launch untracked `agy -p` directly;
3. add `--dangerously-skip-permissions` to avoid a soft denial;
4. claim success from an Antigravity response without checking the diff or tests;
5. poll a background process continuously;
6. restart a stale job without checking its conversation ID;
7. convert a review into edits without authorization.

Run the scenarios without the skill in an isolated temporary workspace when an independent agent evaluator is authorized. Record the exact failure pattern. If no evaluator is authorized, mark the behavioral baseline pending and continue with deterministic contract tests; do not claim independent behavioral validation.

- [ ] **Step 2: Write failing structural tests**

Assert that the skill has valid frontmatter, a description beginning with `Use when`, a runtime command contract, reference links that resolve, a permissions warning, a verification requirement, and no unfinished scaffold markers.

- [ ] **Step 3: Run and verify RED**

Run: `node --test tests/package-contract.test.mjs`

Expected: FAIL because the skill package is absent.

- [ ] **Step 4: Initialize the skill metadata**

Use the bundled skill initializer only if it can target the existing intended directory without overwriting runtime files. Otherwise create the minimal files with `apply_patch` and generate `openai.yaml` with the skill-creator helper.

Skill frontmatter:

```yaml
---
name: antigravity-delegator
description: Use when delegating bounded research, documentation, coding, testing, review, or recovery work to Antigravity CLI requires persistent job tracking, follow-up messages, model-quota fallback, or continuation after interruption.
---
```

- [ ] **Step 5: Write the minimal routing skill**

Keep `SKILL.md` focused on:

- when to delegate and when to stay local;
- authority and access-profile selection;
- task prompt shape;
- choosing foreground or background;
- runtime command invocation;
- status, follow-up, recovery, result handling, and independent verification;
- which reference to read for each advanced case.

Place the complete Antigravity command catalog and operational details in references rather than the entrypoint.

- [ ] **Step 6: Run contract validation**

Run: `node --test tests/package-contract.test.mjs`

Run: `python C:/Users/junio/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugins/antigravity/skills/antigravity-delegator`

Expected: both commands PASS.

- [ ] **Step 7: Run behavioral scenarios with the skill when authorized**

Use fresh-context evaluators and the same prompts from Step 1. Confirm that the agent chooses the tracked runtime, preserves permissions, reports the job ID, and verifies results independently. Add only corrections supported by observed failures.

- [ ] **Step 8: Commit**

```bash
git add plugins/antigravity/skills/antigravity-delegator tests
git commit -m "feat: add Antigravity delegation skill"
```

---

### Task 10: Claude Code plugin adapters

**Files:**

- Create: `plugins/antigravity/.claude-plugin/plugin.json`
- Create: `plugins/antigravity/agents/antigravity-runner.md`
- Create: `plugins/antigravity/commands/delegate.md`
- Create: `plugins/antigravity/commands/status.md`
- Create: `plugins/antigravity/commands/wait.md`
- Create: `plugins/antigravity/commands/send.md`
- Create: `plugins/antigravity/commands/result.md`
- Create: `plugins/antigravity/commands/recover.md`
- Create: `plugins/antigravity/commands/cancel.md`
- Create: `plugins/antigravity/commands/doctor.md`
- Modify: `tests/package-contract.test.mjs`

**Interfaces:**

- Commands: `/antigravity:delegate`, `/antigravity:status`, `/antigravity:wait`, `/antigravity:send`, `/antigravity:result`, `/antigravity:recover`, `/antigravity:cancel`, `/antigravity:doctor`.
- Agent: `antigravity:antigravity-runner`, a Bash-only thin forwarder.

- [ ] **Step 1: Add failing plugin contract tests**

Validate the manifest, unique command descriptions, allowed-tool boundaries, runtime paths through `${CLAUDE_PLUGIN_ROOT}`, argument hints, and the rule that the forwarding agent returns runtime stdout unchanged.

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/package-contract.test.mjs`

Expected: FAIL because plugin files are absent.

- [ ] **Step 3: Use plugin-creator instructions and create the manifest**

The manifest identifies one plugin named `antigravity`. Do not add hooks, MCP servers, or a stop-review gate in this release.

- [ ] **Step 4: Add thin commands and forwarding agent**

`delegate.md` invokes the forwarding agent. Status-style commands invoke the runtime directly and preserve full result details. The forwarding agent performs one runtime `delegate` call and does no repository work of its own.

- [ ] **Step 5: Validate the plugin**

Run the local structural tests. If `claude plugin validate` or an equivalent installed validator is available, run it against `plugins/antigravity`; otherwise record the unavailable validator and rely on manifest contract tests.

- [ ] **Step 6: Verify GREEN**

Run: `node --test tests/package-contract.test.mjs`

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add plugins/antigravity tests/package-contract.test.mjs
git commit -m "feat: add Claude Code Antigravity plugin"
```

---

### Task 11: Codex installer and cross-host packaging

**Files:**

- Create: `scripts/install-codex.mjs`
- Modify: `plugins/antigravity/skills/antigravity-delegator/references/host-integration.md`
- Modify: `tests/package-contract.test.mjs`

**Interfaces:**

- Installer commands: `node scripts/install-codex.mjs --check`, `--copy`, and `--link`.
- Default target: `$CODEX_HOME/skills/antigravity-delegator`, falling back to `~/.codex/skills/antigravity-delegator`.

- [ ] **Step 1: Write failing installer tests**

Test target resolution, dry-run output, refusal to overwrite an unrelated existing directory, idempotent update of a matching installation, link capability detection, and copy fallback on Windows.

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/package-contract.test.mjs`

Expected: FAIL on missing installer.

- [ ] **Step 3: Implement safe check, copy, and link modes**

`--check` is read-only. `--copy` and `--link` print the exact source and destination before changing anything. An existing target is updated only if its `SKILL.md` declares `name: antigravity-delegator`; otherwise the installer stops.

Tests must supply a temporary target and never touch the user's real Codex directory.

- [ ] **Step 4: Verify GREEN**

Run: `node --test tests/package-contract.test.mjs`

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/install-codex.mjs plugins/antigravity/skills/antigravity-delegator/references/host-integration.md tests/package-contract.test.mjs
git commit -m "feat: add portable Codex skill installer"
```

---

### Task 12: End-to-end verification and release readiness

**Files:**

- Modify: files found deficient by verification only.
- Do not create a README unless the skill and host-integration reference cannot carry required setup information.

**Interfaces:**

- Consumes all prior runtime, skill, plugin, and installer interfaces.
- Produces fresh verification evidence and a clean working tree.

- [ ] **Step 1: Run the complete automated suite**

Run: `npm test`

Expected: all tests PASS, zero leaked workers, zero warnings from production code.

- [ ] **Step 2: Run package validators**

Run:

```text
node scripts/install-codex.mjs --check
python C:/Users/junio/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugins/antigravity/skills/antigravity-delegator
```

Run the available Claude plugin validator if installed.

Expected: all available validators PASS.

- [ ] **Step 3: Exercise the fake CLI end to end**

From a temporary workspace, run `doctor`, a foreground read-only job, a background job, `status`, `send`, `wait`, `result`, simulated quota fallback, simulated crash, `recover`, and `cancel`.

Expected: each command returns the documented state and next command; the recovered job retains its conversation ID.

- [ ] **Step 4: Check security and portability invariants**

Search for shell execution, dangerous permission flags, absolute development paths, unbounded polling, raw PID termination, writes to Antigravity settings, and non-portable path concatenation.

Expected: no violations. The only absolute path may appear in the development-time validation command inside this plan, not production files.

- [ ] **Step 5: Review the requirements line by line**

Compare the implementation with every acceptance criterion and explicit exclusion in the approved design. Record any unmet criterion instead of claiming completion.

- [ ] **Step 6: Run an opt-in real Antigravity smoke test only with authorization**

Prerequisites: authenticated `agy`, explicit permission to consume quota, a temporary workspace, and a read-only prompt. Do not enable credit overages or dangerous permissions.

Expected: a real `conversation_id`, observable stream events, and a stored result. If authorization is absent, report this test as not run.

- [ ] **Step 7: Inspect Git state and commit verification fixes**

Run: `git status --short` and `git diff --check`.

If verification required code changes:

```bash
git add <verified-files>
git commit -m "fix: close Antigravity delegator verification gaps"
```

- [ ] **Step 8: Prepare the handoff**

Report:

- commands and files delivered;
- automated test counts and validator output;
- whether independent agent scenarios ran;
- whether the real authenticated smoke test ran;
- remaining risks, especially changes in future Antigravity CLI versions.
