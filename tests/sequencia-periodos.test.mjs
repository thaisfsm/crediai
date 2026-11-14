// Sequência dos períodos de juros (pedido da Thaís, 14/11/2026): o período seguinte só nasce e só é liberado para
// renovação depois que os juros vencidos do anterior estiverem integralmente pagos; o saldo total sugerido é o principal
// em aberto + os juros vencidos e exigíveis, sem juros de períodos futuros; a amortização do principal não muda.
import { test } from "node:test";
import assert from "node:assert/strict";
import { operationLedger, planPayment } from "../src/lib/finance/rules.ts";

// Caso da tela: R$ 1.200 a 30% (R$ 360 por período), 1º vencimento 12/10/2026, juros primeiro (contrato antigo).
const contract = (paymentOrder = "INTEREST_FIRST", extra = {}) => ({
  modality: "SINGLE", frequency: "MONTHLY", principalCents: 120000, interestRateBps: 3000, interestCents: 36000, firstDueDate: "2026-10-12",
  installmentCount: null, installmentCents: null, renewals: [], paymentOrder, ...extra,
});
// Grava pelo mesmo caminho do servidor (planPayment valida e devolve a renovação a gravar).
function record(state, id, input, asOf = input.paidAt) {
  const plan = planPayment(state.terms, state.payments, input, asOf, id);
  if (!plan.ok) return { ...state, error: plan.error };
  const payments = [...state.payments, { id, amountCents: input.amountCents, paidAt: input.paidAt, createdAt: `${input.paidAt}T12:00:${String(state.payments.length).padStart(2, "0")}Z`, mode: plan.mode, allocationOrder: plan.allocationOrder, period: plan.period }];
  const terms = plan.renewal ? { ...state.terms, renewals: [...state.terms.renewals, { paymentId: id, ...plan.renewal }] } : state.terms;
  return { terms, payments, plan };
}
const views = (state, asOf) => operationLedger(state.terms, state.payments, asOf).periodViews.map((p) => `${p.number}:${p.dueDate}:${p.status}${p.locked ? ":locked" : ""}`).join(" ");
// 1º período pago e renovado em 26/10 (R$ 360); 2º vence 12/11.
const screen = (order) => record({ terms: contract(order), payments: [] }, "p1", { mode: "INTEREST_ONLY_RENEWAL", amountCents: 36000, paidAt: "2026-10-26", period: 1 });

