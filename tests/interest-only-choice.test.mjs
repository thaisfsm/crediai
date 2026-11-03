import { test } from "node:test";
import assert from "node:assert/strict";
import { interestOnlyRenewal, operationLedger, paymentLabel } from "../src/lib/finance/rules.ts";

// R$ 5.000 a 2% ao mês (juros do período R$ 100), pagamento único mensal — o caso das imagens (4 pagamentos de R$ 100).
const base = (paymentOrder, extra = {}) => ({ modality: "SINGLE", frequency: "MONTHLY", principalCents: 500000, interestRateBps: 200, interestCents: 10000, firstDueDate: "2026-11-05", installmentCount: null, installmentCents: null, renewals: [], paymentOrder, ...extra });
const pay = (id, amountCents, paidAt) => ({ id, amountCents, paidAt, createdAt: paidAt });

// Registra pagamentos como o servidor: "Só os juros e renovar" (explicit) grava a linha de renovação do pagamento.
function register(terms, entries) {
  const payments = [];
  for (const [id, amountCents, paidAt, explicit] of entries) {
    const before = operationLedger(terms, payments, paidAt);
    const renewal = interestOnlyRenewal(terms, before, amountCents, explicit);
    if (explicit) assert.ok(renewal, `${id}: só juros escolhido precisa renovar`);
    if (renewal) terms = { ...terms, renewals: [...terms.renewals, { paymentId: id, periodNumber: before.periodNumber + 1, previousDueDate: renewal.previousDueDate, newDueDate: renewal.defaultNewDueDate, principalBaseCents: renewal.principalBaseCents, interestCents: renewal.nextInterestCents }] };
    payments.push(pay(id, amountCents, paidAt));
  }
  return { terms, payments };
}

test("JR1. R$ 100 só de juros (principal primeiro): juros recebidos +100, principal recebido e restante intactos", () => {
  const { terms, payments } = register(base("PRINCIPAL_FIRST"), [["p1", 10000, "2026-11-05", true]]);
  const ledger = operationLedger(terms, payments, "2026-11-05");
  assert.equal(ledger.interestPaidCents, 10000);
  assert.equal(ledger.principalPaidCents, 0);
  assert.equal(ledger.principalRemainingCents, 500000);
  assert.equal(ledger.items[0].interestCents, 10000);
  assert.equal(ledger.items[0].principalCents, 0);
});

test("JR2. quatro renovações seguidas não alteram o principal; o período avança e a quitação continua R$ 5.100", () => {
  const { terms, payments } = register(base("PRINCIPAL_FIRST"), [["p1", 10000, "2026-11-05", true], ["p2", 10000, "2026-12-05", true], ["p3", 10000, "2027-01-05", true], ["p4", 10000, "2027-02-05", true]]);
  const ledger = operationLedger(terms, payments, "2027-02-05");
  assert.equal(ledger.renewalCount, 4);
  assert.equal(ledger.interestPaidCents, 40000);
  assert.equal(ledger.principalPaidCents, 0);
  assert.equal(ledger.principalRemainingCents, 500000);
  assert.equal(ledger.periodInterestCents, 10000);
  assert.equal(ledger.balanceCents, 510000);
  assert.equal(ledger.nextDueDate, "2027-03-05");
  assert.equal(ledger.state, "ACTIVE");
});

test("JR3. amortização: principal primeiro abate só o principal; juros primeiro separa juros e amortização", () => {
  const pf = operationLedger(base("PRINCIPAL_FIRST"), [pay("a1", 100000, "2026-11-01")], "2026-11-01");
  assert.equal(pf.principalPaidCents, 100000);
  assert.equal(pf.interestPaidCents, 0);
  assert.equal(pf.principalRemainingCents, 400000);
  assert.equal(pf.items[0].kind, "PARTIAL");
  const inf = operationLedger(base("INTEREST_FIRST"), [pay("a1", 110000, "2026-11-01")], "2026-11-01");
  assert.equal(inf.interestPaidCents, 10000);
  assert.equal(inf.principalPaidCents, 100000);
  assert.equal(inf.principalRemainingCents, 400000);
  // Só juros escolhido e depois amortização: cada um no seu lugar.
  const { terms, payments } = register(base("PRINCIPAL_FIRST"), [["p1", 10000, "2026-11-05", true], ["a2", 200000, "2026-11-20", false]]);
  const mixed = operationLedger(terms, payments, "2026-11-20");
  assert.equal(mixed.interestPaidCents, 10000);
  assert.equal(mixed.principalPaidCents, 200000);
  assert.equal(mixed.principalRemainingCents, 300000);
});

