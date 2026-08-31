// Antigravity CLI 1.1.22 reports several no-work outcomes with exit 0 and, in two
// cases, status SUCCESS. Everything below is derived from observed `agy` output.

// `jetski: no output produced — a tool required the "command" permission that headless
// mode cannot prompt for, so it was auto-denied. ...` (stderr, exit 0, status SUCCESS)
export const PERMISSION_DENIAL_RE = /permission denied|not approved|approval required|soft.?deny|auto-denied|headless mode cannot prompt/i;
const DENIED_PERMISSION_RE = /(?:required|require) the "([^"]+)" permission/i;
const SKIP_PERMISSIONS_SUGGESTION_RE = /\s*(?:Alternatively,\s*)?(?:re-run|rerun) with --dangerously-skip-permissions[^.]*\.\s*/gi;

// `--mode plan` writes an implementation plan under the CLI brain directory and asks for
// approval that headless mode can never deliver. Reported by agy as status SUCCESS.
const PLAN_ARTIFACT_RE = /[\\/]brain[\\/][^\\/]+[\\/][^\\/]+\.md$/i;
const APPROVAL_REQUEST_RE = /review and approve|approve the plan|please review the plan|awaiting (?:your )?approval|would like me to proceed|proceed with (?:the )?execution|let me know if you want me to proceed/i;

const QUOTA_RE = /quota|resource[_ -]?exhausted|credit.+exhausted/i;
const QUOTA_RESET_RE = /resets? in ((?:\d+[hms])+|\d{1,2}:\d{2}(?::\d{2})?)/i;

function evidence(input) {
  return [input.error, input.stderr, input.response, input.status, input.exitCode === null ? "process did not exit" : ""].filter(Boolean).join(" | ");
}

/** Strips agy's own `--dangerously-skip-permissions` advice; this package never suggests it. */
export function withoutBypassSuggestion(text) {
  return String(text || "").replace(SKIP_PERMISSIONS_SUGGESTION_RE, " ").replace(/\s+/g, " ").trim();
}

export function parsePermissionDenial(text) {
  const line = String(text || "").split(/\r?\n/).find(value => PERMISSION_DENIAL_RE.test(value));
  if (!line) return null;
  return { permission: line.match(DENIED_PERMISSION_RE)?.[1] || null, message: withoutBypassSuggestion(line) };
}

export function parseQuotaLimit(text) {
  const value = String(text || "");
  if (!QUOTA_RE.test(value)) return null;
  const line = value.split(/\r?\n/).find(entry => QUOTA_RE.test(entry)) || value;
  return { resetsIn: value.match(QUOTA_RESET_RE)?.[1] || null, message: line.trim() };
}

function planArtifacts(turn) {
  return (turn.events || [])
    .filter(event => event.kind === "progress" && /write/i.test(event.tool || ""))
    .map(event => event.toolInfo?.parameters?.TargetFile || event.toolInfo?.parameters?.target_file || "")
    .filter(file => PLAN_ARTIFACT_RE.test(file));
}

/**
 * True when a plan-mode turn stopped to request an approval headless mode cannot give.
 * Only meaningful for read-only profiles, which map to `--mode plan`.
 */
export function detectPlanApproval(turn, accessProfile = "read-only") {
  if (String(accessProfile).startsWith("write")) return null;
  const response = String(turn.response ?? "");
  const artifacts = planArtifacts(turn);
  if (artifacts.length) return { planArtifact: artifacts[0], evidence: `Antigravity wrote a plan to ${artifacts[0]} and stopped for approval` };
  if (APPROVAL_REQUEST_RE.test(response) && /\bplan\b/i.test(response)) {
    return { planArtifact: null, evidence: "Antigravity returned a plan and asked for approval that headless mode cannot deliver" };
  }
  return null;
}

export function isBlankResponse(turn) {
  return turn.response === null || turn.response === undefined || !String(turn.response).trim();
}

/**
 * Single decision point for "did this turn do the work?".
 * Returns null only for a turn that finished with real output; otherwise a failure record.
 */
