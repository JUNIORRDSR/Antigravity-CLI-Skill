// Regression tests for the failure modes observed against real agy 1.1.22 on Windows.
// Each test names the reported problem it pins down.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { FAKE_AGY, CLI, makeTempWorkspace, runCliJson, runNode } from "./helpers.mjs";
import { buildAgyArgs, effortIsCompatible, runAgyTurn, workspaceDirs } from "../plugins/antigravity/skills/antigravity-delegator/scripts/lib/agy.mjs";
import { inspectTurn, normalizedStateForResult, parsePermissionDenial, parseQuotaLimit, withoutBypassSuggestion } from "../plugins/antigravity/skills/antigravity-delegator/scripts/lib/errors.mjs";
import { rankModels, remainingModels } from "../plugins/antigravity/skills/antigravity-delegator/scripts/lib/model-routing.mjs";
import { buildDelegationPrompt, withHeadlessDirective } from "../plugins/antigravity/skills/antigravity-delegator/scripts/lib/prompt.mjs";
import { inspectPermissions } from "../plugins/antigravity/skills/antigravity-delegator/scripts/lib/doctor.mjs";

const command = { agyPath: process.execPath, agyPrefixArgs: [FAKE_AGY] };
const REAL_MODELS = [
  "gemini-3.7-flash-high", "gemini-3.1-pro-high", "claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium",
];

function envFor(scenario, extra = {}) {
  return {
    ANTIGRAVITY_AGY_PATH: process.execPath,
    ANTIGRAVITY_AGY_PREFIX_JSON: JSON.stringify([FAKE_AGY]),
    FAKE_AGY_SCENARIO: scenario,
    ...extra,
  };
}

// Problem 3: without --add-dir agy searches the user's home directory, not the cwd.
test("every turn passes the canonical workspace as --add-dir", () => {
  const args = buildAgyArgs({ prompt: "task", cwd: "C:/repo", workspace: "C:/repo" });
  assert.equal(args.filter(value => value === "--add-dir").length, 1);
  assert.equal(args[args.indexOf("--add-dir") + 1], "C:/repo");

  const extra = buildAgyArgs({ prompt: "task", workspace: "C:/repo", addDirs: ["C:/other", "C:/repo"] });
  assert.deepEqual(extra.filter((_, index) => extra[index - 1] === "--add-dir"), ["C:/other", "C:/repo"]);
  assert.deepEqual(workspaceDirs({ workspace: "C:/Repo", cwd: "C:/repo" }), process.platform === "win32" ? ["C:/Repo"] : ["C:/Repo", "C:/repo"]);
});

// Problem 6: `--effort is not supported for model "claude-opus-4-6-thinking"`, and
// `--model gemini-3.5-flash-medium conflicts with --effort=high`.
test("--effort is only sent when no model is pinned", () => {
  assert.equal(effortIsCompatible("claude-opus-4-6-thinking"), false);
  assert.equal(effortIsCompatible(undefined), true);
  assert.ok(!buildAgyArgs({ prompt: "t", model: "claude-opus-4-6-thinking", effort: "high" }).includes("--effort"));
  assert.ok(buildAgyArgs({ prompt: "t", effort: "high" }).includes("--effort"));
});

// Problem 9: `--print took "--model" as its prompt`. Never reproduced through the wrapper,
// which spawns argv directly, but pinned so a future refactor cannot regress into it.
test("--print is immediately followed by the prompt and never by a flag", () => {
  for (const run of [
    { prompt: "task", model: "claude-opus-4-6-thinking" },
    { prompt: "--model", agent: "reviewer", conversationId: "c1", cwd: "C:/repo" },
    { prompt: "task", jsonSchema: "C:/schema.json", accessProfile: "write" },
  ]) {
    const args = buildAgyArgs(run);
    assert.equal(args[0], "--print");
    assert.equal(args[1], run.prompt);
    assert.equal(args[2], "--output-format");
  }
});

test("--json-schema is forwarded when a schema is requested", () => {
  const args = buildAgyArgs({ prompt: "t", jsonSchema: "C:/audit.json" });
  assert.equal(args[args.indexOf("--json-schema") + 1], "C:/audit.json");
  assert.ok(!buildAgyArgs({ prompt: "t" }).includes("--json-schema"));
});

// The write barrier is the --mode flag, not prompt wording. Do not weaken.
test("read-only never reaches accept-edits and no path emits a permission bypass", () => {
  for (const profile of [undefined, "read-only", "read-only-sandbox"]) {
    const args = buildAgyArgs({ prompt: "please edit everything", accessProfile: profile, cwd: "C:/repo" });
    assert.equal(args[args.indexOf("--mode") + 1], "plan");
    assert.ok(!args.includes("--dangerously-skip-permissions"));
  }
  assert.equal(buildAgyArgs({ prompt: "t", accessProfile: "write" })[buildAgyArgs({ prompt: "t", accessProfile: "write" }).indexOf("--mode") + 1], "accept-edits");
});

