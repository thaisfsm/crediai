// Contas a Pagar (Etapa C): regras puras das obrigações com investidores, da baixa e da entrada no capital, e a
// integração com o extrato do Financeiro e o capital disponível de buildPortfolio.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPortfolio } from "../src/lib/finance/portfolio.ts";
import { checkOutflow, financeRows, financeStatement, statementCategoryLabels } from "../src/lib/finance/cashflow.ts";
import {
  INVESTOR_CATEGORIES, buildObligations, checkCapitalEntry, checkPayment, entryDateOf, filterObligations, maskReference, obligationStatus, parsePayablesFilters,
  parsePaymentFields, payablesSections, payablesTotals, paymentCategory,
} from "../src/lib/investors/payables.ts";

const TODAY = "2026-10-13";
const investment = (id, extra = {}) => ({ id, investorId: `inv-${id}`, investorName: `Investidor ${id}`, contractNumber: `C-${id}`, status: "ACTIVE", startDate: "2026-01-10", amountCents: 1_000_000, ...extra });
const item = (id, investmentId, number, dueDate, yieldCents, principalCents = 0) => ({ id, investmentId, number, dueDate, yieldCents, principalCents, description: null });
const pay = (id, scheduleItemId, kind, amountCents, paidOn) => ({ id, scheduleItemId, kind, amountCents, paidOn, method: "PIX", reference: null, notes: null, createdAt: `${paidOn}T12:00:00.000Z`, createdBy: "Teste", capitalMovementId: `cap-${id}` });

test("CP1. cada linha do cronograma gera no máximo uma obrigação por tipo, rendimento e principal separados", () => {
  const list = buildObligations({
    investments: [investment("a")],
    items: [item("i1", "a", 1, "2026-09-10", 10_000), item("i2", "a", 2, "2026-10-10", 10_000, 1_000_000), item("i3", "a", 3, "2026-11-10", 0, 500)],
    payments: [], today: TODAY,
  });
  assert.deepEqual(list.map((obligation) => obligation.key), ["i1:YIELD", "i2:YIELD", "i2:PRINCIPAL", "i3:PRINCIPAL"]);
  assert.equal(new Set(list.map((obligation) => obligation.key)).size, list.length);
  assert.deepEqual(list.map((obligation) => obligation.expectedCents), [10_000, 10_000, 1_000_000, 500]);
});

test("CP2. situação: prevista, parcialmente paga, paga e vencida (vencida com saldo continua em atraso)", () => {
  assert.equal(obligationStatus({ expectedCents: 100, paidCents: 0, dueDate: "2026-10-20" }, TODAY), "PREVISTA");
  assert.equal(obligationStatus({ expectedCents: 100, paidCents: 40, dueDate: "2026-10-20" }, TODAY), "PARCIAL");
  assert.equal(obligationStatus({ expectedCents: 100, paidCents: 100, dueDate: "2026-10-01" }, TODAY), "PAGA");
  assert.equal(obligationStatus({ expectedCents: 100, paidCents: 40, dueDate: "2026-10-12" }, TODAY), "VENCIDA");
  assert.equal(obligationStatus({ expectedCents: 100, paidCents: 0, dueDate: TODAY }, TODAY), "PREVISTA");
});

test("CP3. pagamento parcial e total somam por obrigação; saldo zero é paga", () => {
  const [partial, full] = buildObligations({
    investments: [investment("a")],
    items: [item("i1", "a", 1, "2026-10-20", 10_000), item("i2", "a", 2, "2026-10-25", 5_000)],
    payments: [pay("p1", "i1", "YIELD", 3_000, "2026-10-12"), pay("p2", "i2", "YIELD", 2_000, "2026-10-12"), pay("p3", "i2", "YIELD", 3_000, "2026-10-13")],
    today: TODAY,
  });
  assert.equal(partial.paidCents, 3_000); assert.equal(partial.balanceCents, 7_000); assert.equal(partial.status, "PARCIAL");
  assert.equal(full.paidCents, 5_000); assert.equal(full.balanceCents, 0); assert.equal(full.status, "PAGA");
  assert.deepEqual(full.payments.map((payment) => payment.id), ["p2", "p3"]);
});

