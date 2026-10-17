import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { investmentFields, investorFields, investorFilters, rateLabel, summarizeInvestments, RATE_PERIODS } from "../src/lib/investors/rules.ts";
import { normalizeEmail, normalizeSocial, socialHref, socialLabel, whatsappHref } from "../src/lib/contacts.ts";
import { formatCpfCnpj, maskCpfCnpj, normalizeCpfCnpj } from "../src/lib/finance/format.ts";

const form = (values) => (key, max) => String(values[key] ?? "").trim().slice(0, max);

test("IV1. investidor: tipo de pessoa, nome e CPF/CNPJ conferido pelo tipo; contatos normalizados", () => {
  const today = "2026-10-15";
  assert.equal(investorFields(form({}), today).ok, false);
  assert.equal(investorFields(form({ name: "Ana Investidora" }), today).ok, false, "sem tipo de pessoa e documento não grava");
  const minimal = investorFields(form({ personType: "PF", name: "Ana Investidora", document: "411.797.058-58" }), today);
  assert.equal(minimal.ok, true);
  assert.deepEqual(minimal.values, {
    personType: "PF", name: "Ana Investidora", tradeName: null, document: "41179705858", birthDate: null, phone: null, whatsapp: null, email: null, instagram: null, facebook: null, notes: null, status: "ACTIVE",
    addressCep: null, addressStreet: null, addressNumber: null, addressComplement: null, addressDistrict: null, addressCity: null, addressState: null,
  });
  assert.ok(!Object.keys(minimal.values).some((key) => /bank|pix/i.test(key)), "dados bancários ficam nas contas do investidor");
  const full = investorFields(form({ personType: "PJ", name: "Empresa X Ltda", tradeName: " Empresa X ", document: "11.222.333/0001-81", birthDate: "2010-05-20", phone: "(11) 3456-7890", whatsapp: "(11) 98765-4321", email: " Contato@Empresa.COM ", instagram: "@empresax", facebook: "https://facebook.com/empresax", notes: "obs", status: "INACTIVE" }), today);
  assert.equal(full.ok, true);
  assert.equal(full.values.document, "11222333000181");
  assert.equal(full.values.tradeName, "Empresa X");
  assert.equal(full.values.birthDate, "2010-05-20");
  assert.equal(full.values.whatsapp, "11987654321");
  assert.equal(full.values.email, "contato@empresa.com");
  assert.equal(full.values.status, "INACTIVE");
  const pf = { personType: "PF", name: "A", document: "411.797.058-58" };
  assert.equal(investorFields(form({ ...pf, personType: "PJ" }), today).ok, false, "CPF com tipo PJ é recusado");
  assert.equal(investorFields(form({ ...pf, document: "11.222.333/0001-81" }), today).ok, false, "CNPJ com tipo PF é recusado");
  assert.equal(investorFields(form({ ...pf, document: "411.797.058-59" }), today).ok, false, "dígito verificador errado");
  assert.equal(investorFields(form({ ...pf, personType: "XX" }), today).ok, false);
  assert.equal(investorFields(form({ ...pf, birthDate: "2026-10-16" }), today).ok, false, "nascimento no futuro");
  assert.equal(investorFields(form({ ...pf, birthDate: "1899-12-31" }), today).ok, false);
  assert.equal(investorFields(form({ ...pf, email: "sem-arroba" }), today).ok, false);
  assert.equal(investorFields(form({ ...pf, whatsapp: "123" }), today).ok, false);
  assert.equal(investorFields(form({ ...pf, status: "ADMIN" }), today).ok, false);
});

