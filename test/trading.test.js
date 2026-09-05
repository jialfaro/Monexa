import test from "node:test";
import assert from "node:assert/strict";
import { sma, ema, rsi, atr } from "../src/trading/indicators.js";
import { STRATEGIES, strategyById } from "../src/trading/strategies.js";
import { createPaperBook } from "../src/trading/paper.js";
import { assessSignal } from "../src/trading/risk.js";
import { createStore } from "../src/core/store.js";
import { buildConfig } from "../src/core/config.js";

const config = buildConfig({ PAPER_START_USD: "1000", TRADER_FEE_RATE: "0.01", TRADER_MAX_POSITION_PCT: "0.2", TRADER_MAX_EXPOSURE_PCT: "0.5", TRADER_DAILY_LOSS_LIMIT_PCT: "0.05" });

function candlesFrom(closes) {
  return closes.map((close, i) => ({ time: i, open: close, high: close * 1.01, low: close * 0.99, close, volume: 1 }));
}

test("indicadores básicos", () => {
  assert.equal(sma([1, 2, 3, 4, 5], 5), 3);
  assert.ok(Math.abs(ema([1, 2, 3, 4, 5, 6], 3) - 5) < 0.6);
  assert.equal(rsi(Array.from({ length: 20 }, (_, i) => 100 + i), 14), 100);
  assert.ok(rsi([...Array.from({ length: 20 }, (_, i) => 100 - i)], 14) < 1);
  assert.ok(atr(candlesFrom(Array(20).fill(100)), 14) > 0);
});

test("la estrategia de tendencia detecta el cruce alcista", () => {
  const closes = [...Array(60).fill(100), ...Array.from({ length: 30 }, (_, i) => 100 + i * 1.5)];
  const results = [];
  for (let n = 61; n <= closes.length; n += 1) results.push(strategyById("trend-ema").signal(candlesFrom(closes.slice(0, n))).action);
  assert.ok(results.includes("buy"), "hubo una señal de compra durante la subida");
  assert.equal(strategyById("trend-ema").signal(candlesFrom(Array(10).fill(100))).action, "hold");
});

test("la estrategia RSI compra en sobreventa y la de ruptura compra en máximos", () => {
  const falling = Array.from({ length: 30 }, (_, i) => 200 - i * 3);
  assert.equal(strategyById("meanrev-rsi").signal(candlesFrom(falling)).action, "buy");
  const breakout = [...Array(25).fill(100), 110];
  assert.equal(strategyById("breakout-20").signal(candlesFrom(breakout)).action, "buy");
  assert.equal(STRATEGIES.length, 5);
});

test("el libro simulado aplica comisiones, stops y P&L realizado", () => {
  const store = createStore(null);
  const book = createPaperBook({ store, config });
  book.markToMarket({ "BTC-USD": 100 });
  book.open({ product: "BTC-USD", usd: 100, price: 100, strategyId: "trend-ema", reason: "test", agentId: "a" });
  let doc = book.portfolio();
  assert.ok(Math.abs(doc.cash - 899) < 1e-9, "100 USD + 1 % de comisión");
  assert.equal(doc.positions["BTC-USD"].qty, 1);
  assert.ok(Math.abs(book.equity({ "BTC-USD": 110 }) - 1009) < 1e-9);
  const closed = book.checkStops({ "BTC-USD": 96 }, "a");
  assert.equal(closed.length, 1);
  doc = book.portfolio();
  assert.ok(doc.realizedPnl < 0);
  assert.equal(Object.keys(doc.positions).length, 0);
  const summary = book.summary({ "BTC-USD": 96 });
  assert.equal(summary.closedTrades, 1);
  assert.equal(summary.winRate, 0);
  assert.ok(summary.byStrategy["trend-ema"].pnl < 0);
  book.reset();
  assert.equal(book.portfolio().cash, 1000);
});

test("el gestor de riesgo respeta tamaño, exposición y pérdida diaria", () => {
  const store = createStore(null);
  const book = createPaperBook({ store, config });
  const prices = { "BTC-USD": 100, "ETH-USD": 10 };
  book.markToMarket(prices);
  const buy = { product: "BTC-USD", action: "buy", strength: 0.9, strategyId: "trend-ema" };
  const first = assessSignal({ signal: buy, book, prices, config });
  assert.equal(first.approved, true);
  assert.ok(first.sizeUsd <= 200 + 1e-9, "no supera el 20 % del equity");
  book.open({ product: "BTC-USD", usd: first.sizeUsd, price: 100, strategyId: "trend-ema", reason: "t", agentId: "a" });
  assert.equal(assessSignal({ signal: buy, book, prices, config }).approved, false, "no duplica posición");
  assert.equal(assessSignal({ signal: { ...buy, strength: 0.2, product: "ETH-USD" }, book, prices, config }).approved, false, "fuerza insuficiente");
  const weakSell = assessSignal({ signal: { product: "BTC-USD", action: "sell", strength: 0.6, strategyId: "meanrev-rsi" }, book, prices, config });
  assert.equal(weakSell.approved, false, "otra estrategia no cierra con señal débil");
  // Caída del 10 % activa el límite de pérdida diaria
  const crashed = { "BTC-USD": 50, "ETH-USD": 10 };
  book.markToMarket(crashed);
  const afterCrash = assessSignal({ signal: { ...buy, product: "ETH-USD" }, book, prices: crashed, config });
  assert.equal(afterCrash.approved, false);
  assert.match(afterCrash.reason, /pérdida diaria/);
});

test("el backtest recorre velas y devuelve métricas por estrategia", async () => {
  const { runBacktest } = await import("../src/trading/backtest.js");
  const closes = Array.from({ length: 160 }, (_, i) => 100 + 10 * Math.sin(i / 6) + i * 0.2);
  const candles = closes.map((close, i) => ({ time: i, open: close, high: close * 1.01, low: close * 0.99, close, volume: 1 }));
  const report = runBacktest({ config, candlesByProduct: { "BTC-USD": candles }, warmup: 60 });
  assert.equal(Object.keys(report.results).length, 5);
  for (const r of Object.values(report.results)) {
    assert.equal(r.candles, 100);
    assert.ok(Number.isFinite(r.returnPct));
    assert.ok(r.maxDrawdownPct >= 0);
  }
  assert.ok(Number.isFinite(report.buyAndHoldReturnPct));
});

test("metadatos de tokens Base y enlaces DEX en Uniswap", async () => {
  const { getDexUrl, BASE_TOKENS } = await import("../src/trading/market.js");
  assert.ok(BASE_TOKENS["AERO-USD"]);
  assert.ok(BASE_TOKENS["VIRTUAL-USD"]);
  assert.match(getDexUrl("AERO-USD"), /uniswap\.org/);
  assert.match(getDexUrl("VIRTUAL-USD"), /uniswap\.org/);
});
