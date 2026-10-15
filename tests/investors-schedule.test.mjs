import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultModelPlan, investmentChanges, investmentFields, investorFields, scheduleDates, scheduleItemFields, scheduleLinesFields, scheduleSummary, scheduleTotals, suggestScheduleLines, PAYMENT_FREQUENCIES,
} from "../src/lib/investors/rules.ts";
import { cpfCnpjProblem, normalizeCpfCnpj } from "../src/lib/finance/format.ts";

const form = (values) => (key, max) => String(values[key] ?? "").trim().slice(0, max);

test("IS1. CPF/CNPJ do investidor e da contratante com dígitos verificadores", () => {
  assert.equal(normalizeCpfCnpj("411.797.058-58").ok, true);
  assert.equal(normalizeCpfCnpj("11.222.333/0001-81").ok, true);
  assert.equal(normalizeCpfCnpj("411.797.058-59").ok, false, "CPF com dígito errado");
  assert.equal(normalizeCpfCnpj("12.345.678/0001-90").ok, false, "CNPJ com dígito errado");
  assert.equal(normalizeCpfCnpj("00000000000").ok, false);
  assert.equal(investorFields(form({ personType: "PF", name: "A", document: "529.982.247-25" }), "2026-10-15").ok, true);
  assert.equal(investorFields(form({ personType: "PF", name: "A", document: "529.982.247-24" }), "2026-10-15").ok, false, "CPF com dígito errado");
  assert.equal(cpfCnpjProblem(""), null);
  assert.equal(cpfCnpjProblem("41179705858"), null);
  assert.match(cpfCnpjProblem("41179705850"), /CPF inválido/);
  assert.match(cpfCnpjProblem("11222333000180"), /CNPJ inválido/);
  assert.match(cpfCnpjProblem("1234"), /11 dígitos/);
});

test("IS3. contrato: identificação, datas, prazo com unidade, periodicidade e parcelas (todos opcionais, nada calculado)", () => {
  const base = { amount: "50.000,00", rate: "1,5", ratePeriod: "MONTHLY", startDate: "2026-10-01" };
  const full = investmentFields(form({ ...base, contractNumber: " INV-2026/001 ", contractedOn: "2026-09-25", investedOn: "2026-09-28", termCount: "18", termUnit: "MONTHS", paymentFrequency: "QUARTERLY", installmentCount: "6" }));
  assert.equal(full.ok, true);
  assert.equal(full.values.contractNumber, "INV-2026/001");
  assert.equal(full.values.contractedOn, "2026-09-25");
  assert.equal(full.values.investedOn, "2026-09-28");
  assert.equal(full.values.termCount, 18);
  assert.equal(full.values.termUnit, "MONTHS");
  assert.equal(full.values.paymentFrequency, "QUARTERLY");
  assert.equal(full.values.installmentCount, 6);
  for (const unit of ["DAYS", "MONTHS", "YEARS"]) assert.equal(investmentFields(form({ ...base, termCount: "2", termUnit: unit })).values.termUnit, unit);
  assert.equal(investmentFields(form({ ...base, termCount: "2", termUnit: "WEEKS" })).ok, false);
  assert.equal(investmentFields(form({ ...base, contractNumber: "<script>" })).ok, false);
  assert.equal(investmentFields(form({ ...base, termCount: "0", termUnit: "MONTHS" })).ok, false);
  assert.equal(investmentFields(form({ ...base, termCount: "1,5", termUnit: "MONTHS" })).ok, false);
  assert.equal(investmentFields(form({ ...base, paymentFrequency: "WEEKLY" })).ok, false);
  assert.equal(investmentFields(form({ ...base, installmentCount: "601" })).ok, false);
  assert.equal(investmentFields(form({ ...base, investedOn: "2026-02-30" })).ok, false);
  assert.ok(!Object.keys(full.values).filter((key) => !/Terms$/.test(key)).some((key) => /yield|rendimento|balance|saldo|return/i.test(key)));
  assert.deepEqual(Object.keys(PAYMENT_FREQUENCIES), ["MONTHLY", "QUARTERLY", "SEMIANNUAL", "YEARLY", "AT_MATURITY", "OTHER"]);
});

