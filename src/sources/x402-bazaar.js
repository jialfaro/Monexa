/**
 * Fuente: Bazaar x402 (Coinbase CDP). Lista servicios que otros agentes ya cobran con USDC.
 * Sirve como inteligencia de mercado: qué se paga, a qué precio y con cuánta demanda.
 */
export function resourceToOpportunity(item) {
  const accept = item.accepts?.[0] ?? {};
  const amountUsd = accept.amount ? Number(accept.amount) / 1e6 : null;
  const calls = item.quality?.l30DaysTotalCalls ?? 0;
  const payers = item.quality?.l30DaysUniquePayers ?? 0;
  return {
    externalId: `x402:${item.resource}`,
    source: "x402-bazaar",
    kind: "market",
    title: item.serviceName || item.description?.slice(0, 80) || item.resource,
    url: item.resource,
    excerpt: item.description ?? "",
    tags: item.tags ?? [],
    pricePerCallUsd: amountUsd,
    network: accept.network,
    payTo: accept.payTo,
    demand: { calls30d: calls, payers30d: payers, lastCalledAt: item.quality?.lastCalledAt ?? null },
    expectedReward: amountUsd && calls ? { amount: Number((amountUsd * calls).toFixed(2)), asset: "USD", basis: "ingresos 30d del vendedor listado" } : null,
    riskFlags: [],
    fetchedAt: new Date().toISOString()
  };
}

export function createBazaarSource({ fetchJson, url }) {
  async function discover({ limit = 100 } = {}) {
    try {
      const body = await fetchJson(`${url}?type=http&limit=${limit}&offset=0`);
      const opportunities = (body.items ?? []).map(resourceToOpportunity)
        .sort((a, b) => (b.demand.calls30d - a.demand.calls30d));
      return { opportunities, errors: [] };
    } catch (error) {
      return { opportunities: [], errors: [{ query: url, message: error.message }] };
    }
  }
  return { name: "x402-bazaar", discover };
}
