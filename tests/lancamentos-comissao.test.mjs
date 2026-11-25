import { test } from "node:test";
import assert from "node:assert/strict";
import { closingTotals, managerCommission } from "../src/lib/managers/commission.ts";

test("fechamento: comissão 2.000 − débito 200 (adiantamento) + crédito 100 (bônus) = 1.900", () => {
  const totals = closingTotals(200000, [{ kind: "DEBIT", amountCents: 20000 }, { kind: "CREDIT", amountCents: 10000 }]);
  assert.deepEqual(totals, { commissionCents: 200000, debitCents: 20000, creditCents: 10000, finalCents: 190000 });
});

test("fechamento sem lançamentos paga a própria comissão (fechamentos antigos continuam iguais)", () => {
  assert.equal(closingTotals(123456, []).finalCents, 123456);
});

test("vários débitos e créditos somam cada um uma vez, em centavos exatos", () => {
  const totals = closingTotals(100001, [
    { kind: "DEBIT", amountCents: 333 }, { kind: "DEBIT", amountCents: 334 }, { kind: "CREDIT", amountCents: 1 }, { kind: "CREDIT", amountCents: 99 },
  ]);
  assert.equal(totals.debitCents, 667);
  assert.equal(totals.creditCents, 100);
  assert.equal(totals.finalCents, 100001 - 667 + 100);
});

test("débito maior que comissão + créditos dá valor final negativo (o servidor recusa)", () => {
  assert.ok(closingTotals(10000, [{ kind: "DEBIT", amountCents: 20000 }, { kind: "CREDIT", amountCents: 5000 }]).finalCents < 0);
});

test("o saldo de comissão a receber cai pela comissão quitada, não pelo valor final com lançamentos", () => {
  const op = { id: "o", clientId: "c", status: "PAID", state: "PAID", interestPaidCents: 2000000, interestRemainingCents: 0, principalRemainingCents: 0, balanceCents: 0, daysUntilDue: 0 };
  // 10% de R$ 20.000 de juros = R$ 2.000 de comissão; fechamento quitou os R$ 2.000 (pagando R$ 1.900 com os lançamentos).
  const summary = managerCommission([{ bps: 1000, operations: [op] }], 200000);
  assert.equal(summary.earnedCents, 200000);
  assert.equal(summary.balanceCents, 0);
  assert.equal(summary.advanceCents, 0);
});
