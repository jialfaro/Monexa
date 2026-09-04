import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSwarm } from "./src/swarm.js";
import { bus } from "./src/core/bus.js";
import { startCloudflareTunnel } from "./src/core/tunnel.js";

const rootDirectory = fileURLToPath(new URL(".", import.meta.url));
const swarm = createSwarm({ rootDirectory });
const { config, store, registry, sellerService } = swarm;

const mimeTypes = { ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };

function resolvePublicFile(pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safe = normalize(decodeURIComponent(requested)).replace(/^([/\\])+/, "");
  const candidate = resolve(rootDirectory, "public", safe);
  return candidate.startsWith(resolve(rootDirectory, "public")) ? candidate : null;
}

function json(response, status, body, extraHeaders = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders });
  response.end(JSON.stringify(body));
}

async function readBody(request, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("Cuerpo demasiado grande");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

/** Una petición es local sólo si llega desde loopback, sin pasar por un túnel o proxy. */
function isLocal(request) {
  const address = request.socket.remoteAddress ?? "";
  const hostname = (request.headers.host ?? "").split(":")[0];
  const proxied = request.headers["cf-connecting-ip"] || request.headers["x-forwarded-for"] || request.headers["cf-ray"];
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address) && ["127.0.0.1", "localhost", "[::1]", ""].includes(hostname) && !proxied;
}

async function handleApi(request, response, url) {
  const [, , resource, id, action] = url.pathname.split("/");
  const method = request.method;

  if (method === "GET" && resource === "snapshot") return json(response, 200, swarm.snapshot());
  if (method === "GET" && resource === "health") return json(response, 200, { ok: true, agents: registry.active().length });


  if (method === "POST" && resource === "agents" && !id) {
    const body = await readBody(request);
    try {
      const agent = await registry.spawn({ template: body.template, goal: body.goal, parentId: body.parentId || null, requestedBy: "human", input: body.input ?? {} });
      return json(response, 201, agent);
    } catch (error) {
      return json(response, error.denied ? 409 : 500, { error: error.message });
    }
  }
  if (method === "POST" && resource === "agents" && id && action === "stop") {
    return json(response, 200, { stopped: registry.stop(id) });
  }
  if (method === "POST" && resource === "jobs" && id && action === "approve") {
    const job = store.get("jobs", id);
    if (!job || job.status !== "ready_for_review") return json(response, 409, { error: "El trabajo no está listo para aprobación" });
    if (!config.github.token) return json(response, 409, { error: "Configura GITHUB_TOKEN para enviar el PR" });
    store.audit({ type: "human_approved_submission", jobId: id, contentHash: job.updatedAt });
    try {
      const agent = await registry.spawn({ template: "worker", goal: `Enviar PR aprobado: ${job.title}`, requestedBy: "human", input: { jobId: id, submitOnly: true } });
      return json(response, 202, agent);
    } catch (error) {
      return json(response, 409, { error: error.message });
    }
  }
  if (method === "POST" && resource === "jobs" && id && action === "reject") {
    const job = store.get("jobs", id);
    if (!job) return json(response, 404, { error: "No existe" });
    store.upsert("jobs", { id, status: "rejected", finishedAt: new Date().toISOString() });
    if (job.opportunityId) store.upsert("opportunities", { id: job.opportunityId, status: "rejected", assignedAgentId: null });
    store.audit({ type: "human_rejected_submission", jobId: id });
    return json(response, 200, { ok: true });
  }
  if (method === "POST" && resource === "opportunities" && id === "reevaluate") {
    // Vuelve a poner en cola los bounties puntuados sin juicio del modelo; con {all:true}, todos los no iniciados.
    const body = await readBody(request).catch(() => ({}));
    const targets = store.list("opportunities", (o) => o.kind === "bounty" && ["rejected", "needs_review", "qualified"].includes(o.status) && (body.all || !o.evaluation?.judgement));
    for (const opp of targets) store.upsert("opportunities", { id: opp.id, status: "discovered", score: null, evaluation: null });
    store.audit({ type: "human_requested_reevaluation", count: targets.length });
    return json(response, 200, { requeued: targets.length });
  }
  if (method === "POST" && resource === "opportunities" && id && action === "requeue") {
    const opp = store.get("opportunities", id);
    if (!opp) return json(response, 404, { error: "No existe" });
    store.upsert("opportunities", { id, status: "qualified", assignedAgentId: null, score: Math.max(opp.score ?? 0, config.policy.minScore) });
    store.audit({ type: "human_requeued_opportunity", opportunityId: id });
    return json(response, 200, { ok: true });
  }
  if (method === "POST" && resource === "services" && id) {
    const body = await readBody(request);
    const service = store.get("services", id);
    if (!service) return json(response, 404, { error: "No existe" });
    const patch = { id };
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (Number.isFinite(Number(body.priceUsd)) && Number(body.priceUsd) > 0) patch.priceUsd = Number(body.priceUsd);
    store.upsert("services", patch);
    store.audit({ type: "human_updated_service", serviceId: id, patch });
    return json(response, 200, store.get("services", id));
  }
  return json(response, 404, { error: "Ruta no encontrada" });
}

