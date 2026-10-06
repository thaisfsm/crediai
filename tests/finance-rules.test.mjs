import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as rules from "../src/lib/finance/rules.ts";
import {
  calculateDaily, calculateFixedInterest, calculateInstallments, calculateOperation, commercialDaysBetween, dueDates, interestOnlyRenewal, monthlyEquivalentRate,
  nextDueDate, operationLedger, proportionalInterest, rateForDays, simpleInterest, simpleMonthlyRate,
} from "../src/lib/finance/rules.ts";

// Termos de uma operação de juros recorrentes (pagamento único mensal ou quinzenal).
const recurring = (extra) => ({ modality: "SINGLE", frequency: "MONTHLY", installmentCount: null, installmentCents: null, renewals: [], ...extra });
const pay = (id, amountCents, paidAt) => ({ id, amountCents, paidAt, createdAt: `${paidAt}T12:00:00Z` });

test("A. juros simples: R$ 10.000 + R$ 6.000 em 10 meses = 6% ao mês (J = P × i × n, M = P + J)", () => {
  assert.equal(simpleMonthlyRate({ principalCents: 1_000_000, interestCents: 600_000, months: 10 }), 0.06);
  // J = 10.000 × 0,06 × 10 = 6.000 e M = 16.000 = 10 parcelas de 1.600.
  assert.equal(simpleInterest({ principalCents: 1_000_000, rateBps: 600, periods: 10 }), 600_000);
  const calculated = calculateInstallments({ principalCents: 1_000_000, installmentCents: 160_000, count: 10 });
  assert.equal(calculated.interestCents, 600_000);
  assert.equal(calculated.totalCents, 1_600_000);
  assert.equal(calculated.interestRateBps, 600);
  assert.equal(calculated.monthlyRate, 0.06);
});

test("A2. a taxa contratada nunca é a taxa Price de 9,61%", () => {
  const calculated = calculateInstallments({ principalCents: 1_000_000, installmentCents: 160_000, count: 10 });
  assert.notEqual(calculated.interestRateBps, 961);
  assert.deepEqual(Object.keys(calculated).sort(), ["calculationRule", "interestCents", "interestRateBps", "monthlyRate", "totalCents"]);
  for (const value of Object.values(calculated)) if (typeof value === "number") assert.ok(Math.abs(value - 0.0961) > 0.001 && value !== 961);
  // Operação antiga com a taxa Price gravada (961): o extrato não usa a taxa gravada e dá exatamente o mesmo resultado.
  const terms = (bps) => ({ modality: "INSTALLMENT", frequency: "MONTHLY", principalCents: 1_000_000, interestRateBps: bps, interestCents: 600_000, firstDueDate: "2026-10-10", installmentCount: 10, installmentCents: 160_000, renewals: [] });
  const payments = [pay("p1", 160_000, "2026-10-10"), pay("p2", 100_000, "2026-11-10")];
  assert.deepEqual(operationLedger(terms(961), payments, "2026-11-20"), operationLedger(terms(600), payments, "2026-11-20"));
  // Cada parcela leva juros e principal na proporção simples do contrato: 1.600 = 600 de juros + 1.000 de principal.
  const ledger = operationLedger(terms(961), payments, "2026-11-20");
  assert.equal(ledger.items[0].interestCents, 60_000);
  assert.equal(ledger.items[0].principalCents, 100_000);
});

