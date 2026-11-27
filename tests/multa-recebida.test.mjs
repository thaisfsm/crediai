// Multa recebida no pagamento: regra pura (penalty.ts), integração com o caixa (buildPortfolio), Financeiro (cashflow.ts)
// e relatório de rentabilidade (report.ts). A multa é receita própria: nunca vira principal, juros ou saldo do contrato.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPortfolio } from "../src/lib/finance/portfolio.ts";
import { financeRows, financeStatement, negativeAfterChange, negativeAfterChanges, statementCategoryLabels } from "../src/lib/finance/cashflow.ts";
import { PENALTY_KEY_PREFIX, parsePenalty, penaltyRoleOf, penaltyVoidKeys, penaltyChange, penaltyDescription, penaltyKey, penaltyPaymentIdOf, totalReceivedCents } from "../src/lib/finance/penalty.ts";
import { profitabilityReport } from "../src/lib/finance/report.ts";

const TODAY = "2026-10-13";
const op = (id, principalCents, loanDate, extra = {}) => ({
  id, clientId: "c1", clientName: "Cliente Teste", principalCents, interestRateBps: 2000, interestCents: Math.round(principalCents * 0.2), totalCents: Math.round(principalCents * 1.2),
  loanDate, dueDate: "2026-11-10", status: "OPEN", settledAt: null, calculationRule: "FIXED_MONTHLY_INSTALLMENTS_V1", modality: "INSTALLMENT", frequency: "MONTHLY",
  installmentCount: 2, installmentCents: Math.round(principalCents * 0.6), firstDueDate: "2026-10-10", createdAt: `${loanDate}T10:00:00Z`, ...extra,
});
const pay = (id, operationId, amountCents, paidAt, extra = {}) => ({ id, operationId, clientName: "Cliente Teste", amountCents, paidAt, notes: null, createdAt: `${paidAt}T15:00:00Z`, ...extra });
const penaltyMov = (paymentId, amountCents, occurredAt) => ({
  id: `cap_${paymentId}`, kind: "OTHER_INCOME", amountCents, occurredAt, notes: null, reversedMovementId: null, createdAt: `${occurredAt}T15:00:01Z`,
  category: "OTHER_INCOME", description: penaltyDescription("Cliente Teste", "X"), source: "FINANCE", createdByUserId: "u1", penaltyPaymentId: paymentId, penaltyRole: "PENALTY",
});
const build = ({ movements = [], payments = [] } = {}) => buildPortfolio({
  initialCapitalCents: 1_000_000, hasWallet: true, walletCreatedOn: "2026-10-01", capitalMovements: movements, operations: [op("op_a", 100_000, "2026-10-01")], payments, today: TODAY,
});

test("MR1. campo: vazio e 0,00 = sem multa; valor em reais aceito; negativo, texto e acima do limite recusados", () => {
  assert.deepEqual(parsePenalty(""), { ok: true, cents: 0 });
  assert.deepEqual(parsePenalty(undefined), { ok: true, cents: 0 });
  assert.deepEqual(parsePenalty("0,00"), { ok: true, cents: 0 });
  assert.deepEqual(parsePenalty("100,00"), { ok: true, cents: 10_000 });
  assert.deepEqual(parsePenalty("R$ 1.250,50"), { ok: true, cents: 125_050 });
  assert.equal(parsePenalty("-10").ok, false);
  assert.equal(parsePenalty("dez").ok, false);
  assert.equal(parsePenalty("10,999").ok, false);
  assert.equal(parsePenalty("2000000000").ok, false);
});

test("MR2. total recebido = parcela + multa (exemplo R$ 600 + R$ 100 = R$ 700)", () => {
  assert.equal(totalReceivedCents(60_000, 10_000), 70_000);
  assert.equal(totalReceivedCents(60_000, 0), 60_000);
  assert.equal(totalReceivedCents(null, 10_000), 10_000);
});

test("MR3. chave única por pagamento, ida e volta; outras chaves não são multa", () => {
  assert.equal(penaltyKey("pay_1"), `${PENALTY_KEY_PREFIX}pay_1`);
  assert.equal(penaltyPaymentIdOf(penaltyKey("pay_1")), "pay_1");
  assert.equal(penaltyPaymentIdOf("ivf-req123"), null);
  assert.equal(penaltyPaymentIdOf("pen-"), null);
  assert.equal(penaltyPaymentIdOf(null), null);
});

