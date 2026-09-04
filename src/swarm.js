import { resolve } from "node:path";
import { buildConfig, loadDotEnv } from "./core/config.js";
import { createStore } from "./core/store.js";
import { createLlm } from "./core/llm.js";
import { createFetcher } from "./core/http.js";
import { createEvmReader } from "./chain/evm.js";
import { createFacilitator } from "./x402/server.js";
import { createGithubSource } from "./sources/github-bounties.js";
import { createBazaarSource } from "./sources/x402-bazaar.js";
import { createJsonFeedSource } from "./sources/json-feed.js";
import { createGithubTools } from "./agents/github-tools.js";
import { createRegistry } from "./agents/registry.js";
import { createScoutRunner } from "./agents/scout.js";
import { createEvaluatorRunner } from "./agents/evaluator.js";
import { createWorkerRunner, createReviewerRunner } from "./agents/worker.js";
import { createSellerService, createSellerRunner } from "./agents/seller.js";
import { createReconcilerRunner } from "./agents/reconciler.js";
import { createManagerRunner } from "./agents/manager.js";
import { summarizeLedger } from "./ledger.js";
import { TEMPLATES } from "./agents/templates.js";

/** Ensambla el enjambre completo a partir de la configuración. */
export function createSwarm({ rootDirectory, env = process.env, statePath } = {}) {
  if (rootDirectory) loadDotEnv(rootDirectory);
  const config = buildConfig(env);
  const store = createStore(statePath ?? (rootDirectory ? resolve(rootDirectory, "data/state.json") : null));
  const llm = createLlm({ config, store });
  const fetcher = createFetcher({ allowedHosts: config.policy.allowedSourceHosts });
  for (const feed of config.extraFeeds) fetcher.allow(new URL(feed).hostname);
  const evm = createEvmReader({ rpcUrl: config.x402.chain.rpcUrl, usdc: config.x402.chain.usdc });
  const facilitator = createFacilitator({ url: config.x402.facilitatorUrl, authHeader: config.x402.facilitatorAuth });
  const github = createGithubTools({ fetchJson: fetcher.fetchJson, token: config.github.token });

  const sources = [
    createGithubSource({ fetchJson: fetcher.fetchJson, token: config.github.token, queries: config.github.queries }),
    createBazaarSource({ fetchJson: fetcher.fetchJson, url: config.x402.bazaarUrl }),
    ...config.extraFeeds.map((url) => createJsonFeedSource({ fetchJson: fetcher.fetchJson, url }))
  ];

  const runners = {};
  const registry = createRegistry({ store, config, runners });
  const sellerService = createSellerService({ store, llm, config, facilitator, registry });
  Object.assign(runners, {
    manager: createManagerRunner({ store, config, llm, registry, sources }),
    scout: createScoutRunner({ store, sources }),
    evaluator: createEvaluatorRunner({ store, llm, config, github }),
    worker: createWorkerRunner({ store, llm, config, github, registry }),
    reviewer: createReviewerRunner({ store, llm }),
    seller: createSellerRunner({ store, config, llm, sellerService }),
    reconciler: createReconcilerRunner({ store, config, evm })
  });

  async function start() {
    registry.recoverStale();
    // Oportunidades y trabajos que quedaron a medias en un arranque anterior vuelven a revisión.
    for (const opp of store.list("opportunities", (o) => o.status === "assigned")) {
      store.upsert("opportunities", { id: opp.id, status: "qualified", assignedAgentId: null });
    }
    for (const opp of store.list("opportunities", (o) => o.status === "working")) {
      store.upsert("opportunities", { id: opp.id, status: "needs_review", assignedAgentId: null, abandonReason: "Proceso reiniciado durante el trabajo" });
    }
    for (const job of store.list("jobs", (j) => ["in_progress", "review", "submitting"].includes(j.status))) {
      store.upsert("jobs", { id: job.id, status: "failed", finishedAt: new Date().toISOString(), error: "Proceso reiniciado durante el trabajo" });
    }
    const manager = await registry.spawn({ template: "manager", goal: "Encontrar, ejecutar y cobrar trabajo en cripto dentro de las cuotas", requestedBy: "system" });
    return manager;
  }

  function snapshot() {
    const opportunities = store.list("opportunities");
    const ledger = store.list("ledger");
    const snapshotService = store.list("services", (s) => s.slug === "_snapshot")[0] ?? null;
    return {
      now: new Date().toISOString(),
      config: {
        network: config.x402.network,
        chain: config.x402.chain.label,
        explorer: config.x402.chain.explorer,
        payTo: config.x402.payTo,
        publicUrl: config.publicUrl,
        tunnel: config.tunnel,
        autoSubmit: config.policy.autoSubmit,
        llmEnabled: llm.enabled,
        llmProvider: llm.primaryProvider,
        llmProviders: llm.providers,
        githubToken: Boolean(config.github.token),
        workerModel: llm.providers[0]?.worker ?? null,
        scoutModel: llm.providers[0]?.scout ?? null,
        dailyBudgetUsd: config.anthropic.dailyBudgetUsd,
        quotas: { maxAgents: config.policy.maxAgents, maxDepth: config.policy.maxDepth, maxChildrenPerAgent: config.policy.maxChildrenPerAgent, maxConcurrentWorkers: config.policy.maxConcurrentWorkers }
      },
      metrics: {
        ...summarizeLedger(ledger, opportunities),
        llmSpentTodayUsd: llm.spentTodayUsd(),
        activeAgents: registry.active().length,
        totalAgents: store.list("agents").length,
        opportunities: countBy(opportunities, "status"),
        jobs: countBy(store.list("jobs"), "status"),
        chainBalanceUsdc: snapshotService?.balanceUsdc ?? null,
        chainCheckedAt: snapshotService?.checkedAt ?? null
      },
      agentsTree: registry.tree(),
      agents: store.list("agents").sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
      opportunities: opportunities.sort((a, b) => (b.score ?? -1) - (a.score ?? -1)),
      jobs: store.list("jobs").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      ledger: ledger.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      services: store.list("services", (s) => !s.hidden).map(({ system, ...s }) => s),
      audit: store.state.audit.slice(-200).reverse(),
      auditIntegrity: store.verifyAudit(),
      templates: Object.fromEntries(Object.entries(TEMPLATES).map(([k, v]) => [k, { label: v.label, description: v.description, capabilities: v.capabilities, spawnable: v.spawnable }]))
    };
  }

  return { config, store, llm, registry, sellerService, sources, start, snapshot, github };
}

function countBy(list, key) {
  return list.reduce((acc, item) => { acc[item[key]] = (acc[item[key]] ?? 0) + 1; return acc; }, {});
}