test("N. mensal com juros simples: R$ 8.000 a 30% = R$ 2.400 por período; 2 períodos = R$ 4.800, sem juros sobre juros", () => {
  assert.equal(calculateOperation({ principalCents: 800_000, interestRateBps: 3000 }).interestCents, 240_000);
  assert.equal(simpleInterest({ principalCents: 800_000, rateBps: 3000, periods: 2 }), 480_000);
  const terms = recurring({ principalCents: 800_000, interestRateBps: 3000, interestCents: 240_000, firstDueDate: "2026-11-01" });
  // Sem nenhum pagamento, o período vencido não gera juros novos: segue em atraso com os mesmos R$ 2.400 (sem mora).
  const unpaid = operationLedger(terms, [], "2026-12-15");
  assert.equal(unpaid.state, "OVERDUE");
  assert.equal(unpaid.balanceCents, 1_040_000);
  // Pagando só os juros nos dois vencimentos: 2 × R$ 2.400 = R$ 4.800 (nunca 30% de R$ 10.400).
  const renewed = operationLedger(terms, [pay("a", 240_000, "2026-11-01"), pay("b", 240_000, "2026-12-01")], "2026-12-01");
  assert.equal(renewed.interestPaidCents, 480_000);
  assert.equal(renewed.periodInterestCents, 240_000);
  assert.equal(renewed.principalRemainingCents, 800_000);
  assert.equal(renewed.balanceCents, 1_040_000);
  assert.equal(renewed.state, "ACTIVE");
});

test("P. nenhum código do sistema usa a tabela Price, PMT, juros compostos ou busca de taxa implícita", () => {
  assert.equal("installmentRate" in rules, false);
  const files = [];
  const walk = (dir) => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else if (/\.(ts|tsx|mjs|js)$/.test(name)) files.push(path); } };
  walk(new URL("../src", import.meta.url).pathname);
  const forbidden = [/installmentRate/, /priceRate/, /Math\.pow/, /\(\s*1\s*\+\s*\w+\s*\)\s*\*\*/, /\bPMT\b/, /Custo efetivo/i, /busca bin[aá]ria/i, /tabela Price(?! em nenhum)/i];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const pattern of forbidden) assert.equal(pattern.test(source), false, `${file} contém ${pattern}`);
  }
});

test("B. quinzenal: R$ 8.000 com R$ 1.200 por quinzena, pagamento só dos juros mantém o principal e renova", () => {
  const terms = recurring({ frequency: "BIWEEKLY", principalCents: 800_000, interestRateBps: 1500, interestCents: 120_000, firstDueDate: "2026-10-15" });
  const before = operationLedger(terms, [], "2026-10-15");
  assert.equal(before.state, "DUE_TODAY");
  assert.equal(before.balanceCents, 920_000);
  const renewal = interestOnlyRenewal(terms, before, 120_000);
  assert.deepEqual(renewal, { previousDueDate: "2026-10-15", defaultNewDueDate: "2026-10-30", principalBaseCents: 800_000, nextInterestCents: 120_000 });
  // Registrado como "somente juros" (linha de renovação), o período seguinte abre na hora.
  const rows = [{ paymentId: "p1", periodNumber: 2, previousDueDate: "2026-10-15", newDueDate: renewal.defaultNewDueDate, principalBaseCents: 800_000, interestCents: 120_000 }];
  const after = operationLedger({ ...terms, renewals: rows }, [pay("p1", 120_000, "2026-10-15")], "2026-10-15");
  assert.equal(after.principalRemainingCents, 800_000);
  assert.equal(after.interestRemainingCents, 120_000);
  assert.equal(after.balanceCents, 920_000);
  assert.equal(after.nextDueDate, "2026-10-30");
  assert.equal(after.periodNumber, 2);
  assert.equal(after.state, "ACTIVE");
  assert.equal(after.items[0].kind, "RENEWAL");
  // Quitação: principal + juros da quinzena.
  const settled = operationLedger({ ...terms, renewals: rows }, [pay("p1", 120_000, "2026-10-15"), pay("p2", 920_000, "2026-10-30")], "2026-10-30");
  assert.equal(settled.state, "PAID");
  assert.equal(settled.balanceCents, 0);
  assert.equal(settled.items[1].kind, "SETTLEMENT");
  assert.equal(settled.interestPaidCents, 240_000);
  assert.equal(settled.principalPaidCents, 800_000);
});