for (const order of ["INTEREST_FIRST", "PRINCIPAL_FIRST"]) {
  test(`SP1. ${order}: 1º pago e renovado, 2º vencido → sem 3º período; saldo total = R$ 1.200 + R$ 360 = R$ 1.560`, () => {
    const s = screen(order);
    assert.equal(s.error, undefined);
    assert.equal(views(s, "2026-11-13"), "1:2026-10-12:PAID_RENEWED 2:2026-11-12:OVERDUE");
    const led = operationLedger(s.terms, s.payments, "2026-11-13");
    assert.equal(led.principalRemainingCents, 120000);
    assert.equal(led.interestRemainingCents, 36000);
    assert.equal(led.balanceCents, 156000);
    assert.equal(led.nextDueDate, "2026-11-12");
    assert.equal(led.state, "OVERDUE");
    // Saldo total: R$ 1.920 (com os juros do período futuro) é recusado; R$ 1.560 quita.
    assert.match(planPayment(s.terms, s.payments, { mode: "FULL_SETTLEMENT", amountCents: 192000, paidAt: "2026-11-13" }, "2026-11-13").error, /1560\.00/);
    const full = planPayment(s.terms, s.payments, { mode: "FULL_SETTLEMENT", amountCents: 156000, paidAt: "2026-11-13" }, "2026-11-13");
    assert.equal(full.ok, true); assert.equal(full.settles, true);
    assert.deepEqual([full.interestCents, full.principalCents], order === "INTEREST_FIRST" ? [36000, 120000] : [36000, 120000]);
    // Meses depois, sem pagamento, continua só o 2º período (nenhum juro futuro é antecipado).
    assert.equal(views(s, "2027-03-20"), "1:2026-10-12:PAID_RENEWED 2:2026-11-12:OVERDUE");
    assert.equal(operationLedger(s.terms, s.payments, "2027-03-20").balanceCents, 156000);
  });

  test(`SP2. ${order}: o 3º período não pode ser recebido/renovado antes do 2º; depois de pagar o 2º, o 3º é liberado pelo calendário`, () => {
    let s = screen(order);
    const blocked = planPayment(s.terms, s.payments, { mode: "INTEREST_ONLY_RENEWAL", amountCents: 36000, paidAt: "2026-11-13", period: 3 }, "2026-11-13");
    assert.equal(blocked.ok, false);
    s = record(s, "p2", { mode: "INTEREST_ONLY_RENEWAL", amountCents: 36000, paidAt: "2026-11-13", period: 2 });
    assert.equal(s.error, undefined);
    assert.equal(s.plan.interestCents, 36000); assert.equal(s.plan.principalCents, 0);
    assert.equal(s.plan.renewal.previousDueDate, "2026-11-12");
    assert.equal(s.plan.renewal.newDueDate, "2026-12-12");
    assert.equal(views(s, "2026-11-13"), "1:2026-10-12:PAID_RENEWED 2:2026-11-12:PAID_RENEWED 3:2026-12-12:UPCOMING");
    const led = operationLedger(s.terms, s.payments, "2026-11-13");
    assert.equal(led.balanceCents, 156000, "principal + juros do período atual (3º)");
    assert.equal(led.principalRemainingCents, 120000, "renovação não mexe no principal");
    assert.equal(led.renewalCount, 2);
  });

  test(`SP3. ${order}: período pago no dia certo renova no vencimento; pago tarde só libera um período por vez`, () => {
    const s = screen(order);
    // 2º pago só em 20/01/2027: o 3º nasce com o vencimento do contrato (12/12/2026, já vencido) e o 4º não nasce.
    const late = record(s, "p2", { mode: "INTEREST_ONLY_RENEWAL", amountCents: 36000, paidAt: "2027-01-20", period: 2 });
    assert.equal(late.error, undefined);
    assert.equal(late.plan.renewal.newDueDate, "2026-12-12");
    assert.equal(views(late, "2027-01-20"), "1:2026-10-12:PAID_RENEWED 2:2026-11-12:PAID_RENEWED 3:2026-12-12:OVERDUE");
    assert.equal(operationLedger(late.terms, late.payments, "2027-01-20").balanceCents, 156000);
  });
}

test("SP4. pagamento parcial dos juros vencidos: o restante continua exigível e o período seguinte segue bloqueado", () => {
  const s = screen("INTEREST_FIRST");
  // R$ 200 manual em 13/11 (juros primeiro): abate os juros do 2º, que fica com R$ 160 pendentes; nada de 3º período.
  const partial = record(s, "m1", { mode: "MANUAL", amountCents: 20000, paidAt: "2026-11-13" });
  assert.equal(partial.error, undefined);
  assert.deepEqual([partial.plan.interestCents, partial.plan.principalCents, partial.plan.renewal], [20000, 0, null]);
  const led = operationLedger(partial.terms, partial.payments, "2026-12-20");
  assert.deepEqual(led.periodViews.map((p) => [p.number, p.paidCents, p.remainingCents, p.status]), [[1, 36000, 0, "PAID_RENEWED"], [2, 20000, 16000, "OVERDUE"]]);
  assert.equal(led.balanceCents, 136000);
  // "Receber juros e renovar" do 2º recebe exatamente o que falta (R$ 160) e então libera o 3º.
  assert.match(planPayment(partial.terms, partial.payments, { mode: "INTEREST_ONLY_RENEWAL", amountCents: 36000, paidAt: "2026-12-20", period: 2 }, "2026-12-20").error, /160\.00/);
  const done = record(partial, "p2", { mode: "INTEREST_ONLY_RENEWAL", amountCents: 16000, paidAt: "2026-12-20", period: 2 });
  assert.equal(done.error, undefined);
  assert.equal(views(done, "2026-12-20"), "1:2026-10-12:PAID_RENEWED 2:2026-11-12:PAID_RENEWED 3:2026-12-12:OVERDUE");
  // Principal primeiro: pagamento manual abate o principal (regra de amortização inalterada) e os juros do 2º continuam.
  const pf = record(screen("PRINCIPAL_FIRST"), "m2", { mode: "MANUAL", amountCents: 20000, paidAt: "2026-11-13" });
  assert.deepEqual([pf.plan.principalCents, pf.plan.interestCents], [20000, 0]);
  const pfLed = operationLedger(pf.terms, pf.payments, "2026-12-20");
  assert.equal(pfLed.principalRemainingCents, 100000); assert.equal(pfLed.interestRemainingCents, 36000); assert.equal(pfLed.periodViews.length, 2);
});

