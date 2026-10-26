import { test } from "node:test";
import assert from "node:assert/strict";
import { interestOnlyRenewal, operationLedger } from "../src/lib/finance/rules.ts";

// R$ 2.000 a 30% ao mês (juros do período R$ 600), pagamento único mensal.
const terms = (paymentOrder) => ({ modality: "SINGLE", frequency: "MONTHLY", principalCents: 200000, interestRateBps: 3000, interestCents: 60000, firstDueDate: "2026-11-13", installmentCount: null, installmentCents: null, renewals: [], paymentOrder });
const pay = (id, amountCents, paidAt) => ({ id, amountCents, paidAt, createdAt: paidAt });

test("PO1. principal primeiro: R$ 1.000 pagos abatem o principal; juros e lucro continuam zero; saldo R$ 1.600", () => {
  const ledger = operationLedger(terms("PRINCIPAL_FIRST"), [pay("p1", 100000, "2026-10-26")], "2026-10-26");
  assert.equal(ledger.principalPaidCents, 100000);
  assert.equal(ledger.interestPaidCents, 0);
  assert.equal(ledger.principalRemainingCents, 100000);
  assert.equal(ledger.interestRemainingCents, 60000);
  assert.equal(ledger.balanceCents, 160000);
});

test("PO2. principal primeiro: só o que passa do principal vira juros recebidos (lucro) e quita ao zerar", () => {
  const ledger = operationLedger(terms("PRINCIPAL_FIRST"), [pay("p1", 200000, "2026-10-26"), pay("p2", 30000, "2026-11-01")], "2026-11-01");
  assert.equal(ledger.principalPaidCents, 200000);
  assert.equal(ledger.interestPaidCents, 30000);
  assert.equal(ledger.balanceCents, 30000);
  const settled = operationLedger(terms("PRINCIPAL_FIRST"), [pay("p1", 200000, "2026-10-26"), pay("p2", 60000, "2026-11-01")], "2026-11-01");
  assert.equal(settled.balanceCents, 0);
  assert.equal(settled.state, "PAID");
});

test("PO3. contratos antigos seguem juros primeiro (sem o campo ou INTEREST_FIRST) e o pagamento só de juros renova", () => {
  for (const order of [undefined, "INTEREST_FIRST"]) {
    const ledger = operationLedger(terms(order), [pay("p1", 100000, "2026-10-26")], "2026-10-26");
    assert.equal(ledger.interestPaidCents, 60000);
    assert.equal(ledger.principalPaidCents, 40000);
    const before = operationLedger(terms(order), [], "2026-10-26");
    assert.ok(interestOnlyRenewal(terms(order), before, 60000), "renovação por pagamento só de juros continua nos contratos antigos");
  }
  const novo = operationLedger(terms("PRINCIPAL_FIRST"), [], "2026-10-26");
  assert.equal(interestOnlyRenewal(terms("PRINCIPAL_FIRST"), novo, 60000), null, "contrato novo: pagar o valor dos juros abate principal, não renova");
});
