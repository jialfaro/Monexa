import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzePortfolio,
  buildCollectionDraft,
  normalizeImportedInvoices,
  parseCsv
} from "../src/domain.js";

test("parseCsv accepts quoted commas", () => {
  const rows = parseCsv('cliente,factura,fecha_vencimiento,importe\n"Empresa, SAC",F-01,2026-09-01,2500');
  assert.equal(rows[0].cliente, "Empresa, SAC");
});

test("normalizeImportedInvoices maps Spanish headers and reports invalid rows", () => {
  const result = normalizeImportedInvoices([
    {
      cliente: "Luna SAC",
      factura: "F-01",
      fecha_vencimiento: "2026-09-01",
      importe: "S/ 2,500",
      moneda: "PEN"
    },
    { cliente: "", factura: "F-02", fecha_vencimiento: "2026-09-02", importe: "100" }
  ]);

  assert.equal(result.invoices.length, 1);
  assert.equal(result.invoices[0].amount, 2500);
  assert.equal(result.errors.length, 1);
});

test("analyzePortfolio prioritizes overdue invoices and ignores closed invoices", () => {
  const invoices = [
    { id: "old", client: "A", invoiceNumber: "F-1", amount: 1000, currency: "PEN", dueDate: "2026-08-10", status: "open" },
    { id: "soon", client: "B", invoiceNumber: "F-2", amount: 9000, currency: "PEN", dueDate: "2026-09-07", status: "open" },
    { id: "paid", client: "C", invoiceNumber: "F-3", amount: 5000, currency: "PEN", dueDate: "2026-07-01", status: "closed" }
  ];
  const report = analyzePortfolio(invoices, new Date("2026-09-04T12:00:00"));

  assert.equal(report.metrics.openAmount, 10000);
  assert.equal(report.metrics.overdueAmount, 1000);
  assert.equal(report.actions[0].id, "old");
});

test("buildCollectionDraft preserves a respectful tone for an upcoming invoice", () => {
  const draft = buildCollectionDraft(
    { client: "Nora Pérez", invoiceNumber: "F-9", amount: 430, currency: "PEN", dueDate: "2026-09-08" },
    -4
  );

  assert.match(draft, /recordar/i);
  assert.match(draft, /F-9/);
});
