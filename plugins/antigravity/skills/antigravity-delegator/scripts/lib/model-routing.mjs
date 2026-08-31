function slugOf(model) { return model == null ? "" : typeof model === "string" ? model : model.slug || model.id || model.name || ""; }

export function parseModelList(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    const values = Array.isArray(parsed) ? parsed : parsed.models;
    if (Array.isArray(values)) return values.map(value => typeof value === "string" ? { slug: value, label: value } : { ...value, slug: slugOf(value) });
  } catch { /* line-oriented CLI output */ }
  return trimmed.split(/\r?\n/).map(line => line.trim()).filter(Boolean).filter(line => !/^available models:?$/i.test(line)).map(line => {
    const [slug, ...label] = line.replace(/^[-*]\s*/, "").split(/\t|\s{2,}/);
    return { slug: slug.trim(), label: label.join(" ").trim() || slug.trim() };
  });
}

export function classifyModelFamily(model) {
  const slug = slugOf(model)?.toLowerCase() || "";
  return /gemini/.test(slug) ? "gemini" : /claude|gpt|openai|sonnet|opus|haiku/.test(slug) ? "third-party" : "unknown";
}

function score(model, route) {
  const slug = slugOf(model).toLowerCase();
  const family = classifyModelFamily(model);
  let value = 0;
  if (route === "gemini-first") value += family === "gemini" ? 100 : 0;
  if (route === "third-party-first") value += family === "third-party" ? 100 : 0;
  // Measured on real audits: opus-class reasoning produced verifiable citations where the
  // default model returned correct verdicts pointing at the wrong lines.
  if (route === "quality") value += /opus/.test(slug) ? 60 : /pro|sonnet|gpt-5(?:\.|$)/.test(slug) ? 50 : 0;
  if (route === "fast") value += /flash|haiku|mini|fast/.test(slug) ? 50 : 0;
  if (route === "balanced") value += /sonnet|flash|medium/.test(slug) ? 30 : 0;
  return value;
}

export function rankModels(models, route = "auto") {
  const normalized = models.map(model => typeof model === "string" ? { slug: model, label: model } : model);
  const named = new Set(["auto", "quality", "balanced", "fast", "gemini-first", "third-party-first"]);
  if (!named.has(route)) {
    const exact = route.split(",").map(value => value.trim()).filter(Boolean);
    const bySlug = new Map(normalized.map(model => [slugOf(model), model]));
    const missing = exact.filter(slug => !bySlug.has(slug));
    if (missing.length) throw new Error(`Requested model unavailable: ${missing.join(", ")}`);
    return exact.map(slug => bySlug.get(slug));
  }
  return normalized.map((model, index) => ({ model, index, score: score(model, route) }))
    .sort((a, b) => b.score - a.score || a.index - b.index).map(item => item.model);
}

export function chooseFallback(context) {
  const switches = (context.attempts || []).filter(attempt => attempt.familySwitch).length;
  const limit = context.familySwitches ?? 1;
  if (switches >= limit) return null;
  const failedFamily = context.failedFamily || classifyModelFamily(context.failedModel);
  if (failedFamily === "unknown") return null;
  const target = failedFamily === "gemini" ? "third-party" : "gemini";
  const used = new Set((context.attempts || []).map(attempt => attempt.model).filter(Boolean));
  const selected = (context.availableModels || []).find(model => classifyModelFamily(model) === target && !used.has(slugOf(model)));
  if (!selected) return null;
  return { model: slugOf(selected), family: target, conversationId: context.conversationId || null, familySwitch: true };
}

/** Antigravity quota is per model, so an exhausted model does not imply an exhausted account. */
export function remainingModels(models, exhausted = []) {
  const used = new Set(exhausted.map(value => slugOf(value)).filter(Boolean));
  return (models || []).map(model => slugOf(model)).filter(slug => slug && !used.has(slug));
}
