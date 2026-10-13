// Módulo Financeiro: regras puras (cashflow.ts) e a integração com o capital disponível de buildPortfolio.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPortfolio } from "../src/lib/finance/portfolio.ts";
import {
  INFLOW_KINDS, categoriesOf, checkInitialCapitalChange, checkOutflow, financeRows, financeStatement, manualCategories, movementSign, parseFinanceFilters, parseManualMovement, presetPeriods,
} from "../src/lib/finance/cashflow.ts";

const TODAY = "2026-10-13";
const op = (id, principalCents, loanDate, extra = {}) => ({
  id, clientId: "c1", clientName: "Cliente Teste", principalCents, interestRateBps: 3000, interestCents: Math.round(principalCents * 0.3), totalCents: Math.round(principalCents * 1.3),
  loanDate, dueDate: "2026-11-10", status: "OPEN", settledAt: null, calculationRule: "RATE_PER_OPERATION_SINGLE_PAYMENT_V1", createdAt: `${loanDate}T10:00:00Z`, ...extra,
});
const pay = (id, operationId, amountCents, paidAt) => ({ id, operationId, clientName: "Cliente Teste", amountCents, paidAt, notes: null, createdAt: `${paidAt}T15:00:00Z` });
const mov = (id, kind, amountCents, occurredAt, extra = {}) => ({ id, kind, amountCents, occurredAt, notes: null, reversedMovementId: null, createdAt: `${occurredAt}T12:00:00Z`, ...extra });
const build = ({ initial = 1_000_000, movements = [], operations = [], payments = [] } = {}) =>
  buildPortfolio({ initialCapitalCents: initial, hasWallet: true, walletCreatedOn: "2026-10-01", capitalMovements: movements, operations, payments, today: TODAY });
const chronological = (portfolio) => [...portfolio.capitalLedger].reverse();
const input = (extra = {}) => ({ direction: "OUT", category: "SALARY_WITHDRAWAL", amount: "1.500,00", occurredAt: TODAY, description: "Salário de outubro", notes: "", requestId: "req-0123456789abcdef", ...extra });

test("F1. aporte aumenta o saldo uma única vez", () => {
  const before = build();
  const after = build({ movements: [mov("m1", "CONTRIBUTION", 200_000, "2026-10-05", { category: "CAPITAL_CONTRIBUTION", description: "Aporte", source: "FINANCE" })] });
  assert.equal(after.summary.availableCents - before.summary.availableCents, 200_000);
  // Uma linha no extrato, uma linha no Financeiro.
  assert.equal(after.capitalLedger.filter((entry) => entry.key === "m1").length, 1);
  const rows = financeRows(after.capitalLedger, new Map());
  assert.equal(rows.filter((row) => row.category === "CAPITAL_CONTRIBUTION").length, 1);
});

test("F2. empréstimo reduz o saldo pelo principal, como no fluxo atual", () => {
  const portfolio = build({ operations: [op("op_a", 300_000, "2026-10-02")] });
  assert.equal(portfolio.summary.availableCents, 1_000_000 - 300_000);
  const rows = financeRows(portfolio.capitalLedger, new Map());
  const loan = rows.find((row) => row.category === "LOAN");
  assert.equal(loan.direction, "OUT");
  assert.equal(loan.amountCents, 300_000);
  assert.match(loan.origin, /^Operações · OP-/);
});

test("F3. recebimento de parcela entra uma vez, separado em principal e juros", () => {
  const operations = [op("op_a", 100_000, "2026-10-02")];
  const payments = [pay("p1", "op_a", 30_000, "2026-10-05"), pay("p2", "op_a", 100_000, "2026-10-10")];
  const portfolio = build({ operations, payments });
  assert.equal(portfolio.summary.availableCents, 1_000_000 - 100_000 + 130_000);
  const rows = financeRows(portfolio.capitalLedger, new Map());
  const received = rows.filter((row) => row.category === "PAYMENT");
  assert.equal(received.length, 2, "cada pagamento aparece uma única vez");
  const statement = financeStatement(rows, { from: "2026-10-01", to: TODAY, direction: null, category: null });
  const byKey = Object.fromEntries(statement.categories.map((category) => [category.key, category.amountCents]));
  assert.equal(byKey.PAYMENT_INTEREST, 30_000, "juros recebidos");
  assert.equal(byKey.PAYMENT_PRINCIPAL, 100_000, "principal devolvido");
  assert.equal(statement.inflowsCents, 1_000_000 + 130_000, "capital inicial + recebimentos");
  assert.equal(statement.outflowsCents, 100_000);
});

