import { mkdir, readFile, realpath, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { runAgyTurn, discoverModels } from "./agy.mjs";
import { DEFAULT_RETRY_POLICY, HEARTBEAT_STALE_MS, JOB_FILES, RECOVERY_CLAIM_TTL_MS, TERMINAL_JOB_STATES } from "./constants.mjs";
import { inspectTurn, normalizedStateForResult } from "./errors.mjs";
import { chooseFallback, classifyModelFamily, rankModels } from "./model-routing.mjs";
import { buildDelegationPrompt, withHeadlessDirective } from "./prompt.mjs";
import { appendNdjson, createJobRecord, jobPaths, listJobRecords, readJob, readNdjson, tryCreateExclusiveJson, updateJob, writeJsonAtomic } from "./state.mjs";
import { resolveWorkspaceContext } from "./workspace.mjs";

const sleepDefault = ms => new Promise(resolve => setTimeout(resolve, ms));

function mergeRetryPolicy(value = {}) {
  return { ...DEFAULT_RETRY_POLICY, ...value, backoffMs: value.backoffMs || DEFAULT_RETRY_POLICY.backoffMs };
}

function serializeResult(job, turn, attempts) {
  return {
    schemaVersion: 1,
    jobId: job.id,
    state: job.state,
    agyStatus: turn?.status || job.agyStatus || null,
    conversationId: job.conversationId || null,
    attempts,
    response: turn?.response ?? null,
    guidance: job.guidance || null,
    changedFiles: turn?.changedFiles || [],
    verification: turn?.verification || null,
    errors: job.errors || [],
    usage: turn?.usage || null,
    stderr: turn?.stderr || "",
    completedAt: job.endedAt || null,
  };
}

export async function createJob(options = {}) {
  const context = await resolveWorkspaceContext(options);
  const raw = typeof options.task === "object" ? buildDelegationPrompt({ ...options.task, workspace: options.task.workspace || context.workspace }) : options.prompt;
  if (!raw) throw new Error("A prompt is required");
  const prompt = withHeadlessDirective(raw);
  const initial = await createJobRecord({
    ...options, workspace: context.workspace, stateDir: context.stateRoot,
    workspaceDir: context.workspaceDir, prompt,
  });
  const jobDir = path.join(context.workspaceDir, initial.id);
  const job = { ...initial, jobDir, workspaceDir: context.workspaceDir };
  await mkdir(jobDir, { recursive: true });
  await writeJsonAtomic(path.join(jobDir, JOB_FILES.job), job);
  return job;
}

export async function listJobs(context = {}) {
  const resolved = await resolveWorkspaceContext(context);
  const jobs = await listJobRecords(resolved.workspaceDir);
  return Promise.all(jobs.map(job => validateLoadedJob(job, resolved)));
}

export async function getJob(reference, context = {}) {
  const resolved = await resolveWorkspaceContext(context);
  if (reference && reference !== "latest") {
    validateJobId(reference);
    const candidateDir = path.resolve(resolved.workspaceDir, reference);
    assertContained(resolved.workspaceDir, candidateDir, "job reference");
    const [realWorkspaceDir, realCandidateDir] = await Promise.all([realpath(resolved.workspaceDir), realpath(candidateDir)]).catch(error => {
      throw new Error(`Cannot resolve job ${reference}: ${error.message}`);
    });
    assertContained(realWorkspaceDir, realCandidateDir, "resolved job reference");
    const job = await readJob(path.join(candidateDir, JOB_FILES.job));
    return validateLoadedJob(job, resolved, candidateDir);
  }
  const jobs = await listJobs(context);
  if (!jobs.length) throw new Error(`No jobs found for workspace ${resolved.workspace}`);
  return jobs[0];
}

function validateJobId(value) {
  if (!/^agy-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value))) {
    throw new Error(`Invalid job ID: ${value}`);
  }
}

function normalizedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function assertContained(base, candidate, label) {
  const relative = path.relative(normalizedPath(base), normalizedPath(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} is outside the workspace state directory`);
}

async function validateLoadedJob(job, context, expectedJobDir = path.join(context.workspaceDir, job.id)) {
  validateJobId(job.id);
  assertContained(context.workspaceDir, expectedJobDir, "job directory");
  if (normalizedPath(job.jobDir) !== normalizedPath(expectedJobDir)) throw new Error(`Corrupt job ${job.id}: stored job directory does not match its state location`);
  if (normalizedPath(job.workspaceDir) !== normalizedPath(context.workspaceDir)) throw new Error(`Corrupt job ${job.id}: workspace state directory mismatch`);
  if (normalizedPath(job.stateRoot) !== normalizedPath(context.stateRoot)) throw new Error(`Corrupt job ${job.id}: state root mismatch`);
  if (normalizedPath(job.workspace) !== normalizedPath(context.workspace)) throw new Error(`Corrupt job ${job.id}: workspace mismatch`);
  const [realWorkspaceDir, realJobDir] = await Promise.all([realpath(context.workspaceDir), realpath(expectedJobDir)]);
  assertContained(realWorkspaceDir, realJobDir, "resolved job directory");
  return job;
}

export async function runAttempt(job, options = {}) {
  const file = path.join(job.jobDir, JOB_FILES.job);
  const number = (job.attempt || 0) + 1;
  const startedAt = new Date().toISOString();
  job = await updateJob(file, value => ({
    ...value, state: "running", attempt: number, startedAt: value.startedAt || startedAt,
    model: options.model !== undefined ? options.model : value.model,
  }));
  const runTurn = options.runTurn || runAgyTurn;
  const turn = await runTurn({
    agyPath: options.agyPath || job.agyPath,
    agyPrefixArgs: options.agyPrefixArgs || job.agyPrefixArgs,
    cwd: job.workspace,
    workspace: job.workspace,
    addDirs: options.addDirs || job.addDirs,
    jsonSchema: options.jsonSchema !== undefined ? options.jsonSchema : job.jsonSchema,
    prompt: options.prompt || job.prompt,
    model: options.model !== undefined ? options.model : job.model,
    agent: job.agent,
    effort: job.effort,
    conversationId: options.conversationId !== undefined ? options.conversationId : job.conversationId,
    accessProfile: job.accessProfile,
    timeoutMs: options.timeoutMs || job.timeoutMs,
    signal: options.signal,
    env: options.env,
    onChild: options.onChild,
  });
  const paths = jobPaths(job.jobDir);
  for (const event of turn.events || []) await appendNdjson(paths.events, { at: new Date().toISOString(), attempt: number, ...event });
  if (turn.stderr) await import("node:fs/promises").then(({ appendFile }) => appendFile(paths.stderr, turn.stderr, "utf8"));
  const failure = inspectTurn(turn, { accessProfile: job.accessProfile });
  const attemptedModel = turn.model || (options.model !== undefined ? options.model : job.model);
  const attempt = {
    number,
    model: attemptedModel,
    family: classifyModelFamily(attemptedModel),
    startedAt,
    endedAt: new Date().toISOString(),
    outcome: failure ? failure.kind : "succeeded",
    evidence: failure?.evidence || `Antigravity status ${turn.status}`,
    guidance: failure?.guidance || null,
    familySwitch: Boolean(options.familySwitch),
    conversationId: turn.conversationId || job.conversationId || null,
  };
  await appendNdjson(paths.attempts, attempt);
  job = await updateJob(file, value => ({
    ...value,
    conversationId: turn.conversationId || value.conversationId,
    model: turn.model || value.model,
    agyStatus: turn.status,
    latestProgress: [...(turn.events || [])].reverse().find(event => event.kind === "progress") || value.latestProgress,
  }));
  return { job, turn, failure, attempt };
}

function failedFamily(attempt, failure) {
  if (attempt.family !== "unknown") return attempt.family;
  const text = failure.evidence.toLowerCase();
  if (/gemini/.test(text)) return "gemini";
  if (/claude|gpt|third.?party/.test(text)) return "third-party";
  return "unknown";
}

export async function runJob(jobId, options = {}) {
  let job = typeof jobId === "object" ? jobId : await getJob(jobId, options);
  if (TERMINAL_JOB_STATES.has(job.state)) return job;
  const file = path.join(job.jobDir, JOB_FILES.job);
  job = await updateJob(file, value => ({ ...value, state: "starting" }));
  const policy = mergeRetryPolicy(options.retryPolicy);
  const sleep = options.sleep || sleepDefault;
  const attempts = [];
  let model = options.model !== undefined ? options.model : job.model;
  if (!model && job.route && job.route !== "auto") {
    let availableModels = options.availableModels;
    if (!availableModels) availableModels = await (options.discoverModels || discoverModels)({ agyPath: options.agyPath || job.agyPath, agyPrefixArgs: options.agyPrefixArgs || job.agyPrefixArgs, cwd: job.workspace, env: options.env });
    model = rankModels(availableModels, job.route)[0]?.slug || rankModels(availableModels, job.route)[0];
    if (!model) throw new Error(`No available model for route ${job.route}`);
  }
  let familySwitch = false;
  let transportRetries = 0;
  let lastTurn = null;

  while (attempts.length < policy.maxAttempts) {
    const outcome = await runAttempt(job, { ...options, model, familySwitch, conversationId: job.conversationId });
    job = outcome.job;
    lastTurn = outcome.turn;
    attempts.push(outcome.attempt);
    if (!outcome.failure) {
      const endedAt = new Date().toISOString();
      job = await updateJob(file, value => ({ ...value, state: normalizedStateForResult(outcome.turn, null), guidance: null, endedAt }));
      await writeJsonAtomic(path.join(job.jobDir, JOB_FILES.result), serializeResult(job, outcome.turn, attempts));
      return job;
    }

    let next = null;
    if (outcome.failure.kind === "transport" && transportRetries < policy.transportRetries) {
      const delay = policy.backoffMs[Math.min(transportRetries, policy.backoffMs.length - 1)] || 0;
      transportRetries += 1;
      next = { model, familySwitch: false };
      if (delay) await sleep(delay);
    } else if (outcome.failure.switchFamily) {
      let availableModels = options.availableModels;
      if (!availableModels) {
        const discovered = await (options.discoverModels || discoverModels)({ agyPath: options.agyPath || job.agyPath, agyPrefixArgs: options.agyPrefixArgs || job.agyPrefixArgs, cwd: job.workspace, env: options.env });
        availableModels = rankModels(discovered, job.route || "auto");
      }
      next = chooseFallback({
        failedModel: model, failedFamily: failedFamily(outcome.attempt, outcome.failure),
        conversationId: job.conversationId, availableModels, attempts,
        familySwitches: policy.familySwitches,
      });
    }

    if (!next || attempts.length >= policy.maxAttempts) {
      const state = normalizedStateForResult(outcome.turn, outcome.failure);
      const errorEntry = { at: new Date().toISOString(), kind: outcome.failure.kind, evidence: outcome.failure.evidence, guidance: outcome.failure.guidance || null };
      job = await updateJob(file, value => ({ ...value, state, guidance: outcome.failure.guidance || null, endedAt: new Date().toISOString(), errors: [...(value.errors || []), errorEntry] }));
      await writeJsonAtomic(path.join(job.jobDir, JOB_FILES.result), serializeResult(job, outcome.turn, attempts));
      return job;
    }
    model = next.model;
    familySwitch = Boolean(next.familySwitch);
    job = await updateJob(file, value => ({
      ...value, state: "retrying", model,
      errors: [...(value.errors || []), { at: new Date().toISOString(), kind: outcome.failure.kind, evidence: outcome.failure.evidence, guidance: outcome.failure.guidance || null, retryWith: next.model || null }],
    }));
  }

  job = await updateJob(file, value => ({ ...value, state: "failed", endedAt: new Date().toISOString() }));
  await writeJsonAtomic(path.join(job.jobDir, JOB_FILES.result), serializeResult(job, lastTurn, attempts));
  return job;
}

export async function resumeJob(jobId, message, options = {}) {
  const source = await getJob(jobId, options);
  if (!source.conversationId) throw new Error(`Job ${source.id} has no conversation ID to resume`);
  const resumed = await createJob({
    ...options,
    cwd: source.workspace,
    prompt: message || "Continue the previous task from its preserved context.",
    conversationId: source.conversationId,
    accessProfile: source.accessProfile,
    route: source.route,
    model: options.model || source.model,
    agent: options.agent || source.agent,
    effort: options.effort || source.effort,
    parentJobId: source.id,
  });
  resumed.parentJobId = source.id;
  await writeJsonAtomic(path.join(resumed.jobDir, JOB_FILES.job), resumed);
  if (options.run === false) return resumed;
  return runJob(resumed.id, options);
}

export async function reconcileJob(job, options = {}) {
  if (TERMINAL_JOB_STATES.has(job.state)) return { job, action: "none", reason: "terminal" };
  let heartbeat = null;
  try { heartbeat = JSON.parse(await readFile(path.join(job.jobDir, JOB_FILES.heartbeat), "utf8")); } catch { /* absent */ }
  return { job, heartbeat, action: "inspect-control" };
}

export async function readJobResult(job) {
  try { return JSON.parse(await readFile(path.join(job.jobDir, JOB_FILES.result), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function readJobLogs(job) {
  const paths = jobPaths(job.jobDir);
  let stderr = "";
  try { stderr = await readFile(paths.stderr, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  return { events: await readNdjson(paths.events), attempts: await readNdjson(paths.attempts), messages: await readNdjson(paths.messages), stderr };
}

export async function pendingMessages(job) {
  const values = await readNdjson(path.join(job.jobDir, JOB_FILES.messages));
  const acknowledged = new Set(values.filter(value => value.type === "ack").map(value => value.messageId));
  return values.filter(value => value.type === "message" && !acknowledged.has(value.id));
}

export async function queueMessage(jobId, message, options = {}) {
  if (!message || !String(message).trim()) throw new Error("Message is required");
  const job = typeof jobId === "object" ? jobId : await getJob(jobId, options);
  const record = { type: "message", id: options.messageId || randomUUID(), action: options.action || "send", message: String(message), createdAt: new Date().toISOString() };
  await appendNdjson(path.join(job.jobDir, JOB_FILES.messages), record);
  if (options.deliver === false) return record;
  try {
    const { sendControl } = await import("./control.mjs");
    const response = await sendControl(job, record.action, record, options);
    return { ...record, delivered: true, control: response };
  } catch (error) {
    return { ...record, delivered: false, deliveryError: error.message };
  }
}

export async function ackMessage(jobId, messageId, options = {}) {
  const job = typeof jobId === "object" ? jobId : await getJob(jobId, options);
  const record = { type: "ack", messageId, acknowledgedAt: new Date().toISOString() };
  await appendNdjson(path.join(job.jobDir, JOB_FILES.messages), record);
  return record;
}

export async function steerJob(jobId, message, options = {}) {
  return queueMessage(jobId, message, { ...options, action: "steer" });
}

export async function cancelJob(jobId, options = {}) {
  let job = typeof jobId === "object" ? jobId : await getJob(jobId, options);
  if (job.state === "canceled") return { ...job, requested: false };
  const reachable = options.reachable || (async value => (await import("./control.mjs")).isWorkerReachable(value));
  if (await reachable(job)) {
    const { sendControl } = await import("./control.mjs");
    await appendNdjson(path.join(job.jobDir, JOB_FILES.messages), { type: "cancel", requestedAt: new Date().toISOString() });
    await sendControl(job, "cancel", {}, options);
    return { ...job, requested: true };
  }
  await appendNdjson(path.join(job.jobDir, JOB_FILES.messages), { type: "cancel", requestedAt: new Date().toISOString(), endpoint: "unreachable" });
  let heartbeat = null;
  try { heartbeat = JSON.parse(await readFile(path.join(job.jobDir, JOB_FILES.heartbeat), "utf8")); } catch { /* absent or corrupt */ }
  const activityAt = heartbeat?.lastActivityAt || job.worker?.startedAt || job.createdAt;
  const stale = !activityAt || Date.now() - Date.parse(activityAt) > (options.heartbeatStaleMs || HEARTBEAT_STALE_MS);
  if (stale && !TERMINAL_JOB_STATES.has(job.state)) {
    job = await updateJob(path.join(job.jobDir, JOB_FILES.job), value => ({ ...value, state: "canceled", endedAt: new Date().toISOString() }));
  }
  return { ...job, requested: true, pending: !stale };
}

export async function recoverJob(jobId, options = {}) {
  let job = typeof jobId === "object" ? jobId : await getJob(jobId, options);
  if (job.state === "canceled") return { job, action: "none", reason: "canceled" };
  const reachable = options.reachable || (async value => (await import("./control.mjs")).isWorkerReachable(value));
  const endpointReachable = await reachable(job);
  const durableControl = await readNdjson(path.join(job.jobDir, JOB_FILES.messages));
  if (durableControl.some(event => event.type === "cancel")) {
    if (endpointReachable) {
      const { sendControl } = await import("./control.mjs");
      await sendControl(job, "cancel", {}, options);
      return { job, action: "cancel-requested", reason: "cancellation-requested" };
    }
    return { job, action: "none", reason: "cancellation-requested" };
  }
  if (endpointReachable) return { job, action: "already-running" };
  if (job.state === "succeeded" || job.state === "failed") return { job, action: "none", reason: "terminal" };
  let heartbeat = null;
  try { heartbeat = JSON.parse(await readFile(path.join(job.jobDir, JOB_FILES.heartbeat), "utf8")); } catch { /* absent or corrupt */ }
  const heartbeatAt = heartbeat?.lastActivityAt || job.worker?.startedAt;
  if (heartbeatAt && Date.now() - Date.parse(heartbeatAt) <= (options.heartbeatStaleMs || HEARTBEAT_STALE_MS)) {
    return { job, action: "waiting", reason: "fresh-heartbeat", heartbeat };
  }
  const claimFile = path.join(job.jobDir, JOB_FILES.claim);
  const claim = { jobId: job.id, claimant: randomUUID(), timestamp: new Date().toISOString() };
  try { await tryCreateExclusiveJson(claimFile, claim); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    let existing;
    try { existing = JSON.parse(await readFile(claimFile, "utf8")); } catch { existing = null; }
    const age = existing ? Date.now() - Date.parse(existing.timestamp) : Infinity;
    if (age <= (options.claimTtlMs || RECOVERY_CLAIM_TTL_MS)) return { job, action: "claimed", claim: existing };
    await unlink(claimFile).catch(() => {});
    try { await tryCreateExclusiveJson(claimFile, claim); }
    catch (second) { if (second.code === "EEXIST") return { job, action: "claimed" }; throw second; }
  }
  job = await updateJob(path.join(job.jobDir, JOB_FILES.job), value => ({ ...value, state: "orphaned" }));
  const startWorker = options.startWorker || (async (id, value) => (await import("./worker.mjs")).startDetachedWorker(id, value));
  await startWorker(job.id, options);
  return { job, action: "restarted", continuityPreserved: Boolean(job.conversationId), claim };
}

export async function recoverWorkspace(options = {}) {
  const jobs = await listJobs(options);
  const results = [];
  for (const job of jobs) results.push(await recoverJob(job, options));
  return results;
}
