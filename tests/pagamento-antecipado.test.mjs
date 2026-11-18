// Pagamento antecipado (pedido da Thaís, 18/11/2026): o recebimento pode ter data anterior ao vencimento e até à data do
// empréstimo. A data real fica gravada; juros e principal seguem o contrato (o extrato não recalcula por data); o início
// e os vencimentos não mudam sozinhos; a divisão juros/principal e a renovação de cada modalidade são as mesmas de
// sempre. Casos: antecipado (antes do empréstimo), na data do vencimento e em atraso.
import { test } from "node:test";
import assert from "node:assert/strict";
import { operationLedger, planPayment } from "../src/lib/finance/rules.ts";

// Contrato do print: R$ 180,00 com juros de R$ 20,02 (saldo total R$ 200,02), empréstimo 26/11/2026, 1º vencimento 26/12/2026.
const DUE = "2026-12-26";
const timings = { antecipado: "2026-11-18", "no vencimento": DUE, "em atraso": "2027-01-10" };
const single = (paymentOrder) => ({
  modality: "SINGLE", frequency: "MONTHLY", principalCents: 18000, interestRateBps: 1112, interestCents: 2002, firstDueDate: DUE,
  installmentCount: null, installmentCents: null, renewals: [], paymentOrder,
});
function record(state, id, input, asOf = input.paidAt) {
  const plan = planPayment(state.terms, state.payments, input, asOf, id);
  if (!plan.ok) return { ...state, error: plan.error };
  const payments = [...state.payments, { id, amountCents: input.amountCents, paidAt: input.paidAt, createdAt: `${input.paidAt}T12:00:0${state.payments.length}Z`, mode: plan.mode, allocationOrder: plan.allocationOrder, period: plan.period }];
  const terms = plan.renewal ? { ...state.terms, renewals: [...state.terms.renewals, { paymentId: id, ...plan.renewal }] } : state.terms;
  return { terms, payments, plan };
}

for (const order of ["INTEREST_FIRST", "PRINCIPAL_FIRST"]) {
  test(`PA1. pagamento único (${order}): saldo total R$ 200,02 quita igual antecipado, no vencimento e em atraso`, () => {
    for (const [label, paidAt] of Object.entries(timings)) {
      const s = record({ terms: single(order), payments: [] }, "p1", { mode: "FULL_SETTLEMENT", amountCents: 20002, paidAt });
      assert.equal(s.error, undefined, `${label}: ${s.error}`);
      assert.equal(s.plan.settles, true, label);
      assert.deepEqual([s.plan.interestCents, s.plan.principalCents], [2002, 18000], `${label}: juros e principal do contrato`);
      const led = operationLedger(s.terms, s.payments, paidAt);
      assert.equal(led.balanceCents, 0, label);
      assert.equal(led.items[0].paidAt, paidAt, `${label}: data real preservada`);
      assert.equal(s.terms.firstDueDate, DUE, `${label}: vencimento não muda`);
    }
  });
}

test("PA2. só os juros e renovar: antecipado renova igual a pagar no vencimento (mesmo novo vencimento, principal intacto); em atraso divide igual", () => {
  const results = Object.fromEntries(Object.entries(timings).map(([label, paidAt]) => [label, record({ terms: single("INTEREST_FIRST"), payments: [] }, "p1", { mode: "INTEREST_ONLY_RENEWAL", amountCents: 2002, paidAt, period: 1 })]));
  for (const [label, s] of Object.entries(results)) {
    assert.equal(s.error, undefined, `${label}: ${s.error}`);
    assert.deepEqual([s.plan.interestCents, s.plan.principalCents], [2002, 0], label);
    assert.equal(s.plan.renewal.previousDueDate, DUE, label);
    assert.equal(s.plan.renewal.principalBaseCents, 18000, label);
    assert.equal(s.plan.renewal.interestCents, 2002, `${label}: juros do próximo período pelo contrato`);
  }
  assert.equal(results.antecipado.plan.renewal.newDueDate, results["no vencimento"].plan.renewal.newDueDate, "antecipar não adianta nem atrasa o calendário");
  assert.equal(results.antecipado.plan.renewal.newDueDate, "2027-01-26");
});

test("PA3. pagamento parcial antes do empréstimo: exatamente o mesmo resultado de um pagamento antes do vencimento (já permitido); no vencimento e em atraso seguem a regra de sempre", () => {
  const BEFORE_DUE = "2026-12-10"; // depois do empréstimo e antes do vencimento: caso que já era aceito
  for (const order of ["INTEREST_FIRST", "PRINCIPAL_FIRST"]) {
    const pay = (paidAt) => record({ terms: single(order), payments: [] }, "p1", { mode: "MANUAL", amountCents: 5000, paidAt });
    const early = pay(timings.antecipado), reference = pay(BEFORE_DUE);
    assert.equal(early.error, undefined, early.error);
    for (const key of ["interestCents", "principalCents"]) assert.equal(early.plan[key], reference.plan[key], `${order}: ${key}`);
    for (const key of ["balanceCents", "interestRemainingCents", "principalRemainingCents", "nextDueDate"]) assert.equal(early.plan.after[key], reference.plan.after[key], `${order}: ${key}`);
    assert.equal(early.plan.after.nextDueDate, DUE, `${order}: vencimento mantido`);
    // Divisão pela ordem de sempre: juros primeiro (R$ 20,02 + R$ 29,98) ou principal primeiro (R$ 50,00 de principal).
    assert.deepEqual([early.plan.interestCents, early.plan.principalCents], order === "INTEREST_FIRST" ? [2002, 2998] : [0, 5000]);
    // No vencimento e em atraso a divisão do dinheiro é a mesma; muda só o que a regra de períodos já previa.
    for (const paidAt of [DUE, timings["em atraso"]]) {
      const late = pay(paidAt);
      assert.equal(late.error, undefined, late.error);
      assert.deepEqual([late.plan.interestCents, late.plan.principalCents], [early.plan.interestCents, early.plan.principalCents], `${order} ${paidAt}`);
    }
  }
});

test("PA4. parcelado: 1ª parcela paga antes do empréstimo abate o principal primeiro e não mexe nas datas das parcelas", () => {
  const terms = { modality: "INSTALLMENT", frequency: "MONTHLY", principalCents: 30000, interestRateBps: 1000, interestCents: 6000, firstDueDate: DUE,
    installmentCount: 3, installmentCents: 12000, renewals: [], paymentOrder: "PRINCIPAL_FIRST" };
  const dates = (state, asOf) => operationLedger(state.terms, state.payments, asOf).schedule.map((item) => item.dueDate).join(",");
  const base = { terms, payments: [] };
  for (const [label, paidAt] of Object.entries(timings)) {
    const s = record(base, "p1", { mode: "MANUAL", amountCents: 12000, paidAt });
    assert.equal(s.error, undefined, `${label}: ${s.error}`);
    assert.deepEqual([s.plan.interestCents, s.plan.principalCents], [0, 12000], `${label}: principal primeiro`);
    assert.equal(s.plan.after.balanceCents, 24000, label);
    assert.equal(dates(s, paidAt), dates(base, paidAt), `${label}: datas das parcelas iguais`);
  }
});
