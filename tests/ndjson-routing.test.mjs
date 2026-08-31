import test from "node:test";
import assert from "node:assert/strict";
import { NdjsonDecoder, normalizeAgyEvent } from "../plugins/antigravity/skills/antigravity-delegator/scripts/lib/ndjson.mjs";
import { classifyFailure } from "../plugins/antigravity/skills/antigravity-delegator/scripts/lib/errors.mjs";
import { chooseFallback, classifyModelFamily, parseModelList, rankModels } from "../plugins/antigravity/skills/antigravity-delegator/scripts/lib/model-routing.mjs";

const MODELS = ["gemini-3.5-flash-medium", "claude-sonnet-4-5", "gpt-5.4"];

test("decoder preserves partial chunks, malformed complete lines, and future events", () => {
  const decoder = new NdjsonDecoder();
  assert.deepEqual(decoder.push('{"type":"in'), []);
  const values = decoder.push('it","conversation_id":"c1"}\n{bad}\n{"type":"future","x":1}\n');
  assert.equal(values[0].value.conversation_id, "c1");
  assert.match(values[1].error.message, /JSON/);
  assert.equal(values[2].value.type, "future");
  assert.deepEqual(decoder.end(), []);
});

test("decoder ignores a truncated final line without losing complete records", () => {
  const decoder = new NdjsonDecoder();
  decoder.push('{"type":"init"}\n{"type":');
  assert.equal(decoder.end()[0].truncated, true);
});

test("normalizes known events while retaining original payload", () => {
  const value = normalizeAgyEvent({ type: "step_update", step: "read", tool: "cat", text: "x", usage: { input_tokens: 2 } });
  assert.equal(value.kind, "progress");
  assert.equal(value.tool, "cat");
  assert.equal(value.raw.type, "step_update");
});

test("normalizes nested init and progress envelopes emitted by agy 1.1.22", () => {
  const init = normalizeAgyEvent({
    event: "init",
    conversation_id: "conv-real-1",
    init: { model: "gemini-3.7-flash-low", cwd: "C:/work" },
  });
  const progress = normalizeAgyEvent({
    event: "step_update",
    step_update: {
      conversation_id: "conv-real-1",
      step_index: 1,
      state: "DONE",
      step_type: "agent_response",
      text_delta: "ANTIGRAVITY_PLUGIN_OK\n",
      usage: { input_tokens: 15_971, output_tokens: 8 },
    },
  });

  assert.equal(init.conversationId, "conv-real-1");
  assert.equal(init.model, "gemini-3.7-flash-low");
  assert.equal(progress.state, "DONE");
  assert.equal(progress.text, "ANTIGRAVITY_PLUGIN_OK\n");
  assert.deepEqual(progress.usage, { input_tokens: 15_971, output_tokens: 8 });
});

test("normalizes the nested result envelope emitted by agy 1.1.22", () => {
  const value = normalizeAgyEvent({
    event: "result",
    result: {
      conversation_id: "conv-real-1",
      status: "SUCCESS",
      response: "ANTIGRAVITY_PLUGIN_OK\n",
      duration_seconds: 1.4,
      num_turns: 1,
      usage: { input_tokens: 15_971, output_tokens: 8, total_tokens: 15_979 },
    },
  });

  assert.equal(value.kind, "result");
  assert.equal(value.status, "SUCCESS");
  assert.equal(value.response, "ANTIGRAVITY_PLUGIN_OK\n");
  assert.deepEqual(value.usage, { input_tokens: 15_971, output_tokens: 8, total_tokens: 15_979 });
  assert.equal(value.error, null);
});

test("failure classifier distinguishes retry and family switching boundaries", () => {
  assert.deepEqual(classifyFailure({ stderr: "Gemini quota exhausted" }).kind, "quota");
  assert.equal(classifyFailure({ stderr: "429 rate limit" }).switchFamily, true);
  assert.equal(classifyFailure({ stderr: "ECONNRESET" }).kind, "transport");
  for (const text of ["authentication required", "permission denied", "unknown model", "tests failed deterministically"]) {
    const failure = classifyFailure({ stderr: text, status: "ERROR" });
    assert.equal(failure.switchFamily, false);
  }
  assert.equal(classifyFailure({ status: "INTERRUPTED" }).kind, "interrupted");
});

test("models are parsed, classified, and ranked from discovery output", () => {
  const models = parseModelList("gemini-3.5-flash-medium\tGemini Flash\nclaude-sonnet-4-5\tClaude Sonnet\n");
  assert.equal(models.length, 2);
  assert.equal(classifyModelFamily(models[0]), "gemini");
  assert.equal(classifyModelFamily(models[1]), "third-party");
  assert.equal(rankModels(models, "third-party-first")[0].slug, "claude-sonnet-4-5");
  assert.throws(() => rankModels(models, "missing-exact"), /unavailable/i);
});

test("quota fallback switches family once and preserves conversation", () => {
  const next = chooseFallback({ failedModel: MODELS[0], conversationId: "conv-1", availableModels: MODELS, attempts: [] });
  assert.equal(next.family, "third-party");
  assert.equal(next.conversationId, "conv-1");
  const reverse = chooseFallback({ failedModel: MODELS[1], conversationId: "conv-2", availableModels: MODELS, attempts: [] });
  assert.equal(reverse.family, "gemini");
  assert.equal(chooseFallback({ failedModel: MODELS[0], availableModels: MODELS, attempts: [{ familySwitch: true }] }), null);
});