test("SP5. período pago antes do vencimento: renova no vencimento normalmente (sem bloqueio)", () => {
  const s = screen("INTEREST_FIRST");
  const early = record(s, "p2", { mode: "MANUAL", amountCents: 36000, paidAt: "2026-11-05" });
  assert.equal(early.error, undefined);
  assert.equal(views(early, "2026-11-12"), "1:2026-10-12:PAID_RENEWED 2:2026-11-12:PAID_RENEWED 3:2026-12-12:UPCOMING");
});

test("SP6. histórico preservado: recebimento já gravado pela regra anterior para um período posterior continua igual; os seguintes ficam bloqueados", () => {
  // Gravado entre 04/11 e 14/11 (juros contínuos): o 3º período (vence 12/12) recebido em 13/12 com o 2º ainda pendente.
  const s = screen("PRINCIPAL_FIRST");
  const payments = [...s.payments, { id: "old3", amountCents: 36000, paidAt: "2026-12-13", createdAt: "2026-12-13T12:00:00Z", mode: "INTEREST_ONLY_RENEWAL", allocationOrder: "PRINCIPAL_FIRST", period: 3 }];
  const led = operationLedger(s.terms, payments, "2027-01-20");
  assert.deepEqual(led.items.map((i) => [i.id, i.interestCents, i.principalCents]), [["p1", 36000, 0], ["old3", 36000, 0]]);
  assert.equal(views({ terms: s.terms, payments }, "2027-01-20"), "1:2026-10-12:PAID_RENEWED 2:2026-11-12:OVERDUE 3:2026-12-12:PAID", "o 4º não nasce enquanto o 2º estiver pendente");
  assert.equal(led.balanceCents, 156000, "só os juros vencidos do 2º; nenhum período futuro");
  assert.equal(led.paidCents, 72000);
});

test("SP7. período com juros anteriores pendentes aparece bloqueado (locked) e não aceita recebimento", () => {
  const s = screen("PRINCIPAL_FIRST");
  // Situação herdada: 2º e 3º pendentes (3º aberto pela regra anterior, com um recebimento do 4º gravado).
  const payments = [...s.payments, { id: "old4", amountCents: 36000, paidAt: "2027-01-13", createdAt: "2027-01-13T12:00:00Z", mode: "INTEREST_ONLY_RENEWAL", allocationOrder: "PRINCIPAL_FIRST", period: 4 }];
  const led = operationLedger(s.terms, payments, "2027-01-20");
  assert.deepEqual(led.periodViews.map((p) => [p.number, p.status, p.locked]), [[1, "PAID_RENEWED", false], [2, "OVERDUE", false], [3, "OVERDUE", true], [4, "PAID", false]]);
  const blocked = planPayment(s.terms, payments, { mode: "INTEREST_ONLY_RENEWAL", amountCents: 36000, paidAt: "2027-01-20", period: 3 }, "2027-01-20");
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /bloqueado: receba antes os juros do 2º período/);
  assert.equal(planPayment(s.terms, payments, { mode: "INTEREST_ONLY_RENEWAL", amountCents: 36000, paidAt: "2027-01-20", period: 2 }, "2027-01-20").ok, true);
});