test("MR4. correção: criar, atualizar (valor ou data), retirar ou nada, sempre na mesma linha", () => {
  assert.deepEqual(penaltyChange(0, 0, false), { action: "NONE" });
  assert.deepEqual(penaltyChange(0, 5_000, false), { action: "INSERT", cents: 5_000 });
  assert.deepEqual(penaltyChange(10_000, 15_000, false), { action: "UPDATE", cents: 15_000 });
  assert.deepEqual(penaltyChange(10_000, 10_000, true), { action: "UPDATE", cents: 10_000 });
  assert.deepEqual(penaltyChange(10_000, 10_000, false), { action: "NONE" });
  assert.deepEqual(penaltyChange(10_000, 0, false), { action: "DELETE" });
});

test("MR5. multa entra no caixa uma vez e fica fora de principal, juros, saldo e recebido do contrato", () => {
  const without = build({ payments: [pay("pay_1", "op_a", 60_000, "2026-10-10")] });
  const withPenalty = build({ payments: [pay("pay_1", "op_a", 60_000, "2026-10-10", { penaltyCents: 10_000 })], movements: [penaltyMov("pay_1", 10_000, "2026-10-10")] });
  assert.equal(withPenalty.summary.availableCents - without.summary.availableCents, 10_000);
  const [a, b] = [without.operations[0], withPenalty.operations[0]];
  for (const key of ["paidCents", "interestPaidCents", "principalPaidCents", "balanceCents", "interestRemainingCents", "principalRemainingCents", "state"]) assert.equal(b[key], a[key], key);
  assert.equal(b.penaltyReceivedCents, 10_000);
  assert.equal(a.penaltyReceivedCents, 0);
  assert.equal(b.payments[0].penaltyCents, 10_000);
  assert.equal(b.payments[0].amountCents, 60_000);
});

test("MR6. Financeiro: categoria própria \"Multa recebida\", automática, separada de Outras entradas e do recebimento", () => {
  const portfolio = build({
    payments: [pay("pay_1", "op_a", 60_000, "2026-10-10", { penaltyCents: 10_000 })],
    movements: [penaltyMov("pay_1", 10_000, "2026-10-10"), { id: "m_other", kind: "OTHER_INCOME", amountCents: 3_000, occurredAt: "2026-10-11", notes: null, reversedMovementId: null, createdAt: "2026-10-11T10:00:00Z", category: "OTHER_INCOME", description: "Venda", source: "FINANCE", createdByUserId: "u1" }],
  });
  const rows = financeRows(portfolio.capitalLedger, new Map([["u1", "Thaís"]]));
  const penalty = rows.filter((row) => row.category === "PENALTY_INCOME");
  assert.equal(penalty.length, 1);
  assert.equal(penalty[0].categoryLabel, statementCategoryLabels.PENALTY_INCOME);
  assert.equal(penalty[0].categoryLabel, "Multa recebida");
  assert.equal(penalty[0].amountCents, 10_000);
  assert.equal(penalty[0].direction, "IN");
  assert.match(penalty[0].responsible, /^Automático/);
  assert.equal(rows.filter((row) => row.category === "OTHER_INCOME").length, 1);
  const statement = financeStatement(rows, { from: "2026-10-01", to: TODAY, direction: null, category: null });
  const byKey = Object.fromEntries(statement.categories.map((item) => [item.key, item.amountCents]));
  assert.equal(byKey.PENALTY_INCOME, 10_000);
  assert.equal(byKey.OTHER_INCOME, 3_000);
  assert.equal((byKey.PAYMENT_PRINCIPAL ?? 0) + (byKey.PAYMENT_INTEREST ?? 0), 60_000);
  const filtered = financeStatement(rows, { from: "2026-10-01", to: TODAY, direction: null, category: "PENALTY_INCOME" });
  assert.equal(filtered.inflowsCents, 10_000);
});