test("CP4. contrato cancelado não gera obrigação em aberto; outro contrato não mistura baixas", () => {
  const list = buildObligations({
    investments: [investment("a", { status: "CANCELED" }), investment("b")],
    items: [item("i1", "a", 1, "2026-10-20", 10_000), item("i2", "b", 1, "2026-10-20", 10_000), item("x", "z", 1, "2026-10-20", 10_000)],
    payments: [pay("p1", "i1", "PRINCIPAL", 1, TODAY)], today: TODAY,
  });
  assert.deepEqual(list.map((obligation) => obligation.key), ["i2:YIELD"]);
  assert.equal(list[0].paidCents, 0);
});

test("CP5. seções, filtros e totais derivados (nada guardado à parte)", () => {
  const list = buildObligations({
    investments: [investment("a", { investorName: "Ana Souza" }), investment("b", { investorName: "Bruno Lima" })],
    items: [item("i1", "a", 1, "2026-10-01", 10_000), item("i2", "a", 2, TODAY, 20_000), item("i3", "b", 1, "2026-11-01", 30_000, 1_000_000), item("i4", "b", 2, "2026-09-01", 4_000)],
    payments: [pay("p1", "i1", "YIELD", 4_000, "2026-10-05"), pay("p2", "i4", "YIELD", 4_000, "2026-09-02")], today: TODAY,
  });
  const sections = payablesSections(list, TODAY);
  assert.deepEqual(sections.overdue.map((obligation) => obligation.key), ["i1:YIELD"]);
  assert.deepEqual(sections.dueToday.map((obligation) => obligation.key), ["i2:YIELD"]);
  assert.deepEqual(sections.upcoming.map((obligation) => obligation.key), ["i3:YIELD", "i3:PRINCIPAL"]);
  assert.deepEqual(sections.paid.map((obligation) => obligation.key), ["i4:YIELD"]);
  const all = payablesTotals(list, { from: null, to: null }, TODAY);
  assert.equal(all.overdueCents, 6_000); assert.equal(all.dueTodayCents, 20_000); assert.equal(all.paidCents, 8_000); assert.equal(all.openCents, 6_000 + 20_000 + 30_000 + 1_000_000);
  assert.equal(payablesTotals(list, { from: "2026-10-01", to: "2026-10-31" }, TODAY).paidCents, 4_000);
  // Busca por investidor sem acento e caixa, filtro de tipo, situação e período do vencimento.
  assert.deepEqual(filterObligations(list, parsePayablesFilters({ q: "bruno" })).map((obligation) => obligation.key), ["i4:YIELD", "i3:YIELD", "i3:PRINCIPAL"]);
  assert.deepEqual(filterObligations(list, parsePayablesFilters({ q: "SOUZA", tipo: "rendimento", situacao: "vencida" })).map((obligation) => obligation.key), ["i1:YIELD"]);
  assert.deepEqual(filterObligations(list, parsePayablesFilters({ tipo: "principal" })).map((obligation) => obligation.key), ["i3:PRINCIPAL"]);
  assert.deepEqual(filterObligations(list, parsePayablesFilters({ de: "2026-10-31", ate: "2026-10-02" })).map((obligation) => obligation.key), ["i2:YIELD"]);
  assert.deepEqual(parsePayablesFilters({ situacao: "x", tipo: "y", de: "13/10/2026" }), { q: "", from: null, to: null, status: null, kind: null });
});

test("CP6. formulário da baixa: tipo, valor positivo, data, forma, tamanhos e chave do envio", () => {
  const base = { scheduleItemId: "i1", kind: "YIELD", amount: "1.500,00", paidOn: TODAY, method: "PIX", reference: " E2E  123 ", notes: "", requestId: "0123456789abcdef-x" };
  const ok = parsePaymentFields(base);
  assert.equal(ok.ok, true);
  assert.equal(ok.value.amountCents, 150_000); assert.equal(ok.value.reference, "E2E 123"); assert.equal(ok.value.notes, null);
  for (const [change, message] of [
    [{ kind: "JUROS" }, /tipo/], [{ amount: "-10" }, /menos/], [{ amount: "0" }, /maior que zero/], [{ amount: "abc" }, /reais/],
    [{ paidOn: "2026-02-30" }, /data/], [{ method: "BOLETO" }, /forma/], [{ reference: "x".repeat(121) }, /120/], [{ requestId: "curta" }, /expirado/], [{ scheduleItemId: "" }, /inválida/],
  ]) {
    const result = parsePaymentFields({ ...base, ...change });
    assert.equal(result.ok, false, JSON.stringify(change));
    assert.match(result.error, message);
  }
});