test("F4. saída reduz o saldo uma única vez e não mexe na operação do cliente", () => {
  const operations = [op("op_a", 300_000, "2026-10-02")];
  const before = build({ operations });
  const after = build({ operations, movements: [mov("s1", "WITHDRAWAL", 150_000, "2026-10-12", { category: "SALARY_WITHDRAWAL", description: "Salário", source: "FINANCE", createdByUserId: "u1" })] });
  assert.equal(before.summary.availableCents - after.summary.availableCents, 150_000);
  assert.equal(after.summary.withdrawalsCents, 150_000);
  // A operação continua igual: principal, saldo e capital emprestado.
  assert.deepEqual(after.operations.map((operation) => [operation.principalCents, operation.balanceCents, operation.principalRemainingCents]), before.operations.map((operation) => [operation.principalCents, operation.balanceCents, operation.principalRemainingCents]));
  assert.equal(after.summary.lentCents, before.summary.lentCents);
  assert.equal(after.summary.usedCapitalCents, before.summary.usedCapitalCents);
});

test("F5. retirada de salário é uma saída (WITHDRAWAL) com categoria e responsável", () => {
  const parsed = parseManualMovement(input(), { today: TODAY, cycleStartedOn: "2026-10-01" });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.kind, "WITHDRAWAL");
  assert.equal(parsed.value.direction, "OUT");
  assert.equal(parsed.value.amountCents, 150_000, "valor gravado positivo");
  const portfolio = build({ movements: [mov("s1", "WITHDRAWAL", 150_000, TODAY, { category: "SALARY_WITHDRAWAL", description: "Salário de outubro", source: "FINANCE", createdByUserId: "u1" })] });
  const [row] = financeRows(portfolio.capitalLedger, new Map([["u1", "Thaís"]])).filter((item) => item.key === "s1");
  assert.equal(row.categoryLabel, "Retirada de salário");
  assert.equal(row.direction, "OUT");
  assert.equal(row.responsible, "Thaís");
  assert.equal(row.origin, "Financeiro · lançamento manual");
  assert.equal(row.balanceCents, 1_000_000 - 150_000);
});

test("F6. valores zero, negativos ou inválidos são bloqueados", () => {
  for (const amount of ["0", "0,00", "-10", "-1.500,00", "abc", "", "10,999"]) {
    const parsed = parseManualMovement(input({ amount }), { today: TODAY, cycleStartedOn: null });
    assert.equal(parsed.ok, false, `valor ${JSON.stringify(amount)}`);
  }
  assert.match(parseManualMovement(input({ amount: "-10" }), { today: TODAY, cycleStartedOn: null }).error, /sem sinal de menos/);
  assert.match(parseManualMovement(input({ amount: "0,00" }), { today: TODAY, cycleStartedOn: null }).error, /maior que zero/);
});