test("IV2. redes sociais: @usuário ou URL, sem validação restritiva; link só para o próprio Instagram/Facebook", () => {
  assert.deepEqual(normalizeSocial("  @maria.silva "), { ok: true, value: "@maria.silva" });
  assert.deepEqual(normalizeSocial("instagram.com/maria"), { ok: true, value: "instagram.com/maria" });
  assert.deepEqual(normalizeSocial(""), { ok: true, value: null });
  assert.equal(socialHref("instagram", "@maria.silva"), "https://instagram.com/maria.silva");
  assert.equal(socialHref("instagram", "maria"), "https://instagram.com/maria");
  assert.equal(socialHref("facebook", "https://www.facebook.com/maria"), "https://www.facebook.com/maria");
  assert.equal(socialHref("instagram", "instagram.com/maria"), "https://instagram.com/maria");
  assert.equal(socialHref("instagram", "https://golpe.example.com/maria"), null);
  assert.equal(socialHref("facebook", "javascript:alert(1)"), null);
  assert.equal(socialLabel("maria"), "@maria");
  assert.equal(whatsappHref("11987654321"), "https://wa.me/5511987654321");
  assert.equal(normalizeEmail("a@b").ok, false);
});

test("IV3. CPF ou CNPJ com máscara", () => {
  assert.equal(maskCpfCnpj("41179705858"), "411.797.058-58");
  assert.equal(maskCpfCnpj("11222333000181"), "11.222.333/0001-81");
  assert.equal(formatCpfCnpj("11222333000181"), "11.222.333/0001-81");
  assert.equal(formatCpfCnpj("RG 123"), "RG 123");
  assert.equal(normalizeCpfCnpj("11111111111").ok, false);
});

test("IV4. investimento: taxa e período obrigatórios, período nunca presumido, sem cálculo", () => {
  const base = { amount: "50.000,00", rate: "1,5", ratePeriod: "MONTHLY", startDate: "2026-10-01" };
  const ok = investmentFields(form(base));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.values, {
    amountCents: 5_000_000, agreedRateBps: 150, ratePeriod: "MONTHLY", startDate: "2026-10-01", maturityDate: null, dueDay: null, notes: null, status: "ACTIVE",
    contractNumber: null, investedOn: null, termMonths: null, paymentFrequency: null, installmentCount: null,
    contractedOn: null, termCount: null, termUnit: null, paymentMethod: null, bankAccountId: null, yieldTerms: null, principalTerms: null,
    redemptionRule: null, redemptionDays: null, yieldPaymentCents: null,
  });
  const custom = investmentFields(form({ ...base, contractedOn: "2026-09-28", investedOn: "2026-09-30", termCount: "12", termUnit: "MONTHS", paymentMethod: "PIX", bankAccountId: "conta-1", yieldTerms: "mensal até o dia 10", principalTerms: "50% no 6º mês e 50% no 12º" }));
  assert.equal(custom.ok, true);
  assert.equal(custom.values.termCount, 12);
  assert.equal(custom.values.termUnit, "MONTHS");
  assert.equal(custom.values.termMonths, null, "o prazo novo não é convertido para o campo antigo");
  assert.equal(custom.values.paymentMethod, "PIX");
  assert.equal(custom.values.principalTerms, "50% no 6º mês e 50% no 12º");
  assert.equal(investmentFields(form({ ...base, termCount: "12" })).ok, false, "prazo sem unidade");
  assert.equal(investmentFields(form({ ...base, termCount: "0", termUnit: "MONTHS" })).ok, false);
  assert.equal(investmentFields(form({ ...base, paymentMethod: "BOLETO" })).ok, false);
  assert.equal(investmentFields(form({ ...base, contractedOn: "2026-13-01" })).ok, false);
  assert.equal(investmentFields(form({ ...base, ratePeriod: "" })).ok, false, "sem período escolhido não grava");
  assert.equal(investmentFields(form({ ...base, rate: "" })).ok, false);
  assert.equal(investmentFields(form({ ...base, amount: "0" })).ok, false);
  assert.equal(investmentFields(form({ ...base, maturityDate: "2026-09-01" })).ok, false);
  assert.equal(investmentFields(form({ ...base, dueDay: "32" })).ok, false);
  assert.equal(investmentFields(form({ ...base, dueDay: "10", maturityDate: "2027-10-01", status: "PENDING_SIGNATURE" })).values.dueDay, 10);
  // Nenhum campo de rendimento, saldo ou total a devolver é produzido.
  // Nenhum campo de rendimento calculado, saldo ou total a devolver é produzido (as condições são texto livre).
  assert.ok(!Object.keys(ok.values).filter((key) => !/Terms$|^yieldPaymentCents$/.test(key)).some((key) => /yield|rendimento|balance|saldo|return/i.test(key)));
  assert.equal(rateLabel(150, "YEARLY"), "1,5% ao ano");
  assert.deepEqual(Object.keys(RATE_PERIODS), ["MONTHLY", "YEARLY", "CONTRACT_TERM", "OTHER"]);
});

