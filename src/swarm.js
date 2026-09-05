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
import { createTraderRunners } from "./agents/trader.js";
import { createMarket, getDexUrl, BASE_TOKENS } from "./trading/market.js";
import { createPaperBook } from "./trading/paper.js";
import { STRATEGIES } from "./trading/strategies.js";
import { assessSignal } from "./trading/risk.js";
import { summarizeLedger } from "./ledger.js";
import { TEMPLATES } from "./agents/templates.js";
import { listAllSkills } from "./skills/index.js";
import { connectMongoStore } from "./core/mongo.js";

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

  const market = createMarket({ fetchJson: fetcher.fetchJson });
  const book = createPaperBook({ store, config });
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
    reconciler: createReconcilerRunner({ store, config, evm }),
    ...createTraderRunners({ store, config, market, book, registry })
  });

  async function start() {
    if (config.mongoUri) {
      await connectMongoStore(store, config.mongoUri);
    }
    registry.recoverStale();
    // Oportunidades y trabajos que quedaron a medias en un arranque anterior vuelven a revisión.
    for (const opp of store.list("opportunities", (o) => o.status === "assigned")) {
      store.upsert("opportunities", { id: opp.id, status: "qualified", assignedAgentId: null });
    }

    // Las que cayeron a revisión sólo porque no había cupo de modelo vuelven a la cola.
    for (const opp of store.list("opportunities", (o) => o.status === "needs_review" && /429|quota|cuota|Sin cupo|credit balance|no credits|Proceso reiniciado/i.test(o.abandonReason ?? "") && (o.score ?? 0) >= config.policy.minScore)) {
      store.upsert("opportunities", { id: opp.id, status: "qualified", abandonReason: null });
    }
    for (const job of store.list("jobs", (j) => ["in_progress", "review", "submitting"].includes(j.status))) {
      if (job.changes?.length) {
        // El entregable ya está pagado: se conserva para revisión humana en vez de perderlo por el reinicio.
        store.upsert("jobs", { id: job.id, status: "ready_for_review", readyAt: new Date().toISOString(), note: "Proceso reiniciado antes del cierre; entregable conservado" });
        if (job.opportunityId) store.upsert("opportunities", { id: job.opportunityId, status: "ready_for_review", assignedAgentId: null });
      } else {
        store.upsert("jobs", { id: job.id, status: "failed", finishedAt: new Date().toISOString(), error: "Proceso reiniciado durante el trabajo" });
      }
    }
    for (const opp of store.list("opportunities", (o) => o.status === "working")) {
      const keptJob = store.list("jobs", (j) => j.opportunityId === opp.id && j.status === "ready_for_review")[0];
      if (keptJob) continue;
      store.upsert("opportunities", { id: opp.id, status: "needs_review", assignedAgentId: null, abandonReason: "Proceso reiniciado durante el trabajo" });
    }
    const manager = await registry.spawn({ template: "manager", goal: "Encontrar, ejecutar y cobrar trabajo en cripto dentro de las cuotas", requestedBy: "system" });
    if (config.trader.enabled) {
      await registry.spawn({ template: "trader", goal: `Operar ${config.trader.watchlist.join(", ")} con dinero real en DEX Base (${config.trader.mode})`, requestedBy: "system" })
        .catch((error) => store.audit({ type: "trader_not_started", error: error.message }));
    }
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
        lanUrl: config.lanUrl,
        lanIp: config.lanIp,
        tunnel: config.tunnel,
        autoSubmit: config.policy.autoSubmit,
        llmEnabled: llm.enabled,
        llmProvider: llm.primaryProvider,
        llmProviders: llm.providers,
        llmStatus: llm.status(),
        llmAvailable: llm.enabled ? llm.available("worker") : { ok: false, reason: "sin clave" },
        autoSubmitMode: config.policy.autoSubmitMode,
        maxJobCostUsd: config.policy.maxJobCostUsd,
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
      agents: store.list("agents").sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "")),
      opportunities: opportunities.sort((a, b) => (b.score ?? -1) - (a.score ?? -1)),
      jobs: store.list("jobs").sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")),
      ledger: ledger.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")),
      services: store.list("services", (s) => !s.hidden).map(({ system, ...s }) => s),
      trader: {
        enabled: config.trader.enabled,
        mode: config.trader.mode,
        watchlist: config.trader.watchlist,
        limits: { maxPositionPct: config.trader.maxPositionPct, maxExposurePct: config.trader.maxExposurePct, stopLossPct: config.trader.stopLossPct, takeProfitPct: config.trader.takeProfitPct, dailyLossLimitPct: config.trader.dailyLossLimitPct, feeRate: config.trader.feeRate, tickMinutes: config.trader.tickMs / 60_000 },
        strategies: STRATEGIES.map((x) => ({ id: x.id, label: x.label, description: x.description })),
        summary: book.summary(),
        market: (() => { const m = store.get("trading", "market"); return m ? { at: m.at, prices: m.prices, stats: m.stats, errors: m.errors } : null; })(),
        tokens: BASE_TOKENS,
        signals: store.list("signals").sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")).slice(0, 60),
        trades: store.list("trades").sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")).slice(0, 100),
        proposals: store.list("proposals").sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")).slice(0, 50),
        realizedDexProfitUsd: store.list("ledger", (l) => (l.agentId === "trader" || l.proposalId) && l.kind === "claimed").reduce((sum, l) => sum + (l.amount || 0), 0),
        x402SignalRevenueUsd: store.list("ledger", (l) => l.serviceSlug === "trading-signals" || l.serviceSlug === "dex-arbitrage" || l.note?.includes("trading-signals") || l.note?.includes("dex-arbitrage")).reduce((sum, l) => sum + (l.amount || 0), 0),
        payToAddress: config.x402.payTo,
        network: config.x402.network,
        networkLabel: config.x402.chain.label,
        backtest: store.get("trading", "backtest")
      },
      audit: store.state.audit.slice(-200).reverse(),
      auditIntegrity: store.verifyAudit(),
      skills: listAllSkills(),
      templates: Object.fromEntries(Object.entries(TEMPLATES).map(([k, v]) => [k, { label: v.label, description: v.description, capabilities: v.capabilities, skills: v.skills ?? [], spawnable: v.spawnable }]))
    };
  }

  async function triggerTraderScan() {
    const t = config.trader;
    const snapshotData = await market.snapshot(t.watchlist, t.granularity);
    if (!Object.keys(snapshotData.prices).length) {
      return { ok: false, error: "No se pudieron obtener precios de mercado" };
    }
    store.upsert("trading", { id: "market", ...snapshotData });
    book.markToMarket(snapshotData.prices);

    let signalsCount = 0;
    let proposalsCount = 0;
    const tickId = `${Date.now().toString(36)}`;

    for (const product of t.watchlist) {
      const candles = snapshotData.candles[product];
      const price = snapshotData.prices[product];
      if (!candles?.length || !price) continue;

      for (const strategy of STRATEGIES) {
        const result = strategy.signal(candles);
        if (result.action === "hold") continue;

        const signalDoc = store.upsert("signals", {
          tickId,
          product,
          strategyId: strategy.id,
          strategyLabel: strategy.label,
          price,
          ...result,
          status: "pending",
          at: snapshotData.at
        });
        signalsCount += 1;

        const verdict = assessSignal({ signal: signalDoc, book, prices: snapshotData.prices, config });
        if (verdict.approved) {
          store.upsert("signals", { id: signalDoc.id, status: "approved", riskReason: verdict.reason, sizeUsd: verdict.sizeUsd });

          const targetPrice = signalDoc.action === "buy" ? price * (1 + t.takeProfitPct) : price * (1 - t.takeProfitPct);
          const stopPrice = signalDoc.action === "buy" ? price * (1 - t.stopLossPct) : price * (1 + t.stopLossPct);
          const potentialGainUsd = Number((verdict.sizeUsd * t.takeProfitPct).toFixed(2));
          const potentialLossUsd = Number((verdict.sizeUsd * t.stopLossPct).toFixed(2));
          const dexUrl = getDexUrl(product);
          const tokenInfo = BASE_TOKENS[product] || null;

          store.upsert("proposals", {
            signalId: signalDoc.id,
            product,
            action: signalDoc.action,
            sizeUsd: verdict.sizeUsd,
            price,
            targetPrice: Number(targetPrice.toFixed(targetPrice < 1 ? 4 : 2)),
            stopPrice: Number(stopPrice.toFixed(stopPrice < 1 ? 4 : 2)),
            targetPct: Number((t.takeProfitPct * 100).toFixed(1)),
            stopPct: Number((t.stopLossPct * 100).toFixed(1)),
            potentialGainUsd,
            potentialLossUsd,
            riskReward: `${(t.takeProfitPct / t.stopLossPct).toFixed(1)}:1`,
            strategyLabel: signalDoc.strategyLabel,
            reason: signalDoc.reason,
            dexUrl,
            network: tokenInfo?.network || "Base (EIP-155:8453)",
            dexName: tokenInfo?.dexName || "Uniswap v3 (Base)",
            tokenAddress: tokenInfo?.address || null,
            status: "proposed",
            at: new Date().toISOString()
          });
          proposalsCount += 1;
        } else {
          store.upsert("signals", { id: signalDoc.id, status: "rejected", riskReason: verdict.reason });
        }
      }
    }

    store.audit({ type: "trader_scan_triggered", signalsCount, proposalsCount });
    return {
      ok: true,
      timestamp: new Date().toISOString(),
      prices: snapshotData.prices,
      stats: snapshotData.stats,
      signalsCount,
      proposalsCount
    };
  }

  return { config, store, llm, registry, sellerService, sources, start, snapshot, github, book, market, triggerTraderScan, evm };
}

function countBy(list, key) {
  return list.reduce((acc, item) => { acc[item[key]] = (acc[item[key]] ?? 0) + 1; return acc; }, {});
}
