/**
 * Fuente: issues de GitHub con recompensa (etiquetas bounty, Algora "💎 Bounty", comandos /bounty).
 * Usa la API pública de búsqueda; el token es opcional pero sube el límite de peticiones.
 */
const REWARD_PATTERNS = [
  /\/bounty\s+\$?\s*([\d,]+(?:\.\d+)?)\s*(k)?/i,
  /(?:bounty|reward|pledged?|funding|funded)[^$\d]{0,40}\$\s*([\d,]+(?:\.\d+)?)\s*(k)?/i,
  /\$\s*([\d,]+(?:\.\d+)?)\s*(k)?[^$\d]{0,40}(?:bounty|reward|pledged?|funding|funded)/i,
  /💎\s*[^$\d]{0,20}\$?\s*([\d,]+(?:\.\d+)?)\s*(k)?/i,
  /\$\s*([\d,]+(?:\.\d+)?)\s*(k)?\s*(?:usd|usdc|bounty|reward)/i,
  /([\d,]+(?:\.\d+)?)\s*(k)?\s*(usdc|usdt|dai|eth|sol|btc)\b/i
];

export function extractReward(text = "") {
  for (const pattern of REWARD_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      let amount = Number(match[1].replace(/,/g, ""));
      if (match[2] && String(match[2]).toLowerCase() === "k") {
        amount *= 1000;
      }
      if (Number.isFinite(amount) && amount > 0) {
        const assetMatch = match[3];
        const isAsset = assetMatch && ["USDC", "USDT", "DAI", "ETH", "SOL", "BTC"].includes(String(assetMatch).toUpperCase());
        const asset = isAsset ? String(assetMatch).toUpperCase() : "USD";
        return { amount, asset };
      }
    }
  }
  return null;
}

export function issueToOpportunity(issue) {
  const labels = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean);
  const text = `${issue.title}\n${issue.body ?? ""}\n${labels.join(" ")}`;
  let reward = extractReward(text);
  if (!reward && labels.some((l) => /bounty|reward|💎|polar|algora|opire/i.test(l))) {
    for (const label of labels) {
      const match = label.match(/^\$?\s*([\d,]+(?:\.\d+)?)\s*(k)?$/i);
      if (match) {
        let amount = Number(match[1].replace(/,/g, ""));
        if (match[2]?.toLowerCase() === "k") amount *= 1000;
        if (amount > 0) { reward = { amount, asset: "USD" }; break; }
      }
    }
  }
  const repo = issue.repository_url?.replace("https://api.github.com/repos/", "") ?? "";
  const riskFlags = [];
  if (/kyc|identity verification|passport/i.test(text)) riskFlags.push("kyc");
  if (/private key|seed phrase|connect (your )?wallet/i.test(text)) riskFlags.push("wallet_access");
  if (/install|download and run|execute (this|the) script/i.test(text)) riskFlags.push("run_foreign_code");
  return {
    externalId: `github:${repo}#${issue.number}`,
    source: "github",
    kind: "bounty",
    title: issue.title,
    url: issue.html_url,
    repo,
    number: issue.number,
    labels,
    expectedReward: reward,
    excerpt: (issue.body ?? "").slice(0, 1200),
    riskFlags,
    postedAt: issue.created_at,
    comments: issue.comments ?? 0,
    assignees: (issue.assignees ?? []).length,
    language: null,
    fetchedAt: new Date().toISOString()
  };
}

export function createGithubSource({ fetchJson, token, queries }) {
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (token) headers.Authorization = `Bearer ${token}`;

  async function discover({ perQuery = 30 } = {}) {
    const found = new Map();
    const errors = [];
    for (const query of queries) {
      const q = encodeURIComponent(`is:issue ${query}`);
      // Las consultas con "commenter:<bot>" identifican al pagador de forma no falsificable.
      const payerBot = (query.match(/commenter:([\w.-]+\[bot\])/) ?? [])[1] ?? null;
      const sort = payerBot ? "updated" : "created";
      try {
        const body = await fetchJson(`https://api.github.com/search/issues?q=${q}&sort=${sort}&order=desc&per_page=${perQuery}`, { headers });
        for (const issue of body.items ?? []) {
          if (issue.pull_request) continue;
          const opp = issueToOpportunity(issue);
          if (payerBot) opp.verifiedPayer = payerBot.replace("[bot]", "");
          const existing = found.get(opp.externalId);
          if (!existing) found.set(opp.externalId, opp);
          else if (opp.verifiedPayer && !existing.verifiedPayer) existing.verifiedPayer = opp.verifiedPayer;
        }
      } catch (error) {
        errors.push({ query, message: error.message });
      }
    }
    return { opportunities: [...found.values()], errors };
  }

  return { name: "github", discover, headers };
}
