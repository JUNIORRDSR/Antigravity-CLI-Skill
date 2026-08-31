import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { FAKE_AGY, makeTempWorkspace, ROOT } from "./helpers.mjs";
import { createJob, getJob, queueMessage, pendingMessages, cancelJob } from "../plugins/antigravity/skills/antigravity-delegator/scripts/lib/jobs.mjs";
import { isWorkerReachable, sendControl, startControlServer } from "../plugins/antigravity/skills/antigravity-delegator/scripts/lib/control.mjs";
import { startDetachedWorker } from "../plugins/antigravity/skills/antigravity-delegator/scripts/lib/worker.mjs";

const WORKER = path.join(ROOT, "plugins", "antigravity", "skills", "antigravity-delegator", "scripts", "lib", "worker.mjs");
const waitFor = async (fn, timeout = 8000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error("condition timed out");
};

test("control server authenticates ping and rejects a wrong token", async t => {
  const control = await startControlServer({ token: "correct-token", handlers: {} });
  t.after(() => control.close());
  const job = { worker: { token: "correct-token", port: control.port } };
  assert.equal((await sendControl(job, "ping")).ok, true);
  await assert.rejects(sendControl({ worker: { ...job.worker, token: "wrong-token" } }, "ping"), /401|unauthorized/i);
});

test("durable messages remain pending until separately acknowledged", async t => {
  const temp = await makeTempWorkspace(); t.after(temp.cleanup);
  const job = await createJob({ cwd: temp.workspace, stateDir: temp.stateDir, prompt: "task" });
  const queued = await queueMessage(job.id, "follow up", { cwd: temp.workspace, stateDir: temp.stateDir, deliver: false });
  assert.equal((await pendingMessages(job))[0].id, queued.id);
  const { ackMessage } = await import("../plugins/antigravity/skills/antigravity-delegator/scripts/lib/jobs.mjs");
  await ackMessage(job.id, queued.id, { cwd: temp.workspace, stateDir: temp.stateDir });
  assert.deepEqual(await pendingMessages(job), []);
});

test("detached worker returns immediately, writes heartbeat, and is canceled through authenticated control", async t => {
  const temp = await makeTempWorkspace(); t.after(temp.cleanup);
  const job = await createJob({ cwd: temp.workspace, stateDir: temp.stateDir, prompt: "task", agyPath: process.execPath, agyPrefixArgs: [FAKE_AGY] });
  const startedAt = Date.now();
  await startDetachedWorker(job.id, {
    cwd: temp.workspace, stateDir: temp.stateDir, entryPath: WORKER, directModule: true,
    env: { FAKE_AGY_SCENARIO: "slow-success", FAKE_AGY_DELAY_MS: "2000" },
  });
  assert.ok(Date.now() - startedAt < 750);
  const live = await waitFor(async () => {
    const value = await getJob(job.id, { cwd: temp.workspace, stateDir: temp.stateDir });
    return value.worker?.port ? value : null;
  });
  try {
    assert.equal(await isWorkerReachable(live), true);
  } catch (error) {
    const workerStderr = await readFile(path.join(job.jobDir, "worker.stderr.log"), "utf8").catch(readError => `<unreadable: ${readError.message}>`);
    const current = await getJob(job.id, { cwd: temp.workspace, stateDir: temp.stateDir }).catch(readError => ({ readError: readError.message }));
    assert.fail(`${error.message}\nworker=${JSON.stringify(current.worker)} state=${current.state} stderr=${workerStderr}`);
  }
  const canceled = await cancelJob(job.id, { cwd: temp.workspace, stateDir: temp.stateDir });
  assert.equal(canceled.requested, true);
  await waitFor(async () => ["canceled", "interrupted"].includes((await getJob(job.id, { cwd: temp.workspace, stateDir: temp.stateDir })).state));
  await waitFor(async () => !await isWorkerReachable(await getJob(job.id, { cwd: temp.workspace, stateDir: temp.stateDir })));
  assert.doesNotMatch(await readFile(path.join(job.jobDir, "job.json"), "utf8"), /killPid|signalPid/);
});
