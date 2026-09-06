import { STRATEGIES, strategyById } from "../trading/strategies.js";
import { assessSignal } from "../trading/risk.js";
import { getDexUrl, BASE_TOKENS } from "../trading/market.js";

/**
 * Apartado Trader: un manager de trading que en cada ciclo crea agentes especializados:
 * market-scout → strategy-analyst (uno por estrategia) → risk-manager → dex-executor.
 * Operaciones con dinero real en DEX; en modo "real" / "proposal" las órdenes quedan como propuestas verificadas para Uniswap v3 / Aerodrome en Base con liquidación en ledger on-chain.
 */
export function createTraderRunners({ store, config, market, book, registry, swapper }) {
  const t = config.trader;
  const sleep = (ms, signal) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });

  async function checkOnChainStops(prices, ctx) {
    if (!swapper || !swapper.isConfigured()) return;
    const openPositions = store.list("proposals", (p) => p.status === "open_onchain");
    for (const pos of openPositions) {
      const currentPrice = prices[pos.product];
      if (!currentPrice) continue;

      const isTakeProfit = currentPrice >= pos.targetPrice;
      const isStopLoss = currentPrice <= pos.stopPrice;

      if (isTakeProfit || isStopLoss) {
        const exitReason = isTakeProfit ? "Take Profit (+6%) alcanzado" : "Stop Loss (-3%) ejecutado";
        ctx.log(`[Auto-Trader] ${pos.product}: Ejecutando venta on-chain por ${exitReason} a $${currentPrice}`);
        try {
          const sellResult = await swapper.executeSell({
            product: pos.product,
            tokenAmount: pos.tokensHeld,
            currentPrice
          });
          const pnl = Number((sellResult.estimatedUsdReceived - pos.sizeUsd).toFixed(2));
          store.upsert("proposals", {
            id: pos.id,
            status: isTakeProfit ? "closed_take_profit" : "closed_stop_loss",
            closeTxHash: sellResult.txHash,
            closeBasescanUrl: sellResult.basescanUrl,
            realizedProfitUsd: pnl,
            resolvedAt: new Date().toISOString()
          });

          store.upsert("ledger", {
            id: `dex_pnl_${Date.now()}_${pos.product}`,
            agentId: "trader",
            proposalId: pos.id,
            kind: "claimed",
            amount: pnl,
            asset: "USDC",
            note: `P&L On-Chain Uniswap v3 Base (${pos.product}): ${pnl >= 0 ? "+" : ""}$${pnl} USDC`,
            at: new Date().toISOString()
          });

          ctx.log(`🟢 CIERRE ON-CHAIN EN BASE: ${exitReason} -> P&L ${pnl >= 0 ? "+" : ""}$${pnl} USDC · ${sellResult.basescanUrl}`);
        } catch (err) {
          ctx.log(`❌ Error al cerrar posición on-chain para ${pos.product}: ${err.message}`, { level: "error" });
        }
      }
    }
  }

  async function traderManager(ctx) {
    const isAuto = t.executionMode === "auto" && swapper?.isConfigured();
    ctx.log(`Trader iniciado en modo ${t.mode} (${isAuto ? "🟢 AUTO-EXECUTION ON-CHAIN UNISWAP V3" : "🟡 MODO ASISTIDO PROPOSAL"}) · capital ${t.tradingCapitalUsd || t.paperStartUsd} USD · ${t.watchlist.join(", ")}`);
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

        const executor = await ctx.spawnChild({ template: "dex-executor", goal: `Ciclo ${ticks}: ejecutar ${riskReport?.approved ?? 0} propuestas`, input: { tickId } });
        const execReport = await ctx.waitFor(executor.id);

        const summary = book.summary();
        ctx.log(`Ciclo ${ticks}: ${riskReport?.approved ?? 0} aprobadas, ${execReport?.executed ?? 0} ejecutadas, ${execReport?.stopped ?? 0} cierres · equity ${summary.equity.toFixed(2)} USD`);
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

  async function dexExecutor(ctx) {
    const marketDoc = store.get("trading", "market");
    const prices = marketDoc?.prices ?? {};
    
    // 1. Revisar Take Profit y Stop Loss de posiciones on-chain
    await checkOnChainStops(prices, ctx);

    // 2. Revisar stops de la cartera simulada
    const stopped = book.checkStops(prices, ctx.agent.id);
    for (const trade of stopped) ctx.log(`Cierre automático simulado ${trade.product} a ${trade.price} (${trade.reason}) → P&L ${trade.pnl.toFixed(2)} USD`);

    let executed = 0;
    const approvedSignals = store.list("signals", (s) => s.tickId === ctx.input.tickId && s.status === "approved");

    for (const signal of approvedSignals) {
      const price = prices[signal.product];
      const targetPrice = signal.action === "buy" ? price * (1 + t.takeProfitPct) : price * (1 - t.takeProfitPct);
      const stopPrice = signal.action === "buy" ? price * (1 - t.stopLossPct) : price * (1 + t.stopLossPct);
      const potentialGainUsd = Number((signal.sizeUsd * t.takeProfitPct).toFixed(2));
      const potentialLossUsd = Number((signal.sizeUsd * t.stopLossPct).toFixed(2));
      const dexUrl = getDexUrl(signal.product);
      const tokenInfo = BASE_TOKENS[signal.product] || null;

      const isAuto = t.executionMode === "auto" && swapper?.isConfigured();
      let onchainResult = null;

      // Intentar ejecución automática on-chain si está configurada
      if (isAuto && signal.action === "buy" && tokenInfo?.address) {
        try {
          ctx.log(`[Auto-Trader] Ejecutando orden on-chain automática para ${signal.product} en Base Uniswap v3...`);
          onchainResult = await swapper.executeBuy({
            product: signal.product,
            usdAmount: Math.min(signal.sizeUsd, t.maxOrderUsd || 15),
            currentPrice: price
          });
          ctx.log(`🟢 COMPRA ON-CHAIN EXITOSA: ${onchainResult.basescanUrl}`);
        } catch (swErr) {
          ctx.log(`🟡 Fallo swap on-chain (${swErr.message}) -> guardando como propuesta manual`, { level: "warn" });
        }
      }

      // Actualizar libro y registro
      try {
        if (signal.action === "buy") book.open({ product: signal.product, usd: signal.sizeUsd, price, strategyId: signal.strategyId, reason: signal.reason, agentId: ctx.agent.id });
        else book.close({ product: signal.product, price, reason: signal.reason, agentId: ctx.agent.id });
        executed += 1;
        store.upsert("signals", { id: signal.id, status: onchainResult ? "executed_real_onchain" : "executed_real", executedAt: new Date().toISOString(), executedPrice: price });

        store.upsert("proposals", {
          signalId: signal.id,
          product: signal.product,
          action: signal.action,
          sizeUsd: onchainResult ? onchainResult.amountInUsd : signal.sizeUsd,
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
          status: onchainResult ? "open_onchain" : "proposed",
          txHash: onchainResult?.txHash || null,
          basescanUrl: onchainResult?.basescanUrl || null,
          tokensHeld: onchainResult?.estimatedTokens || null,
          at: new Date().toISOString()
        });

      } catch (error) {
        store.upsert("signals", { id: signal.id, status: "failed", riskReason: error.message });
        ctx.log(`No ejecutada ${signal.product}: ${error.message}`, { level: "warn" });
      }
    }
    book.markToMarket(prices);
    return { summary: `${executed} órdenes procesadas en DEX, ${stopped.length} cierres por stop`, executed, stopped: stopped.length };
  }

  return {
    trader: traderManager,
    "market-scout": marketScout,
    "strategy-analyst": strategyAnalyst,
    "risk-manager": riskManager,
    "dex-executor": dexExecutor,
    "paper-executor": dexExecutor,
    "trade-executor": dexExecutor
  };
}
