/** Peticiones salientes con lista de hosts permitidos, timeout y tamaño máximo. */
export function createFetcher({ allowedHosts, timeoutMs = 20_000, maxBytes = 2_000_000, userAgent = "Monexa-Agent/0.2" }) {
  const allowed = new Set(allowedHosts);

  async function fetchJson(url, options = {}) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
      throw new Error(`Sólo HTTPS: ${url}`);
    }
    if (!options.skipAllowlist && !allowed.has(parsed.hostname)) {
      throw new Error(`Host no permitido por política: ${parsed.hostname}`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: { "User-Agent": userAgent, Accept: "application/json", ...(options.headers ?? {}) }
      });
      const text = await response.text();
      if (text.length > maxBytes) throw new Error(`Respuesta demasiado grande de ${parsed.hostname}`);
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 2000) }; }
      if (!response.ok) {
        const error = new Error(`${response.status} ${response.statusText} en ${parsed.hostname}: ${JSON.stringify(body).slice(0, 300)}`);
        error.status = response.status;
        error.body = body;
        throw error;
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  return { fetchJson, allow: (host) => allowed.add(host) };
}