test("JR4. liquidação antecipada depois de renovações: encerra, principal R$ 5.000 recuperado e juros só o que passou do principal", () => {
  const { terms, payments } = register(base("PRINCIPAL_FIRST"), [["p1", 10000, "2026-11-05", true], ["p2", 10000, "2026-12-05", true]]);
  const all = [...payments, pay("liq", 505000, "2026-12-20")];
  const ledger = operationLedger({ ...terms, settlementPaymentId: "liq" }, all, "2026-12-20");
  assert.equal(ledger.state, "PAID");
  assert.equal(ledger.balanceCents, 0);
  assert.equal(ledger.principalPaidCents, 500000);
  assert.equal(ledger.interestPaidCents, 25000);
  const liq = ledger.items.find((item) => item.id === "liq");
  assert.equal(liq.kind, "SETTLEMENT");
  assert.equal(liq.principalCents, 500000);
  assert.equal(liq.interestCents, 5000);
});

test("JR5. histórico identifica cada modalidade", () => {
  const { terms, payments } = register(base("PRINCIPAL_FIRST"), [["p1", 10000, "2026-11-05", true], ["a2", 100000, "2026-11-20", false]]);
  const ledger = operationLedger(terms, payments, "2026-11-20");
  assert.deepEqual(ledger.items.map(paymentLabel), ["Juros / Renovação", "Amortização do principal"]);
  const mixed = operationLedger(base("INTEREST_FIRST"), [pay("m", 110000, "2026-11-01")], "2026-11-01");
  assert.equal(paymentLabel(mixed.items[0]), "Juros + amortização do principal");
  const settled = operationLedger(base("INTEREST_FIRST"), [pay("s", 510000, "2026-11-01")], "2026-11-01");
  assert.equal(paymentLabel(settled.items[0]), "Quitação");
});

test("JR6. indicadores consistentes: recebido = juros + principal; saldo = principal restante + juros restantes; lucro = juros recebidos", () => {
  const { terms, payments } = register(base("PRINCIPAL_FIRST"), [["p1", 10000, "2026-11-05", true], ["p2", 10000, "2026-12-05", true], ["a3", 150000, "2026-12-10", false]]);
  const ledger = operationLedger(terms, payments, "2026-12-10");
  const sum = (key) => ledger.items.reduce((total, item) => total + item[key], 0);
  assert.equal(ledger.paidCents, 170000);
  assert.equal(ledger.paidCents, ledger.interestPaidCents + ledger.principalPaidCents);
  assert.equal(ledger.interestPaidCents, sum("interestCents"));
  assert.equal(ledger.principalPaidCents, sum("principalCents"));
  assert.equal(ledger.interestPaidCents, 20000);
  assert.equal(ledger.principalRemainingCents, 500000 - ledger.principalPaidCents);
  assert.equal(ledger.balanceCents, ledger.principalRemainingCents + ledger.interestRemainingCents);
});

test("JR7. outras regras intactas: sem a escolha, principal primeiro abate principal; juros primeiro renova pelo valor; parcelado não renova", () => {
  const noChoice = operationLedger(base("PRINCIPAL_FIRST"), [pay("p1", 10000, "2026-11-05")], "2026-11-05");
  assert.equal(noChoice.principalPaidCents, 10000);
  assert.equal(noChoice.interestPaidCents, 0);
  assert.equal(interestOnlyRenewal(base("PRINCIPAL_FIRST"), operationLedger(base("PRINCIPAL_FIRST"), [], "2026-11-05"), 10000), null);
  const old = base("INTEREST_FIRST");
  assert.ok(interestOnlyRenewal(old, operationLedger(old, [], "2026-11-05"), 10000));
  assert.ok(interestOnlyRenewal(old, operationLedger(old, [], "2026-11-05"), 10000, true));
  const wrongValue = operationLedger(base("PRINCIPAL_FIRST"), [], "2026-11-05");
  assert.equal(interestOnlyRenewal(base("PRINCIPAL_FIRST"), wrongValue, 9000, true), null, "só juros exige o valor exato dos juros do período");
  const installment = { modality: "INSTALLMENT", frequency: "MONTHLY", principalCents: 100000, interestRateBps: 1000, interestCents: 30000, firstDueDate: "2026-11-05", installmentCount: 3, installmentCents: 43334, renewals: [], paymentOrder: "PRINCIPAL_FIRST" };
  assert.equal(interestOnlyRenewal(installment, operationLedger(installment, [], "2026-11-05"), 30000, true), null);
});