async function handleX402(request, response, url) {
  const slug = url.pathname.split("/")[2];
  if (request.method === "GET") {
    const service = sellerService.services().find((s) => s.slug === slug && s.enabled);
    if (!service) return json(response, 404, { error: "Servicio no encontrado" });
    const requirements = sellerService.requirementsFor(service);
    return json(response, 402, requirements, { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(requirements)).toString("base64") });
  }
  if (request.method !== "POST") return json(response, 405, { error: "Usa POST" });
  let input;
  try { input = await readBody(request, 500_000); } catch (error) { return json(response, 400, { error: error.message }); }
  try {
    const outcome = await sellerService.handle(slug, request.headers, input);
    return json(response, outcome.status, outcome.body, outcome.headers);
  } catch (error) {
    return json(response, 502, { error: error.message });
  }
}

function handleEvents(request, response) {
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
  response.write(`event: hello\ndata: {}\n\n`);
  const listener = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
  bus.on("event", listener);
  const ping = setInterval(() => response.write(": ping\n\n"), 25_000);
  request.on("close", () => { bus.off("event", listener); clearInterval(ping); });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  try {
    if (url.pathname.startsWith("/x402/")) return await handleX402(request, response, url);
    if (url.pathname === "/.well-known/x402") {
      return json(response, 200, { x402Version: 2, services: sellerService.services().filter((s) => s.enabled).map((s) => ({ url: s.url, name: s.name, description: s.description, priceUsd: s.priceUsd })) });
    }
    // Desde fuera (túnel o red) sólo existen los servicios de pago; el dashboard y la API son locales.
    if (!isLocal(request)) return json(response, 404, { error: "No encontrado" });
    if (url.pathname.startsWith("/api/")) return await handleApi(request, response, url);
    if (url.pathname === "/events") return handleEvents(request, response);
    if (request.method !== "GET") return json(response, 405, { error: "Método no soportado" });
    const filePath = resolvePublicFile(url.pathname);
    if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) return json(response, 404, { error: "No encontrado" });
    response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": mimeTypes[extname(filePath)] ?? "application/octet-stream", "X-Content-Type-Options": "nosniff" });
    createReadStream(filePath).pipe(response);
  } catch (error) {
    if (!response.headersSent) json(response, 500, { error: error.message });
    else response.end();
  }
});

let tunnel = null;
server.listen(config.port, config.host, async () => {
  console.log(`Monexa dashboard: http://${config.host}:${config.port}`);
  if (config.tunnel === "cloudflare") {
    try {
      tunnel = await startCloudflareTunnel({ port: config.port });
      config.publicUrl = tunnel.url;
      store.audit({ type: "tunnel_started", provider: "cloudflare", url: tunnel.url });
      console.log(`Túnel público (Cloudflare, gratuito): ${tunnel.url} → sólo /x402/* y /.well-known/x402`);
    } catch (error) {
      store.audit({ type: "tunnel_failed", provider: "cloudflare", error: error.message });
      console.error(`Túnel no disponible: ${error.message}. Los servicios x402 sólo serán locales.`);
    }
  }
  console.log(`Red: ${config.x402.chain.label} · cobro a: ${config.x402.payTo || "(PAYTO_ADDRESS sin configurar)"} · LLM: ${swarm.llm.enabled ? "activo" : "sin clave"} · AUTO_SUBMIT: ${config.policy.autoSubmit}`);
  const manager = await swarm.start();
  console.log(`Manager ${manager.id} en marcha`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const agent of registry.active()) registry.stop(agent.id, "apagado del proceso");
    tunnel?.stop();
    store.save();
    setTimeout(() => process.exit(0), 300);
  });
}
