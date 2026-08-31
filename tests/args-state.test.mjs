import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeTempWorkspace } from "./helpers.mjs";
import { parseCli, parseDuration } from "../plugins/antigravity/skills/antigravity-delegator/scripts/lib/args.mjs";
import { canonicalWorkspace, defaultStateRoot, workspaceStateDir } from "../plugins/antigravity/skills/antigravity-delegator/scripts/lib/workspace.mjs";
import { appendNdjson, createJobRecord, readJob, readNdjson, updateJob, writeJsonAtomic } from "../plugins/antigravity/skills/antigravity-delegator/scripts/lib/state.mjs";

test("parseCli preserves prompt and cwd arguments containing spaces", () => {
  const parsed = parseCli(["delegate", "--cwd", "C:/work/my project", "write docs for the parser"]);
  assert.equal(parsed.options.cwd, "C:/work/my project");
  assert.equal(parsed.positionals[0], "write docs for the parser");
});

test("parseCli supports boolean, routed, and duration options", () => {
  const parsed = parseCli(["delegate", "--background", "--read-only", "--route", "gemini-first", "--timeout=2m", "task"]);
  assert.equal(parsed.options.background, true);
  assert.equal(parsed.options.accessProfile, "read-only");
  assert.equal(parsed.options.route, "gemini-first");
  assert.equal(parsed.options.timeoutMs, 120000);
  assert.equal(parseDuration("250ms"), 250);
});

test("workspace state is platform aware and deterministically hashed", async () => {
  assert.equal(defaultStateRoot({ LOCALAPPDATA: "C:/state" }, "win32", "C:/home"), path.join("C:/state", "antigravity-delegator"));
  assert.equal(defaultStateRoot({ XDG_STATE_HOME: "/state" }, "linux", "/home/u"), "/state/antigravity-delegator");
  assert.equal(defaultStateRoot({}, "darwin", "/home/u"), "/home/u/.local/state/antigravity-delegator");
  const one = workspaceStateDir("/state", await canonicalWorkspace("."));
  const two = workspaceStateDir("/state", await canonicalWorkspace("."));
  assert.equal(one, two);
  assert.match(path.basename(one), /^[a-f0-9]{24}$/);
});

test("atomic metadata writes leave no temporary sibling", async t => {
  const temp = await makeTempWorkspace(); t.after(temp.cleanup);
  const file = path.join(temp.root, "job.json");
  await writeJsonAtomic(file, { id: "agy-test", state: "queued" });
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { id: "agy-test", state: "queued" });
  assert.deepEqual((await readdir(temp.root)).filter(name => name.startsWith("job.json.tmp-")), []);
});

test("NDJSON reader tolerates a truncated final line", async t => {
  const temp = await makeTempWorkspace(); t.after(temp.cleanup);
  const file = path.join(temp.root, "events.ndjson");
  await appendNdjson(file, { n: 1 });
  await writeFile(file, '{"n":1}\n{"n":', "utf8");
  assert.deepEqual(await readNdjson(file), [{ n: 1 }]);
});

test("job IDs are immutable and terminal state rewrites are rejected", async t => {
  const temp = await makeTempWorkspace(); t.after(temp.cleanup);
  const dir = path.join(temp.root, "job"); await mkdir(dir, { recursive: true });
  const file = path.join(dir, "job.json");
  const job = await createJobRecord({ workspace: temp.workspace, stateDir: temp.stateDir });
  await writeJsonAtomic(file, { ...job, state: "succeeded" });
  await assert.rejects(updateJob(file, value => ({ ...value, id: "different" })), /immutable/i);
  await assert.rejects(updateJob(file, value => ({ ...value, state: "running" })), /terminal/i);
});

test("concurrent job mutations preserve both writers", async t => {
  const temp = await makeTempWorkspace(); t.after(temp.cleanup);
  const file = path.join(temp.root, "job.json");
  const job = await createJobRecord({ workspace: temp.workspace, stateDir: temp.stateDir });
  await writeJsonAtomic(file, job);
  await Promise.all([
    updateJob(file, async value => { await new Promise(resolve => setTimeout(resolve, 25)); return { ...value, worker: { pid: 123 } }; }),
    updateJob(file, value => ({ ...value, latestProgress: { step: "started" } })),
  ]);
  const stored = await readJob(file);
  assert.equal(stored.worker.pid, 123);
  assert.equal(stored.latestProgress.step, "started");
});

test("readJob preserves corrupt metadata for diagnosis", async t => {
  const temp = await makeTempWorkspace(); t.after(temp.cleanup);
  const file = path.join(temp.root, "job.json"); await writeFile(file, "{bad", "utf8");
  await assert.rejects(readJob(file), /corrupt/i);
  assert.equal(await readFile(file, "utf8"), "{bad");
});
