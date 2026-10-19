import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPortfolio } from "../src/lib/finance/portfolio.ts";
import { operationLedger, deferralDueDate, deferralEligibility } from "../src/lib/finance/rules.ts";

// Parcela renegociada para o final: 9 × R$ 400 (15/07/2026), parcelas 1–3 pagas, a 4ª (15/10/2026) em atraso, acréscimo de R$ 100.
const TODAY = "2026-10-18";
const operation = { id: "op_b", clientId: "c1", clientName: "Bruna", principalCents: 300_000, interestRateBps: 0, interestCents: 60_000, totalCents: 360_000, loanDate: "2026-06-15", dueDate: "2027-03-15", firstDueDate: "2026-07-15", status: "OPEN", settledAt: null, calculationRule: "FIXED_MONTHLY_INSTALLMENTS_V1", modality: "INSTALLMENT", frequency: "MONTHLY", installmentCount: 9, installmentCents: 40_000, createdAt: "2026-06-15T10:00:00Z" };
const pay = (n, amount = 40_000) => ({ id: `p${n}`, operationId: "op_b", clientName: "Bruna", amountCents: amount, paidAt: `2026-0${6 + n}-15`, notes: null, createdAt: `2026-0${6 + n}-15T12:00:00Z` });
const deferral = (number, additionCents, newDueDate, original = 40_000) => ({ id: `d${number}`, originalNumber: number, originalDueDate: "x", originalAmountCents: original, additionCents, newDueDate, newAmountCents: original + additionCents, reason: null, createdAt: "2026-10-18T00:00:00Z" });
const view = (deferrals = [], payments = [pay(1), pay(2), pay(3)]) => buildPortfolio({ initialCapitalCents: 1_000_000, hasWallet: true, operations: [{ ...operation, deferrals }], payments, today: TODAY }).operations[0];

