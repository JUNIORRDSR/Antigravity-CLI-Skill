import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { HEARTBEAT_INTERVAL_MS, JOB_FILES } from "./constants.mjs";
import { startControlServer } from "./control.mjs";
import { ackMessage, getJob, pendingMessages, resumeJob, runJob } from "./jobs.mjs";
import { readNdjson, updateJob, writeJsonAtomic } from "./state.mjs";

const THIS_FILE = fileURLToPath(import.meta.url);
const DEFAULT_ENTRY = path.resolve(path.dirname(THIS_FILE), "..", "antigravity-delegator.mjs");

export async function writeHeartbeat(job, worker) {
  const value = { jobId: job.id, workerId: worker.workerId, pid: process.pid, port: worker.port, lastActivityAt: new Date().toISOString() };
  await writeJsonAtomic(path.join(job.jobDir, JOB_FILES.heartbeat), value);
  return value;
}

export async function startDetachedWorker(jobId, options = {}) {
  let job = await getJob(jobId, options);
  const identity = { workerId: randomUUID(), token: randomUUID(), pid: null, port: null, startedAt: new Date().toISOString() };
  const jobFile = path.join(job.jobDir, JOB_FILES.job);
  job = await updateJob(jobFile, value => ({ ...value, worker: identity }));
  const entryPath = options.entryPath || DEFAULT_ENTRY;
  const args = options.directModule
    ? [entryPath, "--internal-worker", job.id, job.workspace, job.stateRoot]
    : [entryPath, "worker", job.id, "--cwd", job.workspace, "--state-dir", job.stateRoot];
  const stdoutFd = openSync(path.join(job.jobDir, JOB_FILES.workerStdout), "a");
  const stderrFd = openSync(path.join(job.jobDir, JOB_FILES.workerStderr), "a");
  let child;
  try {
    child = spawn(process.execPath, args, {
      cwd: job.workspace,
      env: { ...process.env, ...options.env },
      detached: true, windowsHide: true, shell: false,
      stdio: ["ignore", stdoutFd, stderrFd],
    });
  } finally {
    closeSync(stdoutFd); closeSync(stderrFd);
  }
  job = await updateJob(jobFile, value => ({ ...value, worker: { ...value.worker, pid: child.pid } }));
  child.unref();
  return job;
}

export async function runWorker(jobId, options = {}) {
  let job = await getJob(jobId, options);
  // Do not hold the delegated workspace as this worker's process cwd on Windows.
  // Antigravity itself still receives the exact workspace via spawn({ cwd }).
  process.chdir(os.tmpdir());
  const durableControl = await readNdjson(path.join(job.jobDir, JOB_FILES.messages));
  if (durableControl.some(event => event.type === "cancel")) {
    if (!["succeeded", "failed", "canceled", "interrupted"].includes(job.state)) {
      job = await updateJob(path.join(job.jobDir, JOB_FILES.job), value => ({ ...value, state: "canceled", endedAt: new Date().toISOString() }));
    }
    return job;
  }
  const controller = new AbortController();
  const queued = [];
  let cancelRequested = false;
  const control = await startControlServer({
    token: job.worker.token,
    handlers: {
      ping: async () => ({ workerId: job.worker.workerId }),
      send: async payload => { queued.push({ ...payload, action: "send" }); return { accepted: true }; },
      steer: async payload => { queued.push({ ...payload, action: "steer" }); controller.abort(); return { accepted: true }; },
      cancel: async () => { cancelRequested = true; controller.abort(); return { requested: true }; },
    },
  });
  const jobFile = path.join(job.jobDir, JOB_FILES.job);
  job = await updateJob(jobFile, value => ({ ...value, worker: { ...value.worker, pid: process.pid, port: control.port } }));
  await writeHeartbeat(job, job.worker);
  const heartbeat = setInterval(() => { writeHeartbeat(job, job.worker).catch(() => {}); }, options.heartbeatIntervalMs || HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();
  try {
    let finished = await runJob(job.id, { ...options, cwd: job.workspace, stateDir: job.stateRoot, signal: controller.signal });
    if (cancelRequested && finished.state !== "canceled") {
      finished = { ...finished, state: "canceled", endedAt: new Date().toISOString() };
      await writeJsonAtomic(jobFile, finished);
    } else if (!cancelRequested) {
      await new Promise(resolve => setTimeout(resolve, options.controlDrainMs ?? 100));
      const stored = await pendingMessages(finished);
      const byId = new Map([...stored, ...queued].map(message => [message.id, message]));
      for (const message of byId.values()) {
        if (!finished.conversationId) break;
        await resumeJob(finished.id, message.message, { ...options, cwd: finished.workspace, stateDir: finished.stateRoot });
        await ackMessage(finished.id, message.id, { cwd: finished.workspace, stateDir: finished.stateRoot });
      }
    }
    return finished;
  } finally {
    clearInterval(heartbeat);
    await control.close();
  }
}

if (process.argv[2] === "--internal-worker") {
  const [, , , jobId, cwd, stateDir] = process.argv;
  runWorker(jobId, { cwd, stateDir }).catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
}
