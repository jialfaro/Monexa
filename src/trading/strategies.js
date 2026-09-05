import { emaSeries, rsi, atr, highest, lowest, bollingerBands, macd, volumeSurge } from "./indicators.js";

/**
 * Estrategias deterministas. Cada una devuelve { action: buy|sell|hold, strength 0..1, reason, indicators }.
 * Sólo posiciones largas: buy abre, sell cierra.
 */
export const STRATEGIES = [
  {
    id: "trend-ema",
    label: "Tendencia EMA 12/26",
    description: "Compra cuando la EMA 12 cruza por encima de la EMA 26 con la EMA 50 alcista; vende en el cruce contrario.",
    signal(candles) {
      const closes = candles.map((c) => c.close);
      const fast = emaSeries(closes, 12);
      const slow = emaSeries(closes, 26);
      const long = emaSeries(closes, 50);
      if (fast.length < 3 || slow.length < 3 || long.length < 3) return hold("datos insuficientes");
      const [f1, f0] = [fast.at(-2), fast.at(-1)];
      const s1 = slow.at(-2), s0 = slow.at(-1);
      const trendUp = long.at(-1) > long.at(-2);
      const spread = Math.abs(f0 - s0) / s0;
      const indicators = { ema12: f0, ema26: s0, ema50: long.at(-1) };
      if (f1 <= s1 && f0 > s0 && trendUp) return { action: "buy", strength: Math.min(1, 0.5 + spread * 50), reason: "cruce alcista EMA 12/26 con EMA 50 al alza", indicators };
      if (f1 >= s1 && f0 < s0) return { action: "sell", strength: Math.min(1, 0.5 + spread * 50), reason: "cruce bajista EMA 12/26", indicators };
      return hold(f0 > s0 ? "tendencia alcista vigente" : "tendencia bajista vigente", indicators);
    }
  },
  {
    id: "momentum-volume",
    label: "Momentum & Volumen (CCXT)",
    description: "Detecta acumulación institucional y rupturas cuando el volumen supera 1.6x la media de 20 periodos y el precio quiebra al alza.",
    signal(candles) {
      if (candles.length < 25) return hold("datos insuficientes");
      const closes = candles.map((c) => c.close);
      const v = volumeSurge(candles, 20);
      const fastEma = emaSeries(closes, 9).at(-1);
      const slowEma = emaSeries(closes, 21).at(-1);
      const last = candles.at(-1);
      const prev = candles.at(-2);
      if (!v) return hold("sin datos de volumen");
      const indicators = { volumeRatio: Number(v.surgeRatio.toFixed(2)), isSurge: v.isSurge, ema9: fastEma, ema21: slowEma };
      const isGreen = last.close > last.open && last.close > prev.close;
      const isRed = last.close < last.open && last.close < prev.close;
      if (v.isSurge && isGreen && fastEma > slowEma) {
        return { action: "buy", strength: Math.min(1, 0.55 + (v.surgeRatio - 1.6) * 0.25), reason: `Volumen inusual (${v.surgeRatio.toFixed(1)}x) y quiebre alcista`, indicators };
      }
      if (v.isSurge && isRed && fastEma < slowEma) {
        return { action: "sell", strength: Math.min(1, 0.55 + (v.surgeRatio - 1.6) * 0.25), reason: `Presión vendedora con alto volumen (${v.surgeRatio.toFixed(1)}x)`, indicators };
      }
      return hold(v.isSurge ? "volumen alto sin quiebre direccional" : "volumen en rango normal", indicators);
    }
  },
  {
    id: "macd-trend",
    label: "MACD Momentum 12/26/9",
    description: "Cruce de línea MACD y Signal con confirmación del histograma para capturar aceleración del mercado.",
    signal(candles) {
      const closes = candles.map((c) => c.close);
      const m = macd(closes, 12, 26, 9);
      if (!m) return hold("datos insuficientes");
      const indicators = { macd: Number(m.macd.toFixed(3)), signal: Number(m.signal.toFixed(3)), histogram: Number(m.histogram.toFixed(3)) };
      if (m.crossUp && m.histogram > 0) {
        return { action: "buy", strength: 0.72, reason: "Cruce alcista MACD sobre línea de señal", indicators };
      }
      if (m.crossDown && m.histogram < 0) {
        return { action: "sell", strength: 0.72, reason: "Cruce bajista MACD bajo línea de señal", indicators };
      }
      return hold(m.histogram > 0 ? "histograma MACD positivo" : "histograma MACD negativo", indicators);
    }
  },
  {
    id: "meanrev-rsi",
    label: "Reversión RSI 14",
    description: "Compra con RSI por debajo de 30 y vende por encima de 70.",
    signal(candles) {
      const closes = candles.map((c) => c.close);
      const value = rsi(closes, 14);
      if (value === null) return hold("datos insuficientes");
      const indicators = { rsi14: value };
      if (value < 30) return { action: "buy", strength: Math.min(1, (30 - value) / 15 + 0.5), reason: `RSI ${value.toFixed(1)}: sobreventa`, indicators };
      if (value > 70) return { action: "sell", strength: Math.min(1, (value - 70) / 15 + 0.5), reason: `RSI ${value.toFixed(1)}: sobrecompra`, indicators };
      return hold(`RSI ${value.toFixed(1)} neutral`, indicators);
    }
  },
  {
    id: "breakout-20",
    label: "Ruptura 20 velas",
    description: "Compra al cerrar por encima del máximo de las 20 velas previas; vende al cerrar por debajo del mínimo.",
    signal(candles) {
      if (candles.length < 22) return hold("datos insuficientes");
      const previous = candles.slice(0, -1);
      const last = candles.at(-1);
      const hi = highest(previous, 20);
      const lo = lowest(previous, 20);
      const range = atr(candles, 14) ?? (hi - lo);
      const indicators = { high20: hi, low20: lo, atr14: range };
      if (last.close > hi) return { action: "buy", strength: Math.min(1, 0.5 + (last.close - hi) / Math.max(range, 1e-9) * 0.5), reason: "cierre por encima del máximo de 20 velas", indicators };
      if (last.close < lo) return { action: "sell", strength: Math.min(1, 0.5 + (lo - last.close) / Math.max(range, 1e-9) * 0.5), reason: "cierre por debajo del mínimo de 20 velas", indicators };
      return hold("dentro del rango", indicators);
    }
  }
];

function hold(reason, indicators = {}) {
  return { action: "hold", strength: 0, reason, indicators };
}

export function strategyById(id) {
  return STRATEGIES.find((s) => s.id === id) ?? null;
}