test("F7. data, categoria, tipo e descrição são conferidos", () => {
  const check = (extra, cycleStartedOn = "2026-10-01") => parseManualMovement(input(extra), { today: TODAY, cycleStartedOn });
  assert.match(check({ occurredAt: "2026-10-14" }).error, /depois de hoje/);
  assert.match(check({ occurredAt: "2026-09-30" }).error, /início do ciclo atual/);
  assert.match(check({ occurredAt: "2026-02-30" }).error, /data válida/);
  assert.match(check({ category: "CAPITAL_CONTRIBUTION" }).error, /categoria de saída/, "categoria de entrada numa saída");
  assert.match(check({ direction: "IN", category: "SALARY_WITHDRAWAL" }).error, /categoria de entrada/);
  assert.match(check({ category: "LOAN" }).error, /categoria/, "empréstimo não é categoria manual");
  assert.match(check({ direction: "X" }).error, /entrada ou uma saída/);
  assert.match(check({ description: "   " }).error, /Descreva/);
  assert.match(check({ description: "x".repeat(201) }).error, /200 caracteres/);
  assert.match(check({ requestId: "" }).error, /Recarregue/);
  assert.equal(check({ occurredAt: "2026-10-01" }).ok, true, "o primeiro dia do ciclo vale");
  // Categorias iniciais pedidas.
  assert.deepEqual(categoriesOf("IN").map((key) => manualCategories[key].label), ["Aporte de capital", "Outras entradas"]);
  assert.deepEqual(categoriesOf("OUT").map((key) => manualCategories[key].label), ["Retirada de salário", "Retirada de sócio", "Despesa operacional", "Impostos e taxas", "Outras saídas"]);
  // Aporte de capital grava o mesmo tipo da tela Capital (sem segunda fonte de verdade).
  assert.equal(manualCategories.CAPITAL_CONTRIBUTION.kind, "CONTRIBUTION");
});

test("F8. saída maior que o saldo, hoje ou em data passada, é recusada com mensagem explícita", () => {
  // Capital 10.000; empréstimo de 8.000 em 05/10; pagamento de 3.000 em 10/10. Disponível hoje: 5.000.
  const portfolio = build({ operations: [op("op_a", 800_000, "2026-10-05")], payments: [pay("p1", "op_a", 300_000, "2026-10-10")] });
  const ledger = chronological(portfolio);
  const available = portfolio.summary.availableCents;
  assert.equal(available, 500_000);
  assert.deepEqual(checkOutflow({ ledger, amountCents: 500_000, occurredAt: TODAY, availableCents: available }), { ok: true });
  assert.match(checkOutflow({ ledger, amountCents: 500_001, occurredAt: TODAY, availableCents: available }).error, /Saldo insuficiente/);
  // Em 07/10 o saldo era só 2.000: uma saída de 3.000 nessa data deixaria aquele dia negativo, mesmo cabendo hoje.
  const backdated = checkOutflow({ ledger, amountCents: 300_000, occurredAt: "2026-10-07", availableCents: available });
  assert.equal(backdated.ok, false);
  assert.match(backdated.error, /07\/10\/2026 ficaria negativo/);
  assert.deepEqual(checkOutflow({ ledger, amountCents: 200_000, occurredAt: "2026-10-07", availableCents: available }), { ok: true });
  // Antes do empréstimo havia 10.000, mas a saída também reduz os saldos seguintes (05/10 ficaria negativo).
  assert.equal(checkOutflow({ ledger, amountCents: 300_000, occurredAt: "2026-10-02", availableCents: available }).ok, false);
});

test("F9. outras entradas somam ao saldo; o sinal de cada tipo é o mesmo no extrato e na regra", () => {
  const movements = [
    mov("a", "CONTRIBUTION", 10_000, "2026-10-02"), mov("b", "OTHER_INCOME", 20_000, "2026-10-03", { category: "OTHER_INCOME", description: "Venda de equipamento", source: "FINANCE" }),
    mov("c", "WITHDRAWAL", 5_000, "2026-10-04"), mov("d", "CONTRIBUTION_REVERSAL", 10_000, "2026-10-05", { reversedMovementId: "a" }),
  ];
  const portfolio = build({ movements });
  assert.equal(portfolio.summary.otherIncomeCents, 20_000);
  assert.equal(portfolio.summary.availableCents, 1_000_000 + 10_000 + 20_000 - 5_000 - 10_000);
  for (const movement of movements) {
    const entry = portfolio.capitalLedger.find((item) => item.key === movement.id);
    assert.equal(Math.sign(entry.amountCents), movementSign(movement.kind), movement.kind);
  }
  assert.deepEqual([...INFLOW_KINDS], ["CONTRIBUTION", "OTHER_INCOME"]);
  // Retirada antiga (tela Capital, sem categoria) continua contando e aparece como "sem categoria".
  const legacy = financeRows(portfolio.capitalLedger, new Map()).find((row) => row.key === "c");
  assert.equal(legacy.category, "LEGACY_WITHDRAWAL");
  assert.match(legacy.responsible, /Não registrado/);
});

