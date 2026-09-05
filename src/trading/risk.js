/**
 * Gestor de riesgo determinista: convierte señales en propuestas con tamaño, o las rechaza.
 * Reglas: límite de pérdida diaria, tamaño máximo por posición, exposición máxima, fuerza mínima, sin duplicar posiciones.
 */
export function assessSignal({ signal, book, prices, config }) {
  const t = config.trader;
  const price = prices[signal.product];
  if (!price) return { approved: false, reason: "sin precio" };
  const doc = book.portfolio();
  const equity = book.equity(prices);
  const hasPosition = Boolean(doc.positions[signal.product]);

  if (signal.action === "hold") return { approved: false, reason: "sin señal" };
  if (signal.action === "sell") {
    if (!hasPosition) return { approved: false, reason: "no hay posición que cerrar" };
    if (doc.positions[signal.product].strategyId !== signal.strategyId && signal.strength < 0.8) {
      return { approved: false, reason: "la posición pertenece a otra estrategia; sólo una señal fuerte la cierra" };
    }
    return { approved: true, reason: "cierre aprobado", sizeUsd: doc.positions[signal.product].qty * price };
  }
  // buy
  if (hasPosition) return { approved: false, reason: "ya hay posición abierta" };
  if (signal.strength < t.minStrength) return { approved: false, reason: `fuerza ${signal.strength.toFixed(2)} por debajo de ${t.minStrength}` };
  const dailyLoss = book.dailyLossPct(prices);
  if (dailyLoss >= t.dailyLossLimitPct) return { approved: false, reason: `límite de pérdida diaria alcanzado (${(dailyLoss * 100).toFixed(1)} %)` };
  const exposure = book.exposure(prices);
  const maxNew = Math.min(t.maxPositionPct * equity, t.maxExposurePct * equity - exposure, doc.cash / (1 + t.feeRate));
  if (maxNew < t.minOrderUsd) return { approved: false, reason: `sin margen de exposición (máximo nuevo ${maxNew.toFixed(2)} USD)` };
  const sizeUsd = Math.max(t.minOrderUsd, maxNew * Math.min(1, 0.5 + signal.strength / 2));
  return { approved: true, reason: "apertura aprobada", sizeUsd: Number(sizeUsd.toFixed(2)) };
}