test("IV5. painel: soma só o cadastrado; rendimentos vêm do cronograma e das baixas, nunca da taxa", () => {
  const row = (values) => ({ scheduledYieldCents: 0, paidYieldCents: 0, paidPrincipalCents: 0, ...values });
  const rows = [
    row({ status: "ACTIVE", amountCents: 100_000, maturityDate: "2026-10-20", scheduledYieldCents: 12_000, paidYieldCents: 3_000, paidPrincipalCents: 40_000 }),
    row({ status: "ACTIVE", amountCents: 50_000, maturityDate: "2027-05-01" }),
    row({ status: "ACTIVE", amountCents: 10_000, maturityDate: "2026-09-01" }),
    row({ status: "PENDING_SIGNATURE", amountCents: 999_999, maturityDate: "2026-10-12" }),
    row({ status: "CLOSED", amountCents: 999_999, maturityDate: null, scheduledYieldCents: 5_000, paidYieldCents: 5_000 }),
    row({ status: "CANCELED", amountCents: 7_777, maturityDate: null, scheduledYieldCents: 9_999 }),
  ];
  const summary = summarizeInvestments(rows, "2026-10-10");
  assert.equal(summary.investedCents, 160_000);
  assert.equal(summary.activeCount, 3);
  assert.equal(summary.pendingSignatureCount, 1);
  assert.equal(summary.nextMaturityDate, "2026-10-20");
  assert.equal(summary.maturingSoonCount, 1);
  assert.equal(summary.overdueMaturityCount, 1);
  assert.equal(summary.expectedYieldCents, 17_000, "linhas de rendimento digitadas, sem contrato cancelado");
  assert.equal(summary.paidYieldCents, 8_000);
  assert.equal(summary.principalToReturnCents, 60_000 + 50_000 + 10_000 + 999_999, "ativos e aguardando assinatura menos o principal devolvido");
  assert.deepEqual(summarizeInvestments([], "2026-10-10").investedCents, 0);
});

test("IV6. filtros da lista: status só valores conhecidos, página válida", () => {
  assert.deepEqual(investorFilters({ q: "  ana ", status: "x", pagina: "-2" }), { q: "ana", status: "", carteira: "", page: 1 });
  assert.equal(investorFilters({ status: "INACTIVE", pagina: "3" }).page, 3);
});

test("IV7. migration 0015 só cria estrutura: nenhuma linha existente é alterada ou apagada", () => {
  const sql = readFileSync("drizzle/0015_investors.sql", "utf8").replace(/^--.*$/gm, "");
  assert.ok(!/(^|breakpoint)\s*(UPDATE|DELETE|TRUNCATE|DROP|INSERT)\b/im.test(sql));
  assert.ok(!/\bDROP\b/i.test(sql));
  assert.ok(!/ALTER TABLE "(loan_operation|payment|subscription|wallet|tenant|user)"/.test(sql));
  for (const column of ["whatsapp", "email", "instagram", "facebook"]) assert.match(sql, new RegExp(`ALTER TABLE "client" ADD COLUMN "${column}" text;`));
  for (const table of ["investor", "investment", "investment_document"]) {
    assert.match(sql, new RegExp(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`));
    assert.match(sql, new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`));
  }
  // Documento ligado ao investimento (mesmo tenant), não ao investidor.
  assert.match(sql, /FOREIGN KEY \("tenant_id","investment_id"\) REFERENCES "public"."investment"\("tenant_id","id"\)/);
});