test("F10. filtros por período, tipo e categoria e o saldo líquido do período", () => {
  const movements = [
    mov("s1", "WITHDRAWAL", 100_000, "2026-09-20", { category: "SALARY_WITHDRAWAL", description: "Salário set", source: "FINANCE" }),
    mov("s2", "WITHDRAWAL", 120_000, "2026-10-10", { category: "SALARY_WITHDRAWAL", description: "Salário out", source: "FINANCE" }),
    mov("e1", "WITHDRAWAL", 30_000, "2026-10-11", { category: "OPERATING_EXPENSE", description: "Internet", source: "FINANCE" }),
    mov("i1", "OTHER_INCOME", 50_000, "2026-10-12", { category: "OTHER_INCOME", description: "Reembolso", source: "FINANCE" }),
  ];
  const portfolio = buildPortfolio({ initialCapitalCents: 1_000_000, hasWallet: true, walletCreatedOn: "2026-09-01", capitalMovements: movements, operations: [], payments: [], today: TODAY });
  const rows = financeRows(portfolio.capitalLedger, new Map());
  const october = financeStatement(rows, { from: "2026-10-01", to: "2026-10-31", direction: null, category: null });
  assert.deepEqual(october.rows.map((row) => row.key).sort(), ["e1", "i1", "s2"]);
  assert.equal(october.inflowsCents, 50_000);
  assert.equal(october.outflowsCents, 150_000);
  assert.equal(october.netCents, -100_000);
  const salaries = financeStatement(rows, { from: "2026-09-01", to: TODAY, direction: null, category: "SALARY_WITHDRAWAL" });
  assert.deepEqual(salaries.rows.map((row) => row.key).sort(), ["s1", "s2"]);
  assert.equal(salaries.outflowsCents, 220_000);
  const outs = financeStatement(rows, { from: "2026-09-01", to: TODAY, direction: "OUT", category: null });
  assert.ok(outs.rows.every((row) => row.direction === "OUT"));
  assert.equal(outs.inflowsCents, 0);
  // Saldo após cada linha é o do extrato completo, mesmo filtrado.
  assert.equal(salaries.rows.find((row) => row.key === "s2").balanceCents, 1_000_000 - 100_000 - 120_000);
  // Filtros do endereço: inválidos voltam ao padrão (mês atual); datas invertidas são trocadas.
  assert.deepEqual(parseFinanceFilters({}, TODAY, "2026-09-01"), { from: "2026-10-01", to: TODAY, direction: null, category: null });
  assert.deepEqual(parseFinanceFilters({ de: "2026-10-10", ate: "2026-10-01", tipo: "saida", categoria: "SALARY_WITHDRAWAL" }, TODAY, null), { from: "2026-10-01", to: "2026-10-10", direction: "OUT", category: "SALARY_WITHDRAWAL" });
  assert.deepEqual(parseFinanceFilters({ de: "lixo", tipo: "x", categoria: "DROP TABLE" }, TODAY, null), { from: "2026-10-01", to: TODAY, direction: null, category: null });
  const presets = presetPeriods(TODAY, "2026-09-01");
  assert.deepEqual(presets.lastMonth, { label: "Mês anterior", from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(presets.last30, { label: "Últimos 30 dias", from: "2026-09-14", to: TODAY });
  assert.deepEqual(presets.cycle, { label: "Ciclo atual", from: "2026-09-01", to: TODAY });
});

test("F11. a fórmula SQL do servidor usa os mesmos tipos de entrada que a tela", () => {
  const source = readFileSync(new URL("../src/app/actions.ts", import.meta.url), "utf8");
  assert.match(source, /INFLOW_KINDS\.map/, "availableCapitalCents monta o CASE a partir de INFLOW_KINDS");
  assert.doesNotMatch(source, /kind\} = 'CONTRIBUTION' then/, "nada de tipo de entrada escrito à mão no SQL");
  const migration = readFileSync(new URL("../drizzle/0017_financial_movements.sql", import.meta.url), "utf8");
  assert.doesNotMatch(migration, /\b(DROP TABLE|DELETE FROM|TRUNCATE|UPDATE "?capital_movement"? SET)\b/i, "migration só aditiva");
});

test("F12. operação com data futura também protege o saldo: a saída de hoje não pode deixar a data futura negativa", () => {
  // Capital 10.000; empréstimo de 7.000 lançado para daqui a 5 dias. Disponível hoje (fórmula): 3.000.
  const portfolio = build({ operations: [op("op_f", 700_000, "2026-10-18")] });
  const ledger = chronological(portfolio);
  assert.equal(portfolio.summary.availableCents, 300_000);
  assert.equal(checkOutflow({ ledger, amountCents: 300_000, occurredAt: TODAY, availableCents: 300_000 }).ok, true);
  const tooMuch = checkOutflow({ ledger, amountCents: 300_001, occurredAt: TODAY, availableCents: 300_000 });
  assert.equal(tooMuch.ok, false);
  // O último saldo do extrato (depois da operação futura) é o capital disponível: as duas contas batem.
  assert.equal(ledger.at(-1).balanceCents, portfolio.summary.availableCents);
});

test("F13. reduzir o capital inicial não pode deixar nenhum saldo negativo; aumentar sempre pode", () => {
  // Capital 10.000; saída de 6.000 em 05/10; empréstimo de 3.000 em 08/10. Menor saldo do extrato: 1.000.
  const portfolio = build({
    movements: [mov("s1", "WITHDRAWAL", 600_000, "2026-10-05", { category: "PARTNER_WITHDRAWAL", description: "Sócio", source: "FINANCE" })],
    operations: [op("op_a", 300_000, "2026-10-08")],
  });
  assert.equal(portfolio.summary.availableCents, 100_000);
  const ledger = portfolio.capitalLedger;
  assert.deepEqual(checkInitialCapitalChange({ ledger, previousCents: 1_000_000, nextCents: 2_000_000 }), { ok: true });
  assert.deepEqual(checkInitialCapitalChange({ ledger, previousCents: 1_000_000, nextCents: 900_000 }), { ok: true });
  const blocked = checkInitialCapitalChange({ ledger, previousCents: 1_000_000, nextCents: 899_999 });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /ficaria negativo/);
});

