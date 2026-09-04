import { createAnthropicProvider } from "./providers/anthropic.js";
import { createOpenAiProvider } from "./providers/openai.js";
import { createGeminiProvider } from "./providers/gemini.js";

/**
 * Cliente de modelos compartido por los agentes. Soporta Anthropic, OpenAI y Gemini con un formato interno común,
 * registra uso y coste por agente, corta al superar el presupuesto diario y conmuta de proveedor si uno falla.
 */
export const PRICES_PER_MTOK = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-fable-5-1": { input: 10, output: 50 },
  "gpt-5": { input: 1.25, output: 10 },
  "gpt-5-mini": { input: 0.25, output: 2 },
  "gpt-5-nano": { input: 0.05, output: 0.4 },
  "gpt-4.1": { input: 2, output: 8 },
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 }
};

const PROVIDER_DEFAULTS = {
  anthropic: { worker: "claude-opus-5", scout: "claude-sonnet-5" },
  openai: { worker: "gpt-5", scout: "gpt-5-mini" },
  gemini: { worker: "gemini-3.8-flash", scout: "gemini-3.5-flash-lite" }
};

export function buildProviders(llmConfig) {
  const providers = [];
  if (llmConfig.anthropicKey) providers.push(createAnthropicProvider({ apiKey: llmConfig.anthropicKey, defaults: PROVIDER_DEFAULTS.anthropic }));
  if (llmConfig.openaiKey) providers.push(createOpenAiProvider({ apiKey: llmConfig.openaiKey, defaults: PROVIDER_DEFAULTS.openai }));
  if (llmConfig.geminiKey) providers.push(createGeminiProvider({ apiKey: llmConfig.geminiKey, defaults: PROVIDER_DEFAULTS.gemini }));
  const preferred = llmConfig.provider && llmConfig.provider !== "auto" ? llmConfig.provider : null;
  if (preferred) {
    const index = providers.findIndex((p) => p.name === preferred);
    if (index === -1) throw new Error(`LLM_PROVIDER=${preferred} pero no hay clave configurada para ese proveedor`);
    providers.unshift(...providers.splice(index, 1));
  }
  return providers;
}

export function createLlm({ config, store, providers = buildProviders(config.anthropic), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const settings = config.anthropic;
  const primary = providers[0] ?? null;
  // Enfriamiento por proveedor: tras un 429 nadie vuelve a llamar hasta que pase el tiempo indicado.
  const cooldown = new Map();
  const MAX_ATTEMPTS = settings.maxAttempts ?? 5;

  function spentTodayUsd() {
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    return store.usageSince(dayStart.toISOString()).reduce((sum, u) => sum + (u.costUsd ?? 0), 0);
  }

  function assertBudget() {
    const spent = spentTodayUsd();
    if (spent >= settings.dailyBudgetUsd) {
      throw new Error(`Presupuesto diario de LLM agotado (${spent.toFixed(2)} USD de ${settings.dailyBudgetUsd}).`);
    }
  }

  function record(agentId, provider, model, usage) {
    const price = priceFor(model);
    const inputTokens = (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0);
    const outputTokens = usage?.output_tokens ?? 0;
    const costUsd = (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
    store.addUsage({ agentId, provider, model, inputTokens, outputTokens, costUsd });
    return costUsd;
  }

  /** Modelo a usar para un rol ("worker" | "scout") en un proveedor concreto. */
  function modelFor(provider, role) {
    const configured = role === "scout" ? settings.scoutModel : settings.workerModel;
    if (configured && provider === primary) return configured;
    return provider.defaults[role];
  }

  /**
   * Llamada de texto o con herramientas. `role` elige el modelo (worker: capaz; scout: barato).
   * Si el proveedor principal falla por un error de red, cuota o servidor, se intenta con el siguiente configurado.
   */
  async function complete({ agentId, role = "worker", model, system, messages, tools, maxTokens = 16000, effort = "high", onFallback = () => {} }) {
    if (!primary) throw new Error("Sin clave de modelo (ANTHROPIC_API_KEY, OPENAI_API_KEY o GEMINI_API_KEY): el agente no puede razonar.");
    assertBudget();
    let lastError = null;
    for (const provider of settings.fallback ? providers : [primary]) {
      const chosenModel = model && provider === primary ? model : modelFor(provider, role);
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const wait = (cooldown.get(provider.name) ?? 0) - Date.now();
        if (wait > 0) await sleep(wait);
        try {
          const response = await provider.complete({ model: chosenModel, system, messages, tools, maxTokens, effort });
          const costUsd = record(agentId, provider.name, chosenModel, response.usage);
          return { response, costUsd, provider: provider.name, model: chosenModel };
        } catch (error) {
          lastError = error;
          const kind = classifyError(error);
          if (kind === "rate_limit" && attempt < MAX_ATTEMPTS) {
            const delayMs = retryDelayMs(error, attempt);
            cooldown.set(provider.name, Date.now() + delayMs);
            onFallback({ provider: provider.name, model: chosenModel, error: `límite de velocidad, reintento ${attempt}/${MAX_ATTEMPTS - 1} en ${Math.round(delayMs / 1000)} s`, retry: true });
            continue;
          }
          if (kind === "fatal") throw error;
          onFallback({ provider: provider.name, model: chosenModel, error: error.message });
          break;
        }
      }
    }
    throw lastError;
  }

  function textOf(response) {
    return response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  }

  function parseJson(text) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenced ? fenced[1] : text;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("La respuesta del modelo no contiene JSON.");
    return JSON.parse(candidate.slice(start, end + 1));
  }

  return {
    enabled: Boolean(primary),
    providers: providers.map((p) => ({ name: p.name, worker: modelFor(p, "worker"), scout: modelFor(p, "scout") })),
    primaryProvider: primary?.name ?? null,
    complete, textOf, parseJson, spentTodayUsd, PRICES_PER_MTOK
  };
}

