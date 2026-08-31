#!/usr/bin/env node

import { cp, lstat, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SKILL_NAME = "antigravity-delegator";
export const source = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../plugins/antigravity/skills/antigravity-delegator"
);

export function resolveTarget({ env = process.env, home = homedir(), target } = {}) {
  if (target) return path.resolve(target);
  const codexHome = env.CODEX_HOME || path.join(home, ".codex");
  return path.resolve(codexHome, "skills", SKILL_NAME);
}

export function parseArguments(argv) {
  let mode;
  let target;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["--check", "--copy", "--link"].includes(argument)) {
      if (mode) throw new Error("Choose exactly one of --check, --copy, or --link.");
      mode = argument.slice(2);
    } else if (argument === "--target") {
      target = argv[++index];
      if (!target) throw new Error("--target requires a destination directory.");
    } else if (argument === "--help" || argument === "-h") {
      return { help: true };
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!mode) throw new Error("Choose one of --check, --copy, or --link.");
  return { mode, target };
}

export async function managedInstallation(target) {
  let stat;
  try {
    stat = await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, managed: false, isSymbolicLink: false };
    throw error;
  }

  try {
    const skill = await readFile(path.join(target, "SKILL.md"), "utf8");
    return { exists: true, managed: /^---\s*\r?\nname:\s*antigravity-delegator\s*\r?\n/m.test(skill), isSymbolicLink: stat.isSymbolicLink() };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return { exists: true, managed: false, isSymbolicLink: stat.isSymbolicLink() };
    }
    throw error;
  }
}

function validateTarget(target) {
  if (path.basename(target) !== SKILL_NAME) {
    throw new Error(`Refusing unsafe target ${target}; its final directory must be ${SKILL_NAME}.`);
  }
  if (path.resolve(target) === source) {
    throw new Error("Refusing to install the source skill onto itself.");
  }
}

async function validateSource() {
  const installation = await managedInstallation(source);
  if (!installation.exists || !installation.managed) {
    throw new Error(`Bundled skill is missing or invalid: ${source}`);
  }
}

async function prepareTarget(target) {
  const current = await managedInstallation(target);
  if (current.exists && !current.managed) {
    throw new Error(`Refusing to overwrite unrelated target: ${target}`);
  }
  await mkdir(path.dirname(target), { recursive: true });
  if (current.exists) await rm(target, { recursive: true, force: false });
  return current;
}

async function installCopy(target) {
  await prepareTarget(target);
  await cp(source, target, { recursive: true, force: false, errorOnExist: true });
  return { installedAs: "copy", target };
}

async function installLink(target) {
  await prepareTarget(target);
  try {
    await symlink(source, target, process.platform === "win32" ? "junction" : "dir");
    return { installedAs: "link", target };
  } catch (error) {
    if (process.platform !== "win32") throw error;
    await cp(source, target, { recursive: true, force: false, errorOnExist: true });
    return { installedAs: "copy", target, linkFallback: true };
  }
}

export async function install({ mode, target: requestedTarget, env, home } = {}) {
  const target = resolveTarget({ env, home, target: requestedTarget });
  validateTarget(target);
  await validateSource();
  const current = await managedInstallation(target);

  if (mode === "check") {
    return { mode, source, target, ...current, action: current.exists ? "check existing installation" : "check install target" };
  }

  if (mode === "copy") return { mode, source, ...(await installCopy(target)) };
  if (mode === "link") return { mode, source, ...(await installLink(target)) };
  throw new Error(`Unsupported install mode: ${mode}`);
}

export function usage() {
  return `Usage: node scripts/install-codex.mjs (--check | --copy | --link) [--target <skill-directory>]\n\nInstalls ${SKILL_NAME} from ${source}. The default destination is $CODEX_HOME/skills/${SKILL_NAME}, or ~/.codex/skills/${SKILL_NAME}.`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = await install(options);
  console.log(`Source: ${result.source}`);
  console.log(`Destination: ${result.target}`);
  if (result.mode === "check") {
    console.log(result.exists ? "Check: existing Antigravity Delegator installation is valid." : "Check: destination is available for installation.");
  } else if (result.linkFallback) {
    console.log("Installed as a copy because this Windows environment cannot create a directory link.");
  } else {
    console.log(`Installed as ${result.installedAs}.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`install-codex: ${error.message}`);
    process.exitCode = 1;
  });
}
