const VALUE_OPTIONS = new Map([
  ["cwd", "cwd"], ["state-dir", "stateDir"], ["timeout", "timeoutMs"],
  ["model", "model"], ["agent", "agent"], ["effort", "effort"],
  ["route", "route"], ["conversation", "conversationId"],
  ["agy-path", "agyPath"], ["message", "message"],
  ["json-schema", "jsonSchema"],
]);

const REPEATABLE_OPTIONS = new Map([["add-dir", "addDirs"]]);

const BOOLEAN_OPTIONS = new Map([
  ["json", "json"], ["background", "background"], ["wait", "wait"],
  ["sandbox", "sandbox"], ["read-only", "readOnly"], ["write", "write"],
  ["help", "help"], ["force", "force"],
]);

export function parseDuration(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i);
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const factors = { ms: 1, s: 1000, m: 60000, h: 3600000 };
  return Math.round(Number(match[1]) * factors[(match[2] || "ms").toLowerCase()]);
}

export function parseCli(argv) {
  if (!Array.isArray(argv)) throw new TypeError("argv must be an array");
  const values = [...argv];
  let command = "help";
  if (values[0] && !values[0].startsWith("-")) command = values.shift();
  const options = {};
  const positionals = [];
  let parsingOptions = true;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (parsingOptions && value === "--") { parsingOptions = false; continue; }
    if (!parsingOptions || !value.startsWith("--")) { positionals.push(value); continue; }
    const [rawName, inlineValue] = value.slice(2).split(/=(.*)/s, 2);
    if (rawName === "dangerously-skip-permissions") throw new Error("Dangerous permission bypass is not supported");
    if (BOOLEAN_OPTIONS.has(rawName)) {
      if (inlineValue !== undefined) throw new Error(`--${rawName} does not accept a value`);
      options[BOOLEAN_OPTIONS.get(rawName)] = true;
      continue;
    }
    const repeatable = REPEATABLE_OPTIONS.get(rawName);
    const key = repeatable || VALUE_OPTIONS.get(rawName);
    if (!key) throw new Error(`Unknown option: --${rawName}`);
    const optionValue = inlineValue !== undefined ? inlineValue : values[++index];
    if (optionValue === undefined) throw new Error(`Missing value for --${rawName}`);
    if (repeatable) { options[key] = [...(options[key] || []), optionValue]; continue; }
    options[key] = key === "timeoutMs" ? parseDuration(optionValue) : optionValue;
  }
  if (options.readOnly && options.write) throw new Error("Choose either --read-only or --write");
  options.accessProfile = options.write ? "write" : "read-only";
  if (options.sandbox) options.accessProfile = options.write ? "write-sandbox" : "read-only-sandbox";
  if (command === "delegate") options.prompt = positionals[0];
  return { command, options, positionals };
}
