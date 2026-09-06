import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSwarm } from "./src/swarm.js";
import { bus } from "./src/core/bus.js";
import { startCloudflareTunnel, startNgrokTunnel } from "./src/core/tunnel.js";

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
  if (method === "POST" && resource === "trader" && id === "backtest") {
    const { runBacktest } = await import("./src/trading/backtest.js");
    const candlesByProduct = {};
    for (const product of config.trader.watchlist) candlesByProduct[product] = await swarm.market.candles(product, config.trader.granularity, 300);
    const report = runBacktest({ config, candlesByProduct });
    store.upsert("trading", { id: "backtest", ...report, granularity: config.trader.granularity, at: new Date().toISOString() });
    store.audit({ type: "human_ran_backtest", strategies: Object.keys(report.results) });
    return json(response, 200, report);
  }
  if (method === "POST" && resource === "trader" && id === "reset") {
    swarm.book.reset();
    for (const c of ["signals", "trades", "proposals"]) store.state[c].length = 0;
    store.state.ledger = store.state.ledger.filter((l) => l.agentId !== "trader" && !l.proposalId);
    store.save();
    store.audit({ type: "human_reset_trading_portfolio" });
    return json(response, 200, { ok: true, summary: swarm.book.summary() });
  }
  if (method === "POST" && resource === "trader" && id === "scan") {
    try {
      const scanResult = await swarm.triggerTraderScan();
      return json(response, 200, scanResult);
    } catch (error) {
      return json(response, 500, { ok: false, error: error.message });
    }
  }
  if (method === "POST" && resource === "trader" && id === "proposals" && action) {
    const body = await readBody(request).catch(() => ({}));
    const proposal = store.get("proposals", action);
    if (!proposal) return json(response, 404, { error: "No existe" });
    const status = body.status === "executed" ? "executed_by_human" : "dismissed";
    const profitUsd = Number(body.profitUsd) || 0;
    store.upsert("proposals", {
      id: action,
      status,
      resolvedAt: new Date().toISOString(),
      humanPrice: Number(body.price) || null,
      realizedProfitUsd: profitUsd > 0 ? profitUsd : null,
      note: String(body.note ?? "").slice(0, 300)
    });
    if (status === "executed_by_human" && profitUsd > 0) {
      store.upsert("ledger", {
        kind: "claimed",
        amount: Number(profitUsd.toFixed(2)),
        asset: "USDC",
        network: "eip155:8453",
        proposalId: action,
        note: `Ganancia real DEX en Base: ${proposal.product} (+${profitUsd.toFixed(2)} USDC)`,
        agentId: "trader"
      });
    }
    store.audit({ type: "human_resolved_trade_proposal", proposalId: action, status, profitUsd });
    return json(response, 200, store.get("proposals", action));
  }
  if (method === "GET" && resource === "trader" && id === "wallet") {
    try {
      const balances = await swarm.swapper.getWalletBalances();
      return json(response, 200, {
        ok: true,
        ...balances,
        executionMode: config.trader.executionMode,
        maxOrderUsd: config.trader.maxOrderUsd,
        slippageTolerancePct: config.trader.slippageTolerancePct,
        minEthGas: config.trader.minEthGas
      });
    } catch (error) {
      return json(response, 500, { ok: false, error: error.message });
    }
  }
  if (method === "POST" && resource === "trader" && id === "mode") {
    const body = await readBody(request).catch(() => ({}));
    const newMode = body.mode === "manual" ? "manual" : "auto";
    config.trader.executionMode = newMode;
    store.audit({ type: "trader_mode_changed", executionMode: newMode });
    return json(response, 200, {
      ok: true,
      executionMode: newMode,
      statusText: newMode === "auto" ? "Modo automático activado (swaps on-chain autónomos)" : "Modo manual activado (solo propuestas y enlaces a Uniswap)"
    });
  }
  if (method === "POST" && resource === "trader" && id === "buy-now") {
    const body = await readBody(request).catch(() => ({}));
    const product = body.product || "AERO-USD";
    const amountUsd = Number(body.amountUsd) || 2;
    try {
      const price = (store.get("trading", "market")?.prices?.[product]) || 1;
      const result = await swarm.swapper.executeBuy({ product, usdAmount: amountUsd, currentPrice: price });
      store.upsert("trades", {
        kind: "real_onchain_buy",
        side: "buy",
        product,
        price,
        usd: amountUsd,
        txHash: result.txHash,
        basescanUrl: result.basescanUrl,
        at: new Date().toISOString(),
        reason: "Compra manual directa on-chain desde Hot Wallet"
      });
      return json(response, 200, result);
    } catch (error) {
      return json(response, 500, { ok: false, error: error.message });
    }
  }
  if (method === "GET" && resource === "trader" && id === "onchain") {
    try {
      const address = config.x402.payTo;
      const [usdc, eth, block] = await Promise.all([
        swarm.evm.usdcBalance(address).catch(() => 0),
        swarm.evm.ethBalance(address).catch(() => 0),
        swarm.evm.blockNumber().catch(() => 0)
      ]);
      return json(response, 200, {
        ok: true,
        address,
        network: config.x402.network,
        networkLabel: config.x402.chain.label,
        usdcBalance: usdc,
        ethBalance: eth,
        latestBlock: block
      });
    } catch (error) {
      return json(response, 500, { ok: false, error: error.message });
    }
  }
  if (method === "POST" && resource === "trader" && id === "execute-onchain") {
    try {
      const body = await readBody(request).catch(() => ({}));
      const { proposalId, txHash, profitUsd } = body;
      const proposal = store.get("proposals", proposalId);
      if (!proposal) return json(response, 404, { error: "Propuesta no encontrada" });

      let receipt = null;
      if (txHash && /^0x[a-fA-F0-9]{64}$/.test(txHash)) {
        receipt = await swarm.evm.getTransactionReceipt(txHash).catch(() => null);
      }

      const verified = receipt && (receipt.status === "0x1" || receipt.status === 1);
      const basescanUrl = txHash ? `https://basescan.org/tx/${txHash}` : null;
      const pnlNum = Number(profitUsd) || proposal.potentialGainUsd || 0;

      store.upsert("proposals", {
        id: proposalId,
        status: "executed_real_onchain",
        txHash: txHash || null,
        basescanUrl,
        realizedProfitUsd: pnlNum > 0 ? pnlNum : null,
        resolvedAt: new Date().toISOString(),
        verifiedOnChain: Boolean(verified)
      });

      if (pnlNum > 0) {
        store.upsert("ledger", {
          kind: "claimed",
          amount: Number(pnlNum.toFixed(2)),
          asset: "USDC",
          network: "eip155:8453",
          txHash: txHash || undefined,
          proposalId,
          note: `Swap Real en Base (${proposal.product}): +$${pnlNum.toFixed(2)} USDC${txHash ? ` · tx ${txHash.slice(0, 10)}…` : ""}`,
          agentId: "trader"
        });
      }

      store.upsert("trades", {
        kind: "real_onchain",
        side: proposal.action,
        product: proposal.product,
        price: proposal.price,
        usd: proposal.sizeUsd,
        pnl: pnlNum,
        txHash,
        at: new Date().toISOString(),
        reason: `Swap DEX On-Chain en Base (${proposal.strategyLabel})`
      });

      store.audit({ type: "real_dex_trade_confirmed", proposalId, txHash, verified, pnlNum });
      return json(response, 200, { ok: true, verified, txHash, basescanUrl, profitUsd: pnlNum });
    } catch (error) {
      return json(response, 500, { ok: false, error: error.message });
    }
  }
  if (method === "POST" && resource === "llm" && id === "reset") {
    const body = await readBody(request).catch(() => ({}));
    const cleared = swarm.llm.reset(body.key || null);
    store.audit({ type: "human_reset_llm_availability", key: body.key || "all", cleared });
    return json(response, 200, { cleared, available: swarm.llm.available("worker") });
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
      return json(response, 200, {
        x402Version: 2,
        services: sellerService.services().filter((s) => s.enabled).map((s) => ({
          url: s.url,
          name: s.name,
          slug: s.slug,
          tags: s.tags,
          description: s.description,
          priceUsd: s.priceUsd,
          inputSchema: s.inputSchema,
          outputExample: s.outputExample
        }))
      });
    }
    // Rutas dedicadas al portal de microservicios Web3
    if (url.pathname === "/portal" || url.pathname === "/portal.html") {
      const filePath = resolve(rootDirectory, "public", "portal.html");
      if (existsSync(filePath)) {
        response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff" });
        return createReadStream(filePath).pipe(response);
      }
    }

    // API pública y de control (snapshot, health, agents, etc.)
    if (url.pathname.startsWith("/api/")) return await handleApi(request, response, url);

    // Stream SSE de eventos en tiempo real
    if (url.pathname === "/events") return handleEvents(request, response);

    // Métodos soportados para archivos estáticos (GET y HEAD)
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json(response, 405, { error: "Método no soportado" });
    }

    const filePath = resolvePublicFile(url.pathname);
    if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
      return json(response, 404, { error: "No encontrado" });
    }

    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": mimeTypes[extname(filePath)] ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff"
    });
    if (request.method === "HEAD") return response.end();
    createReadStream(filePath).pipe(response);
  } catch (error) {
    if (!response.headersSent) json(response, 500, { error: error.message });
    else response.end();
  }
});

let tunnel = null;
server.listen(config.port, config.host, async () => {
  console.log(`Monexa dashboard local: http://${config.host}:${config.port}`);
  if (config.lanIp && config.lanIp !== "127.0.0.1") {
    console.log(`Acceso móvil Wi-Fi LAN: http://${config.lanIp}:${config.port}`);
  }
  if (["cloudflare", "ngrok"].includes(config.tunnel)) {
    try {
      tunnel = config.tunnel === "ngrok"
        ? await startNgrokTunnel({ port: config.port, domain: config.ngrok.domain, authtoken: config.ngrok.authtoken })
        : await startCloudflareTunnel({ port: config.port, token: config.cloudflare.token, fixedUrl: config.cloudflare.url });
      config.publicUrl = tunnel.url;
      store.audit({ type: "tunnel_started", provider: config.tunnel, url: tunnel.url });
      console.log(`Acceso móvil global (Internet / 4G / 5G): ${tunnel.url}`);
    } catch (error) {
      store.audit({ type: "tunnel_failed", provider: config.tunnel, error: error.message });
      console.error(`Túnel no disponible: ${error.message}.`);
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