test("C. quinzenal: empréstimo dia 01, vencimentos dia 15 e dia 30 (dois ciclos no mês)", () => {
  assert.deepEqual(dueDates("BIWEEKLY", "2026-10-15", 6), ["2026-10-15", "2026-10-30", "2026-11-15", "2026-11-30", "2026-12-15", "2026-12-30"]);
  // Fevereiro: o segundo vencimento é o último dia do mês, e março volta para 15 e 30.
  assert.deepEqual(dueDates("BIWEEKLY", "2027-02-15", 4), ["2027-02-15", "2027-02-28", "2027-03-15", "2027-03-30"]);
  assert.deepEqual(dueDates("BIWEEKLY", "2026-10-10", 3), ["2026-10-10", "2026-10-25", "2026-11-10"]);
  assert.deepEqual(dueDates("BIWEEKLY", "2026-10-20", 3), ["2026-10-20", "2026-11-05", "2026-11-20"]);
});

test("D. quinzenal: só juros nos dois ciclos do mês renova duas vezes, sem juros sobre juros", () => {
  const terms = recurring({ frequency: "BIWEEKLY", principalCents: 800_000, interestRateBps: 1500, interestCents: 120_000, firstDueDate: "2026-10-15" });
  // Sem linha de renovação (ex.: pagamento antigo): renova no vencimento, quando os juros já estão pagos.
  const ledger = operationLedger(terms, [pay("p1", 120_000, "2026-10-15"), pay("p2", 120_000, "2026-10-30")], "2026-10-31");
  assert.equal(ledger.periodNumber, 3);
  assert.deepEqual(ledger.periods.map((period) => [period.dueDate, period.interestCents]), [["2026-10-15", 120_000], ["2026-10-30", 120_000], ["2026-11-15", 120_000]]);
  assert.equal(ledger.principalRemainingCents, 800_000);
  assert.equal(ledger.interestPaidCents, 240_000);
  assert.equal(ledger.balanceCents, 920_000);
  assert.equal(ledger.nextDueDate, "2026-11-15");
  assert.equal(ledger.state, "ACTIVE");
  assert.deepEqual(ledger.items.map((item) => item.kind), ["RENEWAL", "RENEWAL"]);
  // Segunda quinzena sem pagamento: Em atraso a partir do dia seguinte ao vencimento.
  const late = operationLedger(terms, [pay("p1", 120_000, "2026-10-15")], "2026-11-02");
  assert.equal(late.nextDueDate, "2026-10-30");
  assert.equal(late.state, "OVERDUE");
  assert.equal(late.daysUntilDue, -3);
  assert.equal(late.balanceCents, 920_000);
});

test("E/F. diário: R$ 10.000 a 30% em 30 dias = R$ 13.000 em 30 pagamentos, soma exata", () => {
  const plan = calculateDaily({ principalCents: 1_000_000, interestRateBps: 3000, days: 30, loanDate: "2026-10-01" });
  assert.equal(plan.interestCents, 300_000);
  assert.equal(plan.totalCents, 1_300_000);
  assert.equal(plan.installmentCount, 30);
  assert.equal(plan.installmentCents, 43_333);
  assert.equal(plan.lastInstallmentCents, 43_343);
  assert.equal(plan.firstDueDate, "2026-10-02");
  assert.equal(plan.lastDueDate, "2026-10-31");
  const terms = { modality: "SINGLE", frequency: "DAILY", principalCents: 1_000_000, interestRateBps: 3000, interestCents: 300_000, firstDueDate: plan.firstDueDate, installmentCount: 30, installmentCents: 43_333, renewals: [] };
  const empty = operationLedger(terms, [], "2026-10-01");
  assert.equal(empty.schedule.length, 30);
  assert.equal(empty.schedule.reduce((sum, item) => sum + item.amountCents, 0), 1_300_000);
  assert.equal(empty.schedule[29].amountCents, 43_343);
  assert.equal(empty.schedule[29].dueDate, "2026-10-31");
  // Ajuste de centavos em outros valores: a soma sempre fecha.
  for (const [principalCents, rate, days] of [[100_000, 2000, 7], [123_457, 3333, 13], [50_000, 1000, 30], [99_999, 0, 3]]) {
    const other = calculateDaily({ principalCents, interestRateBps: rate, days, loanDate: "2026-10-01" });
    const schedule = operationLedger({ ...terms, principalCents, interestRateBps: rate, interestCents: other.interestCents, installmentCount: days, installmentCents: other.installmentCents }, [], "2026-10-01").schedule;
    assert.equal(schedule.reduce((sum, item) => sum + item.amountCents, 0), other.totalCents);
    assert.ok(schedule.at(-1).amountCents - other.installmentCents < days);
  }
  // Cada pagamento diário leva principal e juros; pagando todos, quita com juros = R$ 3.000 exatos.
  const payments = empty.schedule.map((item) => pay(`d${item.number}`, item.amountCents, item.dueDate));
  const done = operationLedger(terms, payments, "2026-10-31");
  assert.equal(done.state, "PAID");
  assert.equal(done.interestPaidCents, 300_000);
  assert.equal(done.principalPaidCents, 1_000_000);
  assert.ok(done.items[0].interestCents > 0 && done.items[0].principalCents > 0);
  // Três dias pagos e o quarto vencido: Em atraso.
  const late = operationLedger(terms, payments.slice(0, 3), "2026-10-06");
  assert.equal(late.nextItem.number, 4);
  assert.equal(late.state, "OVERDUE");
});

