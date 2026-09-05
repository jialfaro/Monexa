/**
 * Libro de cartera y ejecución de trading Web3 sobre Base (EIP-155:8453).
 * Estado en la colección "trading" del store, documento "portfolio"; operaciones en "trades".
 */
export function createPaperBook({ store, config }) {
  const t = config.trader;
  const startCapital = t.tradingCapitalUsd || t.paperStartUsd || 1000;

  function portfolio() {
    let doc = store.get("trading", "portfolio");
    if (!doc) {
      doc = store.upsert("trading", { id: "portfolio", cash: startCapital, startUsd: startCapital, positions: {}, realizedPnl: 0, fees: 0, equityHistory: [], dayStamp: today(), dayStartEquity: startCapital, peakEquity: startCapital, maxDrawdownPct: 0 });
    }
    return doc;
  }

  function save(doc) {
    return store.upsert("trading", { ...doc, id: "portfolio" });
  }

  function equity(doc, prices) {
    let value = doc.cash;
    for (const [product, pos] of Object.entries(doc.positions)) {
      const price = prices[product] ?? pos.avgPrice;
      value += pos.qty * price;
    }
    return value;
  }

  function exposure(doc, prices) {
    let value = 0;
    for (const [product, pos] of Object.entries(doc.positions)) value += pos.qty * (prices[product] ?? pos.avgPrice);
    return value;
  }

  /** Actualiza equity, drawdown y el arranque del día. */
  function markToMarket(prices) {
    const doc = portfolio();
    const value = equity(doc, prices);
    if (doc.dayStamp !== today()) { doc.dayStamp = today(); doc.dayStartEquity = value; }
    doc.peakEquity = Math.max(doc.peakEquity ?? value, value);
    doc.maxDrawdownPct = Math.max(doc.maxDrawdownPct ?? 0, (doc.peakEquity - value) / doc.peakEquity);
    doc.equityHistory = [...(doc.equityHistory ?? []), { at: new Date().toISOString(), equity: Number(value.toFixed(2)) }].slice(-500);
    doc.lastPrices = prices;
    return save(doc);
  }

  function dailyLossPct(prices) {
    const doc = portfolio();
    const value = equity(doc, prices);
    return (doc.dayStartEquity - value) / doc.dayStartEquity;
  }

  function open({ product, usd, price, strategyId, reason, agentId, stopPct = t.stopLossPct, takePct = t.takeProfitPct }) {
    const doc = portfolio();
    if (doc.positions[product]) throw new Error(`Ya hay posición abierta en ${product}`);
    const fee = usd * t.feeRate;
    if (usd + fee > doc.cash) throw new Error("Efectivo disponible insuficiente");
    const qty = usd / price;
    doc.cash -= usd + fee;
    doc.fees += fee;
    doc.positions[product] = { qty, avgPrice: price, costUsd: usd, stop: price * (1 - stopPct), take: price * (1 + takePct), strategyId, openedAt: new Date().toISOString() };
    save(doc);
    return store.upsert("trades", { kind: "real", side: "buy", product, qty, price, usd, fee, strategyId, reason, agentId, at: new Date().toISOString() });
  }

  function close({ product, price, reason, agentId }) {
    const doc = portfolio();
    const pos = doc.positions[product];
    if (!pos) throw new Error(`No hay posición en ${product}`);
    const gross = pos.qty * price;
    const fee = gross * t.feeRate;
    const pnl = gross - fee - pos.costUsd - pos.costUsd * t.feeRate;
    doc.cash += gross - fee;
    doc.fees += fee;
    doc.realizedPnl += pnl;
    delete doc.positions[product];
    save(doc);
    return store.upsert("trades", { kind: "real", side: "sell", product, qty: pos.qty, price, usd: gross, fee, pnl, strategyId: pos.strategyId, reason, agentId, at: new Date().toISOString(), holdMinutes: Math.round((Date.now() - new Date(pos.openedAt).getTime()) / 60_000) });
  }

  /** Cierra posiciones cuyo stop o take profit se alcanzó. */
  function checkStops(prices, agentId) {
    const doc = portfolio();
    const closed = [];
    for (const [product, pos] of Object.entries(doc.positions)) {
      const price = prices[product];
      if (!price) continue;
      if (price <= pos.stop) closed.push(close({ product, price, reason: `stop loss ${pos.stop.toFixed(2)}`, agentId }));
      else if (price >= pos.take) closed.push(close({ product, price, reason: `take profit ${pos.take.toFixed(2)}`, agentId }));
    }
    return closed;
  }

  function reset() {
    const fresh = { id: "portfolio", cash: t.paperStartUsd, startUsd: t.paperStartUsd, positions: {}, realizedPnl: 0, fees: 0, equityHistory: [], dayStamp: today(), dayStartEquity: t.paperStartUsd, peakEquity: t.paperStartUsd, maxDrawdownPct: 0, resetAt: new Date().toISOString() };
    return save(fresh);
  }

  function summary(prices = portfolio().lastPrices ?? {}) {
    const doc = portfolio();
    const value = equity(doc, prices);
    const trades = store.list("trades", (x) => x.side === "sell");
    const wins = trades.filter((x) => x.pnl > 0).length;
    const byStrategy = {};
    for (const trade of trades) {
      byStrategy[trade.strategyId] ??= { trades: 0, pnl: 0, wins: 0 };
      byStrategy[trade.strategyId].trades += 1;
      byStrategy[trade.strategyId].pnl += trade.pnl;
      if (trade.pnl > 0) byStrategy[trade.strategyId].wins += 1;
    }
    return {
      startUsd: doc.startUsd, cash: doc.cash, equity: value, unrealizedPnl: value - doc.cash - Object.values(doc.positions).reduce((s, p) => s + p.costUsd, 0),
      realizedPnl: doc.realizedPnl, fees: doc.fees, returnPct: (value - doc.startUsd) / doc.startUsd, maxDrawdownPct: doc.maxDrawdownPct ?? 0,
      dailyLossPct: (doc.dayStartEquity - value) / doc.dayStartEquity, exposureUsd: exposure(doc, prices),
      positions: Object.entries(doc.positions).map(([product, p]) => ({ product, ...p, price: prices[product] ?? p.avgPrice, pnl: (prices[product] ?? p.avgPrice) * p.qty - p.costUsd })),
      closedTrades: trades.length, winRate: trades.length ? wins / trades.length : null, byStrategy, equityHistory: doc.equityHistory ?? [], lastPrices: prices
    };
  }

  return { portfolio, markToMarket, dailyLossPct, open, close, checkStops, reset, summary, equity: (prices) => equity(portfolio(), prices), exposure: (prices) => exposure(portfolio(), prices) };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}
