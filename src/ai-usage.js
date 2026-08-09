/**
 * Monitoramento de custos de API (Groq / DeepSeek) do Simple Replit.
 * Persiste em arquivo JSON local (não no workspace do Premercado).
 */
const fs = require('fs');
const path = require('path');

const STORE_PATH = process.env.AI_USAGE_PATH
  ? path.resolve(process.env.AI_USAGE_PATH)
  : path.join(__dirname, '..', 'data', 'ai-usage.json');

// USD por 1M tokens — estimativas públicas (ajuste se mudar a tabela do provedor)
const RATES = {
  // DeepSeek
  'deepseek-chat': { in: 0.14, out: 0.28 },
  'deepseek-reasoner': { in: 0.55, out: 2.19 },
  // Groq (ordem de grandeza; plano pago varia)
  'llama-3.1-8b-instant': { in: 0.05, out: 0.08 },
  'openai/gpt-oss-120b': { in: 0.15, out: 0.60 },
  default: { in: 0.20, out: 0.60 },
};

function emptyDay(day) {
  return {
    day,
    calls: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cost_usd: 0,
    by_model: {},
  };
}

function loadStore() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    }
  } catch (_) {}
  return { days: {}, updatedAt: null };
}

function saveStore(store) {
  try {
    const dir = path.dirname(STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    store.updatedAt = new Date().toISOString();
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
  } catch (err) {
    console.error('[ai-usage] save failed:', err.message);
  }
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function estimateCost(model, promptTokens, completionTokens) {
  const rate = RATES[model] || RATES.default;
  const cost =
    (promptTokens / 1e6) * rate.in +
    (completionTokens / 1e6) * rate.out;
  return Math.round(cost * 1e6) / 1e6; // 6 casas
}

/**
 * Registra usage de uma resposta de LLM.
 * @param {object} opts
 * @param {string} opts.modelKey - chave interna (deepseek-flash, etc.)
 * @param {string} opts.providerModel - id do modelo na API
 * @param {object} [opts.usage] - usage da API OpenAI-compatible
 * @param {string} [opts.endpoint] - chat | agent
 */
function recordUsage({ modelKey, providerModel, usage, endpoint }) {
  if (!usage) return null;

  const prompt = Number(usage.prompt_tokens || usage.input_tokens || 0) || 0;
  const completion = Number(usage.completion_tokens || usage.output_tokens || 0) || 0;
  const total = Number(usage.total_tokens || prompt + completion) || prompt + completion;
  if (!prompt && !completion && !total) return null;

  const model = providerModel || modelKey || 'unknown';
  const cost = estimateCost(model, prompt, completion);
  const day = todayKey();
  const store = loadStore();
  if (!store.days[day]) store.days[day] = emptyDay(day);
  const d = store.days[day];
  d.calls += 1;
  d.prompt_tokens += prompt;
  d.completion_tokens += completion;
  d.total_tokens += total;
  d.cost_usd = Math.round((d.cost_usd + cost) * 1e6) / 1e6;

  if (!d.by_model[modelKey || model]) {
    d.by_model[modelKey || model] = {
      calls: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      cost_usd: 0,
    };
  }
  const m = d.by_model[modelKey || model];
  m.calls += 1;
  m.prompt_tokens += prompt;
  m.completion_tokens += completion;
  m.total_tokens += total;
  m.cost_usd = Math.round((m.cost_usd + cost) * 1e6) / 1e6;

  // últimos eventos (máx 50)
  if (!store.recent) store.recent = [];
  store.recent.unshift({
    at: new Date().toISOString(),
    endpoint: endpoint || 'ai',
    modelKey: modelKey || model,
    model,
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    cost_usd: cost,
  });
  store.recent = store.recent.slice(0, 50);

  saveStore(store);

  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    cost_usd: cost,
    day_total_usd: d.cost_usd,
    day_calls: d.calls,
  };
}

function getSummary(daysBack = 7) {
  const store = loadStore();
  const days = [];
  const now = new Date();
  for (let i = 0; i < daysBack; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push(store.days[key] || emptyDay(key));
  }
  const today = store.days[todayKey()] || emptyDay(todayKey());
  const period = days.reduce(
    (acc, d) => {
      acc.calls += d.calls;
      acc.prompt_tokens += d.prompt_tokens;
      acc.completion_tokens += d.completion_tokens;
      acc.total_tokens += d.total_tokens;
      acc.cost_usd += d.cost_usd;
      return acc;
    },
    { calls: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0 }
  );
  period.cost_usd = Math.round(period.cost_usd * 1e6) / 1e6;

  return {
    success: true,
    today,
    period_days: daysBack,
    period,
    days,
    recent: store.recent || [],
    rates: RATES,
    store_path: STORE_PATH,
    updatedAt: store.updatedAt,
  };
}

function resetUsage() {
  const store = { days: {}, recent: [], updatedAt: new Date().toISOString() };
  saveStore(store);
  return { success: true };
}

module.exports = { recordUsage, getSummary, resetUsage, RATES, STORE_PATH };
