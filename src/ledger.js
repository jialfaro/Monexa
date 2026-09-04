/**
 * Ledger: distingue siempre entre lo estimado, lo reclamado y lo verificado en cadena.
 * kinds: expected | claimed | received_onchain | cost
 */
export function summarizeLedger(entries, opportunities = []) {
  const byAsset = {};
  const bump = (asset, key, amount) => {
    byAsset[asset] ??= { expected: 0, claimed: 0, verified: 0, cost: 0 };
    byAsset[asset][key] += amount;
  };
  for (const entry of entries) {
    const asset = entry.asset ?? "USD";
    if (entry.kind === "expected") bump(asset, "expected", entry.amount);
    else if (entry.kind === "claimed") bump(asset, "claimed", entry.amount);
    else if (entry.kind === "received_onchain") bump(asset, "verified", entry.amount);
    else if (entry.kind === "cost") bump(asset, "cost", entry.amount);
  }
  const verifiedUsd = Object.entries(byAsset).filter(([asset]) => ["USD", "USDC"].includes(asset)).reduce((s, [, v]) => s + v.verified, 0);
  const costUsd = Object.entries(byAsset).filter(([asset]) => ["USD", "USDC"].includes(asset)).reduce((s, [, v]) => s + v.cost, 0);
  const pipelineUsd = opportunities.filter((o) => ["qualified", "assigned", "working", "submitted", "ready_for_review"].includes(o.status))
    .reduce((s, o) => s + (o.expectedReward && ["USD", "USDC"].includes(o.expectedReward.asset) ? o.expectedReward.amount : 0), 0);
  return { byAsset, verifiedUsd, costUsd, netUsd: verifiedUsd - costUsd, pipelineUsd };
}
