export class NdjsonDecoder {
  #buffer = "";

  push(chunk) {
    this.#buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const lines = this.#buffer.split(/\r?\n/);
    this.#buffer = lines.pop() ?? "";
    return lines.filter(Boolean).map(parseLine);
  }

  end() {
    if (!this.#buffer) return [];
    const raw = this.#buffer;
    this.#buffer = "";
    try { return [{ value: JSON.parse(raw), raw }]; }
    catch (error) { return [{ raw, error, truncated: true }]; }
  }
}

function parseLine(raw) {
  try { return { value: JSON.parse(raw), raw }; }
  catch (error) { return { raw, error }; }
}

function conversationOf(payload, value) {
  return payload.conversation_id || payload.conversationId || value.conversation_id || value.conversationId || null;
}

export function normalizeAgyEvent(value) {
  const type = value?.type || value?.event || "unknown";
  const nested = value?.[type];
  const payload = nested && typeof nested === "object" && !Array.isArray(nested) ? nested : value;
  if (type === "init") return {
    kind: "init",
    conversationId: conversationOf(payload, value),
    model: payload.model || payload.model_slug || value.model || value.model_slug || null,
    raw: value,
  };
  if (type === "step_update") return {
    kind: "progress", step: payload.step ?? payload.step_index ?? null, tool: payload.tool || payload.tool_name || null,
    state: payload.state || null, text: payload.text ?? payload.delta ?? payload.text_delta ?? null, usage: payload.usage || null,
    conversationId: conversationOf(payload, value),
    stepType: payload.step_type || payload.stepType || null,
    toolInfo: payload.tool_info || payload.toolInfo || null,
    raw: value,
  };
  if (type === "result") return {
    kind: "result", status: payload.status || value.status || null,
    response: payload.response ?? value.response ?? (payload === value ? value.result : null) ?? null,
    error: payload.error ?? value.error ?? null, usage: payload.usage || value.usage || null,
    conversationId: conversationOf(payload, value),
    changedFiles: payload.changed_files || payload.changedFiles || value.changed_files || value.changedFiles || [],
    verification: payload.verification || value.verification || null, raw: value,
  };
  return { kind: "unknown", type, raw: value };
}
