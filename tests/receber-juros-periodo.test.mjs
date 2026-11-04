// Receber juros e renovar POR PERÍODO (04/11/2026): cada período tem identidade, situação e ação própria; pagar um período
// não quita nem altera os outros; juros simples contínuos; caso Tatiana com nove pagamentos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { operationLedger, planPayment, CONTINUOUS_INTEREST_FROM } from "../src/lib/finance/rules.ts";

const contract = (paymentOrder, extra = {}) => ({
  modality: "SINGLE", frequency: "MONTHLY", principalCents: 500000, interestRateBps: 200, interestCents: 10000, firstDueDate: "2023-05-01",
  installmentCount: null, installmentCents: null, renewals: [], paymentOrder, ...extra,
});
function pay(state, id, period, paidAt, mode = "INTEREST_ONLY_RENEWAL", amountCents) {
  const view = operationLedger(state.terms, state.payments, paidAt).periodViews.find((p) => p.number === period);
  const amount = amountCents ?? view?.remainingCents ?? 10000;
  const plan = planPayment(state.terms, state.payments, { mode, amountCents: amount, paidAt, period }, paidAt, id);
  if (!plan.ok) return { ...state, error: plan.error };
  const payments = [...state.payments, { id, amountCents: amount, paidAt, createdAt: `${paidAt}T12:00:${String(state.payments.length).padStart(2, "0")}Z`, mode: plan.mode, allocationOrder: plan.allocationOrder, period: plan.period }];
  const terms = plan.renewal ? { ...state.terms, renewals: [...state.terms.renewals, { paymentId: id, ...plan.renewal }] } : state.terms;
  return { terms, payments, plan };
}
const start = (order, extra) => ({ terms: contract(order, extra), payments: [] });
const status = (state, asOf) => operationLedger(state.terms, state.payments, asOf).periodViews.map((p) => `${p.number}:${p.status}`).join(" ");

for (const order of ["PRINCIPAL_FIRST", "INTEREST_FIRST"]) {
  test(`RP1/RP2. ${order}: receber o período 1 = 100% juros, principal intacto, renova e abre o 2º`, () => {
    const s = pay(start(order), "p1", 1, "2023-05-01");
    assert.equal(s.error, undefined);
    assert.equal(s.plan.interestCents, 10000); assert.equal(s.plan.principalCents, 0);
    const led = operationLedger(s.terms, s.payments, "2023-05-01");
    assert.equal(led.principalRemainingCents, 500000); assert.equal(led.principalPaidCents, 0);
    assert.equal(led.periodNumber, 2); assert.equal(led.periodDueDate, "2023-06-01"); assert.equal(led.renewalCount, 1);
    assert.equal(status(s, "2023-05-01"), "1:PAID_RENEWED 2:UPCOMING");
  });
}

test("RP3. sem pagar, os períodos nascem um a um (juros simples) e ficam vencidos individualmente", () => {
  const s = start("PRINCIPAL_FIRST");
  const led = operationLedger(s.terms, s.payments, "2023-08-02");
  assert.deepEqual(led.periodViews.map((p) => [p.number, p.dueDate, p.interestCents, p.status]),
    [[1, "2023-05-01", 10000, "OVERDUE"], [2, "2023-06-01", 10000, "OVERDUE"], [3, "2023-07-01", 10000, "OVERDUE"], [4, "2023-08-01", 10000, "OVERDUE"], [5, "2023-09-01", 10000, "UPCOMING"]]);
  assert.equal(led.interestRemainingCents, 50000); assert.equal(led.principalRemainingCents, 500000); assert.equal(led.renewalCount, 0);
});

test("RP4/RP5. pagar o 3º período vencido não quita nem altera o 1º, 2º e 4º", () => {
  let s = start("PRINCIPAL_FIRST");
  const before = operationLedger(s.terms, s.payments, "2023-08-02").periodViews;
  s = pay(s, "p3", 3, "2023-08-02");
  assert.equal(s.error, undefined);
  assert.equal(s.plan.interestCents, 10000); assert.equal(s.plan.principalCents, 0);
  const after = operationLedger(s.terms, s.payments, "2023-08-02").periodViews;
  for (const n of [1, 2, 4]) assert.deepEqual(after.find((p) => p.number === n), before.find((p) => p.number === n), `período ${n} mudou`);
  assert.equal(after[2].status, "PAID_RENEWED"); assert.deepEqual(after[2].paymentIds, ["p3"]);
  assert.equal(operationLedger(s.terms, s.payments, "2023-08-02").interestRemainingCents, 40000);
  assert.equal(operationLedger(s.terms, s.payments, "2023-08-02").principalRemainingCents, 500000);
});

