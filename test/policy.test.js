import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/core/store.js";
import { createRegistry } from "../src/agents/registry.js";
import { TEMPLATES, FORBIDDEN_CAPABILITIES } from "../src/agents/templates.js";
import { buildConfig } from "../src/core/config.js";

const config = buildConfig({ MAX_AGENTS: "3", MAX_DEPTH: "2", MAX_CHILDREN_PER_AGENT: "1" });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function makeRegistry(runners) {
  const store = createStore(null);
  const registry = createRegistry({ store, config, runners });
  return { store, registry };
}

test("ninguna plantilla tiene capacidades prohibidas", () => {
  for (const [name, spec] of Object.entries(TEMPLATES)) {
    for (const cap of spec.capabilities) assert.ok(!FORBIDDEN_CAPABILITIES.includes(cap), `${name} tiene ${cap}`);
  }
});

test("spawn rechaza plantilla desconocida y lo audita", async () => {
  const { store, registry } = makeRegistry({});
  await assert.rejects(registry.spawn({ template: "hacker" }), /Plantilla desconocida/);
  assert.equal(store.list("audit").at(-1).type, "spawn_denied");
});

test("cuota de agentes activos y profundidad", async () => {
  const forever = (ctx) => new Promise((resolve) => ctx.signal.addEventListener("abort", () => resolve({ summary: "fin" })));
  const { registry } = makeRegistry({ manager: forever, scout: forever, worker: forever, reviewer: forever });
  const manager = await registry.spawn({ template: "manager" });
  const worker = await registry.spawn({ template: "worker", parentId: manager.id });
  await assert.rejects(registry.spawn({ template: "scout", parentId: manager.id }), /hijos activos/);
  const reviewer = await registry.spawn({ template: "reviewer", parentId: worker.id });
  await assert.rejects(registry.spawn({ template: "reviewer", parentId: reviewer.id }), /Profundidad|Cuota|no puede crear/);
  assert.equal(registry.active().length, 3);
  registry.stop(manager.id);
  await wait(20);
  assert.equal(registry.active().length, 0, "detener al padre detiene a los hijos");
});

test("un scout no puede crear workers", async () => {
  const forever = (ctx) => new Promise((resolve) => ctx.signal.addEventListener("abort", () => resolve()));
  const { registry } = makeRegistry({ scout: forever, worker: forever });
  const scout = await registry.spawn({ template: "scout" });
  await assert.rejects(registry.spawn({ template: "worker", parentId: scout.id }), /no puede crear/);
  registry.stop(scout.id);
});

test("el informe del hijo llega al padre con waitFor", async () => {
  const { registry } = makeRegistry({ worker: async (ctx) => { const child = await ctx.spawnChild({ template: "reviewer" }); return ctx.waitFor(child.id); }, reviewer: async () => ({ summary: "ok", verdict: "approve" }) });
  const worker = await registry.spawn({ template: "worker" });
  const report = await registry.waitFor(worker.id);
  assert.equal(report.verdict, "approve");
});

test("el manager no supera MAX_CONCURRENT_WORKERS dentro de un mismo ciclo", async () => {
  const { createManagerRunner } = await import("../src/agents/manager.js");
  const cfg = buildConfig({ MAX_CONCURRENT_WORKERS: "2", MAX_AGENTS: "10", MAX_CHILDREN_PER_AGENT: "10" });
  cfg.policy.managerTickMs = 10;
  cfg.x402.enabled = false;
  const store = createStore(null);
  for (let i = 0; i < 5; i += 1) store.upsert("opportunities", { kind: "bounty", status: "qualified", score: 90, repo: "o/r", number: i, title: `t${i}` });
  const forever = (ctx) => new Promise((resolve) => ctx.signal.addEventListener("abort", () => resolve({ summary: "fin" })));
  const runners = { worker: forever, scout: async () => ({}), evaluator: async () => ({}) };
  const registry = createRegistry({ store, config: cfg, runners });
  const llm = { enabled: true, spentTodayUsd: () => 0 };
  runners.manager = createManagerRunner({ store, config: cfg, llm, registry, sources: [] });
  const manager = await registry.spawn({ template: "manager" });
  await wait(60);
  assert.equal(store.list("agents", (a) => a.template === "worker" && a.status === "running").length, 2);
  assert.equal(store.list("opportunities", (o) => o.status === "assigned").length, 2);
  registry.stop(manager.id);
  await wait(30);
});
