import { test } from "node:test";
import assert from "node:assert/strict";
import { allocationOrderFor, operationLedger, planPayment } from "../src/lib/finance/rules.ts";

// Regra de 05/11/2026 (caso Mirian): no PARCELADO o recebimento amortiza primeiro o principal; juros só depois do principal
// todo quitado. Contrato: R$ 1.500 em 3 × R$ 800 (total R$ 2.400, juros R$ 900).
const mirian = (paymentOrder = "INTEREST_FIRST", extra = {}) => ({
  modality: "INSTALLMENT", frequency: "MONTHLY", principalCents: 150000, interestRateBps: 0, interestCents: 90000,
  firstDueDate: "2026-11-13", installmentCount: 3, installmentCents: 80000, renewals: [], paymentOrder, ...extra,
});
const pf = (id, amountCents, paidAt) => ({ id, amountCents, paidAt, createdAt: paidAt, mode: "MANUAL", allocationOrder: "PRINCIPAL_FIRST" });
const legacy = (id, amountCents, paidAt, allocationOrder = "INTEREST_FIRST") => ({ id, amountCents, paidAt, createdAt: paidAt, mode: "MANUAL", allocationOrder });
const split = (ledger) => ledger.items.map((item) => [item.principalCents, item.interestCents]);

test("PP1. 1º recebimento de R$ 800 vai todo para o principal: principal 1.500 → 700, juros 900 pendentes", () => {
  const ledger = operationLedger(mirian(), [pf("p1", 80000, "2026-11-04")], "2026-11-05");
  assert.deepEqual(split(ledger), [[80000, 0]]);
  assert.equal(ledger.principalRemainingCents, 70000);
  assert.equal(ledger.interestRemainingCents, 90000);
  assert.equal(ledger.interestPaidCents, 0);
  assert.equal(ledger.balanceCents, 160000);
});

test("PP2. 2º recebimento termina o principal (700) e começa os juros (100)", () => {
  const ledger = operationLedger(mirian(), [pf("p1", 80000, "2026-11-04"), pf("p2", 80000, "2026-12-13")], "2026-12-13");
  assert.deepEqual(split(ledger), [[80000, 0], [70000, 10000]]);
  assert.equal(ledger.principalRemainingCents, 0);
  assert.equal(ledger.interestRemainingCents, 80000);
});

test("PP3. 3º recebimento é todo juros e liquida: principal 1.500, juros 900, total 2.400", () => {
  const ledger = operationLedger(mirian(), [pf("p1", 80000, "2026-11-04"), pf("p2", 80000, "2026-12-13"), pf("p3", 80000, "2027-01-13")], "2027-01-13");
  assert.deepEqual(split(ledger), [[80000, 0], [70000, 10000], [0, 80000]]);
  assert.equal(ledger.principalPaidCents, 150000);
  assert.equal(ledger.interestPaidCents, 90000);
  assert.equal(ledger.paidCents, 240000);
  assert.equal(ledger.balanceCents, 0);
  assert.equal(ledger.state, "PAID");
  assert.ok(ledger.schedule.every((item) => item.state === "PAID"));
});

test("PP4. pagamento parcial (R$ 300) abate só principal; parcela continua em aberto", () => {
  const ledger = operationLedger(mirian(), [pf("p1", 30000, "2026-11-04")], "2026-11-05");
  assert.deepEqual(split(ledger), [[30000, 0]]);
  assert.equal(ledger.principalRemainingCents, 120000);
  assert.equal(ledger.interestRemainingCents, 90000);
  assert.equal(ledger.nextItem.number, 1);
  assert.equal(ledger.nextItem.remainingCents, 50000);
});

test("PP5. pagamento acima do principal restante: só o que falta de principal é amortizado, o resto é juros", () => {
  const ledger = operationLedger(mirian(), [pf("p1", 140000, "2026-11-04"), pf("p2", 50000, "2026-11-20")], "2026-11-20");
  assert.deepEqual(split(ledger), [[140000, 0], [10000, 40000]]);
  assert.equal(ledger.principalRemainingCents, 0);
  assert.equal(ledger.interestRemainingCents, 50000);
});

test("PP6. pagamento que quita o saldo total (R$ 2.400 de uma vez): 1.500 principal + 900 juros", () => {
  const ledger = operationLedger(mirian(), [pf("p1", 240000, "2026-11-04")], "2026-11-04");
  assert.deepEqual(split(ledger), [[150000, 90000]]);
  assert.equal(ledger.balanceCents, 0);
  assert.equal(ledger.items[0].kind, "SETTLEMENT");
});

test("PP7. principal já quitado: recebimento seguinte é 100% juros e nunca passa dos juros devidos", () => {
  const previous = [pf("p1", 150000, "2026-11-04")];
  const ledger = operationLedger(mirian(), [...previous, pf("p2", 20000, "2026-11-10")], "2026-11-10");
  assert.deepEqual(split(ledger), [[150000, 0], [0, 20000]]);
  // Excedente: mantida a proteção atual (não deixa passar do saldo).
  const over = planPayment(mirian(), previous, { mode: "MANUAL", amountCents: 90001, paidAt: "2026-11-10" }, "2026-11-10");
  assert.equal(over.ok, false);
});