// Problem 1: `--mode plan` answers with a plan and waits for approval headless can never give.
test("a plan awaiting approval is its own state, never succeeded", async () => {
  const turn = await runAgyTurn({ ...command, cwd: process.cwd(), prompt: "task", env: { FAKE_AGY_SCENARIO: "plan-approval" } });
  assert.equal(turn.status, "SUCCESS");
  const failure = inspectTurn(turn, { accessProfile: "read-only" });
  assert.equal(failure.kind, "awaiting-approval");
  assert.match(failure.planArtifact, /brain[\\/].+\.md$/);
  assert.equal(normalizedStateForResult(turn, failure), "awaiting-approval");
  assert.match(failure.guidance, /--mode plan/);
  assert.doesNotMatch(failure.guidance, /dangerously-skip-permissions/);
  // A write job legitimately plans on the way to editing; only read-only is trapped.
  assert.equal(inspectTurn(turn, { accessProfile: "write" }), null);
});

test("delegate reports awaiting-approval end to end", async t => {
  const temp = await makeTempWorkspace(); t.after(temp.cleanup);
  const job = await runCliJson(["delegate", "audit six documents", "--cwd", temp.workspace, "--state-dir", temp.stateDir], { env: envFor("plan-approval") });
  assert.equal(job.state, "awaiting-approval");
  assert.match(job.guidance, /plan/i);
  const result = await runCliJson(["result", job.id, "--cwd", temp.workspace, "--state-dir", temp.stateDir], { env: envFor("plan-approval") });
  assert.equal(result.state, "awaiting-approval");
  assert.equal(result.attempts.at(-1).outcome, "awaiting-approval");
});

// Problem 2: agy reported SUCCESS with an empty response.
test("SUCCESS with an empty response is not a success", async t => {
  const turn = await runAgyTurn({ ...command, cwd: process.cwd(), prompt: "task", env: { FAKE_AGY_SCENARIO: "empty-success" } });
  assert.equal(turn.status, "SUCCESS");
  const failure = inspectTurn(turn, { accessProfile: "read-only" });
  assert.equal(failure.kind, "empty-output");
  assert.equal(normalizedStateForResult(turn, failure), "failed");

  const temp = await makeTempWorkspace(); t.after(temp.cleanup);
  const job = await runCliJson(["delegate", "task", "--cwd", temp.workspace, "--state-dir", temp.stateDir], { env: envFor("empty-success") });
  assert.equal(job.state, "failed");
  assert.match(job.guidance, /without producing any answer/i);
});

// Problems 2 and 8: headless cannot prompt, so it auto-denies and produces nothing.
test("an auto-denied tool names the permission and never suggests the bypass flag", async t => {
  const turn = await runAgyTurn({ ...command, cwd: process.cwd(), prompt: "task", env: { FAKE_AGY_SCENARIO: "headless-deny" } });
  assert.ok(turn.permissionNotices.length > 0, "the jetski auto-deny notice must be recognised");
  const failure = inspectTurn(turn, { accessProfile: "read-only" });
  assert.equal(failure.kind, "permission");
  assert.equal(failure.deniedPermission, "command");
  assert.match(failure.guidance, /permissions\.allow/);
  assert.doesNotMatch(failure.guidance, /dangerously-skip-permissions/);
  assert.doesNotMatch(failure.evidence, /dangerously-skip-permissions/);

  const temp = await makeTempWorkspace(); t.after(temp.cleanup);
  const job = await runCliJson(["delegate", "audit branch strategy", "--cwd", temp.workspace, "--state-dir", temp.stateDir], { env: envFor("headless-deny") });
  assert.equal(job.state, "failed");
  assert.doesNotMatch(JSON.stringify(job), /dangerously-skip-permissions/);
});

test("agy's own bypass advice is stripped before it is reported", () => {
  const line = 'a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. command(<target>)). Alternatively, re-run with --dangerously-skip-permissions to auto-approve all tools.';
  assert.doesNotMatch(withoutBypassSuggestion(line), /dangerously-skip-permissions/);
  assert.match(withoutBypassSuggestion(line), /permissions\.allow/);
  assert.equal(parsePermissionDenial(line).permission, "command");
  assert.equal(parsePermissionDenial("nothing wrong here"), null);
});