export function inspectTurn(turn = {}, options = {}) {
  const accessProfile = options.accessProfile || "read-only";
  const streams = [turn.error, turn.stderr, turn.response].filter(Boolean).join("\n");

  const denial = parsePermissionDenial(streams);
  if (denial) {
    const target = denial.permission ? `${denial.permission}(<target>)` : "<tool>(<target>)";
    return {
      kind: "permission", retryable: false, switchFamily: false,
      deniedPermission: denial.permission,
      evidence: denial.message,
      guidance: `Antigravity auto-denied the "${denial.permission || "required"}" permission because headless mode cannot prompt. Add an allow-rule under permissions.allow in settings.json (e.g. ${target}), or narrow the task so it does not need that tool.`,
    };
  }

  const quota = parseQuotaLimit(streams);
  if (quota) {
    return {
      kind: "quota", retryable: true, switchFamily: true,
      resetsIn: quota.resetsIn, evidence: quota.message,
      guidance: `Model quota is exhausted${quota.resetsIn ? ` and resets in ${quota.resetsIn}` : ""}. Antigravity quota is per model, so another model may still have capacity.`,
    };
  }

  const plan = detectPlanApproval(turn, accessProfile);
  if (plan) {
    return {
      kind: "awaiting-approval", retryable: false, switchFamily: false,
      planArtifact: plan.planArtifact, evidence: plan.evidence,
      guidance: "The read-only profile runs `agy --mode plan`, which plans and waits for an approval headless mode never delivers. Split the task into single-target jobs, or re-delegate with --write when the task must act.",
    };
  }

  if (turn.status === "SUCCESS" && isBlankResponse(turn)) {
    return {
      kind: "empty-output", retryable: false, switchFamily: false,
      evidence: `Antigravity reported ${turn.status} with an empty response${turn.stderr?.trim() ? ` | ${turn.stderr.trim().split(/\r?\n/).slice(-1)[0]}` : ""}`,
      guidance: "Antigravity exited successfully without producing any answer. Inspect `logs` for the denied or failed tool call before re-running.",
    };
  }

  if (turn.status === "SUCCESS") return null;
  return classifyFailure(turn);
}

export function classifyFailure(input = {}) {
  const text = evidence(input);
  const lower = text.toLowerCase();
  let kind = "unknown";
  let retryable = false;
  let switchFamily = false;
  if (input.status === "INTERRUPTED" || /\binterrupt(?:ed)?\b/.test(lower)) kind = "interrupted";
  else if (/auth(?:entication|orization)?|unauthenticated|log ?in|credential|token expired/.test(lower)) kind = "authentication";
  else if (/permission|not approved|access denied|soft.?deny|read.?only/.test(lower)) kind = "permission";
  else if (/unknown model|invalid model|model.+(?:not found|unavailable)/.test(lower)) kind = "invalid-model";
  else if (QUOTA_RE.test(lower)) { kind = "quota"; retryable = true; switchFamily = true; }
  else if (/rate.?limit|\b429\b|too many requests/.test(lower)) { kind = "rate-limit"; retryable = true; switchFamily = true; }
  else if (/econn|enotfound|socket|network|transport|timed? ?out|timeout|connection reset|broken pipe/.test(lower) || input.timedOut) { kind = "transport"; retryable = true; }
  else if (/malformed|protocol|missing terminal|invalid ndjson/.test(lower)) kind = "protocol";
  else if (input.status === "ERROR" || /test(?:s)? failed|deterministic|task failed/.test(lower)) kind = "task";
  return { kind, retryable, switchFamily, evidence: text || "No diagnostic evidence" };
}

export function normalizedStateForResult(result, failure = null) {
  if (failure?.kind === "awaiting-approval") return "awaiting-approval";
  if (result.permissionNotices?.length) return "failed";
  switch (result.status) {
    // A SUCCESS that produced no work (empty output, auto-denied tool) is never `succeeded`.
    case "SUCCESS": return failure ? "failed" : "succeeded";
    case "WAITING": return "waiting";
    case "CANCELED": return "canceled";
    case "INTERRUPTED": return "interrupted";
    default: return "failed";
  }
}
