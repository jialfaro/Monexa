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
  "gpt-5.6-luna": { input: 0.2, output: 1.2 },
  "gpt-4.1": { input: 2, output: 8 },
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 }
};

const PROVIDER_DEFAULTS = {
  anthropic: { worker: "claude-opus-5", scout: "claude-sonnet-5" },
  openai: { worker: "gpt-5", scout: "gpt-5-nano" },
  gemini: { worker: "gemini-3.8-flash", scout: "gemini-3.5-flash-lite" }
};

export function buildProviders(llmConfig) {
  const providers = [];
  if (llmConfig.anthropicKey) providers.push(createAnthropicProvider({ apiKey: llmConfig.anthropicKey, defaults: PROVIDER_DEFAULTS.anthropic }));
  if (llmConfig.openaiKey) providers.push(createOpenAiProvider({ apiKey: llmConfig.openaiKey, defaults: PROVIDER_DEFAULTS.openai, serviceTier: llmConfig.openaiServiceTier || "" }));
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
  // Indisponibilidad larga (cupo diario agotado, sin saldo, clave inválida) por proveedor o por proveedor:modelo.
  const unavailable = new Map();
  const MAX_ATTEMPTS = settings.maxAttempts ?? 5;
  const now = () => Date.now();

  function markUnavailable(key, ms, reason) {
    unavailable.set(key, { until: now() + ms, reason: String(reason).slice(0, 200) });
  }
  function isUnavailable(key) {
    const entry = unavailable.get(key);
    if (!entry) return false;
    if (entry.until <= now()) { unavailable.delete(key); return false; }
    return true;
  }
  /** Modelos candidatos en un proveedor para un rol: el configurado y, como reserva, el modelo barato del proveedor. */
  function candidateModels(provider, role, explicit) {
    const first = explicit && provider === primary ? explicit : modelFor(provider, role);
    const list = role === "worker" ? [first, provider.defaults.scout] : [first];
    return [...new Set(list.filter(Boolean))];
  }

  function spentTodayUsd() {
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    return store.usageSince(dayStart.toISOString()).reduce((sum, u) => sum + (u.costUsd ?? 0), 0);
  }

  function assertBudget() {
    const spent = spentTodayUsd();
    if (spent >= settings.dailyBudgetUsd) {
      const error = new Error(`Presupuesto diario de LLM agotado (${spent.toFixed(2)} USD de ${settings.dailyBudgetUsd}).`);
      error.code = "LLM_UNAVAILABLE"; // fallo de infraestructura: la oportunidad vuelve a la cola, no a revisión
      const reset = new Date(); reset.setUTCHours(24, 0, 0, 0);
      error.retryAt = reset.getTime();
      throw error;
    }
  }

  function record(agentId, provider, model, usage) {
    const price = priceFor(model);
    // OpenAI y Gemini incluyen los tokens cacheados dentro de input_tokens; Anthropic los reporta aparte.
    const cachedRead = (usage?.cache_read_input_tokens ?? 0) + (usage?.cached_tokens ?? 0);
    const cacheWrite = usage?.cache_creation_input_tokens ?? 0;
    const fresh = Math.max(0, (usage?.input_tokens ?? 0) - (usage?.cached_tokens ?? 0));
    const inputTokens = fresh + cachedRead + cacheWrite;
    const outputTokens = usage?.output_tokens ?? 0;
    let costUsd = (fresh * price.input + cachedRead * price.input * 0.1 + cacheWrite * price.input * 1.25 + outputTokens * price.output) / 1_000_000;
    if (provider === "gemini" && settings.geminiFreeTier) costUsd = 0; // el nivel gratuito de Gemini no factura
    store.addUsage({ agentId, provider, model, inputTokens, cachedTokens: cachedRead, outputTokens, costUsd });
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
  async function complete({ agentId, role = "worker", model, system, messages, tools, maxTokens = 16000, effort = "high", onlyProvider = null, onFallback = () => {} }) {
    if (!primary) throw new Error("Sin clave de modelo (ANTHROPIC_API_KEY, OPENAI_API_KEY o GEMINI_API_KEY): el agente no puede razonar.");
    assertBudget();
    let lastError = null;
    // Una conversación con herramientas no puede cambiar de proveedor a mitad (ids y firmas incompatibles): onlyProvider la fija.
    const pool = onlyProvider ? providers.filter((p) => p.name === onlyProvider) : settings.fallback ? providers : [primary];
    providerLoop:
    for (const provider of pool) {
      if (isUnavailable(provider.name)) { lastError = lastError ?? unavailableError(); continue; }
      for (const chosenModel of candidateModels(provider, role, model)) {
        if (isUnavailable(`${provider.name}:${chosenModel}`)) continue;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
          const wait = (cooldown.get(provider.name) ?? 0) - now();
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
              cooldown.set(provider.name, now() + delayMs);
              onFallback({ provider: provider.name, model: chosenModel, error: `límite de velocidad, reintento ${attempt}/${MAX_ATTEMPTS - 1} en ${Math.round(delayMs / 1000)} s`, retry: true });
              continue;
            }
            if (kind === "fatal") throw error;
            if (kind === "quota") {
              // Cupo diario del modelo agotado: se prueba el modelo de reserva del mismo proveedor.
              markUnavailable(`${provider.name}:${chosenModel}`, unavailableDelayMs(error), error.message);
              onFallback({ provider: provider.name, model: chosenModel, error: `cupo agotado (${error.message.slice(0, 90)}); probando otro modelo o proveedor` });
              break;
            }
            // switch: sin saldo o clave inválida → todo el proveedor fuera durante un tiempo.
            markUnavailable(provider.name, unavailableDelayMs(error), error.message);
            onFallback({ provider: provider.name, model: chosenModel, error: error.message });
            continue providerLoop;
          }
        }
      }
    }
    if (!lastError || classifyError(lastError) !== "fatal") {
      const error = unavailableError(lastError);
      throw error;
    }
    throw lastError;
  }

  function unavailableError(cause) {
    const soonest = soonestAvailableAt();
    const error = new Error(`Sin cupo de modelo disponible${soonest ? ` hasta ${new Date(soonest).toISOString()}` : ""}${cause ? `: ${cause.message.slice(0, 160)}` : ""}`);
    error.code = "LLM_UNAVAILABLE";
    error.retryAt = soonest;
    return error;
  }

  function soonestAvailableAt() {
    let soonest = null;
    for (const [, entry] of unavailable) if (entry.until > now() && (soonest === null || entry.until < soonest)) soonest = entry.until;
    return soonest;
  }

  /** ¿Hay algún proveedor y modelo utilizable ahora mismo para el rol? */
  function available(role = "worker") {
    if (!primary) return { ok: false, reason: "sin clave de modelo", retryAt: null };
    for (const provider of settings.fallback ? providers : [primary]) {
      if (isUnavailable(provider.name)) continue;
      for (const m of candidateModels(provider, role)) if (!isUnavailable(`${provider.name}:${m}`)) return { ok: true, provider: provider.name, model: m };
    }
    return { ok: false, reason: "cupos agotados o sin saldo en todos los proveedores", retryAt: soonestAvailableAt() };
  }

  /** Olvida una indisponibilidad (o todas) para volver a intentar ahora mismo. */
  function reset(key = null) {
    if (key) { unavailable.delete(key); cooldown.delete(key.split(":")[0]); return 1; }
    const count = unavailable.size;
    unavailable.clear();
    cooldown.clear();
    return count;
  }

  function status() {
    const t = now();
    return [...unavailable.entries()].filter(([, e]) => e.until > t).map(([key, e]) => ({ key, until: new Date(e.until).toISOString(), reason: e.reason }));
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
    complete, textOf, parseJson, spentTodayUsd, available, status, reset, PRICES_PER_MTOK
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
  if (error.code === "LLM_UNAVAILABLE") return "switch";
  const status = error.status ?? Number((message.match(/\b(4\d\d|5\d\d)\b/) ?? [])[1]);
  if (/no credits|credit balance|billing|insufficient/i.test(message)) return "switch";
  const hint = retryHintMs(error);
  // Un cupo que se libera en menos de 5 minutos es de velocidad, no diario, aunque el texto diga "quota".
  if (status === 429 && hint !== null && hint < 300_000 && !error.perDay && !/per day|RPD/i.test(message)) return "rate_limit";
  if (error.perDay || /per day|RPD|daily|free_tier|exceeded your current quota/i.test(message)) return "quota";
  if ([401, 403].includes(status)) return "switch";
  if (status === 429 || /rate limit|too many requests|high demand|overloaded/i.test(message)) return "rate_limit";
  if (status >= 500 || /ECONNRESET|ETIMEDOUT|fetch failed|socket/i.test(message)) return "rate_limit";
  if ([400, 404, 422].includes(status)) return "fatal";
  return "switch";
}

