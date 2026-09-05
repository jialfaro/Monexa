/** Indicadores técnicos deterministas sobre arreglos de velas {open, high, low, close, volume}. */
export function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function emaSeries(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(ema);
  for (let i = period; i < values.length; i += 1) {
    ema = values[i] * k + ema * (1 - k);
    out.push(ema);
  }
  return out;
}

export function ema(values, period) {
  const series = emaSeries(values, period);
  return series.length ? series.at(-1) : null;
}

export function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    if (change > 0) gains += change; else losses -= change;
  }
  if (losses === 0) return 100;
  const rs = gains / period / (losses / period);
  return 100 - 100 / (1 + rs);
}

export function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = candles.length - period; i < candles.length; i += 1) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
  }
  return trs.reduce((a, b) => a + b, 0) / period;
}

export function highest(candles, period, key = "high") {
  return Math.max(...candles.slice(-period).map((c) => c[key]));
}

export function lowest(candles, period, key = "low") {
  return Math.min(...candles.slice(-period).map((c) => c[key]));
}

export function bollingerBands(closes, period = 20, multiplier = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
  const std = Math.sqrt(variance);
  return {
    middle: mean,
    upper: mean + std * multiplier,
    lower: mean - std * multiplier,
    bandwidth: (std * multiplier * 2) / (mean || 1)
  };
}

export function macd(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (closes.length < slowPeriod + signalPeriod) return null;
  const fast = emaSeries(closes, fastPeriod);
  const slow = emaSeries(closes, slowPeriod);
  const offset = fast.length - slow.length;
  const macdLine = [];
  for (let i = 0; i < slow.length; i += 1) {
    macdLine.push(fast[i + offset] - slow[i]);
  }
  const signalLine = emaSeries(macdLine, signalPeriod);
  if (!signalLine.length) return null;
  const lastMacd = macdLine.at(-1);
  const prevMacd = macdLine.at(-2);
  const lastSignal = signalLine.at(-1);
  const prevSignal = signalLine.at(-2);
  const histogram = lastMacd - lastSignal;
  const prevHistogram = prevMacd - prevSignal;
  return {
    macd: lastMacd,
    signal: lastSignal,
    histogram,
    crossUp: prevMacd <= prevSignal && lastMacd > lastSignal,
    crossDown: prevMacd >= prevSignal && lastMacd < lastSignal
  };
}

export function volumeSurge(candles, period = 20) {
  if (candles.length < period + 1) return null;
  const previous = candles.slice(-period - 1, -1);
  const avgVol = previous.reduce((sum, c) => sum + (c.volume || 0), 0) / period;
  const current = candles.at(-1);
  const curVol = current.volume || 0;
  const ratio = avgVol > 0 ? curVol / avgVol : 1;
  return {
    avgVolume: avgVol,
    currentVolume: curVol,
    surgeRatio: ratio,
    isSurge: ratio >= 1.6
  };
}
