import {
  ACTION_STATUS,
  analyzePortfolio,
  formatMoney,
  formatShortDate,
  normalizeImportedInvoices,
  parseCsv
} from "./domain.js";
import { demoInvoices } from "./demo.js";

const STORAGE_KEY = "monexa.local-state.v1";
const DEMO_DATE = "2026-09-04";
const app = document.querySelector("#app");
const toast = document.querySelector("#toast");

let ui = {
  importOpen: false,
  screen: "today",
  selectedActionId: null
};

function cloneDemoInvoices() {
  return demoInvoices.map((invoice) => ({ ...invoice }));
}

function createInitialState() {
  return {
    audit: [
      {
        detail: "Se cargó un espacio de trabajo de ejemplo. Ningún dato salió de este navegador.",
        kind: "workspace_created",
        timestamp: new Date().toISOString()
      }
    ],
    decisions: {},
    invoices: cloneDemoInvoices(),
    referenceDate: DEMO_DATE,
    source: "Datos de ejemplo",
    version: 1
  };
}

function loadState() {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (!saved) return createInitialState();
    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed.invoices) || !Array.isArray(parsed.audit)) return createInitialState();
    return parsed;
  } catch {
    return createInitialState();
  }
}

let state = loadState();

function saveState() {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function addAudit(kind, detail) {
  state.audit.unshift({ detail, kind, timestamp: new Date().toISOString() });
  state.audit = state.audit.slice(0, 80);
  saveState();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function currentReport() {
  return analyzePortfolio(state.invoices, new Date(`${state.referenceDate}T12:00:00`));
}

function formatBreakdown(amounts) {
  const entries = Object.entries(amounts ?? {});
  return entries.length
    ? entries.map(([currency, amount]) => formatMoney(amount, currency)).join(" · ")
    : "—";
}

function humanDate(timestamp) {
  return new Intl.DateTimeFormat("es-PE", {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short"
  }).format(new Date(timestamp));
}

function shortName(name) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function decisionFor(actionId) {
  return state.decisions[actionId] ?? { status: ACTION_STATUS.NEEDS_REVIEW };
}

function actionStatusLabel(status) {
  if (status === ACTION_STATUS.APPROVED) return "Aprobada";
  if (status === ACTION_STATUS.DISCARDED) return "Descartada";
  return "Requiere revisión";
}

function stageLabel(action) {
  if (action.daysOverdue > 0) {
    return `${action.daysOverdue} día${action.daysOverdue === 1 ? "" : "s"} vencida`;
  }
  if (action.daysOverdue === 0) return "Vence hoy";
  return `Vence en ${Math.abs(action.daysOverdue)} días`;
}

function navigationButton(id, icon, label) {
  const active = ui.screen === id ? "is-active" : "";
  return `<button class="nav-item ${active}" data-action="navigate" data-screen="${id}">
    <span aria-hidden="true">${icon}</span>${label}
  </button>`;
}

function renderSidebar() {
  return `<aside class="sidebar">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
      <span>monexa</span>
    </div>
    <nav aria-label="Navegación principal">
      ${navigationButton("today", "◌", "Hoy")}
      ${navigationButton("collections", "↗", "Cobranza")}
      ${navigationButton("audit", "≡", "Bitácora")}
    </nav>
    <div class="sidebar-footer">
      <div class="local-badge"><span class="status-dot"></span>Datos locales</div>
      <p>Monexa propone.<br />Tú decides.</p>
    </div>
  </aside>`;
}

function renderMetric(label, value, supportingText, tone = "") {
  return `<article class="metric-card ${tone}">
    <p>${label}</p>
    <strong>${value}</strong>
    <span>${supportingText}</span>
  </article>`;
}

function renderActionCard(action, compact = false) {
  const decision = decisionFor(action.id);
  const stateClass = `state-${decision.status.replaceAll("_", "-")}`;
  const actionDescription = action.daysOverdue > 0
    ? `La factura ${action.invoiceNumber} necesita seguimiento.`
    : `Conviene confirmar el pago antes del vencimiento.`;

  return `<button class="action-card ${compact ? "compact" : ""}" data-action="open-action" data-id="${escapeHtml(action.id)}">
    <span class="client-avatar" aria-hidden="true">${escapeHtml(shortName(action.client))}</span>
    <span class="action-main">
      <span class="action-heading"><strong>${escapeHtml(action.client)}</strong><span class="status-pill ${stateClass}">${actionStatusLabel(decision.status)}</span></span>
      <span class="action-description">${escapeHtml(actionDescription)}</span>
      <span class="action-meta"><span class="stage ${action.stage}">${escapeHtml(stageLabel(action))}</span><span>${escapeHtml(action.invoiceNumber)}</span></span>
    </span>
    <span class="action-value">${escapeHtml(formatMoney(action.amount, action.currency))}<small>Ver propuesta →</small></span>
  </button>`;
}

function renderQueue(actions, options = {}) {
  const visibleActions = options.includeResolved
    ? actions
    : actions.filter((action) => decisionFor(action.id).status === ACTION_STATUS.NEEDS_REVIEW);

  if (!visibleActions.length) {
    return `<div class="empty-state"><span>✓</span><div><strong>Todo está al día</strong><p>No hay acciones pendientes en este periodo.</p></div></div>`;
  }

  return `<div class="action-list">${visibleActions.map((action) => renderActionCard(action, options.compact)).join("")}</div>`;
}

function renderPolicy() {
  return `<aside class="policy-card">
    <div class="eyebrow"><span class="shield-icon">⌁</span> Política de acción</div>
    <h3>Siempre con control humano.</h3>
    <ul>
      <li><span>✓</span> Los cálculos usan reglas verificables.</li>
      <li><span>✓</span> Cada mensaje se revisa antes de copiarlo.</li>
      <li><span>✓</span> Nunca se envían correos ni se mueve dinero.</li>
    </ul>
    <button class="text-button" data-action="navigate" data-screen="audit">Ver la bitácora <span>→</span></button>
  </aside>`;
}

function renderToday() {
  const report = currentReport();
  const { metrics } = report;
  const attention = report.actions.filter((action) => decisionFor(action.id).status === ACTION_STATUS.NEEDS_REVIEW);

  return `<section class="screen-content">
    <div class="headline-row">
      <div>
        <p class="eyebrow">Resumen del día</p>
        <h1>Tu caja, con <em>claridad.</em></h1>
        <p class="subhead">Monexa revisó ${metrics.openCount} factura${metrics.openCount === 1 ? "" : "s"} abiertas y preparó las decisiones que más importan.</p>
      </div>
      <div class="date-control">
        <label for="reference-date">Fecha de análisis</label>
        <input id="reference-date" type="date" value="${escapeHtml(state.referenceDate)}" />
      </div>
    </div>

    <div class="metric-grid">
      ${renderMetric("Por cobrar", formatBreakdown(metrics.openByCurrency), `${metrics.openCount} facturas abiertas`)}
      ${renderMetric("Vencido", formatBreakdown(metrics.overdueByCurrency), `${metrics.overdueCount} factura${metrics.overdueCount === 1 ? "" : "s"} requieren atención`, "warning")}
      ${renderMetric("Esta semana", formatBreakdown(metrics.dueSoonByCurrency), `${metrics.dueSoonCount} cobro${metrics.dueSoonCount === 1 ? "" : "s"} por confirmar`, "purple")}
      ${renderMetric("Riesgo concentrado", String(metrics.riskClients), "clientes con saldo vencido", "soft")}
    </div>

    <div class="content-grid">
      <section class="queue-panel">
        <div class="panel-heading">
          <div><p class="eyebrow">Prioridad</p><h2>Qué hacer ahora</h2></div>
          <span class="count-badge">${attention.length} por revisar</span>
        </div>
        ${renderQueue(report.actions)}
        <button class="text-button footer-link" data-action="navigate" data-screen="collections">Ver toda la cobranza <span>→</span></button>
      </section>
      ${renderPolicy()}
    </div>
  </section>`;
}

function renderCollections() {
  const report = currentReport();
  const reviewed = report.actions.filter((action) => decisionFor(action.id).status !== ACTION_STATUS.NEEDS_REVIEW).length;
  return `<section class="screen-content collection-screen">
    <div class="headline-row">
      <div>
        <p class="eyebrow">Bandeja de cobranza</p>
        <h1>Cada seguimiento tiene un <em>porqué.</em></h1>
        <p class="subhead">El orden combina vencimiento, importe y deuda acumulada por cliente. No hay decisiones ocultas.</p>
      </div>
      <div class="collection-summary"><strong>${reviewed}</strong><span>decisiones registradas</span></div>
    </div>
    <section class="queue-panel full-width">
      <div class="panel-heading">
        <div><p class="eyebrow">Acciones priorizadas</p><h2>Facturas para revisar</h2></div>
        <span class="count-badge">${report.actions.length} en ventana de 7 días</span>
      </div>
      ${renderQueue(report.actions, { includeResolved: true })}
    </section>
  </section>`;
}

const auditLabels = {
  action_approved: "Propuesta aprobada",
  action_copied: "Borrador copiado",
  action_discarded: "Propuesta descartada",
  csv_imported: "Facturas importadas",
  demo_restored: "Datos de ejemplo restaurados",
  reference_date_changed: "Fecha de análisis actualizada",
  workspace_created: "Espacio de trabajo iniciado"
};

function renderAudit() {
  return `<section class="screen-content">
    <div class="headline-row">
      <div>
        <p class="eyebrow">Trazabilidad</p>
        <h1>Una bitácora <em>legible.</em></h1>
        <p class="subhead">Aquí queda claro qué se analizó, qué recomendó Monexa y qué decisión tomaste.</p>
      </div>
    </div>
    <section class="audit-panel">
      <div class="panel-heading"><div><p class="eyebrow">Eventos locales</p><h2>Actividad reciente</h2></div><span class="local-badge"><span class="status-dot"></span>Sin integraciones</span></div>
      <ol class="audit-list">
        ${state.audit.map((event) => `<li>
          <span class="audit-point"></span>
          <div><strong>${escapeHtml(auditLabels[event.kind] ?? event.kind)}</strong><p>${escapeHtml(event.detail)}</p></div>
          <time datetime="${escapeHtml(event.timestamp)}">${escapeHtml(humanDate(event.timestamp))}</time>
        </li>`).join("")}
      </ol>
    </section>
  </section>`;
}

function renderImportPanel() {
  if (!ui.importOpen) return "";
  return `<section class="import-panel" aria-label="Importar facturas">
    <div>
      <p class="eyebrow">Tus datos</p>
      <h2>Importa un CSV de facturas</h2>
      <p>Campos requeridos: cliente, factura, fecha_vencimiento e importe. Se procesa sólo en este navegador.</p>
      <a href="/data/plantilla-facturas.csv" download>Descargar plantilla CSV</a>
    </div>
    <label class="upload-control" for="csv-input"><span>↑</span><strong>Elegir un archivo</strong><small>.csv, sin subirlo a ningún servidor</small></label>
    <input id="csv-input" type="file" accept=".csv,text/csv" hidden />
    <button class="close-button" data-action="toggle-import" aria-label="Cerrar importación">×</button>
  </section>`;
}

function renderActionModal() {
  if (!ui.selectedActionId) return "";
  const action = currentReport().actions.find((item) => item.id === ui.selectedActionId);
  if (!action) return "";

  const decision = decisionFor(action.id);
  const draft = decision.draft ?? action.draft;
  const status = decision.status;
  return `<div class="modal-backdrop" data-action="close-modal">
    <section class="proposal-modal" role="dialog" aria-modal="true" aria-labelledby="proposal-title" data-modal>
      <button class="close-button modal-close" data-action="close-modal" aria-label="Cerrar propuesta">×</button>
      <p class="eyebrow">Propuesta de seguimiento</p>
      <h2 id="proposal-title">${escapeHtml(action.client)}</h2>
      <div class="evidence-grid">
        <div><span>Factura</span><strong>${escapeHtml(action.invoiceNumber)}</strong></div>
        <div><span>Importe</span><strong>${escapeHtml(formatMoney(action.amount, action.currency))}</strong></div>
        <div><span>Vencimiento</span><strong>${escapeHtml(formatShortDate(action.dueDate))}</strong></div>
        <div><span>Motivo</span><strong>${escapeHtml(stageLabel(action))}</strong></div>
      </div>
      <label class="draft-label" for="draft-editor">Borrador para revisar</label>
      <textarea id="draft-editor" rows="8">${escapeHtml(draft)}</textarea>
      <p class="model-note">El texto es un borrador local. Al editarlo, se vuelve a revisar antes de aprobarlo.</p>
      <div class="modal-actions">
        <button class="secondary-button" data-action="discard-action" data-id="${escapeHtml(action.id)}">Descartar</button>
        <button class="secondary-button" data-action="copy-action" data-id="${escapeHtml(action.id)}">Copiar borrador</button>
        <button class="primary-button" data-action="approve-action" data-id="${escapeHtml(action.id)}">Aprobar y copiar <span>→</span></button>
      </div>
      <p class="approval-state ${status === ACTION_STATUS.APPROVED ? "visible" : ""}">${status === ACTION_STATUS.APPROVED ? "Esta versión fue aprobada y copiada. Aún no se ha enviado nada." : "La aprobación sólo aplica al texto visible arriba."}</p>
    </section>
  </div>`;
}

function renderHeader() {
  return `<header class="topbar">
    <div class="source-tag"><span class="status-dot"></span>${escapeHtml(state.source)}</div>
    <div class="topbar-actions">
      <button class="reset-button" data-action="restore-demo">Restaurar ejemplo</button>
      <button class="import-button" data-action="toggle-import"><span>+</span> Importar facturas</button>
    </div>
  </header>`;
}

function render() {
  const content = ui.screen === "collections"
    ? renderCollections()
    : ui.screen === "audit"
      ? renderAudit()
      : renderToday();

  app.innerHTML = `<div class="app-shell">
    ${renderSidebar()}
    <main>
      ${renderHeader()}
      ${renderImportPanel()}
      ${content}
    </main>
  </div>${renderActionModal()}`;
  bindEvents();
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("visible"), 3200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const temporaryInput = document.createElement("textarea");
    temporaryInput.value = text;
    temporaryInput.style.position = "fixed";
    temporaryInput.style.opacity = "0";
    document.body.append(temporaryInput);
    temporaryInput.select();
    const copied = document.execCommand("copy");
    temporaryInput.remove();
    return copied;
  }
}

function selectedDraft(action) {
  return document.querySelector("#draft-editor")?.value.trim() || decisionFor(action.id).draft || action.draft;
}

function commitDecision(action, status) {
  const draft = selectedDraft(action);
  state.decisions[action.id] = {
    approvedAt: status === ACTION_STATUS.APPROVED ? new Date().toISOString() : null,
    draft,
    status
  };
  saveState();
  return draft;
}

async function handleAction(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const actionType = button.dataset.action;

  if (actionType === "navigate") {
    ui.screen = button.dataset.screen;
    ui.selectedActionId = null;
    render();
  }

  if (actionType === "toggle-import") {
    ui.importOpen = !ui.importOpen;
    render();
  }

  if (actionType === "open-action") {
    ui.selectedActionId = button.dataset.id;
    render();
  }

  if (actionType === "close-modal") {
    if (button.classList.contains("modal-backdrop") && event.target !== button) return;
    ui.selectedActionId = null;
    render();
    return;
  }

  if (actionType === "restore-demo") {
    if (!window.confirm("¿Restaurar los datos de ejemplo? Se reemplazarán las facturas y decisiones locales actuales.")) return;
    state = createInitialState();
    addAudit("demo_restored", "Se restauraron las facturas de ejemplo y se eliminaron decisiones locales anteriores.");
    ui.selectedActionId = null;
    render();
    showToast("Datos de ejemplo restaurados.");
  }

  if (["approve-action", "copy-action", "discard-action"].includes(actionType)) {
    const action = currentReport().actions.find((item) => item.id === button.dataset.id);
    if (!action) return;

    if (actionType === "discard-action") {
      commitDecision(action, ACTION_STATUS.DISCARDED);
      addAudit("action_discarded", `Descartaste el seguimiento propuesto para ${action.client} (${action.invoiceNumber}).`);
      ui.selectedActionId = null;
      render();
      showToast("Propuesta descartada. La factura no se modificó.");
      return;
    }

    const draft = selectedDraft(action);
    const copied = await copyText(draft);
    if (actionType === "approve-action") {
      commitDecision(action, ACTION_STATUS.APPROVED);
      addAudit("action_approved", `Aprobaste el borrador revisado para ${action.client} (${action.invoiceNumber}).`);
    } else {
      state.decisions[action.id] = { ...decisionFor(action.id), draft };
      saveState();
      addAudit("action_copied", `Copiaste un borrador para ${action.client} (${action.invoiceNumber}) sin enviarlo.`);
    }
    render();
    showToast(copied ? "Borrador copiado. No se envió ningún mensaje." : "No se pudo copiar automáticamente; selecciona el texto para copiarlo.");
  }
}

async function handleCsvInput(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  const result = normalizeImportedInvoices(parseCsv(text));

  if (!result.invoices.length) {
    showToast("No encontramos filas válidas. Revisa la plantilla CSV.");
    return;
  }

  state.invoices = result.invoices;
  state.decisions = {};
  state.source = file.name;
  addAudit("csv_imported", `Importaste ${result.invoices.length} factura${result.invoices.length === 1 ? "" : "s"} desde ${file.name}.${result.errors.length ? ` Se omitieron ${result.errors.length} fila${result.errors.length === 1 ? "" : "s"} inválidas.` : ""}`);
  ui.importOpen = false;
  render();
  showToast(result.errors.length ? `Importación completa con ${result.errors.length} fila(s) omitida(s).` : "Facturas importadas localmente.");
}

function handleReferenceDate(event) {
  if (!event.target.matches("#reference-date")) return;
  state.referenceDate = event.target.value;
  addAudit("reference_date_changed", `Cambiaste la fecha de análisis a ${formatShortDate(state.referenceDate)}.`);
  render();
}

function bindEvents() {
  app.onclick = handleAction;
  const modal = document.querySelector(".modal-backdrop");
  if (modal) modal.onclick = handleAction;
  const csvInput = document.querySelector("#csv-input");
  if (csvInput) csvInput.onchange = handleCsvInput;
  const referenceDate = document.querySelector("#reference-date");
  if (referenceDate) referenceDate.onchange = handleReferenceDate;
}

render();
