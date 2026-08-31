import test from "node:test";
import assert from "node:assert/strict";
import { FAKE_AGY, CLI, makeTempWorkspace, runCliJson, runNode } from "./helpers.mjs";

const fakeEnv = { ANTIGRAVITY_AGY_PATH: process.execPath, ANTIGRAVITY_AGY_PREFIX_JSON: JSON.stringify([FAKE_AGY]), FAKE_AGY_SCENARIO: "success" };

test("help is concise, includes public commands, and hides internal worker", async () => {
  const value = await runNode([CLI, "help"]);
  assert.equal(value.code, 0);
  assert.match(value.stdout, /delegate/);
  assert.match(value.stdout, /recover/);
  assert.doesNotMatch(value.stdout, /internal-worker|\bworker\b/);
});

test("unknown commands fail on stderr", async () => {
  const value = await runNode([CLI, "unknown"]);
  assert.notEqual(value.code, 0);
  assert.match(value.stderr, /Unknown command/);
});

test("delegate and status JSON preserve actionable fields without prompt leakage", async t => {
  const temp = await makeTempWorkspace(); t.after(temp.cleanup);
  const delegated = await runCliJson(["delegate", "secret prompt text", "--cwd", temp.workspace, "--state-dir", temp.stateDir], { env: fakeEnv });
  assert.equal(delegated.state, "succeeded");
  const status = await runCliJson(["status", delegated.id, "--cwd", temp.workspace, "--state-dir", temp.stateDir], { env: fakeEnv });
  assert.equal(status.id, delegated.id);
  assert.equal(status.workspace.toLowerCase(), temp.workspace.toLowerCase());
  assert.ok(status.nextCommands.result);
  assert.doesNotMatch(JSON.stringify(status), /secret prompt text/);
});

test("human status is compact and tabular", async t => {
  const temp = await makeTempWorkspace(); t.after(temp.cleanup);
  const delegated = await runCliJson(["delegate", "task", "--cwd", temp.workspace, "--state-dir", temp.stateDir], { env: fakeEnv });
  const value = await runNode([CLI, "status", delegated.id, "--cwd", temp.workspace, "--state-dir", temp.stateDir], { env: fakeEnv });
  assert.match(value.stdout, /JOB\s+STATE\s+MODEL/);
  assert.match(value.stdout, new RegExp(delegated.id));
});

test("latest job resolution is scoped to the workspace and wait is bounded", async t => {
  const temp = await makeTempWorkspace(); t.after(temp.cleanup);
  const delegated = await runCliJson(["delegate", "task", "--cwd", temp.workspace, "--state-dir", temp.stateDir], { env: fakeEnv });
  const latest = await runCliJson(["status", "--cwd", temp.workspace, "--state-dir", temp.stateDir], { env: fakeEnv });
  assert.equal(latest.id, delegated.id);
  const started = Date.now();
  const waited = await runCliJson(["wait", delegated.id, "--timeout", "50ms", "--cwd", temp.workspace, "--state-dir", temp.stateDir], { env: fakeEnv });
  assert.equal(waited.state, "succeeded");
  assert.ok(Date.now() - started < 1000);
});

test("result JSON preserves complete response and attempts", async t => {
  const temp = await makeTempWorkspace(); t.after(temp.cleanup);
  const delegated = await runCliJson(["delegate", "task", "--cwd", temp.workspace, "--state-dir", temp.stateDir], { env: fakeEnv });
  const result = await runCliJson(["result", delegated.id, "--cwd", temp.workspace, "--state-dir", temp.stateDir], { env: fakeEnv });
  assert.equal(result.response, "completed");
  assert.equal(result.attempts.length, 1);
  assert.ok(result.nextCommands.status);
});

test("doctor failures are actionable", async t => {
  const temp = await makeTempWorkspace(); t.after(temp.cleanup);
  const value = await runCliJson(["doctor", "--cwd", temp.workspace, "--state-dir", temp.stateDir], { env: { ANTIGRAVITY_AGY_PATH: "missing-agy-executable" } });
  assert.equal(value.ok, false);
  assert.match(JSON.stringify(value), /install|PATH|authentication/i);
});