test("DF1. sem renegociação nada muda: 9 parcelas, saldo R$ 2.400, numeração igual à original", () => {
  const op = view();
  assert.equal(op.installments.length, 9);
  assert.equal(op.installmentTotal, 9);
  assert.equal(op.balanceCents, 240_000);
  assert.deepEqual(op.installments.map((item) => item.number), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(op.installments.every((item) => item.number === item.originalNumber && item.deferredTo === null && item.deferredFrom === null));
});

test("DF2. caso da Bruna: 4/9 vira Renegociada para o final, nasce R$ 500 em 15/04/2027 e a sequência ativa é renumerada", () => {
  const base = view();
  const date = deferralDueDate(base.ledgerTerms, base.installments);
  assert.equal(date, "2027-04-15");
  const op = view([deferral(4, 10_000, date)]);
  const [p1, p2, p3, p4, ...rest] = op.installments;
  assert.deepEqual([p1, p2, p3].map((item) => [item.number, item.state, item.paidCents]), [[1, "PAID", 40_000], [2, "PAID", 40_000], [3, "PAID", 40_000]]);
  assert.equal(p4.state, "DEFERRED");
  assert.equal(p4.originalNumber, 4);
  assert.equal(p4.dueDate, "2026-10-15");
  assert.equal(p4.amountCents, 40_000);
  assert.equal(p4.paidCents, 0);
  assert.equal(p4.remainingCents, 0);
  assert.equal(p4.deferredTo, 9);
  // 5..9 passam a 4..8 com as mesmas datas; a obrigação nova é a 9ª ativa.
  assert.deepEqual(rest.map((item) => [item.number, item.originalNumber, item.dueDate, item.amountCents]), [
    [4, 5, "2026-11-15", 40_000], [5, 6, "2026-12-15", 40_000], [6, 7, "2027-01-15", 40_000], [7, 8, "2027-02-15", 40_000], [8, 9, "2027-03-15", 40_000], [9, 4, "2027-04-15", 50_000],
  ]);
  assert.equal(rest.at(-1).deferredFrom, 4);
  assert.equal(op.installmentTotal, 9);
  // Sem duplicidade de vencimentos entre as obrigações ativas.
  const dates = op.installments.filter((item) => item.state !== "DEFERRED").map((item) => item.dueDate);
  assert.equal(new Set(dates).size, dates.length);
});

test("DF3. total e saldo: o contrato passa de R$ 3.600 para R$ 3.700 e o saldo de R$ 2.400 para R$ 2.500; nada vira pago", () => {
  const before = view();
  const after = view([deferral(4, 10_000, "2027-04-15")]);
  assert.equal(before.totalCents, 360_000);
  assert.equal(after.totalCents, 370_000);
  assert.equal(after.balanceCents, 250_000);
  assert.equal(after.paidCents, before.paidCents);
  // Pagamentos já feitos não mudam de divisão: o acréscimo não vira lucro recebido antes de ser pago.
  assert.equal(after.interestPaidCents, before.interestPaidCents);
  assert.deepEqual(after.payments.map((item) => [item.interestCents, item.principalCents]), before.payments.map((item) => [item.interestCents, item.principalCents]));
  // O acréscimo é juros do contrato (só realizado quando pago): os juros a receber sobem R$ 100.
  assert.equal(after.interestRemainingCents, before.interestRemainingCents + 10_000);
  assert.equal(after.principalRemainingCents, before.principalRemainingCents);
  assert.equal(after.nextInstallment.originalNumber, 5);
  assert.equal(after.nextDueDate, "2026-11-15");
});

test("DF4. sem acréscimo, só a data muda e o total fica igual", () => {
  const after = view([deferral(4, 0, "2027-04-15")]);
  assert.equal(after.totalCents, 360_000);
  assert.equal(after.installments.at(-1).amountCents, 40_000);
});

test("DF5. pagamento posterior cobre as obrigações ativas em ordem e quita no fim, sem pagar a parcela renegociada", () => {
  const payments = [pay(1), pay(2), pay(3), pay(4)];
  const op = view([deferral(4, 10_000, "2027-04-15")], payments);
  assert.equal(op.installments.find((item) => item.originalNumber === 5).state, "PAID");
  assert.equal(op.installments.find((item) => item.state === "DEFERRED").paidCents, 0);
  const all = view([deferral(4, 10_000, "2027-04-15")], [pay(1), pay(2), pay(3), { ...pay(4, 250_000), id: "rest" }]);
  assert.equal(all.balanceCents, 0);
  assert.ok(all.installments.filter((item) => item.state !== "DEFERRED").every((item) => item.state === "PAID"));
  assert.equal(all.interestPaidCents, 70_000);
});

test("DF6. quinzenal usa a periodicidade do contrato", () => {
  const biweekly = { ...operation, frequency: "BIWEEKLY", firstDueDate: "2026-07-10" };
  const op = buildPortfolio({ initialCapitalCents: 1_000_000, hasWallet: true, operations: [biweekly], payments: [], today: TODAY }).operations[0];
  const date = deferralDueDate(op.ledgerTerms, op.installments);
  assert.equal(date, op.installments.at(-1).dueDate.replace(/.*/, (last) => op.ledgerTerms && date));
  assert.ok(date > op.installments.at(-1).dueDate);
  assert.equal((new Date(date) - new Date(op.installments.at(-1).dueDate)) / 86_400_000 <= 16, true);
});

test("DF7. elegibilidade: só parcela em aberto, não renegociada, não paga, de parcelado aberto", () => {
  const op = view([deferral(4, 10_000, "2027-04-15")]);
  const get = (n) => op.installments.find((item) => item.originalNumber === n && item.deferredFrom === null);
  const target = op.installments.find((item) => item.deferredFrom === 4);
  const ctx = { status: "OPEN", modality: "INSTALLMENT" };
  assert.equal(deferralEligibility(ctx, get(5)).ok, true);
  assert.equal(deferralEligibility(ctx, get(4)).ok, false);
  assert.equal(deferralEligibility(ctx, get(1)).ok, false);
  assert.equal(deferralEligibility(ctx, target).ok, false);
  assert.equal(deferralEligibility({ ...ctx, settlementPaymentId: "x" }, get(5)).ok, false);
  assert.equal(deferralEligibility({ status: "OPEN", modality: "SINGLE" }, get(5)).ok, false);
  const partial = view([], [pay(1), pay(2), pay(3), pay(4, 10_000)]);
  assert.equal(deferralEligibility(ctx, partial.installments[3]).ok, false);
});

test("DF8. liquidação antecipada mantém a parcela renegociada como histórico", () => {
  const terms = { ...view([deferral(4, 10_000, "2027-04-15")]).ledgerTerms, settlementPaymentId: "s" };
  const ledger = operationLedger(terms, [pay(1), pay(2), pay(3), { id: "s", amountCents: 100_000, paidAt: "2026-10-18", createdAt: "z" }], TODAY);
  assert.equal(ledger.schedule.find((item) => item.originalNumber === 4 && item.deferredFrom === null).state, "DEFERRED");
  assert.equal(ledger.balanceCents, 0);
});