test("G. Alexandre: R$ 360 de juros pagos no vencimento não deixa a operação em atraso; abre o novo ciclo", () => {
  const terms = recurring({ principalCents: 120_000, interestRateBps: 3000, interestCents: 36_000, firstDueDate: "2026-09-17" });
  // Pagamento gravado sem linha de renovação (como em produção).
  const ledger = operationLedger(terms, [pay("pay_alexandre", 36_000, "2026-09-17")], "2026-10-05");
  assert.equal(ledger.state, "ACTIVE");
  assert.equal(ledger.nextDueDate, "2026-10-17");
  assert.equal(ledger.periodNumber, 2);
  assert.equal(ledger.paidCents, 36_000);
  assert.equal(ledger.interestPaidCents, 36_000);
  assert.equal(ledger.principalRemainingCents, 120_000);
  assert.equal(ledger.interestRemainingCents, 36_000);
  assert.equal(ledger.balanceCents, 156_000);
  assert.equal(ledger.items[0].kind, "RENEWAL");
  // Antes da correção: o mesmo pagamento sem pagar mais nada, um mês depois, fica Em atraso (ciclo 2 sem juros pagos).
  assert.equal(operationLedger(terms, [pay("pay_alexandre", 36_000, "2026-09-17")], "2026-10-18").state, "OVERDUE");
  // Sem nenhum pagamento, aí sim estaria em atraso desde 18/09.
  const unpaid = operationLedger(terms, [], "2026-10-05");
  assert.equal(unpaid.state, "OVERDUE");
  assert.equal(unpaid.daysUntilDue, -18);
});

test("G2. pagamento de juros antes do vencimento seguido da quitação no mesmo período (como em produção) continua quitado", () => {
  const terms = recurring({ principalCents: 10_000, interestRateBps: 3000, interestCents: 3_000, firstDueDate: "2026-10-30" });
  const ledger = operationLedger(terms, [pay("a", 3_000, "2026-09-30"), pay("b", 10_000, "2026-10-02")], "2026-10-06");
  assert.equal(ledger.state, "PAID");
  assert.deepEqual(ledger.items.map((item) => item.kind), ["INTEREST", "SETTLEMENT"]);
});

