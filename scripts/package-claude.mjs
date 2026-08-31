#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const pluginRoot = path.join(repositoryRoot, "plugins", "antigravity");
export const defaultOutput = path.join(repositoryRoot, "dist", "antigravity-claude-plugin.zip");
const includedRoots = [".claude-plugin", ".codex-plugin", "agents", "claude-skills", "skills"];
const utf8Flag = 0x0800;
const storedMethod = 0;
const dosTime = 0;
const dosDate = (1 << 5) | 1;

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function localHeader(entry) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(utf8Flag, 6);
  header.writeUInt16LE(storedMethod, 8);
  header.writeUInt16LE(dosTime, 10);
  header.writeUInt16LE(dosDate, 12);
  header.writeUInt32LE(entry.crc, 14);
  header.writeUInt32LE(entry.data.length, 18);
  header.writeUInt32LE(entry.data.length, 22);
  header.writeUInt16LE(entry.name.length, 26);
  return header;
}

function centralHeader(entry, offset) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(utf8Flag, 8);
  header.writeUInt16LE(storedMethod, 10);
  header.writeUInt16LE(dosTime, 12);
  header.writeUInt16LE(dosDate, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.data.length, 20);
  header.writeUInt32LE(entry.data.length, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt32LE(offset, 42);
  return header;
}

function endOfCentralDirectory(count, size, offset) {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(0x06054b50, 0);
  record.writeUInt16LE(count, 8);
  record.writeUInt16LE(count, 10);
  record.writeUInt32LE(size, 12);
  record.writeUInt32LE(offset, 16);
  return record;
}

async function collectFiles(directory, entries) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, item.name);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link in Claude plugin package: ${absolute}`);
    if (stat.isDirectory()) await collectFiles(absolute, entries);
    else if (stat.isFile()) {
      const relative = path.relative(pluginRoot, absolute).split(path.sep).join("/");
      const name = Buffer.from(relative, "utf8");
      const data = await readFile(absolute);
      if (name.length > 0xffff || data.length > 0xffffffff) throw new Error(`ZIP entry is too large: ${relative}`);
      entries.push({ relative, name, data, crc: crc32(data) });
    }
  }
}

async function sourceEntries() {
  const manifestPath = path.join(pluginRoot, ".claude-plugin", "plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.name !== "antigravity") throw new Error(`Unexpected Claude plugin name in ${manifestPath}`);

  const entries = [];
  for (const root of includedRoots) await collectFiles(path.join(pluginRoot, root), entries);
  entries.sort((left, right) => left.relative.localeCompare(right.relative, "en"));
  if (entries.length > 0xffff) throw new Error("Claude plugin has too many files for a standard ZIP archive");
  return entries;
}

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entry of entries) {
    const header = localHeader(entry);
    localParts.push(header, entry.name, entry.data);
    centralParts.push(centralHeader(entry, localOffset), entry.name);
    localOffset += header.length + entry.name.length + entry.data.length;
  }
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  if (localOffset > 0xffffffff || centralSize > 0xffffffff) throw new Error("Claude plugin ZIP exceeds the standard 4 GiB limit");
  return Buffer.concat([...localParts, ...centralParts, endOfCentralDirectory(entries.length, centralSize, localOffset)]);
}

export async function packageClaudePlugin(output = defaultOutput) {
  const destination = path.resolve(output);
  if (path.extname(destination).toLowerCase() !== ".zip") throw new Error("Claude plugin output must use a .zip extension");
  const entries = await sourceEntries();
  const archive = buildZip(entries);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, archive, { flag: "wx" });
    try { await rename(temporary, destination); }
    catch (error) {
      if (!["EEXIST", "EPERM"].includes(error?.code)) throw error;
      await rm(destination, { force: true });
      await rename(temporary, destination);
    }
  } finally {
    await rm(temporary, { force: true });
  }
  return { output: destination, files: entries.length, bytes: archive.length };
}

export function parseArguments(argv) {
  let output = defaultOutput;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output") {
      output = argv[++index];
      if (!output) throw new Error("--output requires a .zip path");
    } else if (argument === "--help" || argument === "-h") return { help: true };
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return { output };
}

export function usage() {
  return "Usage: node scripts/package-claude.mjs [--output <plugin.zip>]";
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) return console.log(usage());
  const result = await packageClaudePlugin(options.output);
  console.log(`Claude plugin ZIP: ${result.output}`);
  console.log(`Packaged ${result.files} files (${result.bytes} bytes) with .claude-plugin/plugin.json at the archive root.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`package-claude: ${error.message}`);
    process.exitCode = 1;
  });
}