test("MR7. relatório de rentabilidade: multas recebidas no período, à parte do recebido e dos juros", () => {
  const operations = [
    { id: "o1", clientId: "c1", clientName: "Ana", status: "OPEN", state: "ACTIVE", loanDate: "2026-09-10", principalCents: 100_000, interestRemainingCents: 0, balanceCents: 0,
      payments: [{ paidAt: "2026-09-25", amountCents: 60_000, interestCents: 10_000, principalCents: 50_000, penaltyCents: 10_000 }, { paidAt: "2026-10-05", amountCents: 60_000, interestCents: 10_000, principalCents: 50_000 }] },
  ];
  const all = profitabilityReport(operations, { period: "CYCLE", from: "", to: "", status: "ALL" }, TODAY);
  assert.equal(all.totals.penaltyReceivedCents, 10_000);
  assert.equal(all.totals.receivedCents, 120_000);
  assert.equal(all.totals.interestReceivedCents, 20_000);
  const october = profitabilityReport(operations, { period: "THIS_MONTH", from: "", to: "", status: "ALL" }, TODAY);
  assert.equal(october.totals.penaltyReceivedCents, 0);
});

test("MR8. capital nunca negativo: reduzir multa e pagamento juntos é conferido de uma vez", () => {
  const ledger = [
    { key: "initial", date: "2026-10-01", amountCents: 0 }, { key: "loan", date: "2026-10-01", amountCents: 0 },
    { key: "pay_1", date: "2026-10-05", amountCents: 60_000 }, { key: "cap_pen", date: "2026-10-05", amountCents: 10_000 },
    { key: "out", date: "2026-10-06", amountCents: -65_000 },
  ];
  assert.equal(negativeAfterChanges(ledger, { removeKeys: ["pay_1", "cap_pen"], adds: [{ date: "2026-10-05", amountCents: 60_000 }] })?.balanceCents, -5_000);
  assert.equal(negativeAfterChanges(ledger, { removeKeys: ["pay_1", "cap_pen"], adds: [{ date: "2026-10-05", amountCents: 60_000 }, { date: "2026-10-05", amountCents: 5_000 }] }), null);
  // A versão de uma linha continua igual.
  assert.equal(negativeAfterChange(ledger, { removeKey: "cap_pen" })?.balanceCents, -5_000);
  assert.equal(negativeAfterChange(ledger, {}), null);
});

test("MR9. multa retirada: receita estornada + saída de estorno se anulam no caixa, não contam como multa do pagamento e aparecem no Financeiro", () => {
  const keys = penaltyVoidKeys("pay_1", "123");
  assert.equal(penaltyRoleOf("OTHER_INCOME", "pen-pay_1"), "PENALTY");
  assert.equal(penaltyRoleOf("OTHER_INCOME", keys.income), "PENALTY_VOIDED");
  assert.equal(penaltyRoleOf("WITHDRAWAL", keys.reversal), "PENALTY_REVERSAL");
  assert.equal(penaltyRoleOf("OTHER_INCOME", "ivf-x"), null);
  assert.equal(penaltyPaymentIdOf(keys.income), null);
  assert.equal(penaltyPaymentIdOf(keys.reversal), null);
  const voidedIncome = { ...penaltyMov("pay_1", 10_000, "2026-10-10"), penaltyPaymentId: null, penaltyRole: "PENALTY_VOIDED" };
  const reversal = { id: "cap_rev", kind: "WITHDRAWAL", amountCents: 10_000, occurredAt: "2026-10-10", notes: null, reversedMovementId: null, createdAt: "2026-10-12T10:00:00Z", category: "OTHER_OUTFLOW", description: "Estorno de multa", source: "FINANCE", createdByUserId: "u1", penaltyRole: "PENALTY_REVERSAL" };
  const without = build({ payments: [pay("pay_1", "op_a", 60_000, "2026-10-10")] });
  const removed = build({ payments: [pay("pay_1", "op_a", 60_000, "2026-10-10")], movements: [voidedIncome, reversal] });
  assert.equal(removed.summary.availableCents, without.summary.availableCents);
  assert.equal(removed.operations[0].penaltyReceivedCents, 0);
  const rows = financeRows(removed.capitalLedger, new Map());
  assert.deepEqual(rows.filter((row) => row.category.startsWith("PENALTY")).map((row) => [row.category, row.categoryLabel, row.direction, row.amountCents]).sort(),
    [["PENALTY_INCOME", "Multa recebida", "IN", 10_000], ["PENALTY_REVERSAL", "Estorno de multa", "OUT", 10_000]]);
});
