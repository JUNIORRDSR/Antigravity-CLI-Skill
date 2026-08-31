import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, value => value.slice(1))), "..");
export const CLI = path.join(ROOT, "plugins", "antigravity", "skills", "antigravity-delegator", "scripts", "antigravity-delegator.mjs");
export const FAKE_AGY = path.join(ROOT, "tests", "fixtures", "fake-agy.mjs");

export function runNode(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      windowsHide: true,
      signal: options.signal,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

export async function makeTempWorkspace(prefix = "agy-delegator-") {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const workspace = path.join(root, "workspace with spaces");
  const stateDir = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  return {
    root,
    workspace,
    stateDir,
    async cleanup() { await rm(root, { recursive: true, force: true }); },
  };
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export async function runCliJson(args, options = {}) {
  const result = await runNode([CLI, ...args, "--json"], options);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
