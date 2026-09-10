import assert from "node:assert/strict";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(root, "plugins", "antigravity");
const skillRoot = path.join(pluginRoot, "skills", "antigravity-delegator");
const installer = path.join(root, "scripts", "install-codex.mjs");
const claudePackager = path.join(root, "scripts", "package-claude.mjs");
const lifecycleSkillNames = ["delegate", "status", "wait", "send", "result", "recover", "cancel", "doctor"];

function runInstaller(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [installer, ...args], {
      cwd: root,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function runClaudePackager(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [claudePackager, ...args], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function storedZipEntries(buffer) {
  let end = buffer.length - 22;
  const minimum = Math.max(0, buffer.length - 65_557);
  while (end >= minimum && buffer.readUInt32LE(end) !== 0x06054b50) end -= 1;
  assert.ok(end >= minimum, "ZIP end-of-central-directory record is missing");

  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, "invalid central-directory entry");
    const method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    assert.equal(method, 0, `${name} must use the portable stored ZIP method`);
    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, `invalid local header for ${name}`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    entries.set(name, buffer.subarray(dataOffset, dataOffset + size));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function temporaryTarget() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "antigravity-delegator-package-"));
  return path.join(parent, "antigravity-delegator");
}

test("canonical skill package has a valid, complete structural contract", async () => {
  const skill = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
  assert.match(skill, /^---\r?\nname: antigravity-delegator\r?\ndescription: Use when /);
  assert.match(skill, /antigravity-delegator\.mjs/);
  assert.match(skill, /--dangerously-skip-permissions/);
  assert.match(skill, /independent verification/i);
  assert.doesNotMatch(skill, /\b(TODO|TBD|FIXME)\b/i);

  for (const reference of ["cli-reference", "host-integration", "model-routing", "permissions", "recovery"]) {
    assert.match(skill, new RegExp(`references/${reference}\\.md`));
    await access(path.join(skillRoot, "references", `${reference}.md`));
  }

  await access(path.join(skillRoot, "scripts", "antigravity-delegator.mjs"));
  const metadata = await readFile(path.join(skillRoot, "agents", "openai.yaml"), "utf8");
  assert.match(metadata, /display_name:/);
  assert.match(metadata, /\$antigravity-delegator/);
  assert.match(metadata, /allow_implicit_invocation:\s*true/);

  const integration = await readFile(path.join(skillRoot, "references", "host-integration.md"), "utf8");
  assert.match(integration, /\.codex-plugin\/plugin\.json/);
  assert.match(integration, /claude-skills\/.*SKILL\.md/);
  assert.match(integration, /commands\/.*legacy/i);
});

