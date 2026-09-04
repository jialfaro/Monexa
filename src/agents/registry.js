import { randomUUID } from "node:crypto";
import { TEMPLATES } from "./templates.js";
import { emit } from "../core/bus.js";

/**
 * Registro de agentes: creación acotada por cuotas, árbol padre/hijo, ciclo de vida y reportes.
 * Un agente es una función asíncrona con contexto; el registro conoce su AbortController.
 */
export function createRegistry({ store, config, runners }) {
  const controllers = new Map();
  const runs = new Map();

  function active() {
    return store.list("agents", (a) => ["running", "starting"].includes(a.status));
  }

  function checkSpawn({ template, parentId, requestedBy }) {
    const spec = TEMPLATES[template];
    if (!spec) return { ok: false, reason: `Plantilla desconocida: ${template}` };
    const parent = parentId ? store.get("agents", parentId) : null;
    if (parentId && !parent) return { ok: false, reason: "Padre inexistente" };
    if (parent && !["running", "starting"].includes(parent.status)) return { ok: false, reason: "El padre ya no está activo" };
    if (parent && !TEMPLATES[parent.template].spawnable.includes(template) && requestedBy !== "human") {
      return { ok: false, reason: `${parent.template} no puede crear ${template}` };
    }
    const depth = parent ? parent.depth + 1 : 0;
    if (depth > config.policy.maxDepth) return { ok: false, reason: `Profundidad máxima ${config.policy.maxDepth} superada` };
    if (active().length >= config.policy.maxAgents) return { ok: false, reason: `Cuota de agentes activos (${config.policy.maxAgents}) alcanzada` };
    if (parent) {
      const siblings = active().filter((a) => a.parentId === parent.id).length;
      if (siblings >= config.policy.maxChildrenPerAgent) return { ok: false, reason: `El padre ya tiene ${siblings} hijos activos` };
    }
    return { ok: true, depth, spec };
  }

  async function spawn({ template, goal, parentId = null, requestedBy = "system", input = {} }) {
    const check = checkSpawn({ template, parentId, requestedBy });
    if (!check.ok) {
      store.audit({ type: "spawn_denied", template, parentId, requestedBy, reason: check.reason });
      const error = new Error(check.reason);
      error.denied = true;
      throw error;
    }
    const id = randomUUID();
    const record = store.upsert("agents", {
      id,
      template,
      label: check.spec.label,
      goal: goal || check.spec.description,
      parentId,
      depth: check.depth,
      capabilities: [...check.spec.capabilities],
      requestedBy,
      status: "starting",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      report: null,
      stats: { llmCostUsd: 0, llmCalls: 0, fetches: 0 },
      log: []
    });
    store.audit({ type: "agent_spawned", agentId: id, template, parentId, requestedBy, goal: record.goal });
    runs.set(id, run(record, input));
    return record;
  }

  function log(agentId, message, extra = {}) {
    const agent = store.get("agents", agentId);
    if (!agent) return;
    const line = { at: new Date().toISOString(), message: String(message).slice(0, 500), ...extra };
    const next = [...(agent.log ?? []), line].slice(-60);
    store.upsert("agents", { id: agentId, log: next });
    emit("agent:log", { agentId, line });
  }

  function addCost(agentId, costUsd) {
    const agent = store.get("agents", agentId);
    if (!agent) return;
    store.upsert("agents", { id: agentId, stats: { ...agent.stats, llmCostUsd: (agent.stats.llmCostUsd ?? 0) + costUsd, llmCalls: (agent.stats.llmCalls ?? 0) + 1 } });
  }

  function makeContext(record, input) {
    const controller = new AbortController();
    controllers.set(record.id, controller);
    return {
      agent: record,
      input,
      signal: controller.signal,
      log: (message, extra) => log(record.id, message, extra),
      addCost: (cost) => addCost(record.id, cost),
      spawnChild: (params) => spawn({ ...params, parentId: record.id, requestedBy: record.template }),
      children: () => store.list("agents", (a) => a.parentId === record.id),
      waitFor
    };
  }

  async function run(record, input) {
    const runner = runners[record.template];
    const ctx = makeContext(record, input);
    store.upsert("agents", { id: record.id, status: "running" });
    try {
      const report = await runner(ctx);
      store.upsert("agents", { id: record.id, status: "done", finishedAt: new Date().toISOString(), report: report ?? null });
      store.audit({ type: "agent_finished", agentId: record.id, template: record.template, summary: report?.summary ?? null });
    } catch (error) {
      const status = ctx.signal.aborted ? "stopped" : "failed";
      store.upsert("agents", { id: record.id, status, finishedAt: new Date().toISOString(), report: { error: error.message } });
      store.audit({ type: "agent_failed", agentId: record.id, template: record.template, error: error.message });
      log(record.id, `Error: ${error.message}`, { level: "error" });
    } finally {
      controllers.delete(record.id);
    }
    return store.get("agents", record.id)?.report ?? null;
  }

  /** Espera a que un agente termine y devuelve su informe. */
  async function waitFor(agentId) {
    const pending = runs.get(agentId);
    if (pending) {
      const report = await pending;
      runs.delete(agentId);
      return report;
    }
    return store.get("agents", agentId)?.report ?? null;
  }

  function stop(agentId, reason = "detenido por la persona") {
    const controller = controllers.get(agentId);
    if (controller) controller.abort(reason);
    for (const child of store.list("agents", (a) => a.parentId === agentId && ["running", "starting"].includes(a.status))) {
      stop(child.id, `padre detenido: ${reason}`);
    }
    store.audit({ type: "agent_stop_requested", agentId, reason });
    return Boolean(controller);
  }

  function tree() {
    const agents = store.list("agents");
    const byParent = new Map();
    for (const agent of agents) {
      const key = agent.parentId ?? "root";
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(agent);
    }
    const build = (parentKey) => (byParent.get(parentKey) ?? []).map((a) => ({ ...a, children: build(a.id) }));
    return build("root");
  }

  /** Marca como fallidos los agentes que quedaron "running" en un arranque anterior. */
  function recoverStale() {
    for (const agent of active()) {
      store.upsert("agents", { id: agent.id, status: "failed", finishedAt: new Date().toISOString(), report: { error: "Proceso reiniciado" } });
    }
  }

  return { spawn, stop, tree, active, checkSpawn, log, recoverStale, waitFor, TEMPLATES };
}