test("CP7. baixa: data entre o início do contrato e hoje, dentro do ciclo, valor até o saldo, contrato não cancelado", () => {
  const context = { today: TODAY, startDate: "2026-03-01", cycleStartedOn: "2026-02-01", balanceCents: 10_000, investmentStatus: "ACTIVE" };
  assert.deepEqual(checkPayment({ amountCents: 10_000, paidOn: TODAY }, context), { ok: true });
  assert.deepEqual(checkPayment({ amountCents: 1, paidOn: "2026-03-01" }, context), { ok: true });
  assert.match(checkPayment({ amountCents: 1, paidOn: "2026-10-14" }, context).error, /depois de hoje/);
  assert.match(checkPayment({ amountCents: 1, paidOn: "2026-02-28" }, context).error, /início do contrato/);
  assert.match(checkPayment({ amountCents: 1, paidOn: "2026-03-01" }, { ...context, cycleStartedOn: "2026-05-01" }).error, /ciclo atual/);
  assert.match(checkPayment({ amountCents: 10_001, paidOn: TODAY }, context).error, /maior que o saldo/);
  assert.match(checkPayment({ amountCents: 1, paidOn: TODAY }, { ...context, balanceCents: 0 }).error, /já está paga/);
  assert.match(checkPayment({ amountCents: 1, paidOn: TODAY }, { ...context, investmentStatus: "CANCELED" }).error, /cancelado/);
});

test("CP8. capital insuficiente: a baixa usa a mesma regra temporal das saídas do Financeiro", () => {
  const portfolio = buildPortfolio({
    initialCapitalCents: 100_000, hasWallet: true, walletCreatedOn: "2026-01-01", today: TODAY, operations: [], payments: [],
    capitalMovements: [{ id: "m1", kind: "WITHDRAWAL", amountCents: 80_000, occurredAt: "2026-06-01", notes: null, reversedMovementId: null, createdAt: "2026-06-01T10:00:00.000Z", category: "OTHER_OUTFLOW", description: "Despesa", source: "FINANCE" }],
  });
  const ledger = [...portfolio.capitalLedger].reverse();
  assert.equal(portfolio.summary.availableCents, 20_000);
  assert.equal(checkOutflow({ ledger, amountCents: 20_000, occurredAt: TODAY, availableCents: 20_000 }).ok, true);
  assert.match(checkOutflow({ ledger, amountCents: 20_001, occurredAt: TODAY, availableCents: 20_000 }).error, /Saldo insuficiente/);
  // Retroativa: antes da despesa havia mais saldo, mas a despesa de junho ficaria negativa.
  assert.match(checkOutflow({ ledger, amountCents: 30_000, occurredAt: "2026-03-01", availableCents: 20_000 }).error, /Saldo insuficiente|ficaria negativo/);
});

test("CP9. entrada no capital: uma vez, nunca cancelado, data do investimento (ou início) dentro do ciclo e não futura", () => {
  assert.equal(entryDateOf({ investedOn: "2026-01-05", startDate: "2026-01-10" }), "2026-01-05");
  assert.equal(entryDateOf({ investedOn: null, startDate: "2026-01-10" }), "2026-01-10");
  const base = { enteredOn: "2026-10-01", today: TODAY, cycleStartedOn: "2026-01-01", investmentStatus: "ACTIVE", hasWallet: true, alreadyRegistered: false };
  assert.deepEqual(checkCapitalEntry(base), { ok: true });
  assert.match(checkCapitalEntry({ ...base, alreadyRegistered: true }).error, /já foi registrada/);
  assert.match(checkCapitalEntry({ ...base, investmentStatus: "CANCELED" }).error, /cancelado/);
  assert.match(checkCapitalEntry({ ...base, hasWallet: false }).error, /capital inicial/);
  assert.match(checkCapitalEntry({ ...base, enteredOn: "2026-10-14" }).error, /ainda não chegou/);
  assert.match(checkCapitalEntry({ ...base, cycleStartedOn: "2026-10-02" }).error, /ciclo atual/);
});

