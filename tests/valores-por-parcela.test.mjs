import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPortfolio } from "../src/lib/finance/portfolio.ts";
import { operationTermsFromForm } from "../src/lib/finance/operation-terms.ts";

// Caso da Thaís (valores fictícios): R$ 4.000 em 10 parcelas; a 1ª de R$ 900 e as outras 9 de R$ 800.
const form = (extra = {}) => {
  const data = new FormData();
  for (const [key, value] of Object.entries({ modality: "INSTALLMENT", installmentFrequency: "MONTHLY", loanAmount: "4000,00", installment: "800,00", term: "10", loanDate: "2026-06-11", firstDueDate: "2026-07-30", ...extra })) data.set(key, value);
  return data;
};
const amounts = [90_000, ...Array(9).fill(80_000)];
const asOperation = (terms, extra = {}) => ({ id: "op_a", clientId: "c1", clientName: "Gustavo", principalCents: 400_000, interestRateBps: terms.values.interestRateBps, interestCents: terms.values.interestCents, totalCents: terms.values.totalCents, loanDate: "2026-06-11", dueDate: terms.dueDate, firstDueDate: terms.values.firstDueDate, status: "OPEN", settledAt: null, calculationRule: terms.values.calculationRule, modality: "INSTALLMENT", frequency: "MONTHLY", installmentCount: 10, installmentCents: terms.values.installmentCents, customAmounts: terms.values.installmentAmounts, createdAt: "2026-06-11T10:00:00Z", ...extra });

test("VP1. sem valores ajustados nada é gravado a mais e o total é parcela × quantidade", () => {
  const terms = operationTermsFromForm(form());
  assert.equal(terms.ok, true);
  assert.equal(terms.values.installmentAmounts, null);
  assert.equal(terms.values.totalCents, 800_000);
  assert.equal(operationTermsFromForm(form({ customAmounts: JSON.stringify(Array(10).fill(80_000)) })).values.installmentAmounts, null);
});

test("VP2. 1ª parcela de R$ 900 e as demais de R$ 800: total, lucro e cronograma somam certo", () => {
  const terms = operationTermsFromForm(form({ customAmounts: JSON.stringify(amounts) }));
  assert.equal(terms.ok, true);
  assert.deepEqual(terms.values.installmentAmounts, amounts);
  assert.equal(terms.values.totalCents, 810_000);
  assert.equal(terms.values.interestCents, 410_000);
  assert.equal(terms.values.installmentCents, 80_000); // menor parcela (mantém a regra do banco: total >= qtd × parcela)
  const op = buildPortfolio({ initialCapitalCents: 1_000_000, hasWallet: true, operations: [asOperation(terms)], payments: [], today: "2026-07-01" }).operations[0];
  assert.deepEqual(op.installments.map((item) => item.amountCents), amounts);
  assert.equal(op.installments.reduce((sum, item) => sum + item.amountCents, 0), op.totalCents);
  assert.equal(op.balanceCents, 810_000);
  // Capital: o principal sai uma vez só do caixa, independente dos valores das parcelas.
  const wallet = buildPortfolio({ initialCapitalCents: 1_000_000, hasWallet: true, operations: [asOperation(terms)], payments: [], today: "2026-07-01" });
  assert.equal(wallet.summary.availableCents, 600_000);
});

test("VP3. pagamento de R$ 900 quita a 1ª parcela; depois R$ 800 quita a 2ª (sem duplicidade)", () => {
  const terms = operationTermsFromForm(form({ customAmounts: JSON.stringify(amounts) }));
  const payments = [{ id: "p1", operationId: "op_a", clientId: "c1", clientName: "Gustavo", amountCents: 90_000, paidAt: "2026-07-30", createdAt: "2026-07-30T10:00:00Z" }, { id: "p2", operationId: "op_a", clientId: "c1", clientName: "Gustavo", amountCents: 80_000, paidAt: "2026-08-30", createdAt: "2026-08-30T10:00:00Z" }];
  const op = buildPortfolio({ initialCapitalCents: 1_000_000, hasWallet: true, operations: [asOperation(terms)], payments, today: "2026-09-01" }).operations[0];
  assert.deepEqual(op.installments.slice(0, 3).map((item) => item.state), ["PAID", "PAID", "OPEN"]);
  assert.equal(op.balanceCents, 810_000 - 170_000);
});

test("VP4. valores inválidos são recusados: zero, negativo, quantidade errada ou texto solto", () => {
  for (const bad of [JSON.stringify([0, ...Array(9).fill(80_000)]), JSON.stringify([-5, ...Array(9).fill(80_000)]), JSON.stringify([90_000]), "abc", JSON.stringify([...Array(9).fill(80_000), 1.5])]) {
    assert.equal(operationTermsFromForm(form({ customAmounts: bad })).ok, false, bad);
  }
});

test("VP5. se as parcelas somam menos que o emprestado, recusa", () => {
  assert.equal(operationTermsFromForm(form({ customAmounts: JSON.stringify(Array(10).fill(30_000)) })).ok, false);
});
