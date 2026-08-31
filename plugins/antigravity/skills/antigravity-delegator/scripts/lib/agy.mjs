import { spawn } from "node:child_process";
import { NdjsonDecoder, normalizeAgyEvent } from "./ndjson.mjs";
import { parseModelList } from "./model-routing.mjs";
import { PERMISSION_DENIAL_RE } from "./errors.mjs";

/**
 * agy 1.1.22 rejects --effort whenever --model is set, because every published slug
 * already encodes its reasoning effort:
 *   invalid model selection (--model "claude-opus-4-6-thinking" --effort "high")
 *   invalid model selection (--model "gemini-3.5-flash-medium" --effort "high")
 */
export function effortIsCompatible(model) {
  return !model;
}

/** Directories agy must be able to read; without --add-dir it searches $HOME, not the cwd. */
export function workspaceDirs(run) {
  const seen = new Map();
  for (const dir of [...(run.addDirs || []), run.workspace, run.cwd]) {
    if (!dir) continue;
    const key = process.platform === "win32" ? String(dir).toLowerCase() : String(dir);
    if (!seen.has(key)) seen.set(key, String(dir));
  }
  return [...seen.values()];
}

export function buildAgyArgs(run) {
  if (!run?.prompt) throw new Error("Antigravity prompt is required");
  // --print must be immediately followed by the prompt; every later flag is its own argv entry.
  const args = ["--print", run.prompt, "--output-format", "stream-json"];
  if (run.model) args.push("--model", run.model);
  if (run.agent) args.push("--agent", run.agent);
  if (run.effort && effortIsCompatible(run.model)) args.push("--effort", run.effort);
  if (run.conversationId) args.push("--conversation", run.conversationId);
  if (run.jsonSchema) args.push("--json-schema", run.jsonSchema);
  const profile = run.accessProfile || "read-only";
  args.push("--mode", profile.startsWith("write") ? "accept-edits" : "plan");
  if (profile.endsWith("sandbox") || run.sandbox) args.push("--sandbox");
  for (const dir of workspaceDirs(run)) args.push("--add-dir", dir);
  return args;
}

function commandFor(options, args) {
  return {
    file: options.agyPath || process.env.ANTIGRAVITY_AGY_PATH || "agy",
    args: [...(options.agyPrefixArgs || []), ...args],
  };
}

function collectProcess(options, args) {
  return new Promise((resolve, reject) => {
    const command = commandFor(options, args);
    const child = spawn(command.file, command.args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

export async function discoverModels(options = {}) {
  const result = await collectProcess(options, ["models"]);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `agy models exited ${result.code}`);
  return parseModelList(result.stdout);
}

export async function discoverAgents(options = {}) {
  const result = await collectProcess(options, ["agents"]);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `agy agents exited ${result.code}`);
  const text = result.stdout.trim();
  try {
    const parsed = JSON.parse(text);
    const values = Array.isArray(parsed) ? parsed : parsed.agents;
    if (Array.isArray(values)) return values.map(value => typeof value === "string" ? value : value.slug || value.name);
  } catch { /* line output */ }
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

export function runAgyTurn(options) {
  return new Promise(resolve => {
    const decoder = new NdjsonDecoder();
    const events = [];
    const callbackWork = [];
    const command = commandFor(options, buildAgyArgs(options));
    let conversationId = options.conversationId || null;
    let selectedModel = options.model || null;
    let terminal = null;
    let stderr = "";
    let timedOut = false;
    let spawnError = null;
    let closed = false;

    const child = spawn(command.file, command.args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    options.onChild?.(child);

    const emit = item => {
      let normalized;
      if (item.value) normalized = normalizeAgyEvent(item.value);
      else normalized = { kind: "malformed", raw: item.raw, error: item.error?.message, truncated: Boolean(item.truncated) };
      events.push(normalized);
      // Real agy streams carry conversation_id on step_update/result, never on an init event.
      if (normalized.conversationId) conversationId = normalized.conversationId;
      if (normalized.kind === "init" && normalized.model) selectedModel = normalized.model;
      if (normalized.kind === "result") terminal = normalized;
      if (options.onEvent) callbackWork.push(Promise.resolve().then(() => options.onEvent(normalized)));
    };

    child.stdout.on("data", chunk => { for (const item of decoder.push(chunk)) emit(item); });
    child.stderr.on("data", chunk => {
      const text = chunk.toString("utf8");
      stderr += text;
      if (options.onStderr) callbackWork.push(Promise.resolve().then(() => options.onStderr(text)));
    });
    child.once("error", error => { spawnError = error; });

    const stop = () => { if (!closed) child.kill(); };
    const abort = () => stop();
    if (options.signal) {
      if (options.signal.aborted) stop();
      else options.signal.addEventListener("abort", abort, { once: true });
    }
    const timer = options.timeoutMs > 0 ? setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs) : null;

    child.once("close", async (exitCode, signal) => {
      closed = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      for (const item of decoder.end()) emit(item);
      await Promise.allSettled(callbackWork);
      const permissionNotices = stderr.split(/\r?\n/).filter(line => PERMISSION_DENIAL_RE.test(line));
      let status = terminal?.status || (signal || timedOut ? "INTERRUPTED" : "ERROR");
      if (permissionNotices.length) status = "ERROR";
      resolve({
        exitCode, signal, timedOut, conversationId, model: selectedModel, status,
        response: terminal?.response ?? null,
        error: terminal?.error ?? spawnError?.message ?? (timedOut ? "Antigravity turn timed out" : null),
        usage: terminal?.usage || null,
        changedFiles: terminal?.changedFiles || [], verification: terminal?.verification || null,
        events, stderr, permissionNotices,
      });
    });
  });
}
