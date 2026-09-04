const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

const HEADER_ALIASES = {
  amount: ["amount", "importe", "monto", "total"],
  client: ["client", "cliente", "customer", "empresa"],
  currency: ["currency", "moneda", "currency_code"],
  dueDate: ["due_date", "due date", "fecha_vencimiento", "vencimiento", "fecha de vencimiento"],
  email: ["email", "correo", "correo_electronico", "correo electrónico"],
  invoiceNumber: ["invoice_number", "invoice", "factura", "numero_factura", "número de factura"],
  issueDate: ["issue_date", "issue date", "fecha_emision", "fecha de emisión"],
  status: ["status", "estado"]
};

export const ACTION_STATUS = Object.freeze({
  APPROVED: "approved",
  DISCARDED: "discarded",
  NEEDS_REVIEW: "needs_review"
});

export function parseCsv(text) {
  const rows = [];
  let field = "";
  let row = [];
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const nextCharacter = text[index + 1];

    if (character === '"' && quoted && nextCharacter === '"') {
      field += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(field.trim());
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && nextCharacter === "\n") {
        index += 1;
      }
      row.push(field.trim());
      if (row.some((value) => value.length > 0)) {
        rows.push(row);
      }
      field = "";
      row = [];
    } else {
      field += character;
    }
  }

  row.push(field.trim());
  if (row.some((value) => value.length > 0)) {
    rows.push(row);
  }

  if (rows.length < 2) {
    return [];
  }

  const [headers, ...body] = rows;
  return body.map((values) =>
    Object.fromEntries(headers.map((header, index) => [header.trim(), values[index] ?? ""]))
  );
}

function canonicalHeader(header) {
  return header.trim().toLocaleLowerCase("es").replace(/\s+/g, " ");
}

function getField(row, fieldName) {
  const aliases = HEADER_ALIASES[fieldName];
  const entry = Object.entries(row).find(([header]) => aliases.includes(canonicalHeader(header)));
  return entry?.[1]?.trim() ?? "";
}

function parseAmount(rawAmount) {
  let normalized = rawAmount.replace(/[^\d,.-]/g, "");
  const lastComma = normalized.lastIndexOf(",");
  const lastDot = normalized.lastIndexOf(".");

  if (lastComma !== -1 && lastDot !== -1) {
    const decimalSeparator = lastComma > lastDot ? "," : ".";
    const thousandsSeparator = decimalSeparator === "," ? "." : ",";
    normalized = normalized.replaceAll(thousandsSeparator, "").replace(decimalSeparator, ".");
  } else if (lastComma !== -1) {
    const decimals = normalized.length - lastComma - 1;
    normalized = decimals === 3 ? normalized.replaceAll(",", "") : normalized.replace(",", ".");
  } else if (lastDot !== -1) {
    const decimals = normalized.length - lastDot - 1;
    if (decimals === 3) normalized = normalized.replaceAll(".", "");
  }

  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : Number.NaN;
}

function normalizeStatus(status) {
  const normalized = status.trim().toLocaleLowerCase("es");
  return ["paid", "pagada", "pagado", "cobrado", "cancelled", "cancelada"].includes(normalized)
    ? "closed"
    : "open";
}

export function normalizeImportedInvoices(rows) {
  const invoices = [];
  const errors = [];

  rows.forEach((row, rowIndex) => {
    const client = getField(row, "client");
    const invoiceNumber = getField(row, "invoiceNumber");
    const dueDate = getField(row, "dueDate");
    const amount = parseAmount(getField(row, "amount"));

    if (!client || !invoiceNumber || !dueDate || !Number.isFinite(amount) || amount <= 0) {
      errors.push({
        row: rowIndex + 2,
        message: "Faltan cliente, número de factura, vencimiento o importe válido."
      });
      return;
    }

    const dueAt = new Date(`${dueDate}T12:00:00`);
    if (Number.isNaN(dueAt.getTime())) {
      errors.push({ row: rowIndex + 2, message: "La fecha de vencimiento no es válida." });
      return;
    }

    invoices.push({
      amount,
      client,
      currency: getField(row, "currency") || "PEN",
      dueDate: dueAt.toISOString().slice(0, 10),
      email: getField(row, "email"),
      id: `${invoiceNumber}-${rowIndex + 2}`,
      invoiceNumber,
      issueDate: getField(row, "issueDate"),
      status: normalizeStatus(getField(row, "status"))
    });
  });

  return { errors, invoices };
}

export function daysFromDueDate(dueDate, referenceDate = new Date()) {
  const dueAt = new Date(`${dueDate}T12:00:00`);
  const referenceAt = new Date(referenceDate);
  referenceAt.setHours(12, 0, 0, 0);
  return Math.round((referenceAt.getTime() - dueAt.getTime()) / DAY_IN_MILLISECONDS);
}

export function formatMoney(amount, currency = "PEN") {
  return new Intl.NumberFormat("es-PE", {
    currency,
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
    style: "currency"
  }).format(amount);
}

