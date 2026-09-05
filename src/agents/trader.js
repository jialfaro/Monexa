import { STRATEGIES, strategyById } from "../trading/strategies.js";
import { assessSignal } from "../trading/risk.js";
import { getDexUrl, BASE_TOKENS } from "../trading/market.js";

/**
 * Apartado Trader: un manager de trading que en cada ciclo crea agentes especializados:
 * market-scout → strategy-analyst (uno por estrategia) → risk-manager → dex-executor.
 * Operaciones con dinero real en DEX; en modo "real" / "proposal" las órdenes quedan como propuestas verificadas para Uniswap v3 / Aerodrome en Base con liquidación en ledger on-chain.
 */
export function createTraderRunners({ store, config, market, book, registry }) {
  const t = config.trader;
  const sleep = (ms, signal) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });

  async function traderManager(ctx) {
    ctx.log(`Trader iniciado en modo ${t.mode} · capital de trading ${t.tradingCapitalUsd || t.paperStartUsd} USD · ${t.watchlist.join(", ")} · velas ${t.granularity}s`);
    let ticks = 0;
    while (!ctx.signal.aborted) {
      ticks += 1;
      const tickId = `${Date.now().toString(36)}`;
      try {
        const scout = await ctx.spawnChild({ template: "market-scout", goal: `Ciclo ${ticks}: leer ${t.watchlist.length} mercados`, input: { tickId } });
        const marketReport = await ctx.waitFor(scout.id);
        if (!marketReport?.ok) throw new Error(marketReport?.error ?? "sin datos de mercado");

        const analysts = [];
        for (const strategy of STRATEGIES) {
          analysts.push(await ctx.spawnChild({ template: "strategy-analyst", goal: `Ciclo ${ticks}: ${strategy.label}`, input: { tickId, strategyId: strategy.id } }));
        }
        for (const analyst of analysts) await ctx.waitFor(analyst.id);

        const risk = await ctx.spawnChild({ template: "risk-manager", goal: `Ciclo ${ticks}: evaluar señales`, input: { tickId } });
        const riskReport = await ctx.waitFor(risk.id);

        const executor = await ctx.spawnChild({ template: "paper-executor", goal: `Ciclo ${ticks}: ejecutar ${riskReport?.approved ?? 0} propuestas`, input: { tickId } });
        const execReport = await ctx.waitFor(executor.id);

        const summary = book.summary();
        ctx.log(`Ciclo ${ticks}: ${riskReport?.approved ?? 0} aprobadas, ${execReport?.executed ?? 0} ejecutadas, ${execReport?.stopped ?? 0} cierres por stop · equity ${summary.equity.toFixed(2)} USD (${(summary.returnPct * 100).toFixed(2)} %)`);
        registry.prune?.({ keep: 400 });
      } catch (error) {
        ctx.log(`Error en el ciclo ${ticks}: ${error.message}`, { level: "error" });
      }
      await sleep(t.tickMs, ctx.signal);
    }
    return { summary: `Trader detenido tras ${ticks} ciclos` };
  }

  async function marketScout(ctx) {
    const snapshot = await market.snapshot(t.watchlist, t.granularity);
    if (!Object.keys(snapshot.prices).length) return { ok: false, error: snapshot.errors.map((e) => e.message).join("; ") };
    store.upsert("trading", { id: "market", ...snapshot, tickId: ctx.input.tickId });
    book.markToMarket(snapshot.prices);
    for (const error of snapshot.errors) ctx.log(`${error.product}: ${error.message}`, { level: "warn" });
    ctx.log(Object.entries(snapshot.prices).map(([p, v]) => `${p} ${v}`).join(" · "));
    return { ok: true, summary: `${Object.keys(snapshot.prices).length} mercados leídos`, prices: snapshot.prices };
  }

  async function strategyAnalyst(ctx) {
    const strategy = strategyById(ctx.input.strategyId);
    if (!strategy) throw new Error("Estrategia desconocida");
    const marketDoc = store.get("trading", "market");
    if (!marketDoc) throw new Error("Sin datos de mercado");
    let actionable = 0;
    for (const product of t.watchlist) {
      const candles = marketDoc.candles[product];
      if (!candles?.length) continue;
      const result = strategy.signal(candles);
      store.upsert("signals", { tickId: ctx.input.tickId, product, strategyId: strategy.id, strategyLabel: strategy.label, price: marketDoc.prices[product], ...result, status: result.action === "hold" ? "hold" : "pending", agentId: ctx.agent.id, at: marketDoc.at });
      if (result.action !== "hold") { actionable += 1; ctx.log(`${product}: ${result.action.toUpperCase()} (${result.strength.toFixed(2)}) ${result.reason}`); }
    }
    if (!actionable) ctx.log("Sin señales accionables en este ciclo");
    return { summary: `${actionable} señales accionables`, actionable };
  }

  async function riskManager(ctx) {
    const marketDoc = store.get("trading", "market");
    const prices = marketDoc?.prices ?? {};
    const signals = store.list("signals", (s) => s.tickId === ctx.input.tickId && s.status === "pending");
    let approved = 0;
    // Con varias señales del mismo producto se conserva la más fuerte para evitar órdenes contradictorias.
    const byProduct = new Map();
    for (const signal of signals) {
      const current = byProduct.get(signal.product);
      if (!current || signal.strength > current.strength) byProduct.set(signal.product, signal);
    }
    for (const signal of signals) {
      const chosen = byProduct.get(signal.product);
      if (chosen.id !== signal.id) { store.upsert("signals", { id: signal.id, status: "rejected", riskReason: `descartada: ${chosen.strategyLabel} tiene más fuerza` }); continue; }
      const verdict = assessSignal({ signal, book, prices, config });
      if (verdict.approved) {
        approved += 1;
        store.upsert("signals", { id: signal.id, status: "approved", riskReason: verdict.reason, sizeUsd: verdict.sizeUsd });
        ctx.log(`APROBADA ${signal.product} ${signal.action} ${verdict.sizeUsd.toFixed(2)} USD (${signal.strategyLabel})`);
      } else {
        store.upsert("signals", { id: signal.id, status: "rejected", riskReason: verdict.reason });
        ctx.log(`Rechazada ${signal.product} ${signal.action}: ${verdict.reason}`);
      }
    }
    return { summary: `${approved} de ${signals.length} señales aprobadas`, approved };
  }

  async function paperExecutor(ctx) {
    const marketDoc = store.get("trading", "market");
    const prices = marketDoc?.prices ?? {};
    const stopped = book.checkStops(prices, ctx.agent.id);
    for (const trade of stopped) ctx.log(`Cierre automático ${trade.product} a ${trade.price} (${trade.reason}) → P&L ${trade.pnl.toFixed(2)} USD`);
    let executed = 0;
    for (const signal of store.list("signals", (s) => s.tickId === ctx.input.tickId && s.status === "approved")) {
      const price = prices[signal.product];
      try {
        if (signal.action === "buy") book.open({ product: signal.product, usd: signal.sizeUsd, price, strategyId: signal.strategyId, reason: signal.reason, agentId: ctx.agent.id });
        else book.close({ product: signal.product, price, reason: signal.reason, agentId: ctx.agent.id });
        executed += 1;
        store.upsert("signals", { id: signal.id, status: "executed_real", executedAt: new Date().toISOString(), executedPrice: price });
        ctx.log(`Operación DEX: ${signal.action.toUpperCase()} ${signal.product} ${signal.sizeUsd.toFixed(2)} USD a ${price}`);
        if (t.mode === "proposal" || t.mode === "paper" || t.mode === "real") {
          const targetPrice = signal.action === "buy" ? price * (1 + t.takeProfitPct) : price * (1 - t.takeProfitPct);
          const stopPrice = signal.action === "buy" ? price * (1 - t.stopLossPct) : price * (1 + t.stopLossPct);
          const potentialGainUsd = Number((signal.sizeUsd * t.takeProfitPct).toFixed(2));
          const potentialLossUsd = Number((signal.sizeUsd * t.stopLossPct).toFixed(2));
          const dexUrl = getDexUrl(signal.product);
          const tokenInfo = BASE_TOKENS[signal.product] || null;

          store.upsert("proposals", {
            signalId: signal.id,
            product: signal.product,
            action: signal.action,
            sizeUsd: signal.sizeUsd,
            price,
            targetPrice: Number(targetPrice.toFixed(targetPrice < 1 ? 4 : 2)),
            stopPrice: Number(stopPrice.toFixed(stopPrice < 1 ? 4 : 2)),
            targetPct: Number((t.takeProfitPct * 100).toFixed(1)),
            stopPct: Number((t.stopLossPct * 100).toFixed(1)),
            potentialGainUsd,
            potentialLossUsd,
            riskReward: `${(t.takeProfitPct / t.stopLossPct).toFixed(1)}:1`,
            strategyLabel: signal.strategyLabel,
            reason: signal.reason,
            dexUrl,
            network: tokenInfo?.network || "Base (EIP-155:8453)",
            dexName: tokenInfo?.dexName || "Uniswap v3 (Base)",
            tokenAddress: tokenInfo?.address || null,
            status: "proposed",
            at: new Date().toISOString()
          });
          ctx.log(`Propuesta DEX para ejecución: ${signal.action.toUpperCase()} ${signal.product} ${signal.sizeUsd.toFixed(2)} USD (TP +$${potentialGainUsd} / SL -$${potentialLossUsd})`);
        }
      } catch (error) {
        store.upsert("signals", { id: signal.id, status: "failed", riskReason: error.message });
        ctx.log(`No ejecutada ${signal.product}: ${error.message}`, { level: "warn" });
      }
    }
    book.markToMarket(prices);
    return { summary: `${executed} órdenes ejecutadas en DEX, ${stopped.length} cierres por stop`, executed, stopped: stopped.length };
  }

  return { trader: traderManager, "market-scout": marketScout, "strategy-analyst": strategyAnalyst, "risk-manager": riskManager, "paper-executor": paperExecutor, "trade-executor": paperExecutor };
}
