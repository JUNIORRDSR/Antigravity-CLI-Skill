export const JOB_STATES = Object.freeze([
  "queued", "starting", "running", "waiting", "retrying", "succeeded",
  "awaiting-approval", "failed", "canceled", "interrupted", "orphaned",
]);

export const TERMINAL_JOB_STATES = new Set(["succeeded", "awaiting-approval", "failed", "canceled", "interrupted"]);

export const AGY_TERMINAL_STATUSES = new Set(["SUCCESS", "ERROR", "CANCELED", "INTERRUPTED", "INVALID", "WAITING"]);

export const DEFAULT_RETRY_POLICY = Object.freeze({
  transportRetries: 2,
  familySwitches: 1,
  maxAttempts: 4,
  backoffMs: [1000, 3000],
});

export const HEARTBEAT_INTERVAL_MS = 2000;
export const HEARTBEAT_STALE_MS = 15000;
export const RECOVERY_CLAIM_TTL_MS = 30000;
export const CONTROL_BODY_LIMIT = 64 * 1024;

export const JOB_FILES = Object.freeze({
  job: "job.json",
  events: "events.ndjson",
  stderr: "stderr.log",
  messages: "messages.ndjson",
  attempts: "attempts.ndjson",
  result: "result.json",
  heartbeat: "heartbeat.json",
  claim: "recovery-claim.json",
  workerStdout: "worker.stdout.log",
  workerStderr: "worker.stderr.log",
});

/** Antigravity CLI settings file, relative to the user's home directory. */
export const AGY_SETTINGS_RELATIVE_PATH = [".gemini", "antigravity-cli", "settings.json"];

/**
 * Permission-rule vocabulary agy 1.1.22 recognises under `permissions.allow`.
 * `*` is the documented wildcard target; agy prints `<kind>(<target>)` when it auto-denies.
 * Headless runs cannot be prompted, so a denied tool needs a rule here or a narrower task.
 * This package never writes these rules and never offers --dangerously-skip-permissions.
 */
export const AGY_PERMISSION_KINDS = Object.freeze([
  "command", "read_file", "write_file", "read_url", "execute_url", "mcp", "unsandboxed",
]);

/** Rules a read-only audit typically needs; `command` covers git/rg/ls style inspection. */
export const READ_ONLY_ALLOW_RULES = Object.freeze(["read_file(*)", "command(*)"]);
