import { randomBytes, randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { JOB_FILES, JOB_STATES, TERMINAL_JOB_STATES } from "./constants.mjs";

export async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    for (let attempt = 0; ; attempt += 1) {
      try { await rename(temp, file); break; }
      catch (error) {
        if (!new Set(["EPERM", "EACCES", "EBUSY"]).has(error.code) || attempt >= 5) throw error;
        await new Promise(resolve => setTimeout(resolve, 5 * (attempt + 1)));
      }
    }
  } catch (error) { await unlink(temp).catch(() => {}); throw error; }
}

export async function appendNdjson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(value)}\n`, "utf8");
}

export async function readNdjson(file) {
  let text;
  try { text = await readFile(file, "utf8"); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const lines = text.split(/\r?\n/);
  const result = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try { result.push(JSON.parse(line)); }
    catch (error) {
      if (index === lines.length - 1 && !text.endsWith("\n")) break;
      result.push({ type: "malformed", raw: line, error: error.message });
    }
  }
  return result;
}

export function jobPaths(jobDir) {
  return Object.fromEntries(Object.entries(JOB_FILES).map(([key, name]) => [key, path.join(jobDir, name)]));
}

export async function createJobRecord(input = {}) {
  const now = input.now || new Date().toISOString();
  return {
    version: 1,
    id: input.id || `agy-${randomUUID()}`,
    state: input.state || "queued",
    agyStatus: input.agyStatus || null,
    workspace: input.workspace,
    stateRoot: input.stateDir,
    workspaceDir: input.workspaceDir,
    jobDir: input.jobDir,
    prompt: input.prompt || "",
    accessProfile: input.accessProfile || "read-only",
    route: input.route || "auto",
    addDirs: input.addDirs || [],
    jsonSchema: input.jsonSchema || null,
    guidance: null,
    model: input.model || null,
    agent: input.agent || null,
    effort: input.effort || null,
    timeoutMs: input.timeoutMs || null,
    agyPath: input.agyPath || null,
    agyPrefixArgs: input.agyPrefixArgs || [],
    parentJobId: input.parentJobId || null,
    conversationId: input.conversationId || null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    endedAt: null,
    latestProgress: null,
    attempt: 0,
    worker: null,
    errors: [],
  };
}

export async function readJsonFile(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export async function readJob(file) {
  try {
    const value = await readJsonFile(file);
    if (!value || typeof value !== "object" || typeof value.id !== "string" || !JOB_STATES.includes(value.state)) throw new Error("invalid job record");
    if (!/^agy-[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(value.id)) throw new Error("invalid job ID");
    const actualJobDir = path.resolve(path.dirname(file));
    if (value.jobDir && path.resolve(value.jobDir) !== actualJobDir) throw new Error("stored job directory does not match metadata location");
    if (value.workspaceDir) {
      const workspaceDir = path.resolve(value.workspaceDir);
      const relative = path.relative(workspaceDir, actualJobDir);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("job directory is outside its workspace state directory");
    }
    return value;
  } catch (error) {
    const wrapped = new Error(`Corrupt job metadata at ${file}: ${error.message}`);
    wrapped.code = "CORRUPT_JOB";
    wrapped.cause = error;
    throw wrapped;
  }
}

function validateMutation(previous, next) {
  if (!next || typeof next !== "object") throw new Error("Job mutation must return an object");
  if (next.id !== previous.id) throw new Error("Job ID is immutable");
  if (!JOB_STATES.includes(next.state)) throw new Error(`Unknown job state: ${next.state}`);
  if (TERMINAL_JOB_STATES.has(previous.state) && next.state !== previous.state) throw new Error(`Cannot rewrite terminal state ${previous.state}`);
}

export async function updateJob(file, mutate) {
  return withFileLock(file, async () => {
    const previous = await readJob(file);
    const next = await mutate(structuredClone(previous));
    validateMutation(previous, next);
    next.updatedAt = new Date().toISOString();
    await writeJsonAtomic(file, next);
    return next;
  });
}

async function withFileLock(file, operation) {
  const lockFile = `${file}.lock`;
  let handle;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      handle = await open(lockFile, "wx");
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const info = await stat(lockFile);
        if (Date.now() - info.mtimeMs > 30000) await unlink(lockFile);
      } catch (inspectError) {
        if (inspectError.code !== "ENOENT") throw inspectError;
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(5 + attempt * 2, 50)));
    }
  }
  if (!handle) throw new Error(`Timed out acquiring job metadata lock: ${lockFile}`);
  try { return await operation(); }
  finally {
    await handle.close().catch(() => {});
    await unlink(lockFile).catch(() => {});
  }
}

export async function listJobRecords(workspaceDir) {
  let names;
  try { names = await readdir(workspaceDir, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const jobs = [];
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    try { jobs.push(await readJob(path.join(workspaceDir, entry.name, JOB_FILES.job))); } catch { /* retained for diagnostics */ }
  }
  return jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function tryCreateExclusiveJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(file, "wx");
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); } finally { await handle.close(); }
}
