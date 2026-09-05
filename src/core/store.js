import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { emit } from "./bus.js";

/**
 * Persistencia JSON en disco con bitácora encadenada por hash.
 * Colecciones: agents, opportunities, jobs, ledger, audit, services, usage.
 */
export function createStore(filePath) {
  let state = emptyState();
  if (filePath && existsSync(filePath)) {
    try {
      state = { ...emptyState(), ...JSON.parse(readFileSync(filePath, "utf8")) };
    } catch (error) {
      console.error("No se pudo leer el estado, se inicia vacío:", error.message);
    }
  }
  let saveTimer = null;

  function save() {
    if (!filePath) return;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      mkdirSync(dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 2));
      renameSync(tmp, filePath);
    }, 150);
  }

  function upsert(collection, { id: givenId, ...record }) {
    const list = state[collection];
    const now = new Date().toISOString();
    const existing = givenId ? list.findIndex((item) => item.id === givenId) : -1;
    const next = existing === -1
      ? { id: givenId ?? randomUUID(), createdAt: now, ...record, updatedAt: now }
      : { ...list[existing], ...record, updatedAt: now };
    if (existing === -1) list.push(next);
    else list[existing] = next;
    save();
    emit(`${collection}:changed`, { record: next });
    return next;
  }

  function get(collection, id) {
    return state[collection].find((item) => item.id === id) ?? null;
  }

  function list(collection, predicate = () => true) {
    return state[collection].filter(predicate);
  }

  function audit(event) {
    const previousHash = state.audit.at(-1)?.hash ?? "genesis";
    const entry = { id: randomUUID(), at: new Date().toISOString(), ...event, previousHash };
    entry.hash = createHash("sha256").update(canonical({ ...entry, hash: undefined })).digest("hex");
    state.audit.push(entry);
    if (state.audit.length > 5000) state.audit.splice(0, state.audit.length - 5000);
    save();
    emit("audit", { entry });
    return entry;
  }

  function verifyAudit() {
    let previousHash = "genesis";
    for (const entry of state.audit) {
      if (entry.previousHash !== previousHash) return { ok: false, brokenAt: entry.id };
      const expected = createHash("sha256").update(canonical({ ...entry, hash: undefined })).digest("hex");
      if (expected !== entry.hash) return { ok: false, brokenAt: entry.id };
      previousHash = entry.hash;
    }
    return { ok: true, length: state.audit.length };
  }

  function addUsage(usage) {
    state.usage.push({ at: new Date().toISOString(), ...usage });
    if (state.usage.length > 20000) state.usage.splice(0, state.usage.length - 20000);
    save();
  }

  function usageSince(isoDate) {
    return state.usage.filter((u) => u.at >= isoDate);
  }

  return { state, upsert, get, list, audit, verifyAudit, addUsage, usageSince, save };
}

export function emptyState() {
  return {
    version: 2,
    agents: [],
    opportunities: [],
    jobs: [],
    ledger: [],
    services: [],
    audit: [],
    usage: [],
    trading: [],
    trades: [],
    signals: [],
    proposals: []
  };
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function contentHash(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
