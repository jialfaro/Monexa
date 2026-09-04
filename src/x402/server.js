/**
 * Lado vendedor del protocolo x402 v2: responde 402 con requisitos de pago, verifica y liquida
 * con un facilitador externo. El agente sólo necesita una dirección pública de cobro (payTo).
 */
export function encodeHeader(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function decodeHeader(value) {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}

export function usdToAtomic(usd) {
  return String(Math.round(usd * 1e6));
}

export function buildPaymentRequired({ resourceUrl, description, mimeType = "application/json", network, asset, payTo, amountUsd, serviceName, tags = [], inputSchema, outputExample, maxTimeoutSeconds = 60 }) {
  const extensions = {};
  if (inputSchema || outputExample) {
    extensions.bazaar = {
      info: { input: { type: "http", method: "POST", bodyType: "json", bodySchema: inputSchema }, output: { example: outputExample } },
      schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" }
    };
  }
  return {
    x402Version: 2,
    resource: { url: resourceUrl, description, mimeType, serviceName: serviceName?.slice(0, 32), tags: tags.slice(0, 5) },
    accepts: [{
      scheme: "exact",
      network,
      amount: usdToAtomic(amountUsd),
      asset,
      payTo,
      maxTimeoutSeconds,
      extra: { name: "USDC", version: "2" }
    }],
    extensions
  };
}

export function createFacilitator({ url, authHeader = "", fetchImpl = fetch }) {
  async function post(path, body) {
    const response = await fetchImpl(`${url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(authHeader ? { Authorization: authHeader } : {}) },
      body: JSON.stringify(body)
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Facilitador ${path} respondió ${response.status}: ${JSON.stringify(json).slice(0, 300)}`);
    return json;
  }
  return {
    verify: (paymentPayload, paymentRequirements) => post("/verify", { x402Version: 2, paymentPayload, paymentRequirements }),
    settle: (paymentPayload, paymentRequirements) => post("/settle", { x402Version: 2, paymentPayload, paymentRequirements }),
    supported: async () => {
      const response = await fetchImpl(`${url}/supported`, { headers: authHeader ? { Authorization: authHeader } : {} });
      return response.json();
    }
  };
}

/** Extrae el payload de pago de la petición (v2 PAYMENT-SIGNATURE, v1 X-PAYMENT). */
export function readPaymentHeader(headers) {
  const raw = headers["payment-signature"] ?? headers["x-payment"];
  if (!raw) return null;
  try { return decodeHeader(String(raw)); } catch { return { invalid: true }; }
}

/**
 * Gestiona una petición a un recurso de pago. Devuelve { status, headers, body }.
 * `handler(input)` produce el resultado sólo tras verificar el pago; la liquidación ocurre antes de responder.
 */
export async function handlePaidRequest({ requirements, paymentPayload, facilitator, handler, input }) {
  const paymentRequired = requirements;
  const requirement = paymentRequired.accepts[0];
  if (!paymentPayload) {
    return { status: 402, headers: { "PAYMENT-REQUIRED": encodeHeader(paymentRequired) }, body: paymentRequired };
  }
  if (paymentPayload.invalid) {
    return { status: 402, headers: { "PAYMENT-REQUIRED": encodeHeader({ ...paymentRequired, error: "Cabecera de pago ilegible" }) }, body: { ...paymentRequired, error: "Cabecera de pago ilegible" } };
  }
  const verification = await facilitator.verify(paymentPayload, requirement);
  if (!verification.isValid) {
    const error = verification.invalidReason ?? verification.error ?? "Pago inválido";
    return { status: 402, headers: { "PAYMENT-REQUIRED": encodeHeader({ ...paymentRequired, error }) }, body: { ...paymentRequired, error } };
  }
  const result = await handler(input, { payer: verification.payer });
  const settlement = await facilitator.settle(paymentPayload, requirement);
  if (!settlement.success) {
    return { status: 402, headers: {}, body: { ...paymentRequired, error: settlement.errorReason ?? "No se pudo liquidar el pago" } };
  }
  return {
    status: 200,
    headers: { "PAYMENT-RESPONSE": encodeHeader(settlement) },
    body: result,
    settlement: { ...settlement, payer: settlement.payer ?? verification.payer, amountAtomic: requirement.amount }
  };
}
