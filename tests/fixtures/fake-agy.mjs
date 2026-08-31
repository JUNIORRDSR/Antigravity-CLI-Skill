#!/usr/bin/env node
const args = process.argv.slice(2);
const scenario = process.env.FAKE_AGY_SCENARIO || "success";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

if (args.includes("--version")) {
  console.log("1.1.22");
  process.exit(0);
}
if (args[0] === "models") {
  console.log("gemini-3.5-flash-medium\tGemini 3.5 Flash\nclaude-sonnet-4-5\tClaude Sonnet\ngpt-5.4\tGPT 5.4");
  process.exit(0);
}
if (args[0] === "agents") {
  console.log("default\nplanner\nreviewer");
  process.exit(0);
}

if (process.env.FAKE_AGY_ARGV_FILE) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.env.FAKE_AGY_ARGV_FILE, JSON.stringify(args), "utf8");
}

const conversationIndex = args.indexOf("--conversation");
const conversationId = conversationIndex >= 0 ? args[conversationIndex + 1] : "conv-fake-1";
if (args.includes("--approval-mode")) {
  process.stderr.write("unknown flag: --approval-mode\n");
  process.exit(2);
}
const modelIndex = args.indexOf("--model");
const selectedModel = modelIndex >= 0 ? args[modelIndex + 1] : (process.env.FAKE_AGY_DEFAULT_MODEL || "gemini-3.5-flash-medium");
const event = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const finish = (status, response, error, code = 0) => {
  event({ type: "result", status, response, error, usage: { input_tokens: 10, output_tokens: 5 } });
  process.exit(code);
};

if (scenario !== "no-conversation-id") event({ type: "init", conversation_id: conversationId, model: selectedModel });
event({ type: "step_update", step: "working", tool: "read_file", state: "running", text: "progress" });

switch (scenario) {
  case "slow-success":
    await delay(Number(process.env.FAKE_AGY_DELAY_MS || 250));
    finish("SUCCESS", "slow ok");
    break;
  case "gemini-quota":
    process.stderr.write("Gemini quota exhausted\n");
    finish("ERROR", undefined, "quota exceeded", 1);
    break;
  case "third-party-quota":
    process.stderr.write("Claude rate limit exceeded\n");
    finish("ERROR", undefined, "rate limit exceeded", 1);
    break;
  case "auth-error":
    process.stderr.write("Authentication required: please login\n");
    finish("ERROR", undefined, "unauthenticated", 1);
    break;
  case "soft-deny":
    process.stderr.write("Permission denied: tool execution was not approved\n");
    finish("SUCCESS", "I could not perform the requested tool action");
    break;
  case "interrupted":
    finish("INTERRUPTED", undefined, "interrupted", 130);
    break;
  case "malformed-line":
    process.stdout.write("{malformed}\n");
    finish("SUCCESS", "ok after malformed");
    break;
  case "no-conversation-id":
    finish("SUCCESS", "ok without conversation");
    break;
  // Shapes below are transcribed from real agy 1.1.22 runs on Windows.
  case "plan-approval":
    event({
      event: "step_update",
      step_update: {
        conversation_id: conversationId, step_index: 6, state: "DONE", step_type: "tool", tool_name: "write_to_file",
        tool_info: { name: "write_to_file", parameters: { TargetFile: `C:\\Users\\dev\\.gemini\\antigravity-cli\\brain\\${conversationId}\\run_git_status_plan.md` } },
      },
    });
    finish("SUCCESS", "I have created the implementation plan for running `git status --short`.\n\nPlease review and approve the plan to proceed with execution.\n");
    break;
  case "empty-success":
    finish("SUCCESS", "");
    break;
  case "headless-deny":
    process.stderr.write('jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. command(<target>)). Alternatively, re-run with --dangerously-skip-permissions to auto-approve all tools.\n');
    finish("SUCCESS", "");
    break;
  case "quota-in-response":
    finish("SUCCESS", "Error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h47m30s.");
    break;
  case "nested-envelope":
    event({ event: "step_update", step_update: { conversation_id: "conv-nested-1", step_index: 0, state: "DONE", step_type: "user_input" } });
    event({ event: "result", result: { conversation_id: "conv-nested-1", status: "SUCCESS", response: "nested ok", usage: { input_tokens: 1, output_tokens: 1 } } });
    process.exit(0);
    break;
  default:
    finish("SUCCESS", process.env.FAKE_AGY_RESPONSE || "completed");
}