/** Tiempo de espera sugerido por el proveedor (cabecera, details o texto), o null. */
export function retryHintMs(error) {
  if (Number.isFinite(error.retryAfterMs)) return error.retryAfterMs;
  const message = error.message ?? "";
  const m = message.match(/(?:try again|retry) in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)\s*(ms|s))?/i);
  if (!m || !(m[1] || m[2] || m[3])) return null;
  const secs = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + (m[4] === "ms" ? Number(m[3] ?? 0) / 1000 : Number(m[3] ?? 0));
  return Math.round(secs * 1000);
}

/** Cuánto tiempo dejar fuera un modelo/proveedor tras un error de cupo o saldo. */
export function unavailableDelayMs(error) {
  const message = error.message ?? "";
  const hint = retryHintMs(error);
  if (hint !== null && hint > 0) return Math.min(24 * 3600_000, Math.max(60_000, hint + 30_000));
  const m = message.match(/try again in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/i);
  if (m && (m[1] || m[2] || m[3])) {
    const ms = (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1000;
    return Math.min(24 * 3600_000, Math.max(60_000, ms + 30_000));
  }
  if (/per day|RPD|daily|free_tier/i.test(message)) return 6 * 3600_000;
  if (/no credits|credit balance|billing|insufficient/i.test(message)) return 12 * 3600_000;
  return 3600_000;
}

export function retryDelayMs(error, attempt) {
  const hint = retryHintMs(error);
  if (hint !== null && hint > 0) return Math.min(120_000, Math.max(1000, hint + 1000));
  return Math.min(120_000, 5000 * 2 ** (attempt - 1));
}
