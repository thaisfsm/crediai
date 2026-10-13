import { test } from "node:test";
import assert from "node:assert/strict";
import { renegotiationPosition, simulateRenegotiation } from "../src/lib/finance/renegotiation.ts";

const op = (status, state, principalRemainingCents, interestRemainingCents, paidCents = 0) => ({ status, state, principalRemainingCents, interestRemainingCents, balanceCents: principalRemainingCents + interestRemainingCents, paidCents, interestPaidCents: paidCents });
const position = renegotiationPosition([op("OPEN", "OVERDUE", 100_000, 30_000), op("OPEN", "ACTIVE", 50_000, 10_000, 5_000), op("PAID", "PAID", 0, 0, 99_000)]);

test("RN1. posição atual: só operações em aberto", () => {
  assert.deepEqual(position, { count: 2, principalOpenCents: 150_000, interestOpenCents: 40_000, balanceCents: 190_000, overdueCount: 1, receivedCents: 5_000, interestReceivedCents: 5_000 });
});

test("RN2. parcelado: juros simples só sobre o principal em aberto, nunca sobre os juros em aberto", () => {
  const result = simulateRenegotiation(position, { modality: "INSTALLMENT", frequency: "MONTHLY", rateBps: 500, count: 3, firstDueDate: "2026-11-10", adjustmentCents: -10_000 });
  assert.equal(result.renegotiatedCents, 180_000);
  assert.equal(result.newInterestCents, 22_500, "150.000 × 5% × 3");
  assert.equal(result.totalCents, 202_500);
  assert.deepEqual(result.payments, [
    { number: 1, dueDate: "2026-11-10", amountCents: 67_500 }, { number: 2, dueDate: "2026-12-10", amountCents: 67_500 }, { number: 3, dueDate: "2027-01-10", amountCents: 67_500 },
  ]);
  assert.deepEqual(result.warnings, []);
});

test("RN3. pagamento único quinzenal, centavos na última parcela e aviso de desconto acima dos juros", () => {
  const single = simulateRenegotiation(position, { modality: "SINGLE", frequency: "BIWEEKLY", rateBps: 1000, count: 9, firstDueDate: "2026-11-06", adjustmentCents: 0 });
  assert.equal(single.payments.length, 1);
  assert.equal(single.totalCents, 190_000 + 15_000);
  assert.equal(single.periodInterestCents, 15_000);
  const odd = simulateRenegotiation(position, { modality: "INSTALLMENT", frequency: "BIWEEKLY", rateBps: 0, count: 3, firstDueDate: "2026-11-06", adjustmentCents: 1 });
  assert.deepEqual(odd.payments.map((payment) => [payment.dueDate, payment.amountCents]), [["2026-11-06", 63_333], ["2026-11-21", 63_333], ["2026-12-06", 63_335]]);
  const tooMuch = simulateRenegotiation(position, { modality: "SINGLE", frequency: "MONTHLY", rateBps: 0, count: 1, firstDueDate: "2026-11-06", adjustmentCents: -50_000 });
  assert.match(tooMuch.warnings[0], /parte do principal/);
});

test("RN4. comparação atual × proposta: principal sem saída nova de caixa, juros a receber e lucro realizado inalterado", () => {
  // Desconto de R$ 100 sobre R$ 400 de juros em aberto; 10% × 3 sobre R$ 1.500.
  const result = simulateRenegotiation(position, { modality: "INSTALLMENT", frequency: "MONTHLY", rateBps: 500, count: 3, firstDueDate: "2026-11-10", adjustmentCents: -10_000 });
  assert.deepEqual(result.comparison, {
    principal: { current: 150_000, proposal: 150_000 },
    interest: { current: 40_000, proposal: 30_000 + 22_500 },
    total: { current: 190_000, proposal: 202_500 },
    realizedProfit: { current: 5_000, proposal: 5_000 },
    capitalOutflowCents: 0,
  });
  // Desconto maior que os juros em aberto: a diferença sai do principal.
  const deep = simulateRenegotiation(position, { modality: "SINGLE", frequency: "MONTHLY", rateBps: 0, count: 1, firstDueDate: "2026-11-06", adjustmentCents: -50_000 });
  assert.deepEqual([deep.comparison.principal.proposal, deep.comparison.interest.proposal, deep.comparison.total.proposal], [140_000, 0, 140_000]);
  // Acréscimo entra como juros a receber, nunca como principal novo.
  const plus = simulateRenegotiation(position, { modality: "SINGLE", frequency: "MONTHLY", rateBps: 0, count: 1, firstDueDate: "2026-11-06", adjustmentCents: 7_000 });
  assert.deepEqual([plus.comparison.principal.proposal, plus.comparison.interest.proposal], [150_000, 47_000]);
});