test("IS4. datas sugeridas do cronograma: mês a mês mantendo o dia, de 3 em 3, 6 em 6, 12 em 12 meses, e pagamento único", () => {
  assert.deepEqual(scheduleDates("2026-01-31", 4, "MONTHLY"), ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  assert.deepEqual(scheduleDates("2026-11-30", 3, "QUARTERLY"), ["2026-11-30", "2027-02-28", "2027-05-30"]);
  assert.deepEqual(scheduleDates("2026-10-15", 3, "SEMIANNUAL"), ["2026-10-15", "2027-04-15", "2027-10-15"]);
  assert.deepEqual(scheduleDates("2024-02-29", 2, "YEARLY"), ["2024-02-29", "2025-02-28"]);
  assert.deepEqual(scheduleDates("2027-10-01", 5, "AT_MATURITY"), ["2027-10-01"]);
  assert.deepEqual(scheduleDates("2027-10-01", 5, "OTHER"), []);
});

test("IS5. sugestão para revisar: valores exatamente os digitados, principal só na última data; nada é gravado por ela", () => {
  const lines = suggestScheduleLines({ frequency: "MONTHLY", firstDueDate: "2026-11-10", count: 3, yieldAmount: "750,00", principalAmount: "50.000,00", description: "Rendimento" });
  assert.deepEqual(lines, [
    { kind: "YIELD", dueDate: "2026-11-10", yieldAmount: "750,00", principalAmount: "", description: "Rendimento" },
    { kind: "YIELD", dueDate: "2026-12-10", yieldAmount: "750,00", principalAmount: "", description: "Rendimento" },
    { kind: "COMBINED", dueDate: "2027-01-10", yieldAmount: "750,00", principalAmount: "50.000,00", description: "Rendimento" },
  ]);
  const parsed = scheduleLinesFields(JSON.stringify(lines));
  assert.equal(parsed.ok, true);
  assert.deepEqual(scheduleTotals(parsed.items), { yieldCents: 225_000, principalCents: 5_000_000, totalCents: 5_225_000, count: 3 });
  assert.deepEqual(suggestScheduleLines({ frequency: "AT_MATURITY", firstDueDate: "2027-10-01", count: 9, yieldAmount: "", principalAmount: "50.000,00", description: "" }),
    [{ kind: "PRINCIPAL", dueDate: "2027-10-01", yieldAmount: "", principalAmount: "50.000,00", description: "" }]);
  assert.deepEqual(suggestScheduleLines({ frequency: "OTHER", firstDueDate: "2026-11-10", count: 3, yieldAmount: "1", principalAmount: "", description: "" }), []);
  assert.deepEqual(suggestScheduleLines({ frequency: "MONTHLY", firstDueDate: "2026-11-10", count: 0, yieldAmount: "1", principalAmount: "", description: "" }), []);
  assert.deepEqual(suggestScheduleLines({ frequency: "MONTHLY", firstDueDate: "", count: 2, yieldAmount: "1", principalAmount: "", description: "" }), []);
  // Linhas revisadas: tipo coerente com os valores, total igual à soma, valores positivos.
  assert.equal(scheduleLinesFields("[]").ok, false);
  assert.equal(scheduleLinesFields("x").ok, false);
  assert.equal(scheduleLinesFields(JSON.stringify([{ kind: "YIELD", dueDate: "2026-11-10", yieldAmount: "", principalAmount: "" }])).ok, false, "linha sem valor");
  assert.equal(scheduleLinesFields(JSON.stringify([{ kind: "YIELD", dueDate: "2026-11-10", yieldAmount: "10", principalAmount: "5" }])).ok, false, "rendimento com principal");
  assert.equal(scheduleLinesFields(JSON.stringify([{ kind: "COMBINED", dueDate: "2026-11-10", yieldAmount: "10", principalAmount: "" }])).ok, false, "combinada sem principal");
  assert.equal(scheduleLinesFields(JSON.stringify([{ kind: "COMBINED", dueDate: "2026-11-10", yieldAmount: "10", principalAmount: "5", total: "16" }])).ok, false, "total diferente da soma");
  assert.equal(scheduleLinesFields(JSON.stringify([{ kind: "YIELD", dueDate: "2026-11-10", yieldAmount: "-5", principalAmount: "" }])).ok, false);
  assert.match(scheduleLinesFields(JSON.stringify([lines[0], { ...lines[1], dueDate: "2026-02-30" }])).error, /^Linha 2:/);
});

test("IS5b. modelo padrão: periodicidade do contrato (ou mensal), quantidade pelo prazo, principal integral no fim; nada fixo", () => {
  const contract = { startDate: "2026-10-15", maturityDate: null, termCount: 12, termUnit: "MONTHS", termMonths: null, paymentFrequency: null, amountCents: 10_000_000 };
  assert.deepEqual(defaultModelPlan(contract), { frequency: "MONTHLY", firstDueDate: "2026-11-15", count: 12, principalAmount: "100.000,00" });
  assert.deepEqual(defaultModelPlan({ ...contract, paymentFrequency: "QUARTERLY", termCount: 2, termUnit: "YEARS" }), { frequency: "QUARTERLY", firstDueDate: "2027-01-15", count: 8, principalAmount: "100.000,00" });
  // Sem prazo: conta até o vencimento; sem prazo nem vencimento: a quantidade fica para o usuário.
  assert.equal(defaultModelPlan({ ...contract, termCount: null, termUnit: null, maturityDate: "2027-04-15" }).count, 6);
  assert.equal(defaultModelPlan({ ...contract, termCount: null, termUnit: null }).count, null);
  assert.equal(defaultModelPlan({ ...contract, termCount: null, termUnit: null, termMonths: 24 }).count, 24, "contrato antigo com prazo em meses");
  assert.equal(defaultModelPlan({ ...contract, termCount: 90, termUnit: "DAYS" }).count, null, "prazo em dias não vira meses por conta própria");
  assert.equal(defaultModelPlan({ ...contract, paymentFrequency: "OTHER" }).frequency, "MONTHLY");
  const plan = defaultModelPlan(contract);
  const lines = suggestScheduleLines({ ...plan, yieldAmount: "5.000,00", description: "" });
  assert.equal(lines.length, 12);
  assert.ok(lines.slice(0, 11).every((line) => line.kind === "YIELD" && line.yieldAmount === "5.000,00"));
  assert.deepEqual(lines[11], { kind: "COMBINED", dueDate: "2027-10-15", yieldAmount: "5.000,00", principalAmount: "100.000,00", description: "" });
});

test("IS5c. negociação personalizada: 50% do principal no 6º mês, 50% no 12º, rendimentos em obrigações separadas e datas irregulares", () => {
  const lines = [
    ...Array.from({ length: 12 }, (_, index) => ({ kind: "YIELD", dueDate: `20${index < 2 ? "26" : "27"}-${String(((index + 10) % 12) + 1).padStart(2, "0")}-${index === 4 ? "03" : "15"}`, yieldAmount: index < 6 ? "5.000,00" : "2.500,00", principalAmount: "" })),
    { kind: "PRINCIPAL", dueDate: "2027-04-15", yieldAmount: "", principalAmount: "50.000,00", description: "50% do principal" },
    { kind: "PRINCIPAL", dueDate: "2027-10-15", yieldAmount: "", principalAmount: "50.000,00", description: "50% do principal" },
  ];
  const parsed = scheduleLinesFields(JSON.stringify(lines));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.items.length, 14);
  assert.equal(parsed.items[4].dueDate, "2027-03-03", "data irregular aceita como digitada");
  assert.deepEqual(scheduleTotals(parsed.items), { yieldCents: 4_500_000, principalCents: 10_000_000, totalCents: 14_500_000, count: 14 });
  assert.ok(parsed.items.filter((item) => item.principalCents).every((item) => item.yieldCents === 0), "principal em obrigação própria");
});

