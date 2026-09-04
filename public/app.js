const $ = (selector) => document.querySelector(selector);
let snapshot = null;
let refreshTimer = null;

const STATUS_LABEL = {
  discovered: "descubierta", qualified: "calificada", needs_review: "revisar", rejected: "descartada", insight: "mercado",
  assigned: "asignada", working: "en curso", ready_for_review: "lista para aprobar", submitted: "enviada", abandoned: "abandonada",
  in_progress: "en curso", review: "en revisión", submitting: "enviando", paid: "cobrado", verified: "verificado",
  running: "activo", starting: "iniciando", done: "terminado", failed: "falló", stopped: "detenido"
};
const label = (s) => STATUS_LABEL[s] ?? s;
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n, asset = "USD") => `${Number(n ?? 0).toLocaleString("es", { maximumFractionDigits: asset === "USD" || asset === "USDC" ? 2 : 6 })} ${asset}`;
const when = (iso) => iso ? new Date(iso).toLocaleString("es", { dateStyle: "short", timeStyle: "short" }) : "";
const link = (url, text) => url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(text ?? url)}</a>` : "";

async function api(path, body) {
  const response = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? response.statusText);
  return data;
}

async function refresh() {
  snapshot = await api("/api/snapshot");
  render();
}

function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; refresh().catch(console.error); }, 400);
}

function render() {
  const { config, metrics } = snapshot;
  $("#status").innerHTML = [
    `<span class="pill ${config.llmEnabled ? "good" : "bad"}" title="${esc((config.llmProviders ?? []).map((p) => `${p.name}: ${p.worker} / ${p.scout}`).join(" · "))}">LLM ${config.llmEnabled ? `${config.llmProvider} · ${config.workerModel}${(config.llmProviders?.length ?? 0) > 1 ? ` (+${config.llmProviders.length - 1} respaldo)` : ""}` : "sin clave"}</span>`,
    `<span class="pill ${config.payTo ? "good" : "warn"}">${esc(config.chain)} · ${config.payTo ? esc(config.payTo.slice(0, 6) + "…" + config.payTo.slice(-4)) : "sin dirección"}</span>`,
    `<span class="pill ${config.githubToken ? "good" : "warn"}">GitHub ${config.githubToken ? "token" : "sin token"}</span>`,
    `<span class="pill ${config.autoSubmit ? "info" : ""}">Envío ${config.autoSubmit ? "automático" : "con aprobación"}</span>`,
    `<span class="pill ${config.publicUrl.startsWith("https://") ? "good" : "warn"}">Público: ${esc(config.publicUrl.replace(/^https?:\/\//, ""))}</span>`,
    `<span class="pill">${metrics.activeAgents} agentes activos</span>`
  ].join("");

  const tiles = [
    ["Verificado en cadena", money(metrics.verifiedUsd, "USDC"), "USDC visto en la blockchain"],
    ["Reclamado", money(metrics.byAsset?.USDC?.claimed ?? 0, "USDC"), "liquidado por el facilitador, sin log aún"],
    ["En pipeline", money(metrics.pipelineUsd), "recompensas anunciadas de trabajos en curso"],
    ["Coste LLM hoy", money(metrics.llmSpentTodayUsd), `de ${money(config.dailyBudgetUsd)} de presupuesto`],
    ["Neto verificado", money(metrics.netUsd), "verificado menos costes"],
    ["Saldo USDC", metrics.chainBalanceUsdc == null ? "—" : money(metrics.chainBalanceUsdc, "USDC"), metrics.chainCheckedAt ? `consultado ${when(metrics.chainCheckedAt)}` : "sin conciliar todavía"],
    ["Oportunidades", Object.values(metrics.opportunities).reduce((a, b) => a + b, 0), Object.entries(metrics.opportunities).map(([k, v]) => `${v} ${label(k)}`).join(" · ") || "ninguna"],
    ["Trabajos", Object.values(metrics.jobs).reduce((a, b) => a + b, 0), Object.entries(metrics.jobs).map(([k, v]) => `${v} ${label(k)}`).join(" · ") || "ninguno"]
  ];
  $("#tiles").innerHTML = tiles.map(([l, v, s]) => `<div class="tile"><div class="label">${esc(l)}</div><div class="value">${esc(v)}</div><div class="sub">${esc(s)}</div></div>`).join("");

  const alerts = [];
  if (!config.llmEnabled) alerts.push("Falta una clave de modelo (ANTHROPIC_API_KEY, OPENAI_API_KEY o GEMINI_API_KEY): los agentes exploran y puntúan, pero no pueden ejecutar trabajos ni vender servicios.");
  if (!config.payTo) alerts.push("Falta PAYTO_ADDRESS: no hay dirección pública donde recibir USDC, así que no hay vendedor ni conciliación.");
  if (!config.githubToken) alerts.push("Falta GITHUB_TOKEN: los entregables se guardan pero nadie puede abrir el PR.");
  if (config.publicUrl.includes("127.0.0.1") || config.publicUrl.includes("localhost")) alerts.push(`PUBLIC_URL es ${config.publicUrl}: los servicios x402 sólo son alcanzables desde esta máquina. Pon TUNNEL=cloudflare en .env para abrir un túnel gratuito.`);
  if (config.network === "eip155:84532") alerts.push("Red de pruebas Base Sepolia: los USDC recibidos no tienen valor real. Cambia X402_NETWORK a eip155:8453 para Base.");
  $("#alerts").innerHTML = alerts.length ? alerts.map((a) => `<li>${esc(a)}</li>`).join("") : "<li>Configuración completa.</li>";
  $("#activity").innerHTML = snapshot.audit.slice(0, 25).map((e) => `<li>${esc(when(e.at))} · ${esc(e.type)} ${esc(e.summary ?? e.reason ?? e.url ?? e.goal ?? "")}</li>`).join("");

  renderAgents();
  renderOpportunities();
  renderJobs();
  renderServices();
  renderLedger();
  renderAudit();
}

