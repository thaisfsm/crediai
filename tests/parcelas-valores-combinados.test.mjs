import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPortfolio } from "../src/lib/finance/portfolio.ts";
import { operationTermsFromForm } from "../src/lib/finance/operation-terms.ts";
import { amortizedSchedule, operationLedger } from "../src/lib/finance/rules.ts";
import { installmentAmountsSummary } from "../src/lib/finance/format.ts";

// Caso do pedido (valores fictícios): R$ 1.844 em 4 × R$ 922, a 4ª negociada por R$ 411 → total R$ 3.177, juros R$ 1.333.
const form = (extra = {}) => {
  const data = new FormData();
  for (const [key, value] of Object.entries({ modality: "INSTALLMENT", loanAmount: "1.844,00", installment: "922,00", term: "4", loanDate: "2026-11-21", firstDueDate: "2027-01-18", ...extra })) data.set(key, value);
  return data;
};
const viewOf = (terms, extra = {}) => ({
  id: "op_pvc", clientId: "c1", clientName: "Vitória", principalCents: 184_400, interestRateBps: terms.values.interestRateBps, interestCents: terms.values.interestCents, totalCents: terms.values.totalCents,
  loanDate: "2026-11-21", dueDate: terms.dueDate, firstDueDate: terms.values.firstDueDate, status: "OPEN", settledAt: null, calculationRule: terms.values.calculationRule,
  modality: "INSTALLMENT", frequency: "MONTHLY", installmentCount: 4, installmentCents: 92_200, customDueDates: terms.values.installmentDueDates, customAmounts: terms.values.installmentAmounts, createdAt: "2026-11-21T10:00:00Z", ...extra,
});
const portfolioOf = (operation, payments = [], today = "2026-11-23") => buildPortfolio({ initialCapitalCents: 1_000_000, hasWallet: true, operations: [operation], payments, today });

test("PVC1. sem valor ajustado nada muda: parcelas iguais, total = parcela × prazo e nada gravado a mais", () => {
  const terms = operationTermsFromForm(form());
  assert.equal(terms.ok, true);
  assert.equal(terms.values.installmentAmounts, null);
  assert.equal(terms.values.totalCents, 368_800);
  assert.equal(terms.values.interestCents, 184_400);
  // Lista enviada com todos iguais ao valor de cada parcela também não grava nada.
  assert.equal(operationTermsFromForm(form({ customInstallmentAmounts: JSON.stringify([92_200, 92_200, 92_200, 92_200]) })).values.installmentAmounts, null);
});

test("PVC2. 4ª parcela por R$ 411: total, juros e taxa pela soma; cronograma com os valores gravados", () => {
  const terms = operationTermsFromForm(form({ customInstallmentAmounts: JSON.stringify([92_200, 92_200, 92_200, 41_100]) }));
  assert.equal(terms.ok, true);
  assert.deepEqual(terms.values.installmentAmounts, [92_200, 92_200, 92_200, 41_100]);
  assert.equal(terms.values.totalCents, 317_700);
  assert.equal(terms.values.interestCents, 133_300);
  assert.equal(terms.values.installmentCents, 92_200);
  const op = portfolioOf(viewOf(terms)).operations[0];
  assert.deepEqual(op.installments.map((item) => item.amountCents), [92_200, 92_200, 92_200, 41_100]);
  assert.equal(op.balanceCents, 317_700);
  assert.equal(installmentAmountsSummary([92_200, 92_200, 92_200, 41_100]).replace(/\s/g, " "), "3 × R$ 922,00 + 1 × R$ 411,00");
});