test("RP6. valor diferente dos juros do período e período já pago são recusados", () => {
  const s = start("PRINCIPAL_FIRST");
  const bad = planPayment(s.terms, s.payments, { mode: "INTEREST_ONLY_RENEWAL", amountCents: 20000, paidAt: "2023-06-02", period: 1 }, "2023-06-02", "x");
  assert.equal(bad.ok, false);
  const done = pay(s, "p1", 1, "2023-06-02");
  const again = planPayment(done.terms, done.payments, { mode: "INTEREST_ONLY_RENEWAL", amountCents: 10000, paidAt: "2023-06-02", period: 1 }, "2023-06-02", "y");
  assert.equal(again.ok, false);
  assert.equal(planPayment(s.terms, s.payments, { mode: "MANUAL", amountCents: 10000, paidAt: "2023-06-02", period: 1 }, "2023-06-02", "z").ok, false);
});

test("RP7. renovar o período atual usa o calendário do contrato (dia âncora) ou a data informada", () => {
  const s = pay(start("INTEREST_FIRST", { firstDueDate: "2023-01-31" }), "p1", 1, "2023-01-31");
  assert.equal(s.plan.nextDueDate, "2023-02-28");
  const custom = planPayment(start("INTEREST_FIRST").terms, [], { mode: "INTEREST_ONLY_RENEWAL", amountCents: 10000, paidAt: "2023-05-01", period: 1, newDueDate: "2023-05-20" }, "2023-05-01", "c");
  assert.equal(custom.nextDueDate, "2023-05-20");
});

test("RP8/RP9/RP10. juros simples contínuos sem capitalizar; pagamento manual e amortização respeitam o contrato", () => {
  const s = start("PRINCIPAL_FIRST");
  const led = operationLedger(s.terms, s.payments, "2023-07-15");
  // 3 vencidos (05, 06, 07) = R$ 300 + o 4º período já aberto (vence 01/08) = R$ 400, tudo sobre o mesmo principal.
  assert.equal(led.interestRemainingCents, 40000); assert.equal(led.principalRemainingCents, 500000);
  assert.ok(led.periodViews.every((p) => p.interestCents === 10000));
  const manual = planPayment(s.terms, [], { mode: "MANUAL", amountCents: 10000, paidAt: "2023-07-15" }, "2023-07-15", "m");
  assert.equal(manual.principalCents, 10000); assert.equal(manual.interestCents, 0); // principal primeiro nos manuais
  const am = planPayment(s.terms, [], { mode: "PRINCIPAL_AMORTIZATION", amountCents: 100000, paidAt: "2023-07-15" }, "2023-07-15", "a");
  assert.equal(am.ok, true); assert.equal(am.principalCents, 100000); assert.equal(am.after.interestRemainingCents, 40000);
  const fullPlan = planPayment(s.terms, [], { mode: "FULL_SETTLEMENT", amountCents: 540000, paidAt: "2023-07-15" }, "2023-07-15", "f");
  assert.equal(fullPlan.ok, true); assert.equal(fullPlan.settles, true);
});

test("RP11. contrato antigo (juros primeiro): vencimentos até hoje não mudam; depois da data de corte geram juros contínuos", () => {
  const s = start("INTEREST_FIRST", { firstDueDate: "2026-09-01" });
  // vencimento anterior ao corte: continua "em atraso" no 1º período (regra de sempre)
  assert.equal(operationLedger(s.terms, s.payments, "2026-11-04").periodViews.length, 1);
  assert.ok("2026-09-01" < CONTINUOUS_INTEREST_FROM);
  const later = start("INTEREST_FIRST", { firstDueDate: "2026-12-01" });
  assert.equal(operationLedger(later.terms, later.payments, "2027-02-02").periodViews.length, 4);
});

test("RP14. receber o mesmo período duas vezes não duplica renovação (2º envio recusado)", () => {
  const s = pay(start("PRINCIPAL_FIRST"), "p1", 1, "2023-05-01");
  const dup = planPayment(s.terms, s.payments, { mode: "INTEREST_ONLY_RENEWAL", amountCents: 10000, paidAt: "2023-05-01", period: 1 }, "2023-05-01", "dup");
  assert.equal(dup.ok, false);
  assert.equal(s.terms.renewals.length, 1);
});

test("RP17. Tatiana: 9 recebimentos de R$ 100 como juros = juros 900, principal 0, restante 5.000, 9 períodos renovados", () => {
  let s = start("PRINCIPAL_FIRST");
  const dates = ["2023-05-01", "2023-06-01", "2023-07-01", "2023-08-01", "2023-09-01", "2023-10-01", "2023-11-01", "2023-12-01", "2024-01-01"];
  dates.forEach((d, i) => { s = pay(s, `t${i + 1}`, i + 1, d); assert.equal(s.error, undefined, `t${i + 1}`); });
  const led = operationLedger(s.terms, s.payments, "2024-01-01");
  assert.equal(led.interestPaidCents, 90000); assert.equal(led.paidCents, 90000);
  assert.equal(led.principalPaidCents, 0); assert.equal(led.principalRemainingCents, 500000);
  assert.equal(led.renewalCount, 9); assert.equal(led.items.length, 9);
  assert.deepEqual(led.items.map((i) => i.id), dates.map((_, i) => `t${i + 1}`));
  assert.ok(led.items.every((i) => i.interestCents === 10000 && i.principalCents === 0));
  assert.equal(led.periodNumber, 10); assert.equal(led.periodDueDate, "2024-02-01");
});
