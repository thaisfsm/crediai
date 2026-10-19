import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPortfolio } from "../src/lib/finance/portfolio.ts";
import { renegotiationContract, renegotiationPosition, skipInstallmentPlan } from "../src/lib/finance/renegotiation.ts";
import { amortizedSchedule } from "../src/lib/finance/rules.ts";

// Jogar a parcela para o final: caso da Bruna (9 × R$ 400, 3 pagas, a 4ª em atraso, multa R$ 100 → última R$ 500).
const TODAY = "2026-10-18";
const operation = { id: "op_b", clientId: "c1", clientName: "Bruna", principalCents: 300_000, interestRateBps: 0, interestCents: 60_000, totalCents: 360_000, loanDate: "2026-06-15", dueDate: "2027-03-15", firstDueDate: "2026-07-15", status: "OPEN", settledAt: null, calculationRule: "FIXED_MONTHLY_INSTALLMENTS_V1", modality: "INSTALLMENT", frequency: "MONTHLY", installmentCount: 9, installmentCents: 40_000, createdAt: "2026-06-15T10:00:00Z" };
const pay = (n) => ({ id: `p${n}`, operationId: "op_b", clientName: "Bruna", amountCents: 40_000, paidAt: `2026-0${6 + n}-15`, notes: null, createdAt: `2026-0${6 + n}-15T12:00:00Z` });
const view = () => buildPortfolio({ initialCapitalCents: 1_000_000, hasWallet: true, operations: [operation], payments: [pay(1), pay(2), pay(3)], today: TODAY }).operations[0];

test("SK1. só a primeira parcela em aberto pode ir para o final; as demais datas ficam", () => {
  const op = view();
  assert.equal(op.installments.length, 9);
  const plan = skipInstallmentPlan(op, 4);
  assert.ok(plan.ok);
  assert.equal(plan.count, 6);
  assert.equal(plan.firstDueDate, "2026-11-15");
  assert.equal(plan.movedFrom, "2026-10-15");
  assert.equal(skipInstallmentPlan(op, 5).ok, false);
  assert.equal(skipInstallmentPlan(op, 2).ok, false);
});

test("SK2. contrato novo: 5 × R$ 400 nas datas de antes e a parcela pulada no fim, com a multa (R$ 500)", () => {
  const op = view();
  const plan = skipInstallmentPlan(op, 4);
  const built = renegotiationContract(renegotiationPosition([op]), { modality: "INSTALLMENT", frequency: plan.frequency, rateBps: 0, count: plan.count, firstDueDate: plan.firstDueDate, adjustmentCents: 0, penaltyCents: 10_000 }, TODAY);
  assert.ok(built.ok);
  assert.equal(built.roundingCents, 0);
  const schedule = amortizedSchedule({ ...built.contract, modality: "INSTALLMENT" }, 0);
  assert.deepEqual(schedule.map((item) => item.dueDate), ["2026-11-15", "2026-12-15", "2027-01-15", "2027-02-15", "2027-03-15", "2027-04-15"]);
  assert.deepEqual(schedule.map((item) => item.amountCents), [40_000, 40_000, 40_000, 40_000, 40_000, 50_000]);
});

test("SK3. sem multa, o total não muda; sem parcela seguinte, a pulada só muda de data", () => {
  const op = view();
  const plan = skipInstallmentPlan(op, 4);
  const built = renegotiationContract(renegotiationPosition([op]), { modality: "INSTALLMENT", frequency: plan.frequency, rateBps: 0, count: plan.count, firstDueDate: plan.firstDueDate, adjustmentCents: 0, penaltyCents: 0 }, TODAY);
  assert.equal(built.contract.totalCents, 240_000);
  const last = { ...op, installments: op.installments.map((item) => (item.number === 9 ? item : { ...item, state: "PAID" })) };
  const lone = skipInstallmentPlan(last, 9);
  assert.ok(lone.ok);
  assert.equal(lone.count, 1);
  assert.equal(lone.firstDueDate, "2027-04-15");
});
