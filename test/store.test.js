import test from "node:test";
import assert from "node:assert/strict";
import { createStore, contentHash } from "../src/core/store.js";
import { summarizeLedger } from "../src/ledger.js";

test("la bitácora encadena hashes y detecta manipulación", () => {
  const store = createStore(null);
  store.audit({ type: "a" });
  store.audit({ type: "b" });
  assert.equal(store.verifyAudit().ok, true);
  store.state.audit[0].type = "tampered";
  assert.equal(store.verifyAudit().ok, false);
});

test("contentHash es canónico", () => {
  assert.equal(contentHash({ b: 1, a: [1, 2] }), contentHash({ a: [1, 2], b: 1 }));
  assert.notEqual(contentHash({ a: 1 }), contentHash({ a: 2 }));
});

test("el ledger separa estimado, reclamado y verificado", () => {
  const summary = summarizeLedger([
    { kind: "expected", amount: 500, asset: "USD" },
    { kind: "claimed", amount: 0.05, asset: "USDC" },
    { kind: "received_onchain", amount: 0.05, asset: "USDC" },
    { kind: "cost", amount: 0.01, asset: "USD" }
  ], [{ status: "working", expectedReward: { amount: 500, asset: "USD" } }, { status: "rejected", expectedReward: { amount: 900, asset: "USD" } }]);
  assert.equal(summary.verifiedUsd, 0.05);
  assert.equal(summary.byAsset.USD.expected, 500);
  assert.equal(summary.pipelineUsd, 500);
  assert.ok(Math.abs(summary.netUsd - 0.04) < 1e-9);
});

test("upsert con id indefinido crea registros distintos", () => {
  const store = createStore(null);
  store.upsert("services", { id: undefined, slug: "a" });
  store.upsert("services", { id: undefined, slug: "b" });
  const created = store.upsert("services", { id: "fixed", slug: "c" });
  store.upsert("services", { id: "fixed", slug: "c2" });
  assert.equal(store.list("services").length, 3);
  assert.equal(store.get("services", "fixed").slug, "c2");
  assert.equal(created.id, "fixed");
});
