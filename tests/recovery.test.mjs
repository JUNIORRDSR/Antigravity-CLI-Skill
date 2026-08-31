import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { makeTempWorkspace } from "./helpers.mjs";
import { cancelJob, createJob, getJob, listJobs, recoverJob, resumeJob, runJob } from "../plugins/antigravity/skills/antigravity-delegator/scripts/lib/jobs.mjs";
import { readNdjson } from "../plugins/antigravity/skills/antigravity-delegator/scripts/lib/state.mjs";

const success = (conversationId = "conv-1") => ({
  exitCode: 0, signal: null, conversationId, status: "SUCCESS", response: "done", error: null,
  usage: { input_tokens: 1, output_tokens: 2 }, events: [], stderr: "", permissionNotices: [], changedFiles: [], verification: null,
});
const failure = (stderr, conversationId = "conv-1") => ({
  exitCode: 1, signal: null, conversationId, status: "ERROR", response: null, error: stderr,
  usage: null, events: [], stderr, permissionNotices: [], changedFiles: [], verification: null,
});

test("fresh job success persists result, attempt, and workspace-scoped lookup", async t => {
  const temp = await makeTempWorkspace(); t.after(temp.cleanup);
  const job = await createJob({ cwd: temp.workspace, stateDir: temp.stateDir, prompt: "task" });
  const finished = await runJob(job.id, { cwd: temp.workspace, stateDir: temp.stateDir, runTurn: async () => success() });
  assert.equal(finished.state, "succeeded");
  assert.equal(finished.conversationId, "conv-1");
  assert.equal((await getJob(job.id, { cwd: temp.workspace, stateDir: temp.stateDir })).id, job.id);
  assert.equal((await listJobs({ cwd: temp.workspace, stateDir: temp.stateDir })).length, 1);
  const attempts = await readNdjson(path.join(job.jobDir, "attempts.ndjson"));
  assert.equal(attempts[0].outcome, "succeeded");
  assert.equal(JSON.parse(await readFile(path.join(job.jobDir, "result.json"), "utf8")).response, "done");
});

test("explicit model and exact continuation are passed to the turn", async t => {
  const temp = await makeTempWorkspace(); t.after(temp.cleanup);
  const seen = [];
  const job = await createJob({ cwd: temp.workspace, stateDir: temp.stateDir, prompt: "task", model: "gpt-5.4", conversationId: "conv exact" });
  await runJob(job.id, { cwd: temp.workspace, stateDir: temp.stateDir, runTurn: async options => { seen.push(options); return success("conv exact"); } });
  assert.equal(seen[0].model, "gpt-5.4");
  assert.equal(seen[0].conversationId, "conv exact");
});

test("transport retries are bounded and use injected backoff", async t => {
  const temp = await makeTempWorkspace(); t.after(temp.cleanup);
  let calls = 0; const sleeps = [];
  const job = await createJob({ cwd: temp.workspace, stateDir: temp.stateDir, prompt: "task" });
  const finished = await runJob(job.id, {
    cwd: temp.workspace, stateDir: temp.stateDir,
    runTurn: async () => ++calls < 3 ? failure("ECONNRESET") : success(),
    sleep: async ms => sleeps.push(ms),
  });
  assert.equal(finished.state, "succeeded");
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [1000, 3000]);
});

test("quota switches from Gemini to third-party while preserving conversation", async t => {
  const temp = await makeTempWorkspace(); t.after(temp.cleanup);
  const seen = [];
  const job = await createJob({ cwd: temp.workspace, stateDir: temp.stateDir, prompt: "task", model: "gemini-3.5-flash-medium" });
  const finished = await runJob(job.id, {
    cwd: temp.workspace, stateDir: temp.stateDir, availableModels: ["gemini-3.5-flash-medium", "claude-sonnet-4-5"],
    runTurn: async options => { seen.push(options); return seen.length === 1 ? failure("Gemini quota exhausted", "conv-quota") : success(options.conversationId); },
  });
  assert.equal(finished.state, "succeeded");
  assert.deepEqual(seen.map(value => value.model), ["gemini-3.5-flash-medium", "claude-sonnet-4-5"]);
  assert.equal(seen[1].conversationId, "conv-quota");
});