export function formatShortDate(dateValue) {
  return new Intl.DateTimeFormat("es-PE", {
    day: "numeric",
    month: "short"
  }).format(new Date(`${dateValue}T12:00:00`));
}

function messageStage(daysOverdue) {
  if (daysOverdue >= 30) return "final";
  if (daysOverdue >= 8) return "firm";
  if (daysOverdue > 0) return "friendly";
  return "upcoming";
}

export function buildCollectionDraft(invoice, daysOverdue) {
  const formattedAmount = formatMoney(invoice.amount, invoice.currency);
  const stage = messageStage(daysOverdue);
  const name = invoice.client.split(" ")[0];
  const opening = stage === "upcoming"
    ? `Hola ${name}, te escribo para recordar que la factura ${invoice.invoiceNumber} vence el ${formatShortDate(invoice.dueDate)}.`
    : `Hola ${name}, quería confirmar el estado de la factura ${invoice.invoiceNumber}, por ${formattedAmount}.`;
  const context = stage === "final"
    ? "Ya supera los 30 días de vencida. ¿Podrías indicarnos una fecha concreta de pago?"
    : stage === "firm"
      ? `Registra ${daysOverdue} días de vencida. Agradeceremos confirmar la fecha de pago.`
      : stage === "friendly"
        ? `Venció hace ${daysOverdue} día${daysOverdue === 1 ? "" : "s"}. ¿Nos ayudas confirmando si está programada?`
        : "¿Podrías confirmarnos si necesitas algún dato adicional para programar el pago?";

  return `${opening}\n\n${context}\n\nGracias,\nEquipo Monexa`;
}

function priorityFor(invoice, clientTotal, daysOverdue) {
  const overdueWeight = Math.max(daysOverdue, 0) * 3;
  const amountWeight = Math.min(Math.round(invoice.amount / 100), 60);
  const concentrationWeight = clientTotal > invoice.amount ? 12 : 0;
  const upcomingWeight = daysOverdue >= -7 && daysOverdue < 0 ? 8 : 0;
  return overdueWeight + amountWeight + concentrationWeight + upcomingWeight;
}

function amountByCurrency(invoices) {
  return invoices.reduce((totals, invoice) => {
    const currency = invoice.currency || "PEN";
    totals[currency] = (totals[currency] ?? 0) + invoice.amount;
    return totals;
  }, {});
}

export function analyzePortfolio(invoices, referenceDate = new Date()) {
  const openInvoices = invoices.filter((invoice) => invoice.status === "open");
  const clientTotals = new Map();

  openInvoices.forEach((invoice) => {
    const current = clientTotals.get(invoice.client) ?? 0;
    clientTotals.set(invoice.client, current + invoice.amount);
  });

  const actions = openInvoices
    .map((invoice) => {
      const daysOverdue = daysFromDueDate(invoice.dueDate, referenceDate);
      const clientTotal = clientTotals.get(invoice.client) ?? invoice.amount;
      return {
        ...invoice,
        daysOverdue,
        draft: buildCollectionDraft(invoice, daysOverdue),
        priority: priorityFor(invoice, clientTotal, daysOverdue),
        reason: daysOverdue > 0
          ? `${daysOverdue} día${daysOverdue === 1 ? "" : "s"} vencida · ${formatMoney(invoice.amount, invoice.currency)}`
          : daysOverdue === 0
            ? `Vence hoy · ${formatMoney(invoice.amount, invoice.currency)}`
            : `Vence en ${Math.abs(daysOverdue)} días · ${formatMoney(invoice.amount, invoice.currency)}`,
        stage: messageStage(daysOverdue)
      };
    })
    .filter((action) => action.daysOverdue >= -7)
    .sort((left, right) => right.priority - left.priority);

  const overdueInvoices = openInvoices.filter((invoice) => daysFromDueDate(invoice.dueDate, referenceDate) > 0);
  const dueSoonInvoices = openInvoices.filter((invoice) => {
    const days = daysFromDueDate(invoice.dueDate, referenceDate);
    return days >= -7 && days <= 0;
  });

  return {
    actions,
    metrics: {
      dueSoonAmount: dueSoonInvoices.reduce((sum, invoice) => sum + invoice.amount, 0),
      dueSoonCount: dueSoonInvoices.length,
      dueSoonByCurrency: amountByCurrency(dueSoonInvoices),
      openAmount: openInvoices.reduce((sum, invoice) => sum + invoice.amount, 0),
      openCount: openInvoices.length,
      openByCurrency: amountByCurrency(openInvoices),
      overdueAmount: overdueInvoices.reduce((sum, invoice) => sum + invoice.amount, 0),
      overdueCount: overdueInvoices.length,
      overdueByCurrency: amountByCurrency(overdueInvoices),
      riskClients: new Set(overdueInvoices.map((invoice) => invoice.client)).size
    }
  };
}