test("PVC3. parcela do meio ajustada e datas combinadas juntas; os pagamentos cobrem as parcelas na ordem pelos valores gravados", () => {
  const dates = ["2027-01-18", "2027-02-25", "2027-03-18", "2027-04-18"];
  const terms = operationTermsFromForm(form({ customInstallmentAmounts: JSON.stringify([92_200, 50_000, 92_200, 92_200]), customDueDates: JSON.stringify(dates) }));
  assert.equal(terms.ok, true);
  assert.equal(terms.values.totalCents, 326_600);
  const operation = viewOf(terms);
  const payments = [{ id: "p1", operationId: "op_pvc", clientName: "Vitória", amountCents: 92_200, paidAt: "2027-01-18", createdAt: "2027-01-18T10:00:00Z" }, { id: "p2", operationId: "op_pvc", clientName: "Vitória", amountCents: 50_000, paidAt: "2027-02-25", createdAt: "2027-02-25T10:00:00Z" }];
  const op = portfolioOf(operation, payments, "2027-02-26").operations[0];
  assert.deepEqual(op.installments.map((item) => [item.dueDate, item.amountCents, item.state]), [["2027-01-18", 92_200, "PAID"], ["2027-02-25", 50_000, "PAID"], ["2027-03-18", 92_200, "OPEN"], ["2027-04-18", 92_200, "OPEN"]]);
  assert.equal(op.balanceCents, 326_600 - 142_200);
  // Principal primeiro (regra do parcelado): os R$ 1.422 recebidos ainda são principal; lucro só depois de recuperar o principal.
  const ledger = operationLedger({ ...op.ledgerTerms, paymentOrder: "PRINCIPAL_FIRST" }, payments.map((p) => ({ ...p, allocationOrder: "PRINCIPAL_FIRST" })), "2027-02-26");
  assert.equal(ledger.principalPaidCents, 142_200);
  assert.equal(ledger.interestPaidCents, 0);
  // Quitação completa: juros recebidos = soma das parcelas − principal.
  const full = operationLedger(op.ledgerTerms, [...payments, { id: "p3", amountCents: 184_400, paidAt: "2027-04-18", createdAt: "2027-04-18T10:00:00Z" }], "2027-04-19");
  assert.equal(full.balanceCents, 0);
  assert.equal(full.interestPaidCents, 142_200);
  assert.equal(full.principalPaidCents, 184_400);
});

test("PVC4. valores inválidos recusados: zero, negativo, quantidade errada, texto, centavos quebrados, soma abaixo do emprestado", () => {
  for (const custom of [[92_200, 92_200, 92_200, 0], [92_200, 92_200, 92_200, -1], [92_200, 92_200, 92_200], [92_200, 92_200, 92_200, 92_200, 1], ["922,00", 92_200, 92_200, 92_200], [92_200, 92_200, 92_200, 411.5]]) {
    assert.equal(operationTermsFromForm(form({ customInstallmentAmounts: JSON.stringify(custom) })).ok, false, JSON.stringify(custom));
  }
  assert.equal(operationTermsFromForm(form({ customInstallmentAmounts: "não é json" })).ok, false);
  const below = operationTermsFromForm(form({ customInstallmentAmounts: JSON.stringify([10_000, 10_000, 10_000, 10_000]) }));
  assert.equal(below.ok, false);
  assert.match(below.error, /menos que o valor emprestado/);
});

test("PVC5. valores gravados que não fecham com o total do contrato são ignorados (parcelas iguais, nunca valor inventado)", () => {
  const terms = { modality: "INSTALLMENT", frequency: "MONTHLY", firstDueDate: "2027-01-18", installmentCount: 4, installmentCents: 92_200, principalCents: 184_400, interestCents: 184_400 };
  assert.deepEqual(amortizedSchedule({ ...terms, customAmounts: [92_200, 92_200, 92_200, 41_100] }, 0).map((item) => item.amountCents), [92_200, 92_200, 92_200, 92_200]);
  assert.deepEqual(amortizedSchedule({ ...terms, customAmounts: null }, 0).map((item) => item.amountCents), [92_200, 92_200, 92_200, 92_200]);
  assert.deepEqual(amortizedSchedule({ ...terms, interestCents: 133_300, customAmounts: [92_200, 92_200, 92_200, 41_100] }, 0).map((item) => item.amountCents), [92_200, 92_200, 92_200, 41_100]);
});
