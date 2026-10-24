import { test } from "node:test";
import assert from "node:assert/strict";
import { clientSituation, commissionOf, effectiveBps, managerCommission } from "../src/lib/managers/commission.ts";

const op = (over = {}) => ({ id: "o", clientId: "c", status: "OPEN", state: "ACTIVE", interestPaidCents: 0, interestRemainingCents: 0, principalRemainingCents: 0, balanceCents: 0, daysUntilDue: 5, ...over });

test("comissão é percentual (pontos-base) sobre os juros, arredondada em centavos", () => {
  assert.equal(commissionOf(10000, 1000), 1000);
  assert.equal(commissionOf(10000, 750), 750);
  assert.equal(commissionOf(333, 1000), 33);
  assert.equal(commissionOf(0, 1000), 0);
  assert.equal(commissionOf(10000, 0), 0);
});

test("percentual livre por cliente: o do cliente vence o padrão do gerente", () => {
  assert.equal(effectiveBps(2000, 1000), 2000);
  assert.equal(effectiveBps(0, 1000), 0);
  assert.equal(effectiveBps(null, 1000), 1000);
  assert.equal(effectiveBps(undefined, 1000), 1000);
});

test("soma por cliente com percentuais diferentes, prevista só das em aberto e canceladas fora", () => {
  const summary = managerCommission([
    { bps: 1000, operations: [op({ status: "PAID", state: "PAID", interestPaidCents: 10000 }), op({ interestRemainingCents: 10000 })] },
    { bps: 2000, operations: [op({ status: "PAID", state: "PAID", interestPaidCents: 10000 }), op({ status: "CANCELED", state: "CANCELED", interestPaidCents: 99999, interestRemainingCents: 99999 })] },
  ], 1000);
  assert.equal(summary.interestReceivedCents, 20000);
  assert.equal(summary.earnedCents, 3000);
  assert.equal(summary.expectedCents, 1000);
  assert.equal(summary.balanceCents, 2000);
  assert.equal(summary.advanceCents, 0);
});

test("pago a mais vira adiantamento e o saldo a receber nunca fica negativo", () => {
  const summary = managerCommission([{ bps: 1000, operations: [op({ status: "PAID", state: "PAID", interestPaidCents: 10000 })] }], 5000);
  assert.equal(summary.balanceCents, 0);
  assert.equal(summary.advanceCents, 4000);
});

test("sem clientes tudo é zero", () => {
  const summary = managerCommission([], 0);
  assert.deepEqual([summary.earnedCents, summary.expectedCents, summary.balanceCents], [0, 0, 0]);
});

test("situação real do cliente: atraso pesa mais; quitado só sem nada em aberto", () => {
  assert.equal(clientSituation([]), "NO_OPERATIONS");
  assert.equal(clientSituation([op({ status: "CANCELED", state: "CANCELED" })]), "NO_OPERATIONS");
  assert.equal(clientSituation([op({ status: "PAID", state: "PAID" })]), "PAID");
  assert.equal(clientSituation([op({ status: "PAID", state: "PAID" }), op()]), "ON_TIME");
  assert.equal(clientSituation([op(), op({ state: "OVERDUE" })]), "OVERDUE");
  assert.equal(clientSituation([op({ state: "DUE_TODAY" })]), "ON_TIME");
  assert.equal(clientSituation([op({ status: "RENEGOTIATED", state: "RENEGOTIATED" })]), "PAID");
});
