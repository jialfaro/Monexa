import { contentHash } from "../core/store.js";

export function createScoutRunner({ store, sources }) {
  return async function scout(ctx) {
    const wanted = ctx.input.sourceName ? sources.filter((s) => s.name === ctx.input.sourceName) : sources;
    let created = 0;
    let refreshed = 0;
    const errors = [];
    for (const source of wanted) {
      if (ctx.signal.aborted) break;
      ctx.log(`Explorando ${source.name}…`);
      const result = await source.discover();
      errors.push(...result.errors);
      for (const opp of result.opportunities) {
        const existing = store.list("opportunities", (o) => o.externalId === opp.externalId)[0];
        const evidenceHash = contentHash({ title: opp.title, excerpt: opp.excerpt, reward: opp.expectedReward });
        if (existing) {
          store.upsert("opportunities", { id: existing.id, ...opp, verifiedPayer: opp.verifiedPayer ?? existing.verifiedPayer ?? null, status: existing.status, score: existing.score, evaluation: existing.evaluation, evidenceHash, discoveredBy: existing.discoveredBy });
          refreshed += 1;
        } else {
          store.upsert("opportunities", { ...opp, status: "discovered", score: null, evaluation: null, assignedAgentId: null, evidenceHash, discoveredBy: ctx.agent.id });
          created += 1;
        }
      }
      ctx.log(`${source.name}: ${result.opportunities.length} hallazgos (${result.errors.length} errores)`);
      for (const error of result.errors) ctx.log(`Fuente ${source.name}: ${error.message}`, { level: "warn" });
    }
    store.audit({ type: "scout_completed", agentId: ctx.agent.id, created, refreshed, errors: errors.length });
    return { summary: `${created} oportunidades nuevas, ${refreshed} actualizadas`, created, refreshed, errors };
  };
}
