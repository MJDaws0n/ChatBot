function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid integer env var ${name}: ${raw}`);
  return parsed;
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

function envStr(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return raw;
}

export const config = {
  port: envInt("PORT", 8080),
  openRouterApiKey: requireEnv("OPEN_ROUTER_API_KEY"),

  // If set, this wins. If empty and useCheapestModel=true, we'll pick cheapest.
  openRouterModel: envStr("OPENROUTER_MODEL", "z-ai/glm-4.7"),
  useCheapestModel: envBool("USE_CHEAPEST_MODEL", false),
  modelAllowlist: envStr("MODEL_ALLOWLIST", "").split(",").map(s => s.trim()).filter(Boolean),
  modelDenylist: envStr("MODEL_DENYLIST", "").split(",").map(s => s.trim()).filter(Boolean),

  openRouterBaseUrl: envStr("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
  httpReferer: envStr("OPENROUTER_HTTP_REFERER", ""),
  appTitle: envStr("OPENROUTER_APP_TITLE", "ChatBot"),

  temperature: Number.parseFloat(envStr("TEMPERATURE", "0.2")),
  maxTokens: envInt("MAX_TOKENS", 900),

  dataDir: envStr("DATA_DIR", "/app/data"),

  recentMessages: envInt("RECENT_MESSAGES", 8),
  summaryMessages: envInt("SUMMARY_MESSAGES", 24),

  // When chat grows beyond recent+summary, we update summary.
  summaryMinMessages: envInt("SUMMARY_MIN_MESSAGES", 40),

  // How to treat total_memory.txt
  memoryMaxLines: envInt("MEMORY_MAX_LINES", 2000)
};
