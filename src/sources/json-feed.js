import { extractReward } from "./github-bounties.js";

/**
 * Fuente genérica: cualquier URL HTTPS que devuelva JSON con una lista de trabajos.
 * Se aceptan formas {items:[...]}, {bounties:[...]}, {data:[...]} o un arreglo directo.
 * Campos reconocidos: title, url|link|html_url, description|body, reward|amount, asset|currency, tags|labels.
 */
export function feedItemToOpportunity(item, feedUrl) {
  const url = item.html_url ?? item.url ?? item.link ?? feedUrl;
  const amount = Number(item.reward ?? item.amount ?? item.rewardAmount);
  let expectedReward = null;
  if (Number.isFinite(amount) && amount > 0) {
    expectedReward = { amount, asset: String(item.asset ?? item.currency ?? "USD").toUpperCase() };
  } else {
    expectedReward = extractReward(`${item.title ?? ""}\n${item.body ?? item.description ?? ""}`);
  }
  const tags = item.tags ?? (item.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean);
  return {
    externalId: `feed:${new URL(feedUrl).hostname}:${item.id ?? url}`,
    source: `feed:${new URL(feedUrl).hostname}`,
    kind: "bounty",
    title: String(item.title ?? item.name ?? "Sin título").slice(0, 200),
    url,
    excerpt: String(item.description ?? item.body ?? "").slice(0, 1200),
    tags,
    expectedReward,
    riskFlags: [],
    fetchedAt: new Date().toISOString()
  };
}

export function createJsonFeedSource({ fetchJson, url }) {
  async function discover() {
    try {
      const body = await fetchJson(url);
      const list = Array.isArray(body) ? body : body.items ?? body.bounties ?? body.data ?? [];
      return { opportunities: list.map((item) => feedItemToOpportunity(item, url)), errors: [] };
    } catch (error) {
      return { opportunities: [], errors: [{ query: url, message: error.message }] };
    }
  }
  return { name: `feed:${new URL(url).hostname}`, discover };
}
