import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPortfolio } from "../src/lib/finance/portfolio.ts";
import { operationTermsFromForm } from "../src/lib/finance/operation-terms.ts";

// Parcelado quinzenal (caso da Michele, valores fictícios): 2 × R$ 450 para R$ 600; a regra dá 06/11 e 21/11, o combinado foi 20/11.
const form = (extra = {}) => {
  const data = new FormData();
  for (const [key, value] of Object.entries({ modality: "INSTALLMENT", installmentFrequency: "BIWEEKLY", loanAmount: "600,00", installment: "450,00", term: "2", loanDate: "2026-10-08", firstDueDate: "2026-11-06", ...extra })) data.set(key, value);
  return data;
};

test("VC1. sem datas ajustadas vale a regra quinzenal e nada é gravado a mais", () => {
  const terms = operationTermsFromForm(form());
  assert.equal(terms.ok, true);
  assert.equal(terms.values.installmentDueDates, null);
  assert.equal(terms.values.firstDueDate, "2026-11-06");
  assert.equal(terms.dueDate, "2026-11-21");
});

test("VC2. data combinada diferente da regra é gravada, o último vencimento acompanha e o cronograma usa a data", () => {
  const terms = operationTermsFromForm(form({ customDueDates: JSON.stringify(["2026-11-06", "2026-11-20"]) }));
  assert.equal(terms.ok, true);
  assert.deepEqual(terms.values.installmentDueDates, ["2026-11-06", "2026-11-20"]);
  assert.equal(terms.dueDate, "2026-11-20");
  const operation = { id: "op_v", clientId: "c1", clientName: "Michele", principalCents: 60_000, interestRateBps: terms.values.interestRateBps, interestCents: terms.values.interestCents, totalCents: terms.values.totalCents, loanDate: "2026-10-08", dueDate: terms.dueDate, firstDueDate: terms.values.firstDueDate, status: "OPEN", settledAt: null, calculationRule: terms.values.calculationRule, modality: "INSTALLMENT", frequency: "BIWEEKLY", installmentCount: 2, installmentCents: 45_000, customDueDates: terms.values.installmentDueDates, createdAt: "2026-10-08T10:00:00Z" };
  const op = buildPortfolio({ initialCapitalCents: 1_000_000, hasWallet: true, operations: [operation], payments: [], today: "2026-10-26" }).operations[0];
  assert.deepEqual(op.installments.map((item) => item.dueDate), ["2026-11-06", "2026-11-20"]);
  assert.equal(op.balanceCents, 90_000);
});

test("VC3. datas iguais à regra não ficam gravadas e o primeiro vencimento passa a ser o da primeira parcela", () => {
  assert.equal(operationTermsFromForm(form({ customDueDates: JSON.stringify(["2026-11-06", "2026-11-21"]) })).values.installmentDueDates, null);
  const moved = operationTermsFromForm(form({ customDueDates: JSON.stringify(["2026-11-05", "2026-11-20"]) }));
  assert.equal(moved.values.firstDueDate, "2026-11-05");
});

test("VC4. datas inválidas são recusadas: fora de ordem, repetidas, antes do empréstimo, quantidade errada ou texto solto", () => {
  for (const custom of [["2026-11-20", "2026-11-06"], ["2026-11-06", "2026-11-06"], ["2026-10-01", "2026-11-20"], ["2026-11-06"], ["2026-11-06", "2026-11-20", "2026-12-01"], ["06/11/2026", "20/11/2026"]]) {
    assert.equal(operationTermsFromForm(form({ customDueDates: JSON.stringify(custom) })).ok, false, JSON.stringify(custom));
  }
  assert.equal(operationTermsFromForm(form({ customDueDates: "{não é lista" })).ok, false);
});