test("H. parcelado (Amany): R$ 2.000 em 2 × R$ 1.500, 1ª paga em 05/10 → próxima em 05/11, Ativa", () => {
  const terms = { modality: "INSTALLMENT", frequency: "MONTHLY", principalCents: 200_000, interestRateBps: 3187, interestCents: 100_000, firstDueDate: "2026-10-05", installmentCount: 2, installmentCents: 150_000, renewals: [] };
  const ledger = operationLedger(terms, [pay("amany1", 150_000, "2026-10-05")], "2026-10-06");
  assert.equal(ledger.state, "ACTIVE");
  assert.equal(ledger.nextDueDate, "2026-11-05");
  assert.equal(ledger.nextItem.number, 2);
  assert.equal(ledger.schedule[0].state, "PAID");
  assert.equal(ledger.balanceCents, 150_000);
  // Proporcional: 1/3 de cada parcela é juros (R$ 500) e 2/3 principal (R$ 1.000), como antes.
  assert.equal(ledger.items[0].interestCents, 50_000);
  assert.equal(ledger.items[0].principalCents, 100_000);
  const done = operationLedger(terms, [pay("amany1", 150_000, "2026-10-05"), pay("amany2", 150_000, "2026-11-05")], "2026-11-05");
  assert.equal(done.state, "PAID");
  assert.equal(done.interestPaidCents, 100_000);
  // Taxa contratada exibida: juros simples, R$ 1.000 ÷ R$ 2.000 ÷ 2 meses = 25% ao mês (não 31,87%).
  assert.equal(simpleMonthlyRate({ principalCents: 200_000, interestCents: 100_000, months: 2 }), 0.25);
  // A taxa gravada (31,87%, da época da Price) não muda nenhum valor do extrato.
  assert.deepEqual(operationLedger({ ...terms, interestRateBps: 2500 }, [pay("amany1", 150_000, "2026-10-05")], "2026-10-06"), ledger);
});

test("Q. operação parcelada de R$ 5.000: taxa simples de 15% ao mês (antes 22,11%)", () => {
  // R$ 5.000 em 5 × R$ 1.750: juros R$ 3.750 ÷ R$ 5.000 ÷ 5 = 15% ao mês; J = 5.000 × 0,15 × 5 = 3.750.
  const calculated = calculateInstallments({ principalCents: 500_000, installmentCents: 175_000, count: 5 });
  assert.equal(calculated.interestCents, 375_000);
  assert.equal(calculated.interestRateBps, 1500);
  assert.notEqual(calculated.interestRateBps, 2211);
  assert.equal(simpleInterest({ principalCents: 500_000, rateBps: 1500, periods: 5 }), calculated.interestCents);
});

test("I. pagamento integral quita (mensal)", () => {
  const terms = recurring({ principalCents: 100_000, interestRateBps: 3000, interestCents: 30_000, firstDueDate: "2026-11-01" });
  const ledger = operationLedger(terms, [pay("x", 130_000, "2026-11-01")], "2026-11-01");
  assert.equal(ledger.state, "PAID");
  assert.equal(ledger.balanceCents, 0);
  assert.equal(ledger.items[0].kind, "SETTLEMENT");
});

test("J. pagamento parcial: juros primeiro, depois principal; renova no vencimento sobre o principal que sobrou", () => {
  const terms = recurring({ principalCents: 100_000, interestRateBps: 3000, interestCents: 30_000, firstDueDate: "2026-11-01" });
  // Parcial menor que os juros: continua no mesmo período e, vencido, fica Em atraso.
  const small = operationLedger(terms, [pay("a", 10_000, "2026-10-20")], "2026-11-03");
  assert.equal(small.interestRemainingCents, 20_000);
  assert.equal(small.balanceCents, 120_000);
  assert.equal(small.state, "OVERDUE");
  // Juros + parte do principal: R$ 500 = R$ 300 juros + R$ 200 principal; saldo R$ 800 até o vencimento.
  const partial = operationLedger(terms, [pay("a", 50_000, "2026-10-20")], "2026-10-25");
  assert.equal(partial.items[0].interestCents, 30_000);
  assert.equal(partial.items[0].principalCents, 20_000);
  assert.equal(partial.items[0].kind, "PARTIAL");
  assert.equal(partial.balanceCents, 80_000);
  assert.equal(partial.state, "ACTIVE");
  // No vencimento, o período renova com juros de 30% sobre R$ 800 = R$ 240.
  const renewed = operationLedger(terms, [pay("a", 50_000, "2026-10-20")], "2026-11-01");
  assert.equal(renewed.periodInterestCents, 24_000);
  assert.equal(renewed.balanceCents, 104_000);
  assert.equal(renewed.nextDueDate, "2026-12-01");
  assert.equal(renewed.state, "ACTIVE");
});