test("Claude and Codex manifests expose modern lifecycle skills", async () => {
  const marketplace = JSON.parse(await readFile(path.join(root, ".claude-plugin", "marketplace.json"), "utf8"));
  const claudeManifest = JSON.parse(await readFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"));
  const rootClaudeManifest = JSON.parse(await readFile(path.join(root, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(marketplace.name, "antigravity-cli-skill");
  assert.deepEqual(
    marketplace.plugins.map(({ name, source }) => ({ name, source })),
    [{ name: "antigravity", source: "./plugins/antigravity" }]
  );
  assert.equal(claudeManifest.name, "antigravity");
  assert.ok(claudeManifest.description);
  assert.equal(claudeManifest.version, undefined, "Claude updates must follow the marketplace commit");
  assert.equal(claudeManifest.skills, "./claude-skills/");
  assert.equal(claudeManifest.hooks, undefined);
  assert.equal(claudeManifest.mcpServers, undefined);

  assert.equal(rootClaudeManifest.name, "antigravity");
  assert.ok(rootClaudeManifest.description);
  assert.equal(rootClaudeManifest.skills, "./plugins/antigravity/claude-skills/");

  const codexManifest = JSON.parse(await readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
  assert.equal(codexManifest.name, "antigravity");
  assert.equal(codexManifest.skills, "./skills/");
  assert.equal(codexManifest.interface.displayName, "Antigravity Delegator");
  assert.ok(codexManifest.interface.defaultPrompt.length > 0);

  const packageManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(packageManifest.version, codexManifest.version);

  const legacyCommands = await readdir(path.join(pluginRoot, "commands")).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  assert.deepEqual(legacyCommands, []);

  const descriptions = new Set();
  for (const name of lifecycleSkillNames) {
    const skill = await readFile(path.join(pluginRoot, "claude-skills", name, "SKILL.md"), "utf8");
    assert.match(skill, new RegExp(`^---\\r?\\nname: ${name}\\r?\\n`));
    const description = skill.match(/^description:\s*(.+)\r?$/m)?.[1];
    assert.ok(description, `${name} skill needs a description`);
    assert.equal(descriptions.has(description), false, `${name} skill description must be unique`);
    descriptions.add(description);
    assert.match(skill, /argument-hint:/);
    assert.match(skill, name === "delegate" ? /allowed-tools:\s*Task/ : /allowed-tools:\s*Bash/);
    if (name !== "delegate") {
      assert.match(skill, /\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/antigravity-delegator\/scripts\/antigravity-delegator\.mjs/);
      assert.match(skill, new RegExp(`antigravity-delegator\\.mjs\" ${name} \\$ARGUMENTS`));
    }
  }

  const delegate = await readFile(path.join(pluginRoot, "claude-skills", "delegate", "SKILL.md"), "utf8");
  assert.match(delegate, /antigravity:antigravity-runner/);
  assert.match(delegate, /gemini-3\.8-flash/);
  assert.match(delegate, /effort:\s*high/);
  assert.match(delegate, /`?maxTurns`? can be modified/);

  const agent = await readFile(path.join(pluginRoot, "agents", "antigravity-runner.md"), "utf8");
  assert.match(agent, /^---\r?\nname: antigravity-runner/m);
  assert.match(agent, /tools:\s*Bash/);
  assert.doesNotMatch(agent, /\b(Read|Edit|Write|Glob|Grep)\b/);
  assert.match(agent, /stdout unchanged/);
  assert.match(agent, /model:\s*gemini-3\.8-flash/);
  assert.match(agent, /effort:\s*high/);
  assert.match(agent, /maxTurns:\s*\d+/);
  assert.match(agent, /`?maxTurns`? can be modified/);
});

test("Claude packager puts the plugin manifest at the ZIP root", async (t) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "antigravity-claude-zip-"));
  const output = path.join(outputDir, "antigravity.zip");
  t.after(() => rm(outputDir, { recursive: true, force: true }));

  const packaged = await runClaudePackager(["--output", output]);
  assert.equal(packaged.code, 0, packaged.stderr);
  const entries = storedZipEntries(await readFile(output));
  assert.ok(entries.has(".claude-plugin/plugin.json"));
  assert.ok(entries.has(".codex-plugin/plugin.json"));
  assert.ok(entries.has("claude-skills/delegate/SKILL.md"));
  assert.ok(entries.has("skills/antigravity-delegator/SKILL.md"));
  assert.equal([...entries.keys()].some((name) => name.startsWith("commands/")), false);
  assert.equal([...entries.keys()].some((name) => name.startsWith("Antigravity-CLI-Skill/") || name.includes("/.git/")), false);
  assert.equal(JSON.parse(entries.get(".claude-plugin/plugin.json").toString("utf8")).name, "antigravity");
});

test("Codex installer resolves CODEX_HOME and falls back to ~/.codex", async () => {
  const { resolveTarget } = await import("../scripts/install-codex.mjs");
  const volumeRoot = path.parse(root).root;
  const portableHome = path.join(volumeRoot, "portable-codex");
  const fallbackHome = path.join(volumeRoot, "home");
  assert.equal(
    resolveTarget({ env: { CODEX_HOME: portableHome }, home: path.join(volumeRoot, "ignored") }),
    path.resolve(portableHome, "skills", "antigravity-delegator")
  );
  assert.equal(
    resolveTarget({ env: {}, home: fallbackHome }),
    path.resolve(fallbackHome, ".codex", "skills", "antigravity-delegator")
  );
});

test("Codex installer checks, copies, and safely replaces only managed targets", async (t) => {
  const target = await temporaryTarget();
  t.after(() => rm(path.dirname(target), { recursive: true, force: true }));

  const check = await runInstaller(["--check", "--target", target]);
  assert.equal(check.code, 0, check.stderr);
  assert.match(check.stdout, new RegExp(`Source: ${escapeRegExp(skillRoot)}`));
  assert.match(check.stdout, new RegExp(`Destination: ${escapeRegExp(target)}`));
  await assert.rejects(lstat(target), { code: "ENOENT" });

  const copied = await runInstaller(["--copy", "--target", target]);
  assert.equal(copied.code, 0, copied.stderr);
  assert.match(copied.stdout, /Installed as copy\./);
  assert.match(await readFile(path.join(target, "SKILL.md"), "utf8"), /name: antigravity-delegator/);

  const copiedAgain = await runInstaller(["--copy", "--target", target]);
  assert.equal(copiedAgain.code, 0, copiedAgain.stderr);
});

test("Codex installer refuses unrelated targets and uses a link when supported", async (t) => {
  const parent = await temporaryTarget();
  const unrelated = path.join(path.dirname(parent), "antigravity-delegator");
  const linked = path.join(path.dirname(parent), "linked", "antigravity-delegator");
  t.after(() => rm(path.dirname(parent), { recursive: true, force: true }));

  await mkdir(unrelated, { recursive: true });
  await writeFile(path.join(unrelated, "SKILL.md"), "---\nname: another-skill\n---\n", "utf8");
  const refusal = await runInstaller(["--copy", "--target", unrelated]);
  assert.notEqual(refusal.code, 0);
  assert.match(refusal.stderr, /Refusing to overwrite unrelated target/);
  assert.match(await readFile(path.join(unrelated, "SKILL.md"), "utf8"), /another-skill/);

  const link = await runInstaller(["--link", "--target", linked]);
  assert.equal(link.code, 0, link.stderr);
  const linkedStat = await lstat(linked);
  assert.ok(linkedStat.isSymbolicLink() || (process.platform === "win32" && /Installed as (?:copy|link)/.test(link.stdout)));
  assert.match(await readFile(path.join(linked, "SKILL.md"), "utf8"), /name: antigravity-delegator/);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
