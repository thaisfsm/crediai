import { test } from "node:test";
import assert from "node:assert/strict";
import {
  investmentChanges, investmentFields, investorFields, scheduleBuildFields, scheduleDates, scheduleItemFields, scheduleSummary, scheduleTotals, PAYMENT_FREQUENCIES,
} from "../src/lib/investors/rules.ts";
import { cpfCnpjProblem, normalizeCpfCnpj } from "../src/lib/finance/format.ts";

const form = (values) => (key, max) => String(values[key] ?? "").trim().slice(0, max);

test("IS1. CPF/CNPJ do investidor e da contratante com dígitos verificadores", () => {
  assert.equal(normalizeCpfCnpj("411.797.058-58").ok, true);
  assert.equal(normalizeCpfCnpj("11.222.333/0001-81").ok, true);
  assert.equal(normalizeCpfCnpj("411.797.058-59").ok, false, "CPF com dígito errado");
  assert.equal(normalizeCpfCnpj("12.345.678/0001-90").ok, false, "CNPJ com dígito errado");
  assert.equal(normalizeCpfCnpj("00000000000").ok, false);
  assert.equal(investorFields(form({ name: "A", document: "529.982.247-24" })).ok, false);
  assert.equal(cpfCnpjProblem(""), null);
  assert.equal(cpfCnpjProblem("41179705858"), null);
  assert.match(cpfCnpjProblem("41179705850"), /CPF inválido/);
  assert.match(cpfCnpjProblem("11222333000180"), /CNPJ inválido/);
  assert.match(cpfCnpjProblem("1234"), /11 dígitos/);
});

test("IS2. dados bancários e Pix do investidor: opcionais e conferidos", () => {
  const ok = investorFields(form({ name: "Ana", bankName: "Banco X", bankBranch: "1234-5", bankAccount: "12345-6", bankAccountType: "CHECKING", bankHolderDocument: "411.797.058-58", pixKeyType: "EMAIL", pixKey: "Ana@Exemplo.com" }));
  assert.equal(ok.ok, true);
  assert.equal(ok.values.bankHolderDocument, "41179705858");
  assert.equal(ok.values.pixKey, "ana@exemplo.com");
  assert.equal(investorFields(form({ name: "Ana", pixKeyType: "CPF", pixKey: "111.111.111-11" })).ok, false);
  assert.equal(investorFields(form({ name: "Ana", bankAccountType: "XYZ" })).ok, false);
  assert.equal(investorFields(form({ name: "Ana", bankBranch: "12a" })).ok, false);
});