test("IL1. liquidez (ao término ou D+N) e rendimento de cada pagamento: validação, datas e histórico", async () => {
  const { redemptionDate, redemptionLabel, investmentChanges, applyRedemptionDate } = await import("../src/lib/investors/rules.ts");
  const base = { amount: "10.000,00", rate: "5", ratePeriod: "MONTHLY", startDate: "2026-07-15" };
  const atMaturity = investmentFields(form({ ...base, redemptionRule: "AT_MATURITY", redemptionDays: "99", yieldPayment: "500,00" }));
  assert.equal(atMaturity.ok, true);
  assert.equal(atMaturity.values.redemptionRule, "AT_MATURITY");
  assert.equal(atMaturity.values.redemptionDays, null, "dias só valem em D+");
  assert.equal(atMaturity.values.yieldPaymentCents, 50_000);
  const dPlus = investmentFields(form({ ...base, redemptionRule: "D_PLUS", redemptionDays: "30" }));
  assert.equal(dPlus.values.redemptionDays, 30);
  assert.equal(dPlus.values.yieldPaymentCents, null);
  for (const bad of [{ redemptionRule: "D_PLUS" }, { redemptionRule: "D_PLUS", redemptionDays: "0" }, { redemptionRule: "D_PLUS", redemptionDays: "3651" }, { redemptionRule: "D_PLUS", redemptionDays: "1,5" }, { redemptionRule: "QUALQUER" }, { yieldPayment: "0" }, { yieldPayment: "abc" }]) {
    assert.equal(investmentFields(form({ ...base, ...bad })).ok, false, JSON.stringify(bad));
  }
  assert.equal(redemptionDate("2027-06-25", "AT_MATURITY", null), "2027-06-25");
  assert.equal(redemptionDate("2027-06-25", "D_PLUS", 30), "2027-07-25");
  assert.equal(redemptionDate("2027-06-25", null, null), null);
  assert.equal(redemptionDate(null, "D_PLUS", 30), null, "sem vencimento não há data presumida");
  assert.equal(redemptionLabel("AT_MATURITY", null), "Ao término do contrato");
  assert.match(redemptionLabel("D_PLUS", 30), /^D\+30/);
  assert.equal(redemptionLabel(null, null), null);
  // Histórico: mudar de D+30 para D+60 aparece uma vez, com antes e depois.
  const changes = investmentChanges(dPlus.values, investmentFields(form({ ...base, redemptionRule: "D_PLUS", redemptionDays: "60" })).values);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].field, "Liquidez (resgate do crédito)");
  assert.match(changes[0].before, /D\+30/);
  assert.match(changes[0].after, /D\+60/);
  assert.equal(investmentChanges(atMaturity.values, { ...atMaturity.values, yieldPaymentCents: 60_000 })[0].field, "Rendimento de cada pagamento");
  // Cronograma sugerido: o principal vai para a data de resgate e os valores não mudam.
  const lines = [
    { kind: "YIELD", dueDate: "2027-05-25", yieldAmount: "500,00", principalAmount: "", description: "" },
    { kind: "COMBINED", dueDate: "2027-06-25", yieldAmount: "500,00", principalAmount: "10.000,00", description: "" },
  ];
  assert.deepEqual(applyRedemptionDate(lines, "2027-06-25"), lines, "resgate no último vencimento: nada muda");
  assert.deepEqual(applyRedemptionDate(lines, "2027-07-25"), [
    lines[0], { kind: "YIELD", dueDate: "2027-06-25", yieldAmount: "500,00", principalAmount: "", description: "" },
    { kind: "PRINCIPAL", dueDate: "2027-07-25", yieldAmount: "", principalAmount: "10.000,00", description: "" },
  ]);
  assert.deepEqual(applyRedemptionDate(lines, null), lines);
});

test("IL2. migration 0026 só acrescenta colunas e travas: nenhum dado existente é alterado", () => {
  const sql = readFileSync("drizzle/0026_investimento_liquidez.sql", "utf8");
  assert.ok(!/\b(UPDATE|DELETE|TRUNCATE|DROP|INSERT)\b/i.test(sql));
  assert.equal((sql.match(/ADD COLUMN/g) ?? []).length, 3);
  assert.ok(/investment_redemption_valid/.test(sql) && /investment_yield_payment_valid/.test(sql));
});