test("K. calendário comercial 30/360", () => {
  assert.equal(commercialDaysBetween("2026-01-01", "2027-01-01"), 360);
  assert.equal(commercialDaysBetween("2026-03-01", "2026-04-01"), 30);
  assert.equal(commercialDaysBetween("2026-01-31", "2026-02-28"), 28);
  assert.equal(commercialDaysBetween("2026-10-01", "2026-10-15"), 14);
  assert.equal(rateForDays(3000, 15), 1500);
  assert.equal(rateForDays(3000, 1), 100);
  assert.equal(rateForDays(3000, 360), 36_000);
  assert.equal(monthlyEquivalentRate(1500, 15), 3000);
  assert.equal(proportionalInterest({ principalCents: 800_000, monthlyRateBps: 3000, days: 15 }), 120_000);
  assert.equal(proportionalInterest({ principalCents: 1_000_000, monthlyRateBps: 3000, days: 1 }), 10_000);
  // J = P × taxa mensal × dias / 30: R$ 10.000 a 30% ao mês por 15 dias = R$ 1.500 (juros simples, sem capitalização).
  assert.equal(proportionalInterest({ principalCents: 1_000_000, monthlyRateBps: 3000, days: 15 }), 150_000);
  assert.equal(proportionalInterest({ principalCents: 1_000_000, monthlyRateBps: 3000, days: 60 }), 600_000);
  // Mensal mantém o dia combinado; 31 → fim de fevereiro → 31 de março.
  assert.equal(nextDueDate("MONTHLY", "2026-01-31", 31), "2026-02-28");
  assert.equal(nextDueDate("MONTHLY", "2026-02-28", 31), "2026-03-31");
  assert.equal(nextDueDate("MONTHLY", "2026-09-17", 17), "2026-10-17");
  assert.equal(nextDueDate("DAILY", "2026-10-31"), "2026-11-01");
});

test("B2. quinzenal por valor fixo: R$ 1.200 por quinzena sobre R$ 8.000, sem calcular taxa à mão", () => {
  const fixed = calculateFixedInterest({ principalCents: 800_000, interestCents: 120_000 });
  assert.equal(fixed.interestRateBps, 1500);
  assert.equal(fixed.totalCents, 920_000);
  assert.equal(fixed.calculationRule, "FIXED_INTEREST_PER_FORTNIGHT_V1");
  // Valor que não dá taxa redonda: R$ 1.000 sobre R$ 7.000 (14,2857%). Os juros continuam exatamente R$ 1.000.
  const odd = recurring({ frequency: "BIWEEKLY", interestMode: "FIXED", principalCents: 700_000, interestRateBps: 1429, interestCents: 100_000, firstDueDate: "2026-10-15" });
  const twoCycles = operationLedger(odd, [pay("a", 100_000, "2026-10-15"), pay("b", 100_000, "2026-10-30")], "2026-10-30");
  assert.deepEqual(twoCycles.periods.map((period) => period.interestCents), [100_000, 100_000, 100_000]);
  assert.equal(twoCycles.principalRemainingCents, 700_000);
  assert.equal(twoCycles.state, "ACTIVE");
  const renewal = interestOnlyRenewal(odd, operationLedger(odd, [], "2026-10-15"), 100_000);
  assert.equal(renewal.nextInterestCents, 100_000);
  assert.equal(renewal.defaultNewDueDate, "2026-10-30");
});

