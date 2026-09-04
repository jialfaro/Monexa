import { EventEmitter } from "node:events";

/** Bus de eventos en proceso. El dashboard lo consume por SSE. */
export const bus = new EventEmitter();
bus.setMaxListeners(100);

export function emit(type, payload = {}) {
  bus.emit("event", { type, at: new Date().toISOString(), ...payload });
}
