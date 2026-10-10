import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { investmentFields, investorFields, investorFilters, rateLabel, summarizeInvestments, RATE_PERIODS } from "../src/lib/investors/rules.ts";
import { normalizeEmail, normalizeSocial, socialHref, socialLabel, whatsappHref } from "../src/lib/contacts.ts";
import { formatCpfCnpj, maskCpfCnpj, normalizeCpfCnpj } from "../src/lib/finance/format.ts";

const form = (values) => (key, max) => String(values[key] ?? "").trim().slice(0, max);

test("IV1. investidor: só o nome é obrigatório; CPF/CNPJ, telefones e e-mail normalizados", () => {
  assert.equal(investorFields(form({})).ok, false);
  const minimal = investorFields(form({ name: "Ana Investidora" }));
  assert.equal(minimal.ok, true);
  assert.deepEqual(minimal.values, { name: "Ana Investidora", document: null, phone: null, whatsapp: null, email: null, instagram: null, facebook: null, notes: null, status: "ACTIVE" });
  const full = investorFields(form({ name: "Empresa X Ltda", document: "12.345.678/0001-90", phone: "(11) 3456-7890", whatsapp: "(11) 98765-4321", email: " Contato@Empresa.COM ", instagram: "@empresax", facebook: "https://facebook.com/empresax", notes: "obs", status: "INACTIVE" }));
  assert.equal(full.ok, true);
  assert.equal(full.values.document, "12345678000190");
  assert.equal(full.values.whatsapp, "11987654321");
  assert.equal(full.values.email, "contato@empresa.com");
  assert.equal(full.values.status, "INACTIVE");
  assert.equal(investorFields(form({ name: "A", document: "123" })).ok, false);
  assert.equal(investorFields(form({ name: "A", email: "sem-arroba" })).ok, false);
  assert.equal(investorFields(form({ name: "A", whatsapp: "123" })).ok, false);
  assert.equal(investorFields(form({ name: "A", status: "ADMIN" })).ok, false);
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
  assert.equal(maskCpfCnpj("12345678000190"), "12.345.678/0001-90");
  assert.equal(formatCpfCnpj("12345678000190"), "12.345.678/0001-90");
  assert.equal(formatCpfCnpj("RG 123"), "RG 123");
  assert.equal(normalizeCpfCnpj("11111111111").ok, false);
});

test("IV4. investimento: taxa e período obrigatórios, período nunca presumido, sem cálculo", () => {
  const base = { amount: "50.000,00", rate: "1,5", ratePeriod: "MONTHLY", startDate: "2026-10-01" };
  const ok = investmentFields(form(base));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.values, { amountCents: 5_000_000, agreedRateBps: 150, ratePeriod: "MONTHLY", startDate: "2026-10-01", maturityDate: null, dueDay: null, notes: null, status: "ACTIVE" });
  assert.equal(investmentFields(form({ ...base, ratePeriod: "" })).ok, false, "sem período escolhido não grava");
  assert.equal(investmentFields(form({ ...base, rate: "" })).ok, false);
  assert.equal(investmentFields(form({ ...base, amount: "0" })).ok, false);
  assert.equal(investmentFields(form({ ...base, maturityDate: "2026-09-01" })).ok, false);
  assert.equal(investmentFields(form({ ...base, dueDay: "32" })).ok, false);
  assert.equal(investmentFields(form({ ...base, dueDay: "10", maturityDate: "2027-10-01", status: "PENDING_SIGNATURE" })).values.dueDay, 10);
  // Nenhum campo de rendimento, saldo ou total a devolver é produzido.
  assert.ok(!Object.keys(ok.values).some((key) => /yield|rendimento|balance|saldo|return/i.test(key)));
  assert.equal(rateLabel(150, "YEARLY"), "1,5% ao ano");
  assert.deepEqual(Object.keys(RATE_PERIODS), ["MONTHLY", "YEARLY", "CONTRACT_TERM", "OTHER"]);
});

test("IV5. painel: soma e conta só o cadastrado; rendimentos e total a devolver ficam sem cálculo", () => {
  const rows = [
    { status: "ACTIVE", amountCents: 100_000, maturityDate: "2026-10-20" },
    { status: "ACTIVE", amountCents: 50_000, maturityDate: "2027-05-01" },
    { status: "ACTIVE", amountCents: 10_000, maturityDate: "2026-09-01" },
    { status: "PENDING_SIGNATURE", amountCents: 999_999, maturityDate: "2026-10-12" },
    { status: "CLOSED", amountCents: 999_999, maturityDate: null },
  ];
  const summary = summarizeInvestments(rows, "2026-10-10");
  assert.equal(summary.investedCents, 160_000);
  assert.equal(summary.activeCount, 3);
  assert.equal(summary.pendingSignatureCount, 1);
  assert.equal(summary.nextMaturityDate, "2026-10-20");
  assert.equal(summary.maturingSoonCount, 1);
  assert.equal(summary.overdueMaturityCount, 1);
  assert.equal(summary.expectedYieldCents, null);
  assert.equal(summary.paidYieldCents, null);
  assert.equal(summary.totalToReturnCents, null);
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