test("J2. renovação com principal parcialmente amortizado: juros + parte do principal reduzem o principal e recalculam os próximos juros", () => {
  // Quinzenal pela taxa: R$ 8.000 a 15%; paga R$ 1.200 de juros + R$ 4.000 de principal → próxima quinzena: R$ 600.
  const rate = recurring({ frequency: "BIWEEKLY", principalCents: 800_000, interestRateBps: 1500, interestCents: 120_000, firstDueDate: "2026-10-15" });
  const byRate = operationLedger(rate, [pay("a", 520_000, "2026-10-15")], "2026-10-15");
  assert.equal(byRate.items[0].interestCents, 120_000);
  assert.equal(byRate.items[0].principalCents, 400_000);
  assert.equal(byRate.principalRemainingCents, 400_000);
  assert.equal(byRate.periodNumber, 2);
  assert.equal(byRate.periodInterestCents, 60_000);
  assert.equal(byRate.nextDueDate, "2026-10-30");
  assert.equal(byRate.balanceCents, 460_000);
  assert.equal(byRate.state, "ACTIVE");
  // Valor fixo: mesma coisa, proporcional ao principal que sobrou (R$ 1.200 × 4.000 / 8.000 = R$ 600).
  const fixed = recurring({ frequency: "BIWEEKLY", interestMode: "FIXED", principalCents: 800_000, interestRateBps: 1500, interestCents: 120_000, firstDueDate: "2026-10-15" });
  const byFixed = operationLedger(fixed, [pay("a", 520_000, "2026-10-15")], "2026-10-15");
  assert.equal(byFixed.periodInterestCents, 60_000);
  assert.equal(byFixed.balanceCents, 460_000);
  // E quitar depois: R$ 4.000 + R$ 600 = R$ 4.600 encerra.
  assert.equal(operationLedger(fixed, [pay("a", 520_000, "2026-10-15"), pay("b", 460_000, "2026-10-30")], "2026-10-30").state, "PAID");
});

test("E2. diário com primeiro vencimento configurável, sábados e domingos incluídos, soma exata", () => {
  // Empréstimo 01/10/2026 (quinta), primeiro vencimento 05/10/2026 (segunda).
  const plan = calculateDaily({ principalCents: 1_000_000, interestRateBps: 3000, days: 30, loanDate: "2026-10-01", firstDueDate: "2026-10-05" });
  assert.equal(plan.firstDueDate, "2026-10-05");
  assert.equal(plan.lastDueDate, "2026-11-03");
  const terms = { modality: "SINGLE", frequency: "DAILY", principalCents: 1_000_000, interestRateBps: 3000, interestCents: plan.interestCents, firstDueDate: plan.firstDueDate, installmentCount: 30, installmentCents: plan.installmentCents, renewals: [] };
  const schedule = operationLedger(terms, [], "2026-10-01").schedule;
  const dates = schedule.map((item) => item.dueDate);
  assert.equal(dates.length, 30);
  assert.ok(dates.includes("2026-10-10") && dates.includes("2026-10-11"), "inclui sábado 10/10 e domingo 11/10");
  assert.equal(new Date("2026-10-10T00:00:00Z").getUTCDay(), 6);
  assert.equal(new Date("2026-10-11T00:00:00Z").getUTCDay(), 0);
  assert.equal(dates.at(-1), "2026-11-03");
  assert.equal(schedule.reduce((sum, item) => sum + item.amountCents, 0), 1_300_000);
  assert.equal(schedule.filter((item) => item.amountCents === 43_333).length, 29);
  assert.equal(schedule.at(-1).amountCents, 43_343);
  // Antes do primeiro vencimento a operação está Ativa; no sábado sem pagamento, Em atraso a partir de domingo.
  assert.equal(operationLedger(terms, [], "2026-10-04").state, "ACTIVE");
  assert.equal(operationLedger(terms, [], "2026-10-05").state, "DUE_TODAY");
});

test("M. taxa 0% não renova sozinha: vencida com principal em aberto fica Em atraso", () => {
  const terms = recurring({ principalCents: 100_000, interestRateBps: 0, interestCents: 0, firstDueDate: "2026-10-01" });
  const ledger = operationLedger(terms, [], "2026-10-05");
  assert.equal(ledger.state, "OVERDUE");
  assert.equal(ledger.periodNumber, 1);
});
