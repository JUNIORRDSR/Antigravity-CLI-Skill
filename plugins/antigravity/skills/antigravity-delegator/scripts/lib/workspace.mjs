import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function canonicalWorkspace(cwd = process.cwd()) {
  const resolved = path.resolve(cwd);
  let canonical;
  try { canonical = await realpath(resolved); } catch { canonical = resolved; }
  canonical = path.normalize(canonical);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

export function defaultStateRoot(env = process.env, platform = process.platform, home = os.homedir()) {
  if (platform === "win32") {
    const base = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return path.win32.join(base, "antigravity-delegator");
  }
  return path.posix.join(env.XDG_STATE_HOME || path.posix.join(home, ".local", "state"), "antigravity-delegator");
}

export function workspaceKey(workspace) {
  return createHash("sha256").update(String(workspace)).digest("hex").slice(0, 24);
}

export function workspaceStateDir(root, workspace) {
  return path.join(root, workspaceKey(workspace));
}

export async function resolveWorkspaceContext(options = {}) {
  const workspace = await canonicalWorkspace(options.cwd || process.cwd());
  const stateRoot = path.resolve(options.stateDir || defaultStateRoot());
  const workspaceDir = workspaceStateDir(stateRoot, workspace);
  return { workspace, stateRoot, workspaceDir };
}