/** Precio por modelo exacto o, si no está tabulado, por familia. */
export function priceFor(model) {
  if (PRICES_PER_MTOK[model]) return PRICES_PER_MTOK[model];
  if (/^gemini/.test(model)) return /lite/.test(model) ? { input: 0.1, output: 0.4 } : /pro/.test(model) ? { input: 1.25, output: 10 } : { input: 0.3, output: 2.5 };
  if (/^gpt|^o\d/.test(model)) return /nano/.test(model) ? { input: 0.05, output: 0.4 } : /mini/.test(model) ? { input: 0.25, output: 2 } : { input: 1.25, output: 10 };
  if (/^claude/.test(model)) return /haiku/.test(model) ? { input: 1, output: 5 } : /sonnet/.test(model) ? { input: 2, output: 10 } : { input: 5, output: 25 };
  return { input: 5, output: 25 };
}

/**
 * rate_limit: esperar y reintentar con el mismo proveedor (429 por velocidad, 5xx, red).
 * switch: pasar al siguiente proveedor (sin saldo, cuota diaria agotada, clave inválida).
 * fatal: no reintentar (petición mal formada).
 */
export function classifyError(error) {
  const message = error.message ?? "";
  const status = error.status ?? Number((message.match(/\b(4\d\d|5\d\d)\b/) ?? [])[1]);
  if (/no credits|credit balance|billing|insufficient|free_tier|per day|daily|exceeded your current quota/i.test(message)) return "switch";
  if ([401, 403].includes(status)) return "switch";
  if (status === 429 || /rate limit|too many requests|high demand|overloaded/i.test(message)) return "rate_limit";
  if (status >= 500 || /ECONNRESET|ETIMEDOUT|fetch failed|socket/i.test(message)) return "rate_limit";
  if ([400, 404, 422].includes(status)) return "fatal";
  return "switch";
}

export function retryDelayMs(error, attempt) {
  const hinted = (error.message ?? "").match(/try again in (\d+(?:\.\d+)?)\s*(ms|s|m)/i);
  if (hinted) {
    const n = Number(hinted[1]);
    const ms = hinted[2] === "ms" ? n : hinted[2] === "m" ? n * 60_000 : n * 1000;
    return Math.min(120_000, Math.max(1000, ms + 1000));
  }
  return Math.min(120_000, 5000 * 2 ** (attempt - 1));
}