test("quota switches from third-party to Gemini", async t => {
  const temp = await makeTempWorkspace(); t.after(temp.cleanup);
  const seen = [];
  const job = await createJob({ cwd: temp.workspace, stateDir: temp.stateDir, prompt: "task", model: "claude-sonnet-4-5" });
  await runJob(job.id, {
    cwd: temp.workspace, stateDir: temp.stateDir, availableModels: ["gemini-3.5-flash-medium", "claude-sonnet-4-5"],
    runTurn: async options => { seen.push(options.model); return seen.length === 1 ? failure("Claude rate limit exceeded") : success(); },
  });
  assert.deepEqual(seen, ["claude-sonnet-4-5", "gemini-3.5-flash-medium"]);
});

test("auto route uses the stream-selected model family for quota fallback", async t => {
  const temp = await makeTempWorkspace(); t.after(temp.cleanup);
  const seen = [];
  const job = await createJob({ cwd: temp.workspace, stateDir: temp.stateDir, prompt: "task" });
  const finished = await runJob(job.id, {
    cwd: temp.workspace, stateDir: temp.stateDir,
    availableModels: ["gemini-3.5-flash-medium", "claude-sonnet-4-5"],
    runTurn: async options => {
      seen.push(options.model);
      return seen.length === 1
        ? { ...failure("quota exhausted", "conv-auto"), model: "gemini-3.5-flash-medium" }
        : success(options.conversationId);
    },
  });
  assert.equal(finished.state, "succeeded");
  assert.deepEqual(seen, [null, "claude-sonnet-4-5"]);
});

test("authentication and permission failures do not retry or switch family", async t => {
  const temp = await makeTempWorkspace(); t.after(temp.cleanup);
  for (const diagnostic of ["Authentication required", "Permission denied"]) {
    let calls = 0;
    const job = await createJob({ cwd: temp.workspace, stateDir: temp.stateDir, prompt: diagnostic });
    const finished = await runJob(job.id, { cwd: temp.workspace, stateDir: temp.stateDir, runTurn: async () => { calls += 1; return failure(diagnostic); } });
    assert.equal(finished.state, "failed");
    assert.equal(calls, 1);
  }
});

test("exhausted family routes retain complete failure history", async t => {
  const temp = await makeTempWorkspace(); t.after(temp.cleanup);
  const job = await createJob({ cwd: temp.workspace, stateDir: temp.stateDir, prompt: "task", model: "gemini-3.5-flash-medium" });
  const finished = await runJob(job.id, {
    cwd: temp.workspace, stateDir: temp.stateDir, availableModels: ["gemini-3.5-flash-medium", "claude-sonnet-4-5"],
    runTurn: async options => failure(`${options.model} quota exhausted`), retryPolicy: { transportRetries: 0, familySwitches: 1, maxAttempts: 2, backoffMs: [] },
  });
  assert.equal(finished.state, "failed");
  assert.equal((await readNdjson(path.join(job.jobDir, "attempts.ndjson"))).length, 2);
});

test("resume creates a new tracked job using the exact stored conversation", async t => {
  const temp = await makeTempWorkspace(); t.after(temp.cleanup);
  const source = await createJob({ cwd: temp.workspace, stateDir: temp.stateDir, prompt: "task", conversationId: "conv-resume" });
  const resumed = await resumeJob(source.id, "follow up", { cwd: temp.workspace, stateDir: temp.stateDir, run: false });
  assert.notEqual(resumed.id, source.id);
  assert.equal(resumed.parentJobId, source.id);
  assert.equal(resumed.conversationId, "conv-resume");
  assert.match(resumed.prompt, /^follow up\b/);
  assert.match(resumed.prompt, /headless single-turn run/i);
});

test("responsive worker wins over a stale heartbeat during reconciliation", async t => {
  const temp = await makeTempWorkspace(); t.after(temp.cleanup);
  const job = await createJob({ cwd: temp.workspace, stateDir: temp.stateDir, prompt: "task" });
  const result = await recoverJob(job.id, { cwd: temp.workspace, stateDir: temp.stateDir, reachable: async () => true });
  assert.equal(result.action, "already-running");
});

