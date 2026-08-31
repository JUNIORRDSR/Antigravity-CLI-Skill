import { readJobLogs, readJobResult } from "./jobs.mjs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { JOB_FILES } from "./constants.mjs";

/** Model fallbacks must never be silent: every switched attempt is printed. */
export function retryLines(view) {
  return (view?.attempts || [])
    .filter(attempt => attempt.familySwitch || attempt.outcome === "quota")
    .map(attempt => `Retry: attempt ${attempt.number} ran on ${attempt.model || "default"} (${attempt.family}) after ${attempt.outcome} — ${attempt.evidence}`);
}

export function nextCommands(job) {
  const base = `--cwd "${job.workspace}" --state-dir "${job.stateRoot}"`;
  return {
    status: `status ${job.id} ${base}`,
    wait: `wait ${job.id} ${base}`,
    logs: `logs ${job.id} ${base}`,
    result: `result ${job.id} ${base}`,
    send: `send ${job.id} "<message>" ${base}`,
    recover: `recover ${job.id} ${base}`,
    cancel: `cancel ${job.id} ${base}`,
  };
}

export async function jobView(job) {
  const logs = await readJobLogs(job);
  let storedHeartbeat = null;
  try { storedHeartbeat = JSON.parse(await readFile(path.join(job.jobDir, JOB_FILES.heartbeat), "utf8")); } catch { /* absent or corrupt */ }
  return {
    id: job.id, state: job.state, agyStatus: job.agyStatus || null, guidance: job.guidance || null,
    workspace: job.workspace, conversationId: job.conversationId || null,
    model: job.model || null, agent: job.agent || null, attempt: job.attempt || 0,
    attempts: logs.attempts, latestProgress: job.latestProgress || null,
    heartbeat: job.worker ? { pid: job.worker.pid, port: job.worker.port, workerId: job.worker.workerId, startedAt: job.worker.startedAt, lastActivityAt: storedHeartbeat?.lastActivityAt || null } : null,
    createdAt: job.createdAt, updatedAt: job.updatedAt, endedAt: job.endedAt || null,
    errors: job.errors || [], nextCommands: nextCommands(job),
  };
}

export async function resultView(job) {
  const result = await readJobResult(job);
  if (!result) throw new Error(`Job ${job.id} has no stored result yet`);
  return { ...result, id: job.id, nextCommands: nextCommands(job) };
}

export function renderHuman(command, value) {
  if (command === "status" || command === "delegate" || command === "wait") {
    const rows = Array.isArray(value) ? value : [value];
    return [
      "JOB\tSTATE\tMODEL\tUPDATED",
      ...rows.map(row => `${row.id}\t${row.state}\t${row.model || "default"}\t${row.updatedAt || "-"}`),
      ...rows.flatMap(retryLines),
      rows[0]?.guidance ? `Guidance: ${rows[0].guidance}` : "",
      rows[0]?.nextCommands?.status ? `Next: ${rows[0].nextCommands.status}` : "",
    ].filter(Boolean).join("\n");
  }
  if (command === "list") return ["JOB\tSTATE\tMODEL\tUPDATED", ...value.map(row => `${row.id}\t${row.state}\t${row.model || "default"}\t${row.updatedAt || "-"}`)].join("\n");
  if (command === "result") {
    return [
      value.response || value.errors?.map(error => error.evidence).join("\n") || "No response",
      ...retryLines(value),
      value.guidance ? `Guidance: ${value.guidance}` : "",
      `Next: ${value.nextCommands.status}`,
    ].filter(Boolean).join("\n");
  }
  if (command === "doctor") return value.checks.map(check => `${check.ok ? "OK" : "FAIL"}\t${check.name}\t${check.value || check.error || ""}${check.guidance ? `\n  ${check.guidance}` : ""}`).join("\n");
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
