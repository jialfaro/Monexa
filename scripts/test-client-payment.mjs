#!/usr/bin/env node
/**
 * Script de prueba de cliente x402 para Monexa.
 * Simula el flujo completo de cliente:
 * 1. Petición inicial a /x402/smart-contract-audit
 * 2. Recepción del desafío 402 con cabecera PAYMENT-REQUIRED
 * 3. Inspección de los requerimientos de la red Base (USDC, PayTo, Amount)
 */

const targetUrl = process.argv[2] || "http://127.0.0.1:4173/x402/smart-contract-audit";

console.log(`[x402-client] Probando endpoint: ${targetUrl}`);

const samplePayload = {
  contract: `
    pragma solidity ^0.8.0;
    contract Vault {
      mapping(address => uint) balances;
      function withdraw() public {
        (bool s, ) = msg.sender.call{value: balances[msg.sender]}("");
        balances[msg.sender] = 0;
      }
    }
  `
};

async function run() {
  console.log("[x402-client] 1. Enviando petición inicial sin pago...");
  const res = await fetch(targetUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(samplePayload)
  });

  console.log(`[x402-client] Estado HTTP recibido: ${res.status} ${res.statusText}`);

  if (res.status === 402) {
    const paymentRequiredHeader = res.headers.get("PAYMENT-REQUIRED");
    const jsonBody = await res.json();
    console.log("[x402-client] ✅ Desafío 402 recibido correctamente.");
    console.log("[x402-client] Requisitos de pago:");
    console.log(`  - Red: ${jsonBody.accepts[0].network}`);
    console.log(`  - Contrato Token: ${jsonBody.accepts[0].asset} (${jsonBody.accepts[0].extra?.name})`);
    console.log(`  - Dirección de cobro: ${jsonBody.accepts[0].payTo}`);
    console.log(`  - Importe requerido: ${Number(jsonBody.accepts[0].amount) / 1e6} USDC`);
    console.log(`  - Esquema: ${jsonBody.accepts[0].scheme}`);
    if (jsonBody.extensions?.bazaar) {
      console.log("  - Compatible con Coinbase Bazaar: Sí");
    }
    console.log("\n[x402-client] Para liquidar este pago en Base, un cliente o agente firma una autorización EIP-3009 y la envía en la cabecera 'PAYMENT-SIGNATURE'.");
  } else {
    console.log("[x402-client] Respuesta:", await res.text());
  }
}

run().catch(console.error);
