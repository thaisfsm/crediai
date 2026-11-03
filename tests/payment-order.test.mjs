import { test } from "node:test";
import assert from "node:assert/strict";
import { interestOnlyRenewal, operationLedger, planPayment } from "../src/lib/finance/rules.ts";

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

// PO3 (reescrito em 03/11/2026): a versão anterior afirmava que, no contrato novo, "pagar o valor dos juros abate principal,
// não renova" — o oposto da regra funcional definida (a escolha explícita "Só os juros e renovar" é 100% juros e renova em
// qualquer contrato). Mantido: contratos antigos em juros primeiro e o pagamento MANUAL seguindo a ordem do contrato.
test("PO3. antigos seguem juros primeiro; 'Só os juros e renovar' explícito renova também no principal primeiro; manual segue a ordem do contrato", () => {
  for (const order of [undefined, "INTEREST_FIRST"]) {
    const ledger = operationLedger(terms(order), [pay("p1", 100000, "2026-10-26")], "2026-10-26");
    assert.equal(ledger.interestPaidCents, 60000);
    assert.equal(ledger.principalPaidCents, 40000);
    const before = operationLedger(terms(order), [], "2026-10-26");
    assert.ok(interestOnlyRenewal(terms(order), before, 60000), "renovação por pagamento só de juros continua nos contratos antigos");
  }
  const novo = operationLedger(terms("PRINCIPAL_FIRST"), [], "2026-10-26");
  const renewal = interestOnlyRenewal(terms("PRINCIPAL_FIRST"), novo, 60000, true);
  assert.ok(renewal, "contrato novo: a escolha explícita de só juros renova");
  assert.equal(renewal.principalBaseCents, 200000);
  const plan = planPayment(terms("PRINCIPAL_FIRST"), [], { mode: "INTEREST_ONLY_RENEWAL", amountCents: 60000, paidAt: "2026-10-26" }, "2026-10-26");
  assert.equal(plan.ok, true);
  assert.equal(plan.interestCents, 60000);
  assert.equal(plan.principalCents, 0);
  assert.equal(plan.after.principalRemainingCents, 200000);
  assert.equal(plan.after.renewalCount, 1);
  const manual = planPayment(terms("PRINCIPAL_FIRST"), [], { mode: "MANUAL", amountCents: 60000, paidAt: "2026-10-26" }, "2026-10-26");
  assert.equal(manual.principalCents, 60000, "pagamento manual no principal primeiro abate o principal (regra do contrato)");
  assert.equal(manual.renewal, null);
});