test("IS3. contrato: identificação, data do investimento, prazo, periodicidade e parcelas (todos opcionais, nada calculado)", () => {
  const base = { amount: "50.000,00", rate: "1,5", ratePeriod: "MONTHLY", startDate: "2026-10-01" };
  const full = investmentFields(form({ ...base, contractNumber: " INV-2026/001 ", investedOn: "2026-09-28", termMonths: "12", paymentFrequency: "QUARTERLY", installmentCount: "4" }));
  assert.equal(full.ok, true);
  assert.equal(full.values.contractNumber, "INV-2026/001");
  assert.equal(full.values.investedOn, "2026-09-28");
  assert.equal(full.values.termMonths, 12);
  assert.equal(full.values.paymentFrequency, "QUARTERLY");
  assert.equal(full.values.installmentCount, 4);
  assert.equal(investmentFields(form({ ...base, contractNumber: "<script>" })).ok, false);
  assert.equal(investmentFields(form({ ...base, termMonths: "0" })).ok, false);
  assert.equal(investmentFields(form({ ...base, termMonths: "1,5" })).ok, false);
  assert.equal(investmentFields(form({ ...base, paymentFrequency: "WEEKLY" })).ok, false);
  assert.equal(investmentFields(form({ ...base, installmentCount: "601" })).ok, false);
  assert.equal(investmentFields(form({ ...base, investedOn: "2026-02-30" })).ok, false);
  assert.ok(!Object.keys(full.values).some((key) => /yield|rendimento|balance|saldo|return/i.test(key)));
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

test("IS5. montagem: valores exatamente os digitados; principal só na última data; validações", () => {
  const built = scheduleBuildFields(form({ frequency: "MONTHLY", firstDueDate: "2026-11-10", count: "3", yieldAmount: "750,00", principalAmount: "50.000,00", description: "Rendimento" }));
  assert.equal(built.ok, true);
  assert.deepEqual(built.items, [
    { dueDate: "2026-11-10", yieldCents: 75_000, principalCents: 0, description: "Rendimento" },
    { dueDate: "2026-12-10", yieldCents: 75_000, principalCents: 0, description: "Rendimento" },
    { dueDate: "2027-01-10", yieldCents: 75_000, principalCents: 5_000_000, description: "Rendimento" },
  ]);
  assert.deepEqual(scheduleTotals(built.items), { yieldCents: 225_000, principalCents: 5_000_000, totalCents: 5_225_000, count: 3 });
  // Pagamento único só com a devolução do principal é aceito.
  const single = scheduleBuildFields(form({ frequency: "AT_MATURITY", firstDueDate: "2027-10-01", principalAmount: "50.000,00" }));
  assert.equal(single.ok, true);
  assert.deepEqual(single.items, [{ dueDate: "2027-10-01", yieldCents: 0, principalCents: 5_000_000, description: null }]);
  assert.equal(scheduleBuildFields(form({ frequency: "OTHER", firstDueDate: "2026-11-10", count: "3", yieldAmount: "1" })).ok, false);
  assert.equal(scheduleBuildFields(form({ frequency: "MONTHLY", firstDueDate: "2026-11-10", count: "3", principalAmount: "100" })).ok, false, "várias datas sem rendimento ficariam zeradas");
  assert.equal(scheduleBuildFields(form({ frequency: "MONTHLY", firstDueDate: "2026-11-10", count: "0", yieldAmount: "1" })).ok, false);
  assert.equal(scheduleBuildFields(form({ frequency: "MONTHLY", firstDueDate: "", count: "2", yieldAmount: "1" })).ok, false);
  assert.equal(scheduleBuildFields(form({ frequency: "MONTHLY", firstDueDate: "2026-11-10", count: "2", yieldAmount: "-5" })).ok, false);
});

test("IS6. linha do cronograma e histórico legível", () => {
  assert.equal(scheduleItemFields(form({ dueDate: "2026-12-01" })).ok, false, "linha sem valor");
  assert.deepEqual(scheduleItemFields(form({ dueDate: "2026-12-01", yieldAmount: "10,50" })).values, { dueDate: "2026-12-01", yieldCents: 1050, principalCents: 0, description: null });
  const before = { amountCents: 5_000_000, agreedRateBps: 150, ratePeriod: "MONTHLY", startDate: "2026-10-01", maturityDate: null, dueDay: null, notes: null, status: "ACTIVE", contractNumber: null, investedOn: null, termMonths: null, paymentFrequency: null, installmentCount: null };
  assert.deepEqual(investmentChanges(before, before), []);
  assert.deepEqual(investmentChanges(before, { ...before, ratePeriod: "YEARLY", termMonths: 12, paymentFrequency: "MONTHLY" }), [
    { field: "Taxa combinada", before: "1,5% ao mês", after: "1,5% ao ano" },
    { field: "Prazo", before: null, after: "12 meses" },
    { field: "Periodicidade dos pagamentos", before: null, after: "Mensal" },
  ]);
  assert.equal(scheduleSummary([]), null);
  assert.match(scheduleSummary([{ dueDate: "2027-01-10", yieldCents: 100, principalCents: 0 }, { dueDate: "2026-11-10", yieldCents: 100, principalCents: 500 }]), /^2 pagamentos de 10\/11\/2026 a 10\/01\/2027/);
});