// Problem 5: quota is per model and the message arrives inside the output.
test("a quota message inside a SUCCESS response is detected with its reset time", async () => {
  const turn = await runAgyTurn({ ...command, cwd: process.cwd(), prompt: "task", env: { FAKE_AGY_SCENARIO: "quota-in-response" } });
  assert.equal(turn.status, "SUCCESS");
  const failure = inspectTurn(turn, { accessProfile: "read-only" });
  assert.equal(failure.kind, "quota");
  assert.equal(failure.resetsIn, "4h47m30s");
  assert.equal(failure.switchFamily, true);
  assert.match(failure.guidance, /per model/);
  assert.equal(parseQuotaLimit("all fine"), null);
  assert.deepEqual(
    remainingModels(REAL_MODELS, ["claude-opus-4-6-thinking"]).slice(0, 2),
    ["gemini-3.7-flash-high", "gemini-3.1-pro-high"]
  );
});

test("a model switch is reported explicitly, never silently", async t => {
  const temp = await makeTempWorkspace(); t.after(temp.cleanup);
  const job = await runCliJson(
    ["delegate", "task", "--route", "third-party-first", "--cwd", temp.workspace, "--state-dir", temp.stateDir],
    { env: envFor("gemini-quota") }
  );
  const rendered = await runNode(
    [CLI, "result", job.id, "--cwd", temp.workspace, "--state-dir", temp.stateDir],
    { env: envFor("gemini-quota") }
  );
  assert.match(rendered.stdout, /Retry: attempt \d+ ran on /);
});

// Problem 4: routes existed but nothing selected them, so audits ran on the default model.
test("the quality route puts opus-class reasoning first", () => {
  assert.equal(rankModels(REAL_MODELS, "quality")[0].slug, "claude-opus-4-6-thinking");
  assert.equal(rankModels(REAL_MODELS, "fast")[0].slug, "gemini-3.7-flash-high");
  assert.equal(rankModels(REAL_MODELS, "claude-opus-4-6-thinking")[0].slug, "claude-opus-4-6-thinking");
});

test("route and model reach the job record through the CLI", async t => {
  const temp = await makeTempWorkspace(); t.after(temp.cleanup);
  const argvFile = path.join(temp.stateDir, "argv.json");
  const job = await runCliJson(
    ["delegate", "task", "--model", "claude-opus-4-6-thinking", "--effort", "high", "--cwd", temp.workspace, "--state-dir", temp.stateDir],
    { env: envFor("success", { FAKE_AGY_ARGV_FILE: argvFile }) }
  );
  assert.equal(job.state, "succeeded");
  const argv = JSON.parse(await readFile(argvFile, "utf8"));
  assert.ok(argv.includes("--model"));
  assert.ok(!argv.includes("--effort"), "a pinned model must not be paired with --effort");
  assert.equal(argv[argv.indexOf("--add-dir") + 1].toLowerCase(), temp.workspace.toLowerCase());
});

// Real streams carry conversation_id on step_update/result; there is no init event.
test("conversation continuity survives agy's real event envelope", async () => {
  const turn = await runAgyTurn({ ...command, cwd: process.cwd(), prompt: "task", env: { FAKE_AGY_SCENARIO: "nested-envelope" } });
  assert.equal(turn.conversationId, "conv-nested-1");
  assert.equal(turn.response, "nested ok");
});

// Problem 1, prompt side: the model must be told nobody can approve anything.
test("every delegated prompt carries the headless directive", () => {
  const contract = buildDelegationPrompt({ task: "Review parser", workspace: "/w", accessProfile: "read-only" });
  assert.match(contract, /do not ask to proceed/i);
  assert.match(contract, /must not change files/i);
  const raw = withHeadlessDirective("audit this file");
  assert.match(raw, /headless single-turn run/i);
  assert.equal(withHeadlessDirective(raw), raw, "the directive must not be appended twice");
});

test("doctor reports the agy allow-rules without ever writing them", async t => {
  const temp = await makeTempWorkspace(); t.after(temp.cleanup);
  const missing = await inspectPermissions({ agySettingsPath: path.join(temp.stateDir, "absent.json") });
  assert.equal(missing.ok, false);
  assert.match(missing.guidance, /permissions/);
  assert.doesNotMatch(missing.guidance, /dangerously-skip-permissions/);

  const file = path.join(temp.stateDir, "settings.json");
  await (await import("node:fs/promises")).writeFile(file, JSON.stringify({ permissions: { allow: ["read_file(*)"] } }), "utf8");
  const present = await inspectPermissions({ agySettingsPath: file });
  assert.deepEqual(present, { name: "permissions", ok: true, value: ["read_file(*)"] });
});
