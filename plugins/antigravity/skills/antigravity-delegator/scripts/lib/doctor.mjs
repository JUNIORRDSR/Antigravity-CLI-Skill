import { spawn } from "node:child_process";
import { mkdir, readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { discoverAgents, discoverModels } from "./agy.mjs";
import { AGY_PERMISSION_KINDS, AGY_SETTINGS_RELATIVE_PATH, READ_ONLY_ALLOW_RULES } from "./constants.mjs";
import { writeJsonAtomic } from "./state.mjs";
import { resolveWorkspaceContext } from "./workspace.mjs";

export function agySettingsPath(home = os.homedir()) {
  return path.join(home, ...AGY_SETTINGS_RELATIVE_PATH);
}

/**
 * Headless agy cannot prompt for a tool permission, so it auto-denies and produces no output.
 * Report what `permissions.allow` holds; never write it, and never suggest bypassing it.
 */
export async function inspectPermissions(options = {}) {
  const file = options.agySettingsPath || agySettingsPath(options.home);
  const guidance = `Add the rules a read-only audit needs under "permissions": { "allow": [...] } in ${file}, using agy's <kind>(<target>) shape (kinds: ${AGY_PERMISSION_KINDS.join(", ")}). Suggested starting point: ${READ_ONLY_ALLOW_RULES.join(", ")}. Denied tools produce an empty run, not an error.`;
  let text;
  try { text = await readFile(file, "utf8"); }
  catch (error) {
    if (error.code !== "ENOENT") return { name: "permissions", ok: false, error: error.message, guidance };
    return { name: "permissions", ok: false, error: `no settings file at ${file}`, guidance };
  }
  let allow;
  try { allow = JSON.parse(text)?.permissions?.allow; }
  catch (error) { return { name: "permissions", ok: false, error: `unreadable settings file: ${error.message}`, guidance }; }
  if (!Array.isArray(allow) || !allow.length) return { name: "permissions", ok: false, error: "permissions.allow is empty", guidance };
  return { name: "permissions", ok: true, value: allow };
}

function runCommand(options, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(options.agyPath || "agy", [...(options.agyPrefixArgs || []), ...args], {
      cwd: options.cwd, env: { ...process.env, ...options.env }, shell: false, windowsHide: true,
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
  });
}

export async function runDoctor(options = {}) {
  const checks = [];
  const context = await resolveWorkspaceContext(options);
  const [major, minor] = process.versions.node.split(".").map(Number);
  checks.push({ name: "node", ok: major > 18 || (major === 18 && minor >= 18), value: process.version, guidance: "Install Node.js 18.18 or newer." });
  try {
    await mkdir(context.workspaceDir, { recursive: true });
    const probe = path.join(context.workspaceDir, `.doctor-${randomUUID()}.json`);
    await writeJsonAtomic(probe, { ok: true }); await unlink(probe);
    checks.push({ name: "state", ok: true, value: context.workspaceDir });
  } catch (error) { checks.push({ name: "state", ok: false, error: error.message, guidance: "Choose a writable --state-dir." }); }
  try {
    const version = await runCommand(options, ["--version"]);
    if (version.code !== 0) throw new Error(version.stderr || `exit ${version.code}`);
    const versionText = version.stdout.trim();
    const match = versionText.match(/(\d+)\.(\d+)\.(\d+)/);
    const versionOk = Boolean(match) && (Number(match[1]) > 1 || (Number(match[1]) === 1 && (Number(match[2]) > 1 || (Number(match[2]) === 1 && Number(match[3]) >= 22))));
    checks.push({ name: "agy", ok: versionOk, value: versionText, guidance: versionOk ? undefined : "Upgrade Antigravity CLI to 1.1.22 or newer." });
    try { checks.push({ name: "models", ok: true, value: await discoverModels(options) }); }
    catch (error) { checks.push({ name: "models", ok: false, error: error.message, guidance: /auth|login/i.test(error.message) ? "Authenticate Antigravity CLI, then retry." : "Run `agy models` and resolve the reported setup error." }); }
    try { checks.push({ name: "agents", ok: true, value: await discoverAgents(options) }); }
    catch (error) { checks.push({ name: "agents", ok: false, error: error.message, guidance: /auth|login/i.test(error.message) ? "Authenticate Antigravity CLI, then retry." : "Run `agy agents` and resolve the reported setup error." }); }
  } catch (error) {
    checks.push({ name: "agy", ok: false, error: error.message, guidance: "Install Antigravity CLI 1.1.22+ and ensure `agy` is on PATH; authenticate it before delegating." });
  }
  const permissions = await inspectPermissions(options);
  checks.push(permissions);
  const required = checks.filter(check => check.name !== "permissions");
  return { ok: required.every(check => check.ok), workspace: context.workspace, stateRoot: context.stateRoot, checks };
}
