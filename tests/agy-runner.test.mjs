import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { FAKE_AGY, makeTempWorkspace } from "./helpers.mjs";
import { buildDelegationPrompt } from "../plugins/antigravity/skills/antigravity-delegator/scripts/lib/prompt.mjs";
import { buildAgyArgs, discoverAgents, discoverModels, runAgyTurn } from "../plugins/antigravity/skills/antigravity-delegator/scripts/lib/agy.mjs";

const command = { agyPath: process.execPath, agyPrefixArgs: [FAKE_AGY] };

test("delegation prompt keeps the seven contract sections in order", () => {
  const prompt = buildDelegationPrompt({
    task: "Review parser", workspace: "/work", scope: "src/parser", accessProfile: "read-only",
    deliverable: "Findings", verification: "Inspect tests", stoppingCondition: "Stop after findings",
  });
  const headings = ["Task", "Workspace and scope", "Authorization", "Expected deliverable", "Verification", "Stopping condition", "Final response contract"];
  let previous = -1;
  for (const heading of headings) { const index = prompt.indexOf(heading); assert.ok(index > previous); previous = index; }
  assert.match(prompt, /must not change files/i);
});

test("buildAgyArgs uses arrays for profiles, selection, and continuation", () => {
  assert.deepEqual(buildAgyArgs({ prompt: "write docs; echo unsafe", accessProfile: "read-only" }), [
    "--print", "write docs; echo unsafe", "--output-format", "stream-json", "--mode", "plan",
  ]);
  // --effort is dropped here on purpose: agy rejects it whenever --model is pinned.
  assert.deepEqual(buildAgyArgs({ prompt: "task", accessProfile: "write-sandbox", model: "gpt-5.4", agent: "reviewer", effort: "high", conversationId: "conv exact" }), [
    "--print", "task", "--output-format", "stream-json", "--model", "gpt-5.4", "--agent", "reviewer", "--conversation", "conv exact", "--mode", "accept-edits", "--sandbox",
  ]);
  assert.ok(!buildAgyArgs({ prompt: "x" }).includes("--dangerously-skip-permissions"));
});

test("discovers models and agents through direct child processes", async () => {
  const models = await discoverModels(command);
  const agents = await discoverAgents(command);
  assert.equal(models[0].slug, "gemini-3.5-flash-medium");
  assert.deepEqual(agents, ["default", "planner", "reviewer"]);
});

test("successful stream captures conversation, progress, usage, and response", async t => {
  const temp = await makeTempWorkspace(); t.after(temp.cleanup); await mkdir(temp.workspace, { recursive: true });
  const progress = [];
  const result = await runAgyTurn({ ...command, cwd: temp.workspace, prompt: "task", onEvent: event => progress.push(event), env: { FAKE_AGY_SCENARIO: "success" } });
  assert.equal(result.exitCode, 0);
  assert.equal(result.status, "SUCCESS");
  assert.equal(result.conversationId, "conv-fake-1");
  assert.equal(result.model, "gemini-3.5-flash-medium");
  assert.equal(result.response, "completed");
  assert.equal(result.usage.input_tokens, 10);
  assert.ok(progress.some(event => event.kind === "progress"));
});

test("malformed complete lines are retained without hiding later success", async () => {
  const result = await runAgyTurn({ ...command, cwd: process.cwd(), prompt: "task", env: { FAKE_AGY_SCENARIO: "malformed-line" } });
  assert.equal(result.status, "SUCCESS");
  assert.equal(result.response, "ok after malformed");
  assert.ok(result.events.some(event => event.kind === "malformed"));
});

test("zero-exit permission soft denial is classified as failure evidence", async () => {
  const result = await runAgyTurn({ ...command, cwd: process.cwd(), prompt: "task", env: { FAKE_AGY_SCENARIO: "soft-deny" } });
  assert.equal(result.exitCode, 0);
  assert.equal(result.status, "ERROR");
  assert.ok(result.permissionNotices.length > 0);
});

test("non-zero authentication and interrupted results remain distinct", async () => {
  const auth = await runAgyTurn({ ...command, cwd: process.cwd(), prompt: "task", env: { FAKE_AGY_SCENARIO: "auth-error" } });
  assert.equal(auth.exitCode, 1);
  assert.match(auth.stderr, /Authentication/);
  const interrupted = await runAgyTurn({ ...command, cwd: process.cwd(), prompt: "task", env: { FAKE_AGY_SCENARIO: "interrupted" } });
  assert.equal(interrupted.status, "INTERRUPTED");
});

test("timeout terminates the owned child and returns after close", async () => {
  const started = Date.now();
  const result = await runAgyTurn({ ...command, cwd: process.cwd(), prompt: "task", timeoutMs: 30, env: { FAKE_AGY_SCENARIO: "slow-success", FAKE_AGY_DELAY_MS: "1000" } });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 900);
});

test("continuation passes the exact conversation ID", async () => {
  const result = await runAgyTurn({ ...command, cwd: process.cwd(), prompt: "follow up", conversationId: "conv exact", env: { FAKE_AGY_SCENARIO: "success" } });
  assert.equal(result.conversationId, "conv exact");
});