test("F14. registros antigos (sem categoria, origem CAPITAL) continuam somando igual e a soma bate com o extrato", () => {
  const legacy = [mov("a", "CONTRIBUTION", 50_000, "2026-10-02"), mov("w", "WITHDRAWAL", 20_000, "2026-10-03"), mov("r", "CONTRIBUTION_REVERSAL", 50_000, "2026-10-04", { reversedMovementId: "a" })];
  const portfolio = build({ movements: legacy, operations: [op("op_a", 100_000, "2026-10-02")], payments: [pay("p1", "op_a", 30_000, "2026-10-06")] });
  // Antes do Financeiro: 10.000 + 500 − 200 − 500 − 1.000 + 300 = 9.100.
  assert.equal(portfolio.summary.availableCents, 910_000);
  assert.equal(portfolio.capitalLedger[0].balanceCents, 910_000, "último saldo do extrato = capital disponível");
  const rows = financeRows(portfolio.capitalLedger, new Map());
  assert.deepEqual(rows.map((row) => row.category).sort(), ["CAPITAL_CONTRIBUTION", "CONTRIBUTION_REVERSAL", "INITIAL_CAPITAL", "LEGACY_WITHDRAWAL", "LOAN", "PAYMENT"]);
  const statement = financeStatement(rows, { from: "2026-09-01", to: TODAY, direction: null, category: null });
  assert.equal(statement.netCents, portfolio.summary.availableCents, "entradas − saídas do ciclo inteiro = capital disponível");
});
