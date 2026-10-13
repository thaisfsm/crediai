import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateInstallments, dueDates, monthlyEquivalentRate, installmentDueDate, operationLedger, BIWEEKLY_INSTALLMENT_RULE, INSTALLMENT_RULE } from "../src/lib/finance/rules.ts";

// Parcelado com parcela fixa (mensal ou quinzenal).
const installment = (extra) => ({ modality: "INSTALLMENT", frequency: "BIWEEKLY", interestRateBps: 0, renewals: [], ...extra });
const pay = (id, amountCents, paidAt) => ({ id, amountCents, paidAt });

test("Q1. exemplo: R$ 600 em 3 × R$ 300 quinzenais a partir de 06/11/2026 → 06/11, 21/11 e 06/12", () => {
  const plan = calculateInstallments({ principalCents: 60000, installmentCents: 30000, count: 3, frequency: "BIWEEKLY" });
  assert.equal(plan.totalCents, 90000);
  assert.equal(plan.interestCents, 30000);
  assert.equal(plan.calculationRule, BIWEEKLY_INSTALLMENT_RULE);
  // Juros simples por quinzena: 300 ÷ 600 ÷ 3 = 16,67%; mensal equivalente 33,33%.
  assert.equal(plan.interestRateBps, 1667);
  assert.ok(Math.abs(plan.monthlyRate - 1 / 6) < 1e-12);
  assert.ok(Math.abs(monthlyEquivalentRate(plan.monthlyRate, 15) - 1 / 3) < 1e-12);
  assert.deepEqual(dueDates("BIWEEKLY", "2026-11-06", 3), ["2026-11-06", "2026-11-21", "2026-12-06"]);
  assert.equal(installmentDueDate("2026-11-06", 3, "BIWEEKLY"), "2026-12-06");
  const terms = installment({ principalCents: 60000, interestCents: 30000, firstDueDate: "2026-11-06", installmentCount: 3, installmentCents: 30000 });
  const ledger = operationLedger(terms, [], "2026-10-13");
  assert.deepEqual(ledger.schedule.map((item) => [item.number, item.dueDate, item.amountCents, item.state]),
    [[1, "2026-11-06", 30000, "OPEN"], [2, "2026-11-21", 30000, "OPEN"], [3, "2026-12-06", 30000, "OPEN"]]);
  assert.equal(ledger.nextDueDate, "2026-11-06");
  assert.equal(ledger.balanceCents, 90000);
  assert.equal(ledger.state, "ACTIVE");
});

test("Q2. pagamentos, parcial, atraso e quitação do parcelado quinzenal", () => {
  const terms = installment({ principalCents: 60000, interestCents: 30000, firstDueDate: "2026-11-06", installmentCount: 3, installmentCents: 30000 });
  // 1ª paga em dia; 2ª só metade; hoje = 25/11 → 2ª em atraso há 4 dias, saldo da parcela 150.
  const partial = operationLedger(terms, [pay("p1", 30000, "2026-11-06"), pay("p2", 15000, "2026-11-21")], "2026-11-25");
  assert.deepEqual(partial.schedule.map((item) => item.state), ["PAID", "PARTIAL", "OPEN"]);
  assert.equal(partial.nextItem.number, 2);
  assert.equal(partial.nextItem.remainingCents, 15000);
  assert.equal(partial.amountDueCents, 15000);
  assert.equal(partial.state, "OVERDUE");
  assert.equal(partial.daysUntilDue, -4);
  // Cada pagamento leva juros e principal na proporção do contrato (1/3 juros), sem juros sobre juros nem mora.
  assert.deepEqual(partial.items.map((item) => [item.interestCents, item.principalCents]), [[10000, 20000], [5000, 10000]]);
  assert.equal(partial.balanceCents, 45000);
  // Quitação: o restante (R$ 450) quita; juros recebidos = 300 no total, principal = 600.
  const settled = operationLedger(terms, [pay("p1", 30000, "2026-11-06"), pay("p2", 15000, "2026-11-21"), pay("p3", 45000, "2026-12-06")], "2026-12-06");
  assert.equal(settled.balanceCents, 0);
  assert.equal(settled.state, "PAID");
  assert.equal(settled.interestPaidCents, 30000);
  assert.equal(settled.principalPaidCents, 60000);
  assert.equal(settled.items.at(-1).kind, "SETTLEMENT");
});

test("Q3. pares fixos de dias do quinzenal (mesma regra aprovada do pagamento único quinzenal)", () => {
  assert.deepEqual(dueDates("BIWEEKLY", "2027-01-20", 4), ["2027-01-20", "2027-02-05", "2027-02-20", "2027-03-05"]);
  assert.deepEqual(dueDates("BIWEEKLY", "2027-01-15", 4), ["2027-01-15", "2027-01-30", "2027-02-15", "2027-02-28"]);
  assert.deepEqual(dueDates("BIWEEKLY", "2027-01-30", 3), ["2027-01-30", "2027-02-15", "2027-02-28"]);
});

test("Q4. parcelado mensal e operações antigas continuam iguais (sem efeito colateral)", () => {
  const monthly = calculateInstallments({ principalCents: 1_000_000, installmentCents: 160_000, count: 10 });
  assert.equal(monthly.calculationRule, INSTALLMENT_RULE);
  assert.equal(monthly.interestRateBps, 600);
  assert.equal(installmentDueDate("2026-04-10", 10), "2027-01-10");
  // Termos antigos (frequency MONTHLY gravada no parcelado) e um valor inesperado caem no mensal.
  for (const frequency of ["MONTHLY", "DAILY"]) {
    const ledger = operationLedger(installment({ frequency, principalCents: 1_000_000, interestCents: 600_000, firstDueDate: "2026-04-10", installmentCount: 10, installmentCents: 160_000 }), [], "2026-04-01");
    assert.deepEqual(ledger.schedule.slice(0, 3).map((item) => item.dueDate), ["2026-04-10", "2026-05-10", "2026-06-10"], frequency);
  }
  // Pagamento único quinzenal (juros recorrentes) não muda: renova pelos mesmos pares.
  const single = operationLedger({ modality: "SINGLE", frequency: "BIWEEKLY", principalCents: 800_000, interestRateBps: 1500, interestCents: 120_000, firstDueDate: "2026-11-06", installmentCount: null, installmentCents: null, renewals: [] }, [pay("j", 120_000, "2026-11-06")], "2026-11-07");
  assert.equal(single.nextDueDate, "2026-11-21");
  assert.equal(single.renewalCount, 1);
});
