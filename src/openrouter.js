import { config } from "./config.js";
import { readJson, writeJsonAtomic } from "./files.js";

const MODELS_CACHE_PATH = `${config.dataDir}/models_cache.json`;
const MODELS_CACHE_TTL_MS = 60 * 60 * 1000;

function buildHeaders() {
  const headers = {
    "Authorization": `Bearer ${config.openRouterApiKey}`,
    "Content-Type": "application/json"
  };
  if (config.httpReferer) headers["HTTP-Referer"] = config.httpReferer;
  if (config.appTitle) headers["X-Title"] = config.appTitle;
  return headers;
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OpenRouter HTTP ${res.status}: ${text.slice(0, 2000)}`);
  }
  return text ? JSON.parse(text) : null;
}

async function* fetchSseJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenRouter HTTP ${res.status}: ${text.slice(0, 2000)}`);
  }

  if (!res.body) return;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let sep;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, sep);
      buf = buf.slice(sep + 2);

      const lines = chunk.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data) continue;
        if (data === "[DONE]") return;
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        yield parsed;
      }
    }
  }
}

function priceScore(model) {
  // OpenRouter returns pricing sometimes as strings. We treat missing as Infinity.
  const pricing = model?.pricing ?? {};
  const prompt = Number(pricing.prompt ?? pricing.prompt_price ?? pricing.input ?? Infinity);
  const completion = Number(pricing.completion ?? pricing.completion_price ?? pricing.output ?? Infinity);

  // Prefer models with known pricing.
  const promptSafe = Number.isFinite(prompt) ? prompt : Infinity;
  const completionSafe = Number.isFinite(completion) ? completion : Infinity;

  // Simple combined score: prompt + completion.
  return promptSafe + completionSafe;
}

async function getModelsCached() {
  const cached = await readJson(MODELS_CACHE_PATH, null);
  const now = Date.now();
  if (cached?.fetchedAt && (now - cached.fetchedAt) < MODELS_CACHE_TTL_MS && Array.isArray(cached?.data)) {
    return cached.data;
  }

  const url = `${config.openRouterBaseUrl}/models`;
  const data = await fetchJson(url, { method: "GET", headers: buildHeaders() });
  const models = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  await writeJsonAtomic(MODELS_CACHE_PATH, { fetchedAt: now, data: models });
  return models;
}

export async function pickModel() {
  // If user provided a model explicitly, always use it.
  if (config.openRouterModel && !config.useCheapestModel) return config.openRouterModel;
  if (config.openRouterModel && config.useCheapestModel) {
    // Interpret "always cheapest" as: choose cheapest among allowlist/denylist,
    // but still allow a fixed override by setting OPENROUTER_MODEL.
    return config.openRouterModel;
  }

  if (!config.useCheapestModel) throw new Error("OPENROUTER_MODEL is empty and USE_CHEAPEST_MODEL is false");

  const models = await getModelsCached();
  const allow = config.modelAllowlist;
  const deny = new Set(config.modelDenylist);

  const filtered = models
    .filter(m => m?.id)
    .filter(m => (allow.length ? allow.includes(m.id) : true))
    .filter(m => !deny.has(m.id));

  if (!filtered.length) throw new Error("No models available after allow/deny filtering");

  filtered.sort((a, b) => priceScore(a) - priceScore(b));
  return filtered[0].id;
}

export async function chatCompletion({ model, messages, responseFormatJson }) {
  const url = `${config.openRouterBaseUrl}/chat/completions`;

  const body = {
    model,
    messages,
    temperature: Number.isFinite(config.temperature) ? config.temperature : 0.2,
    max_tokens: config.maxTokens
  };

  // OpenAI-compatible response_format is supported by some providers; safe to omit if you want.
  if (responseFormatJson) {
    body.response_format = { type: "json_object" };
  }

  return await fetchJson(url, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body)
  });
}

export async function* chatCompletionStream({ model, messages }) {
  const url = `${config.openRouterBaseUrl}/chat/completions`;

  const body = {
    model,
    messages,
    temperature: Number.isFinite(config.temperature) ? config.temperature : 0.2,
    max_tokens: config.maxTokens,
    stream: true
  };

  yield* fetchSseJson(url, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body)
  });
}
