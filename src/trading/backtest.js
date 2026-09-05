import { createStore } from "../core/store.js";
import { createPaperBook } from "./paper.js";
import { assessSignal } from "./risk.js";
import { STRATEGIES } from "./strategies.js";

/**
 * Backtest honesto sobre velas históricas: rehace ciclo a ciclo lo que harían analistas, riesgo y ejecutor,
 * con las mismas comisiones y límites que la cartera simulada. Sirve para ver si una estrategia
 * habría ganado algo ANTES de fiarse de ella. No usa modelo ni red.
 */
export function runBacktest({ config, candlesByProduct, warmup = 60, strategies = STRATEGIES }) {
  const results = {};
  for (const strategy of strategies) {
    const store = createStore(null);
    const book = createPaperBook({ store, config });
    const products = Object.keys(candlesByProduct);
    const length = Math.min(...products.map((p) => candlesByProduct[p].length));
    let signals = 0;
    for (let i = warmup; i < length; i += 1) {
      const prices = {};
      const window = {};
      for (const product of products) {
        window[product] = candlesByProduct[product].slice(0, i + 1);
        prices[product] = window[product].at(-1).close;
      }
      book.markToMarket(prices);
      // Stops intra-vela: se comprueban con el mínimo y el máximo de la vela actual.
      const lows = Object.fromEntries(products.map((p) => [p, window[p].at(-1).low]));
      const highs = Object.fromEntries(products.map((p) => [p, window[p].at(-1).high]));
      for (const product of products) {
        const pos = book.portfolio().positions[product];
        if (!pos) continue;
        if (lows[product] <= pos.stop) book.close({ product, price: pos.stop, reason: "stop loss", agentId: "backtest" });
        else if (highs[product] >= pos.take) book.close({ product, price: pos.take, reason: "take profit", agentId: "backtest" });
      }
      for (const product of products) {
        const result = strategy.signal(window[product]);
        if (result.action === "hold") continue;
        signals += 1;
        const signal = { product, strategyId: strategy.id, ...result };
        const verdict = assessSignal({ signal, book, prices, config });
        if (!verdict.approved) continue;
        if (signal.action === "buy") book.open({ product, usd: verdict.sizeUsd, price: prices[product], strategyId: strategy.id, reason: result.reason, agentId: "backtest" });
        else book.close({ product, price: prices[product], reason: result.reason, agentId: "backtest" });
      }
    }
    const finalPrices = Object.fromEntries(products.map((p) => [p, candlesByProduct[p].at(-1).close]));
    const summary = book.summary(finalPrices);
    results[strategy.id] = {
      label: strategy.label,
      candles: length - warmup,
      signals,
      trades: summary.closedTrades,
      winRate: summary.winRate,
      returnPct: summary.returnPct,
      realizedPnl: summary.realizedPnl,
      fees: summary.fees,
      maxDrawdownPct: summary.maxDrawdownPct,
      openPositions: summary.positions.length
    };
  }
  // Referencia: comprar y mantener a partes iguales durante el mismo periodo.
  const products = Object.keys(candlesByProduct);
  const holdReturn = products.reduce((sum, p) => {
    const c = candlesByProduct[p];
    return sum + (c.at(-1).close - c[warmup].close) / c[warmup].close;
  }, 0) / products.length;
  return { results, buyAndHoldReturnPct: holdReturn, from: Math.min(...products.map((p) => candlesByProduct[p][warmup]?.time ?? 0)), to: Math.max(...products.map((p) => candlesByProduct[p].at(-1).time)) };
}
