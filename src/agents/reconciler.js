/**
 * Conciliador: consulta la cadena en modo lectura y convierte lo "reclamado" en "verificado".
 */
export function createReconcilerRunner({ store, config, evm }) {
  return async function reconcile(ctx) {
    if (!config.x402.payTo) return { summary: "Sin PAYTO_ADDRESS: nada que conciliar" };
    const address = config.x402.payTo;
    const balance = await evm.usdcBalance(address);
    ctx.log(`Saldo USDC en ${config.x402.chain.label}: ${balance}`);
    const transfers = await evm.incomingUsdcTransfers(address, { lookbackBlocks: ctx.input.lookbackBlocks ?? 40_000 });
    let verified = 0;
    let unmatched = 0;
    for (const transfer of transfers) {
      const existing = store.list("ledger", (e) => e.txHash && e.txHash.toLowerCase() === transfer.txHash.toLowerCase())[0];
      if (existing?.kind === "received_onchain") continue;
      if (existing) {
        store.upsert("ledger", { id: existing.id, kind: "received_onchain", amount: transfer.amount, verifiedAt: new Date().toISOString(), blockNumber: transfer.blockNumber, from: transfer.from, note: `${existing.note} · verificado en cadena` });
        if (existing.jobId) store.upsert("jobs", { id: existing.jobId, status: "verified" });
        verified += 1;
      } else {
        store.upsert("ledger", { kind: "received_onchain", amount: transfer.amount, asset: "USDC", txHash: transfer.txHash, network: config.x402.network, blockNumber: transfer.blockNumber, from: transfer.from, agentId: ctx.agent.id, verifiedAt: new Date().toISOString(), note: "Ingreso en cadena sin trabajo asociado" });
        unmatched += 1;
      }
    }
    store.upsert("services", { id: "chain-snapshot", slug: "_snapshot", hidden: true, balanceUsdc: balance, checkedAt: new Date().toISOString(), address });
    store.audit({ type: "reconciled", agentId: ctx.agent.id, balance, transfers: transfers.length, verified, unmatched });
    return { summary: `Saldo ${balance} USDC; ${verified} cobros verificados, ${unmatched} ingresos sin trabajo asociado`, balance, verified, unmatched };
  };
}
