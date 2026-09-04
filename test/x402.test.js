import test from "node:test";
import assert from "node:assert/strict";
import { buildPaymentRequired, handlePaidRequest, encodeHeader, decodeHeader, readPaymentHeader, usdToAtomic } from "../src/x402/server.js";

const requirements = buildPaymentRequired({ resourceUrl: "https://example.com/x402/summarize", description: "Resumen", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x1111111111111111111111111111111111111111", amountUsd: 0.01, serviceName: "Resumen", inputSchema: { type: "object" }, outputExample: { summary: "x" } });

test("el 402 sigue el esquema x402 v2", () => {
  assert.equal(requirements.x402Version, 2);
  assert.equal(requirements.accepts[0].scheme, "exact");
  assert.equal(requirements.accepts[0].amount, "10000");
  assert.deepEqual(requirements.accepts[0].extra, { name: "USDC", version: "2" });
  assert.ok(requirements.extensions.bazaar);
  assert.equal(usdToAtomic(1.5), "1500000");
});

test("sin pago responde 402 con cabecera PAYMENT-REQUIRED", async () => {
  const outcome = await handlePaidRequest({ requirements, paymentPayload: null, facilitator: {}, handler: async () => ({}) , input: {} });
  assert.equal(outcome.status, 402);
  assert.equal(decodeHeader(outcome.headers["PAYMENT-REQUIRED"]).accepts[0].payTo, requirements.accepts[0].payTo);
});

test("pago inválido no ejecuta el trabajo", async () => {
  let executed = false;
  const facilitator = { verify: async () => ({ isValid: false, invalidReason: "insufficient_funds" }) };
  const outcome = await handlePaidRequest({ requirements, paymentPayload: { x402Version: 2 }, facilitator, handler: async () => { executed = true; }, input: {} });
  assert.equal(outcome.status, 402);
  assert.equal(executed, false);
  assert.match(outcome.body.error, /insufficient/);
});

test("pago válido ejecuta, liquida y devuelve PAYMENT-RESPONSE", async () => {
  const calls = [];
  const facilitator = {
    verify: async () => { calls.push("verify"); return { isValid: true, payer: "0xabc" }; },
    settle: async () => { calls.push("settle"); return { success: true, transaction: "0xtx", network: "eip155:8453", payer: "0xabc" }; }
  };
  const outcome = await handlePaidRequest({ requirements, paymentPayload: { x402Version: 2 }, facilitator, handler: async (input) => ({ echo: input.text }), input: { text: "hola" } });
  assert.equal(outcome.status, 200);
  assert.deepEqual(calls, ["verify", "settle"]);
  assert.equal(outcome.body.echo, "hola");
  assert.equal(decodeHeader(outcome.headers["PAYMENT-RESPONSE"]).transaction, "0xtx");
  assert.equal(outcome.settlement.amountAtomic, "10000");
});

test("lee cabeceras v2 y v1", () => {
  const payload = { x402Version: 2, payload: {} };
  assert.deepEqual(readPaymentHeader({ "payment-signature": encodeHeader(payload) }), payload);
  assert.deepEqual(readPaymentHeader({ "x-payment": encodeHeader(payload) }), payload);
  assert.equal(readPaymentHeader({}), null);
  assert.equal(readPaymentHeader({ "payment-signature": "%%%" }).invalid, true);
});
