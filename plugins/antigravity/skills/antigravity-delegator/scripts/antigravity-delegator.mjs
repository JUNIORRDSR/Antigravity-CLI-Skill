#!/usr/bin/env node
import { parseCli } from "./lib/args.mjs";
import { discoverModels } from "./lib/agy.mjs";
import { runDoctor } from "./lib/doctor.mjs";
import { cancelJob, createJob, getJob, listJobs, queueMessage, readJobLogs, recoverJob, recoverWorkspace, resumeJob, runJob, steerJob } from "./lib/jobs.mjs";
import { jobView, renderHuman, resultView } from "./lib/render.mjs";
import { startDetachedWorker, runWorker } from "./lib/worker.mjs";
import { TERMINAL_JOB_STATES } from "./lib/constants.mjs";

const HELP = `antigravity-delegator <command> [options]

Commands:
  doctor, models, delegate, list, status, wait, logs
  send, steer, result, resume, recover, cancel

Delegate options:
  --model <slug>        Pin one model. Cannot be combined with --effort.
  --route <name>        auto | quality | balanced | fast | gemini-first | third-party-first
                        Use quality for audits and reviews.
  --add-dir <path>      Extra readable directory (repeatable). The workspace is always added.
  --json-schema <path>  Force the final result to a JSON schema.
  --read-only (default) | --write | --sandbox

Use --json for machine-readable output. Delegation never bypasses Antigravity permissions.`;

function runtimeOptions(options) {
  let agyPrefixArgs = [];
  if (process.env.ANTIGRAVITY_AGY_PREFIX_JSON) {
    try { agyPrefixArgs = JSON.parse(process.env.ANTIGRAVITY_AGY_PREFIX_JSON); }
    catch { throw new Error("ANTIGRAVITY_AGY_PREFIX_JSON must be a JSON array"); }
  }
  if (!Array.isArray(agyPrefixArgs)) throw new Error("ANTIGRAVITY_AGY_PREFIX_JSON must be a JSON array");
  return { ...options, agyPath: options.agyPath || process.env.ANTIGRAVITY_AGY_PATH || "agy", agyPrefixArgs };
}

async function waitForJob(reference, options) {
  const first = await getJob(reference, options);
  if (TERMINAL_JOB_STATES.has(first.state)) return first;
  const timeoutMs = options.timeoutMs ?? 30000;
  const end = Date.now() + timeoutMs;
  let current = first;
  while (Date.now() < end) {
    await new Promise(resolve => setTimeout(resolve, Math.min(200, Math.max(10, end - Date.now()))));
    current = await getJob(first.id, options);
    if (TERMINAL_JOB_STATES.has(current.state) || current.updatedAt !== first.updatedAt) break;
  }
  return current;
}

async function dispatch(parsed) {
  const { command, positionals } = parsed;
  const options = runtimeOptions(parsed.options);
  if (command === "help" || options.help) return { command: "help", value: HELP, raw: true };
  if (command === "doctor") return { command, value: await runDoctor(options) };
  if (command === "models") return { command, value: await discoverModels(options) };
  if (command === "delegate") {
    const prompt = positionals[0];
    if (!prompt) throw new Error("delegate requires one prompt argument");
    let job = await createJob({ ...options, prompt });
    if (options.background) job = await startDetachedWorker(job.id, options);
    else job = await runJob(job.id, options);
    if (options.wait && options.background) job = await waitForJob(job.id, options);
    return { command, value: await jobView(job) };
  }
  if (command === "list") return { command, value: await Promise.all((await listJobs(options)).map(jobView)) };
  if (command === "status") return { command, value: await jobView(await getJob(positionals[0], options)) };
  if (command === "wait") return { command, value: await jobView(await waitForJob(positionals[0], options)) };
  if (command === "logs") return { command, value: await readJobLogs(await getJob(positionals[0], options)) };
  if (command === "send") {
    if (!positionals[0] || !positionals[1]) throw new Error("send requires a job ID and message");
    return { command, value: await queueMessage(positionals[0], positionals[1], options) };
  }
  if (command === "steer") {
    if (!positionals[0] || !positionals[1]) throw new Error("steer requires a job ID and message");
    return { command, value: await steerJob(positionals[0], positionals[1], options) };
  }
  if (command === "result") return { command, value: await resultView(await getJob(positionals[0], options)) };
  if (command === "resume") {
    if (!positionals[0]) throw new Error("resume requires a job ID");
    let job = await resumeJob(positionals[0], positionals[1], { ...options, run: !options.background });
    if (options.background) job = await startDetachedWorker(job.id, options);
    return { command, value: await jobView(job) };
  }
  if (command === "recover") {
    const value = positionals[0] ? await recoverJob(positionals[0], options) : await recoverWorkspace(options);
    return { command, value };
  }
  if (command === "cancel") return { command, value: await cancelJob(positionals[0], options) };
  if (command === "worker") {
    if (!positionals[0]) throw new Error("worker requires a job ID");
    return { command, value: await runWorker(positionals[0], options), internal: true };
  }
  throw new Error(`Unknown command: ${command}`);
}

try {
  const parsed = parseCli(process.argv.slice(2));
  const output = await dispatch(parsed);
  if (!output.internal) {
    if (parsed.options.json && !output.raw) process.stdout.write(`${JSON.stringify(output.value)}\n`);
    else process.stdout.write(`${output.raw ? output.value : renderHuman(output.command, output.value)}\n`);
  }
} catch (error) {
  process.stderr.write(`antigravity-delegator: ${error.message}\n`);
  process.exitCode = 1;
}