function renderAgents() {
  const templateSelect = $("#spawn-template");
  const current = templateSelect.value;
  templateSelect.innerHTML = Object.entries(snapshot.templates).map(([k, t]) => `<option value="${k}">${esc(t.label)} — ${esc(t.description)}</option>`).join("");
  if (current) templateSelect.value = current;
  const parentSelect = $("#spawn-parent");
  const currentParent = parentSelect.value;
  parentSelect.innerHTML = `<option value="">Sin padre (raíz)</option>` + snapshot.agents.filter((a) => ["running", "starting"].includes(a.status)).map((a) => `<option value="${a.id}">${esc(a.label)} · ${esc(a.goal.slice(0, 40))}</option>`).join("");
  parentSelect.value = currentParent;
  const q = snapshot.config.quotas;
  $("#spawn-help").textContent = `Cuotas: ${q.maxAgents} agentes activos, profundidad ${q.maxDepth}, ${q.maxChildrenPerAgent} hijos por agente, ${q.maxConcurrentWorkers} workers simultáneos. Ninguna plantilla puede firmar, transferir ni leer secretos.`;

  const node = (a) => `<li><div class="agent">
    <div class="head"><span class="dot ${esc(a.status)}"></span><strong>${esc(a.label)}</strong><span class="pill">${esc(label(a.status))}</span><span class="muted">${esc(a.requestedBy)} · ${esc(when(a.startedAt))}</span>
      <span class="muted">${(a.stats?.llmCostUsd ?? 0).toFixed(3)} USD LLM${a.stats?.sales ? ` · ${a.stats.sales} ventas` : ""}</span>
      ${["running", "starting"].includes(a.status) ? `<button class="danger" data-stop="${a.id}">Detener</button>` : ""}</div>
    <div class="goal">${esc(a.goal)}</div>
    ${a.report?.summary ? `<div class="muted">Informe: ${esc(a.report.summary)}</div>` : a.report?.error ? `<div class="muted">Error: ${esc(a.report.error)}</div>` : ""}
    ${a.log?.length ? `<details><summary>Registro (${a.log.length})</summary><div class="log">${a.log.slice(-15).map((l) => `${esc(when(l.at))} ${esc(l.message)}`).join("\n")}</div></details>` : ""}
  </div>${a.children?.length ? `<ul>${a.children.map(node).join("")}</ul>` : ""}</li>`;
  $("#agent-tree").innerHTML = snapshot.agentsTree.length ? `<ul class="tree">${snapshot.agentsTree.map(node).join("")}</ul>` : "<p class='muted'>Sin agentes todavía.</p>";
}