test("CP10. extrato e capital: entrada soma, baixas subtraem uma vez, com categorias próprias e sem duplicar", () => {
  const movement = (id, kind, category, amountCents, occurredAt) => ({ id, kind, amountCents, occurredAt, notes: null, reversedMovementId: null, createdAt: `${occurredAt}T10:00:00.000Z`, category, description: `${category} teste`, source: "INVESTOR", createdByUserId: "u1" });
  const portfolio = buildPortfolio({
    initialCapitalCents: 50_000, hasWallet: true, walletCreatedOn: "2026-01-01", today: TODAY, operations: [], payments: [],
    capitalMovements: [
      movement("e1", "CONTRIBUTION", "INVESTOR_CONTRIBUTION", 1_000_000, "2026-02-01"),
      movement("y1", "WITHDRAWAL", "INVESTOR_YIELD_PAYMENT", 20_000, "2026-03-01"),
      movement("r1", "WITHDRAWAL", "INVESTOR_PRINCIPAL_RETURN", 300_000, "2026-04-01"),
    ],
  });
  assert.equal(portfolio.summary.availableCents, 50_000 + 1_000_000 - 20_000 - 300_000);
  const rows = financeRows(portfolio.capitalLedger, new Map([["u1", "Usuária Teste"]]));
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
  assert.equal(byKey.e1.category, "INVESTOR_CONTRIBUTION"); assert.equal(byKey.e1.direction, "IN"); assert.equal(byKey.e1.origin, "Investidores · entrada do contrato");
  assert.equal(byKey.y1.categoryLabel, "Rendimento pago a investidor"); assert.equal(byKey.y1.direction, "OUT"); assert.equal(byKey.y1.origin, "Contas a pagar · baixa");
  assert.equal(byKey.r1.categoryLabel, "Devolução de principal a investidor"); assert.equal(byKey.r1.responsible, "Usuária Teste");
  // A entrada de investidor não é um aporte comum: não pode ser estornada pela tela Capital.
  const statement = financeStatement(rows, { from: "2026-01-01", to: TODAY, direction: null, category: null });
  assert.deepEqual(statement.categories.map((category) => category.key).sort(), ["INITIAL_CAPITAL", "INVESTOR_CONTRIBUTION", "INVESTOR_PRINCIPAL_RETURN", "INVESTOR_YIELD_PAYMENT"]);
  assert.equal(statement.outflowsCents, 320_000);
  for (const key of Object.keys(INVESTOR_CATEGORIES)) assert.ok(statementCategoryLabels[key]);
  assert.equal(paymentCategory("YIELD"), "INVESTOR_YIELD_PAYMENT"); assert.equal(paymentCategory("PRINCIPAL"), "INVESTOR_PRINCIPAL_RETURN");
});

test("CP11. auditoria: referência sem conta/chave/documento completos", () => {
  assert.equal(maskReference("Pix 12345678901 conta 9876"), "Pix •••8901 conta 9876");
  assert.equal(maskReference(null), null);
});

test("CP12. código: isolamento, travas, transação única, sem exclusão e migração só aditiva", () => {
  const actions = readFileSync("src/app/contas-a-pagar/actions.ts", "utf8");
  // Só withTenantContext (a carteira da sessão, também para o MASTER) e tenant_id explícito em toda leitura/trava.
  assert.ok(!actions.includes("withPlatformContext") && !actions.includes("withInvestorContext"));
  assert.ok(actions.includes('eq(investments.tenantId, tenantId)') && actions.includes('eq(investmentScheduleItems.tenantId, tenantId)'));
  assert.ok(actions.includes('.from(wallets).where(eq(wallets.tenantId, tenantId)).for("update")'));
  assert.ok(actions.includes('.for("update")') && actions.includes("checkOutflow("));
  assert.equal((actions.match(/tx\.insert\(capitalMovements\)/g) ?? []).length, 2, "uma saída por baixa e uma entrada por contrato");
  assert.ok(!/\.delete\(|\.update\(/.test(actions), "Contas a Pagar não altera nem apaga nada");
  assert.ok(actions.includes('await recordAdminAudit(tx, session, {\n        action: "INVESTMENT_PAYMENT_REGISTERED"'));
  const migration = readFileSync("drizzle/0022_contas_a_pagar.sql", "utf8");
  assert.ok(!/\bDROP TABLE\b|\bDELETE FROM\b|\bUPDATE\s+"?\w+"?\s+SET\b|\bTRUNCATE\s+"?\w/i.test(migration.replace(/BEFORE TRUNCATE/g, "")), "migração sem exclusão nem recálculo de dados");
  assert.deepEqual([...migration.matchAll(/DROP CONSTRAINT "([^"]+)"/g)].map((match) => match[1]).sort(), ["capital_movement_category_matches_kind", "capital_movement_source_valid"]);
  for (const name of ["investment_payment_check", "investment_payment_append_only", "investment_capital_entry_append_only", "capital_movement_investor_linked", "investment_schedule_item_paid_guard"]) assert.ok(migration.includes(`"${name}"`), name);
});