test("PP8. o servidor grava PRINCIPAL_FIRST em todo pagamento novo do parcelado (mesmo contrato antigo) e a prévia = gravação", () => {
  assert.equal(allocationOrderFor({ modality: "INSTALLMENT", paymentOrder: "INTEREST_FIRST" }), "PRINCIPAL_FIRST");
  const plan = planPayment(mirian("INTEREST_FIRST"), [], { mode: "MANUAL", amountCents: 80000, paidAt: "2026-11-04" }, "2026-11-05", "p1");
  assert.equal(plan.ok, true);
  assert.equal(plan.allocationOrder, "PRINCIPAL_FIRST");
  assert.equal(plan.principalCents, 80000);
  assert.equal(plan.interestCents, 0);
  assert.equal(plan.principalAfterCents, 70000);
  assert.equal(plan.interestPendingAfterCents, 90000);
  // Gravado com a ordem do plano, o extrato relido dá a mesma divisão.
  const reread = operationLedger(mirian("INTEREST_FIRST"), [{ ...pf("p1", 80000, "2026-11-04"), allocationOrder: plan.allocationOrder }], "2026-11-05");
  assert.deepEqual(split(reread), [[plan.principalCents, plan.interestCents]]);
});

test("PP9. histórico preservado: pagamento antigo gravado como juros primeiro continua 500/300 até a correção autorizada", () => {
  const ledger = operationLedger(mirian("INTEREST_FIRST"), [legacy("p1", 80000, "2026-11-04")], "2026-11-05");
  assert.deepEqual(split(ledger), [[50000, 30000]]);
  // Antigo sem ordem gravada num contrato antigo: também continua proporcional.
  const old = operationLedger(mirian("INTEREST_FIRST"), [legacy("p1", 80000, "2026-11-04", null)], "2026-11-05");
  assert.deepEqual(split(old), [[50000, 30000]]);
  // Próximo recebimento (novo) já é principal primeiro sobre o que sobrou: 1.000 de principal em aberto.
  const mixed = operationLedger(mirian("INTEREST_FIRST"), [legacy("p1", 80000, "2026-11-04"), pf("p2", 80000, "2026-12-13"), pf("p3", 80000, "2027-01-13")], "2027-01-13");
  assert.deepEqual(split(mixed), [[50000, 30000], [80000, 0], [20000, 60000]]);
  assert.equal(mixed.principalPaidCents, 150000);
  assert.equal(mixed.interestPaidCents, 90000);
  assert.equal(mixed.balanceCents, 0);
});

test("PP10. simulação da correção da Mirian: mesmo valor/data, só a divisão muda (500/300 → 800/0)", () => {
  const before = operationLedger(mirian("INTEREST_FIRST"), [legacy("p1", 80000, "2026-11-04")], "2026-11-05");
  const after = operationLedger(mirian("PRINCIPAL_FIRST"), [legacy("p1", 80000, "2026-11-04", "PRINCIPAL_FIRST")], "2026-11-05");
  assert.equal(before.paidCents, after.paidCents);
  assert.equal(before.balanceCents, after.balanceCents);
  assert.equal(before.nextItem.number, after.nextItem.number);
  assert.equal(after.principalPaidCents - before.principalPaidCents, 30000);
  assert.equal(before.interestPaidCents - after.interestPaidCents, 30000);
  assert.equal(after.principalRemainingCents, 70000);
  assert.equal(after.interestRemainingCents, 90000);
});

test("PP11. consistência: em qualquer ponto principal + juros = pago, e nada passa do contratado", () => {
  const payments = [pf("p1", 33333, "2026-11-04"), pf("p2", 80000, "2026-11-20"), pf("p3", 77777, "2026-12-13"), pf("p4", 48890, "2027-01-13")];
  for (let n = 1; n <= payments.length; n++) {
    const ledger = operationLedger(mirian(), payments.slice(0, n), "2027-01-13");
    for (const item of ledger.items) assert.equal(item.principalCents + item.interestCents, item.amountCents);
    assert.equal(ledger.principalPaidCents + ledger.interestPaidCents, ledger.paidCents);
    assert.ok(ledger.principalPaidCents <= 150000 && ledger.interestPaidCents <= 90000);
    assert.equal(ledger.balanceCents, 240000 - ledger.paidCents);
  }
});

test("PP12. outras modalidades preservadas: diário continua proporcional; pagamento único segue a ordem do contrato", () => {
  const daily = { modality: "SINGLE", frequency: "DAILY", principalCents: 100000, interestRateBps: 0, interestCents: 20000, firstDueDate: "2026-11-02", installmentCount: 10, installmentCents: 12000, renewals: [], paymentOrder: "PRINCIPAL_FIRST" };
  const ledger = operationLedger(daily, [pf("d1", 12000, "2026-11-02")], "2026-11-02");
  assert.deepEqual(split(ledger), [[10000, 2000]]);
  assert.equal(allocationOrderFor({ modality: "SINGLE", paymentOrder: "INTEREST_FIRST" }), "INTEREST_FIRST");
  assert.equal(allocationOrderFor({ modality: "SINGLE", paymentOrder: "PRINCIPAL_FIRST" }), "PRINCIPAL_FIRST");
  const single = { modality: "SINGLE", frequency: "MONTHLY", principalCents: 200000, interestRateBps: 3000, interestCents: 60000, firstDueDate: "2026-11-13", installmentCount: null, installmentCents: null, renewals: [], paymentOrder: "INTEREST_FIRST" };
  const s = operationLedger(single, [legacy("s1", 80000, "2026-11-04")], "2026-11-05");
  assert.deepEqual(split(s), [[20000, 60000]]);
});

test("PP13. parcelado quinzenal também é parcelado: principal primeiro", () => {
  const ledger = operationLedger(mirian("PRINCIPAL_FIRST", { frequency: "BIWEEKLY" }), [pf("p1", 80000, "2026-11-04")], "2026-11-05");
  assert.deepEqual(split(ledger), [[80000, 0]]);
});
