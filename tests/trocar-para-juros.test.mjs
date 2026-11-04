// Trocar o tipo de um recebimento já gravado para "Juros / Renovação" (04/11/2026, caso Tatiana: R$ 100 de 01/01/2024
// lançado como pagamento manual, abatendo principal). Mesmo valor e data; só a classificação muda.
import { test } from "node:test";
import assert from "node:assert/strict";
import { operationLedger, planInterestReclassification } from "../src/lib/finance/rules.ts";

const terms = (extra = {}) => ({ modality: "SINGLE", frequency: "MONTHLY", principalCents: 500000, interestRateBps: 200, interestCents: 10000, firstDueDate: "2023-05-01",
  installmentCount: null, installmentCents: null, renewals: [], paymentOrder: "PRINCIPAL_FIRST", ...extra });
const month = (k) => `2023-${String(k + 4).padStart(2, "0")}-01`;
// 8 recebimentos de juros (05 a 12/2023) com as renovações, e o 9º (01/01/2024) gravado como pagamento manual.
function tatiana() {
  const payments = Array.from({ length: 8 }, (_, i) => ({ id: `p${i + 1}`, amountCents: 10000, paidAt: month(i + 1), createdAt: `2026-11-02T21:0${i}:00Z`, mode: "INTEREST_ONLY_RENEWAL", allocationOrder: "PRINCIPAL_FIRST", period: null }));
  const renewals = payments.map((p, i) => ({ paymentId: p.id, periodNumber: i + 2, previousDueDate: month(i + 1), newDueDate: i === 7 ? "2024-01-01" : month(i + 2), principalBaseCents: 500000, interestCents: 10000 }));
  payments.push({ id: "jan", amountCents: 10000, paidAt: "2024-01-01", createdAt: "2026-11-04T02:04:31Z", mode: "MANUAL", allocationOrder: "PRINCIPAL_FIRST", period: null });
  return { terms: terms({ renewals }), payments };
}

test("TJ1. manual de 01/01/2024 vira juros do 9º período: principal volta a R$ 5.000, juros R$ 900, renova até 01/02/2024, saldo R$ 8.500", () => {
  const s = tatiana();
  const before = operationLedger(s.terms, s.payments, "2026-11-04");
  assert.equal(before.principalRemainingCents, 490000); assert.equal(before.balanceCents, 843000);
  const plan = planInterestReclassification(s.terms, s.payments, "jan", "2026-11-04");
  assert.equal(plan.ok, true, plan.error);
  assert.equal(plan.mode, "INTEREST_ONLY_RENEWAL"); assert.equal(plan.period, 9);
  assert.deepEqual(plan.renewal, { periodNumber: 10, previousDueDate: "2024-01-01", newDueDate: "2024-02-01", principalBaseCents: 500000, interestCents: 10000 });
  assert.equal(plan.item.interestCents, 10000); assert.equal(plan.item.principalCents, 0);
  assert.equal(plan.after.interestPaidCents, 90000); assert.equal(plan.after.principalPaidCents, 0);
  assert.equal(plan.after.principalRemainingCents, 500000); assert.equal(plan.after.balanceCents, 850000); assert.equal(plan.after.renewalCount, 9);
  assert.equal(plan.current.balanceCents, 843000);
  // O que o servidor grava reproduz exatamente a prévia.
  const saved = { terms: { ...s.terms, renewals: [...s.terms.renewals, { paymentId: "jan", ...plan.renewal }] }, payments: s.payments.map((p) => (p.id === "jan" ? { ...p, mode: plan.mode, period: plan.period } : p)) };
  const after = operationLedger(saved.terms, saved.payments, "2026-11-04");
  assert.equal(after.balanceCents, plan.after.balanceCents); assert.equal(after.interestPaidCents, 90000);
  assert.equal(after.items.find((i) => i.id === "jan").kind, "RENEWAL");
  assert.equal(after.paidCents, 90000, "nenhum centavo a mais ou a menos");
});

test("TJ2. com recebimento depois dele, recusa (o posterior depende do período)", () => {
  const s = tatiana();
  s.payments.push({ id: "fev", amountCents: 10000, paidAt: "2024-02-01", createdAt: "2026-11-04T18:23:30Z", mode: "INTEREST_ONLY_RENEWAL", allocationOrder: "PRINCIPAL_FIRST", period: 9 });
  const plan = planInterestReclassification(s.terms, s.payments, "jan", "2026-11-04");
  assert.equal(plan.ok, false); assert.match(plan.error, /recebimento mais recente/);
});

test("TJ3. valor diferente dos juros do período, já juros, renovação ou parcelado: recusa", () => {
  const s = tatiana();
  const odd = { ...s, payments: s.payments.map((p) => (p.id === "jan" ? { ...p, amountCents: 15000 } : p)) };
  assert.match(planInterestReclassification(odd.terms, odd.payments, "jan", "2026-11-04").error, /Só o valor exato dos juros/);
  assert.match(planInterestReclassification(s.terms, s.payments, "p8", "2026-11-04").error, /já está como juros/);
  const settled = { ...s.payments.find((p) => p.id === "jan"), mode: "FULL_SETTLEMENT" };
  assert.match(planInterestReclassification(s.terms, [...s.payments.filter((p) => p.id !== "jan"), settled], "jan", "2026-11-04").error, /Só pagamento manual/);
  const inst = terms({ modality: "INSTALLMENT", installmentCount: 3, installmentCents: 200000 });
  assert.match(planInterestReclassification(inst, [{ id: "x", amountCents: 10000, paidAt: "2023-05-01", mode: "MANUAL" }], "x", "2026-11-04").error, /pagamento único/);
  assert.match(planInterestReclassification(s.terms, s.payments, "nao-existe", "2026-11-04").error, /não encontrado/);
});

test("TJ4. contrato antigo (juros primeiro): manual que pagou exatamente os juros também pode virar juros e renovar", () => {
  const t = terms({ paymentOrder: "INTEREST_FIRST" });
  const payments = [{ id: "m1", amountCents: 10000, paidAt: "2023-05-01", createdAt: "2023-05-01T12:00:00Z", mode: "MANUAL", allocationOrder: "INTEREST_FIRST", period: null }];
  const plan = planInterestReclassification(t, payments, "m1", "2023-05-02");
  assert.equal(plan.ok, true, plan.error); assert.equal(plan.period, 1); assert.equal(plan.renewal.periodNumber, 2);
  assert.equal(plan.after.principalRemainingCents, 500000); assert.equal(plan.after.renewalCount, 1);
});