test("IS6. linha do cronograma e histórico legível", () => {
  assert.equal(scheduleItemFields(form({ dueDate: "2026-12-01" })).ok, false, "linha sem valor");
  assert.deepEqual(scheduleItemFields(form({ dueDate: "2026-12-01", yieldAmount: "10,50" })).values, { dueDate: "2026-12-01", yieldCents: 1050, principalCents: 0, description: null });
  const before = {
    amountCents: 5_000_000, agreedRateBps: 150, ratePeriod: "MONTHLY", startDate: "2026-10-01", maturityDate: null, dueDay: null, notes: null, status: "ACTIVE", contractNumber: null, investedOn: null, termMonths: null, paymentFrequency: null, installmentCount: null,
    contractedOn: null, termCount: null, termUnit: null, paymentMethod: null, bankAccountId: null, yieldTerms: null, principalTerms: null,
  };
  assert.deepEqual(investmentChanges(before, before), []);
  assert.deepEqual(investmentChanges(before, { ...before, ratePeriod: "YEARLY", termCount: 12, termUnit: "MONTHS", paymentFrequency: "MONTHLY", paymentMethod: "PIX", bankAccountId: "a1" }, () => "Itaú · Pix •••"), [
    { field: "Taxa combinada", before: "1,5% ao mês", after: "1,5% ao ano" },
    { field: "Prazo", before: null, after: "12 meses" },
    { field: "Periodicidade dos pagamentos", before: null, after: "Mensal" },
    { field: "Forma de pagamento", before: null, after: "Pix" },
    { field: "Conta bancária para os pagamentos", before: null, after: "Itaú · Pix •••" },
  ]);
  // Contrato antigo com prazo em meses passando para o formato novo com o mesmo prazo não é mudança.
  assert.deepEqual(investmentChanges({ ...before, termMonths: 12 }, { ...before, termCount: 12, termUnit: "MONTHS" }), []);
  assert.equal(scheduleSummary([]), null);
  assert.match(scheduleSummary([{ dueDate: "2027-01-10", yieldCents: 100, principalCents: 0 }, { dueDate: "2026-11-10", yieldCents: 100, principalCents: 500 }]), /^2 pagamentos de 10\/11\/2026 a 10\/01\/2027/);
});
