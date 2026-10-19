import { test } from "node:test";
import assert from "node:assert/strict";
import { operationLedger } from "../src/lib/finance/rules.ts";

// Liquidação antecipada: pagamento final negociado, principal primeiro, restante perdoado.
const pay = (id, amountCents, paidAt) => ({ id, amountCents, paidAt, createdAt: `${paidAt}T00:00:00Z-${id}` });
const single = (extra = {}) => ({ modality: "SINGLE", frequency: "MONTHLY", principalCents: 300000, interestRateBps: 1000, interestCents: 30000, firstDueDate: "2026-11-10", installmentCount: null, installmentCents: null, renewals: [], ...extra });
const parcelado = (extra = {}) => ({ modality: "INSTALLMENT", frequency: "MONTHLY", principalCents: 300000, interestRateBps: 0, interestCents: 60000, firstDueDate: "2026-11-10", installmentCount: 6, installmentCents: 60000, renewals: [], ...extra });

test("LA1. pagamento único: R$3.000 liquidado por R$3.300 → principal 3.000, juros 300, saldo 0, sem desconto", () => {
  const terms = single({ settlementPaymentId: "s" });
  const ledger = operationLedger(terms, [pay("s", 330000, "2026-10-11")], "2026-10-12");
  assert.equal(ledger.balanceCents, 0);
  assert.equal(ledger.principalPaidCents, 300000);
  assert.equal(ledger.interestPaidCents, 30000);
  assert.equal(ledger.forgivenCents, 0);
  assert.equal(ledger.state, "PAID");
});

test("LA2. parcelado 6×600 (total 3.600): liquidar por R$3.300 → principal 3.000, juros recebidos 300, desconto 300, parcelas encerradas", () => {
  const terms = parcelado({ settlementPaymentId: "s" });
  const ledger = operationLedger(terms, [pay("s", 330000, "2026-10-11")], "2026-10-12");
  assert.equal(ledger.balanceCents, 0);
  assert.equal(ledger.principalPaidCents, 300000);
  assert.equal(ledger.interestPaidCents, 30000);
  assert.equal(ledger.forgivenCents, 30000);
  assert.ok(ledger.schedule.every((item) => item.state === "CLOSED" && item.remainingCents === 0));
  assert.equal(ledger.amountDueCents, 0);
  assert.equal(ledger.nextItem, null);
});

test("LA3. pagamentos anteriores ficam exatamente como na regra normal; só a liquidação muda", () => {
  const first = pay("p1", 60000, "2026-11-10");
  const normal = operationLedger(parcelado(), [first], "2026-11-11");
  const settled = operationLedger(parcelado({ settlementPaymentId: "s" }), [first, pay("s", 270000, "2026-11-12")], "2026-11-13");
  const before = settled.items.find((item) => item.id === "p1");
  const same = normal.items.find((item) => item.id === "p1");
  assert.deepEqual([before.interestCents, before.principalCents, before.kind], [same.interestCents, same.principalCents, same.kind]);
  // Saldo antes da liquidação = 3.600 − 600 = 3.000; paga 2.700 → cobre o principal restante (2.500 = 3.000 − 500)?
  const settlement = settled.items.find((item) => item.id === "s");
  assert.equal(settlement.balanceBeforeCents, 300000);
  assert.equal(settlement.interestCents + settlement.principalCents, 270000);
  assert.equal(settled.paidCents, 330000);
  assert.equal(settled.forgivenCents, 30000);
  assert.equal(settled.balanceCents, 0);
});

test("LA4. valor recebido uma vez: paidCents soma só os pagamentos reais, sem pagamento extra", () => {
  const ledger = operationLedger(parcelado({ settlementPaymentId: "s" }), [pay("s", 330000, "2026-10-11")], "2026-10-12");
  assert.equal(ledger.paidCents, 330000);
  assert.equal(ledger.items.length, 1);
  assert.equal(ledger.items[0].kind, "SETTLEMENT");
});

test("LA5. sem marcador de liquidação nada muda: parcelado com pagamento menor continua em aberto", () => {
  const ledger = operationLedger(parcelado(), [pay("s", 330000, "2026-10-11")], "2026-10-12");
  assert.equal(ledger.balanceCents, 30000);
  assert.equal(ledger.forgivenCents, 0);
  assert.equal(ledger.state === "PAID", false);
});

test("LA6. pagamento único com juros do período já pagos antes: liquidação cobre só o principal", () => {
  const terms = single({ settlementPaymentId: "s" });
  const ledger = operationLedger(terms, [pay("p1", 30000, "2026-10-20"), pay("s", 300000, "2026-10-21")], "2026-10-22");
  assert.equal(ledger.balanceCents, 0);
  assert.equal(ledger.principalPaidCents, 300000);
  assert.equal(ledger.interestPaidCents, 30000);
  assert.equal(ledger.forgivenCents, 0);
});