test("stale unreachable jobs are compare-and-claim recovered once", async t => {
  const temp = await makeTempWorkspace(); t.after(temp.cleanup);
  const job = await createJob({ cwd: temp.workspace, stateDir: temp.stateDir, prompt: "task", conversationId: "conv-recover" });
  let starts = 0;
  const options = {
    cwd: temp.workspace, stateDir: temp.stateDir, reachable: async () => false,
    startWorker: async () => { starts += 1; await new Promise(resolve => setTimeout(resolve, 20)); },
  };
  const values = await Promise.all([recoverJob(job.id, options), recoverJob(job.id, options)]);
  assert.equal(starts, 1);
  assert.ok(values.some(value => value.action === "restarted"));
  assert.ok(values.some(value => value.action === "claimed"));
});

test("recovery reports continuity loss when no conversation ID exists", async t => {
  const temp = await makeTempWorkspace(); t.after(temp.cleanup);
  const job = await createJob({ cwd: temp.workspace, stateDir: temp.stateDir, prompt: "task" });
  const result = await recoverJob(job.id, { cwd: temp.workspace, stateDir: temp.stateDir, reachable: async () => false, startWorker: async () => {} });
  assert.equal(result.continuityPreserved, false);
});

test("canceled jobs never restart and stale cancellation never signals a stored PID", async t => {
  const temp = await makeTempWorkspace(); t.after(temp.cleanup);
  const job = await createJob({ cwd: temp.workspace, stateDir: temp.stateDir, prompt: "task" });
  await import("../plugins/antigravity/skills/antigravity-delegator/scripts/lib/state.mjs").then(({ updateJob }) => updateJob(path.join(job.jobDir, "job.json"), value => ({ ...value, state: "running", worker: { pid: 4242, startedAt: "2000-01-01T00:00:00.000Z" } })));
  const canceled = await cancelJob(job.id, { cwd: temp.workspace, stateDir: temp.stateDir, reachable: async () => false });
  assert.equal(canceled.state, "canceled");
  let starts = 0;
  const result = await recoverJob(job.id, { cwd: temp.workspace, stateDir: temp.stateDir, startWorker: async () => { starts += 1; } });
  assert.equal(result.action, "none");
  assert.equal(starts, 0);
});

test("fresh unreachable cancellation remains durable but does not assert the worker stopped", async t => {
  const temp = await makeTempWorkspace(); t.after(temp.cleanup);
  const job = await createJob({ cwd: temp.workspace, stateDir: temp.stateDir, prompt: "task" });
  const result = await cancelJob(job.id, { cwd: temp.workspace, stateDir: temp.stateDir, reachable: async () => false });
  assert.equal(result.state, "queued");
  assert.equal(result.pending, true);
  assert.equal((await readNdjson(path.join(job.jobDir, "messages.ndjson"))).at(-1).type, "cancel");
  let starts = 0;
  const recovery = await recoverJob(job.id, { cwd: temp.workspace, stateDir: temp.stateDir, reachable: async () => false, startWorker: async () => { starts += 1; } });
  assert.equal(recovery.reason, "cancellation-requested");
  assert.equal(starts, 0);
});

test("job references and persisted paths cannot escape the workspace state directory", async t => {
  const temp = await makeTempWorkspace(); t.after(temp.cleanup);
  const job = await createJob({ cwd: temp.workspace, stateDir: temp.stateDir, prompt: "task" });
  await assert.rejects(getJob("../outside", { cwd: temp.workspace, stateDir: temp.stateDir }), /invalid job id/i);

  const original = JSON.parse(await readFile(path.join(job.jobDir, "job.json"), "utf8"));
  await import("../plugins/antigravity/skills/antigravity-delegator/scripts/lib/state.mjs").then(({ writeJsonAtomic }) => writeJsonAtomic(path.join(job.jobDir, "job.json"), { ...original, jobDir: path.join(temp.root, "outside") }));
  await assert.rejects(getJob(job.id, { cwd: temp.workspace, stateDir: temp.stateDir }), /corrupt|outside|location/i);

  await import("../plugins/antigravity/skills/antigravity-delegator/scripts/lib/state.mjs").then(({ writeJsonAtomic }) => writeJsonAtomic(path.join(job.jobDir, "job.json"), { ...original, workspace: path.join(temp.root, "other-workspace") }));
  await assert.rejects(getJob(job.id, { cwd: temp.workspace, stateDir: temp.stateDir }), /workspace/i);
});