function renderOpportunities() {
  const filter = $("#opp-filter").value.toLowerCase();
  const rows = snapshot.opportunities.filter((o) => !filter || `${o.title} ${o.source} ${o.status} ${label(o.status)} ${o.repo ?? ""}`.toLowerCase().includes(filter));
  $("#opp-table tbody").innerHTML = rows.slice(0, 300).map((o) => {
    const agent = snapshot.agents.find((a) => a.id === o.assignedAgentId);
    const reward = o.expectedReward ? money(o.expectedReward.amount, o.expectedReward.asset) : o.pricePerCallUsd != null ? `${o.pricePerCallUsd} USD/llamada` : "—";
    const extra = o.kind === "market" ? `<div class="muted">${o.demand?.calls30d ?? 0} llamadas · ${o.demand?.payers30d ?? 0} pagadores (30d)</div>` : o.evaluation?.judgement?.reason ? `<div class="muted">${esc(o.evaluation.judgement.reason)}</div>` : "";
    const canRequeue = ["needs_review", "rejected", "abandoned"].includes(o.status) && o.kind === "bounty";
    return `<tr><td class="num">${o.score ?? "—"}</td><td><span class="pill">${esc(label(o.status))}</span></td><td>${esc(o.source)}</td>
      <td>${link(o.url, o.title)}${o.repo ? `<div class="muted">${esc(o.repo)}#${o.number}</div>` : ""}${extra}</td>
      <td class="num">${esc(reward)}</td><td>${(o.riskFlags ?? []).map((r) => `<span class="pill warn">${esc(r)}</span>`).join(" ")}</td>
      <td>${agent ? esc(agent.label) : ""}</td><td>${canRequeue ? `<button class="secondary" data-requeue="${o.id}">Encolar</button>` : ""}</td></tr>`;
  }).join("") || `<tr><td colspan="8" class="muted">Sin oportunidades. Los scouts se ejecutan al arrancar y cada intervalo configurado.</td></tr>`;
}

function renderJobs() {
  $("#jobs").innerHTML = snapshot.jobs.map((j) => {
    const agent = snapshot.agents.find((a) => a.id === j.agentId);
    const opp = snapshot.opportunities.find((o) => o.id === j.opportunityId);
    const head = j.kind === "x402_sale"
      ? `<strong>Venta x402: ${esc(j.title)}</strong> <span class="pill good">${money(j.amountUsd, "USDC")}</span>`
      : `<strong>${link(j.sourceUrl, j.title)}</strong>`;
    const actions = j.status === "ready_for_review" ? `<div class="row" style="margin-top:8px"><button data-approve="${j.id}">Aprobar y enviar PR</button><button class="danger" data-reject="${j.id}">Descartar</button></div>` : "";
    return `<div class="job"><div class="row between"><div>${head}</div><span class="pill">${esc(label(j.status))}</span></div>
      <div class="muted">${esc(agent?.label ?? "")} · ${esc(when(j.updatedAt))}${opp?.expectedReward ? ` · recompensa ${money(opp.expectedReward.amount, opp.expectedReward.asset)}` : ""}${j.txHash ? ` · tx ${link(`${snapshot.config.explorer}/tx/${j.txHash}`, j.txHash.slice(0, 14) + "…")}` : ""}</div>
      ${j.summary ? `<p>${esc(j.summary)}</p>` : ""}
      ${j.submission ? `<p>PR: ${link(j.submission.url)}</p>` : ""}
      ${j.review ? `<p class="muted">Revisor: ${esc(j.review.verdict)} (${j.review.confidence ?? "?"}%) ${esc(j.review.notes ?? "")}</p>` : ""}
      ${j.steps?.length ? `<details><summary>${j.steps.length} pasos realizados</summary><pre>${esc(j.steps.map((s) => `${when(s.at)} ${s.tool} ${JSON.stringify(s.input)}`).join("\n"))}</pre></details>` : ""}
      ${j.changes?.length ? `<details><summary>${j.changes.length} archivos propuestos</summary>${j.changes.map((c) => `<p class="mono">${esc(c.path)}</p><pre>${esc(c.content.slice(0, 4000))}</pre>`).join("")}</details>` : ""}
      ${actions}</div>`;
  }).join("") || "<p class='muted'>Todavía no hay trabajos. Aparecerán cuando un worker tome un bounty calificado o un comprador pague un servicio.</p>";
}

function renderServices() {
  const c = snapshot.config;
  $("#services-help").textContent = c.payTo ? `Cada llamada cobra USDC en ${c.chain} a ${c.payTo}. Los compradores (personas o agentes) reciben un 402 con los requisitos y pagan con la cabecera PAYMENT-SIGNATURE.` : "Configura PAYTO_ADDRESS para que el vendedor publique el catálogo.";
  $("#services-table tbody").innerHTML = snapshot.services.map((s) => `<tr><td><strong>${esc(s.name)}</strong><div class="muted">${esc(s.description)}</div></td><td class="mono">${link(s.url)}</td>
    <td class="num"><input type="number" step="0.001" min="0.001" value="${s.priceUsd}" data-price="${s.id}" style="width:90px" /></td>
    <td><input type="checkbox" ${s.enabled ? "checked" : ""} data-enabled="${s.id}" /></td></tr>`).join("") || "<tr><td colspan='4' class='muted'>El vendedor publica el catálogo al arrancar.</td></tr>";
}

function renderLedger() {
  const KIND = { expected: "estimado", claimed: "reclamado", received_onchain: "verificado en cadena", cost: "coste" };
  $("#ledger-summary tbody").innerHTML = Object.entries(snapshot.metrics.byAsset).map(([asset, v]) => `<tr><td>${esc(asset)}</td><td class="num">${money(v.expected, asset)}</td><td class="num">${money(v.claimed, asset)}</td><td class="num">${money(v.verified, asset)}</td><td class="num">${money(v.cost, asset)}</td></tr>`).join("") || "<tr><td colspan='5' class='muted'>Sin movimientos.</td></tr>";
  $("#ledger-table tbody").innerHTML = snapshot.ledger.slice(0, 300).map((e) => `<tr><td>${esc(when(e.createdAt))}</td><td><span class="pill ${e.kind === "received_onchain" ? "good" : e.kind === "cost" ? "warn" : ""}">${esc(KIND[e.kind] ?? e.kind)}</span></td><td class="num">${money(e.amount, e.asset)}</td><td>${esc(e.note ?? "")}</td><td>${e.txHash ? link(`${snapshot.config.explorer}/tx/${e.txHash}`, e.txHash.slice(0, 14) + "…") : e.evidenceUrl ? link(e.evidenceUrl, "enlace") : ""}</td></tr>`).join("") || "<tr><td colspan='5' class='muted'>Sin movimientos.</td></tr>";
}

function renderAudit() {
  const integrity = snapshot.auditIntegrity;
  const el = $("#audit-integrity");
  el.textContent = integrity.ok ? `Cadena íntegra · ${integrity.length} eventos` : `Cadena rota en ${integrity.brokenAt}`;
  el.className = `pill ${integrity.ok ? "good" : "bad"}`;
  $("#audit-table tbody").innerHTML = snapshot.audit.map((e) => {
    const { id, at, type, hash, previousHash, ...rest } = e;
    return `<tr><td>${esc(when(at))}</td><td>${esc(type)}</td><td class="mono">${esc(JSON.stringify(rest).slice(0, 220))}</td><td class="hash">${esc(hash.slice(0, 12))}</td></tr>`;
  }).join("");
}

document.addEventListener("click", async (event) => {
  const t = event.target;
  if (t.dataset.tab) {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b === t));
    document.querySelectorAll(".tab").forEach((s) => s.classList.toggle("active", s.id === `tab-${t.dataset.tab}`));
    return;
  }
  try {
    if (t.dataset.stop) await api(`/api/agents/${t.dataset.stop}/stop`, {});
    else if (t.dataset.approve && confirm("¿Abrir el PR en GitHub con tu token? Esta acción es pública.")) await api(`/api/jobs/${t.dataset.approve}/approve`, {});
    else if (t.dataset.reject) await api(`/api/jobs/${t.dataset.reject}/reject`, {});
    else if (t.dataset.requeue) await api(`/api/opportunities/${t.dataset.requeue}/requeue`, {});
    else if (t.dataset.reevaluate) { const r = await api("/api/opportunities/reevaluate", {}); alert(`${r.requeued} oportunidades vuelven a la cola de evaluación`); }
    else return;
    await refresh();
  } catch (error) { alert(error.message); }
});

document.addEventListener("change", async (event) => {
  const t = event.target;
  try {
    if (t.dataset.price) await api(`/api/services/${t.dataset.price}`, { priceUsd: Number(t.value) });
    else if (t.dataset.enabled) await api(`/api/services/${t.dataset.enabled}`, { enabled: t.checked });
    else return;
    await refresh();
  } catch (error) { alert(error.message); }
});

$("#spawn-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    await api("/api/agents", { template: form.get("template"), goal: form.get("goal"), parentId: form.get("parentId") || null });
    event.target.reset();
    await refresh();
  } catch (error) { alert(error.message); }
});

$("#opp-filter").addEventListener("input", renderOpportunities);

const events = new EventSource("/events");
events.onmessage = scheduleRefresh;
refresh().catch(console.error);
setInterval(() => refresh().catch(console.error), 30_000);
