/**
 * Consultas de sólo lectura a una cadena EVM por JSON-RPC. No hay claves privadas ni firmas aquí.
 */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export function createEvmReader({ rpcUrl, usdc, fetchImpl = fetch }) {
  let rpcId = 1;

  async function rpc(method, params) {
    const response = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params })
    });
    const body = await response.json();
    if (body.error) throw new Error(`RPC ${method}: ${body.error.message}`);
    return body.result;
  }

  function padAddress(address) {
    return "0x" + address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  }

  async function blockNumber() {
    return Number.parseInt(await rpc("eth_blockNumber", []), 16);
  }

  /** Saldo USDC (6 decimales) de una dirección pública. */
  async function usdcBalance(address) {
    const data = "0x70a08231" + padAddress(address).slice(2);
    const result = await rpc("eth_call", [{ to: usdc, data }, "latest"]);
    return Number(BigInt(result)) / 1e6;
  }

  /** Transferencias USDC recibidas por `address` en las últimas `lookbackBlocks`. */
  async function incomingUsdcTransfers(address, { lookbackBlocks = 20_000, chunk = 5_000 } = {}) {
    const latest = await blockNumber();
    const from = Math.max(0, latest - lookbackBlocks);
    const transfers = [];
    for (let start = from; start <= latest; start += chunk) {
      const end = Math.min(latest, start + chunk - 1);
      const logs = await rpc("eth_getLogs", [{
        address: usdc,
        fromBlock: "0x" + start.toString(16),
        toBlock: "0x" + end.toString(16),
        topics: [TRANSFER_TOPIC, null, padAddress(address)]
      }]);
      for (const log of logs) {
        transfers.push({
          txHash: log.transactionHash,
          blockNumber: Number.parseInt(log.blockNumber, 16),
          from: "0x" + log.topics[1].slice(26),
          amount: Number(BigInt(log.data)) / 1e6
        });
      }
    }
    return transfers;
  }

  return { rpc, blockNumber, usdcBalance, incomingUsdcTransfers };
}
