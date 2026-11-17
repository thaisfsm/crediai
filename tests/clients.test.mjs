import { test } from "node:test";
import assert from "node:assert/strict";
import { cnpjProblem, cpfProblem, formatCnpj, isValidCnpj, isValidCpf, maskCnpj, normalizeCnpj, normalizeCpf } from "../src/lib/finance/format.ts";
import { bankFields, bankSummary, formatPixKey, normalizePixKey } from "../src/lib/bank-account.ts";
import { clientSearchTerms, filterGuarantorCandidates, normalizeName } from "../src/lib/finance/client-search.ts";
import { clientProfileKeys, guarantorFromClient } from "../src/lib/finance/client-profile.ts";

const form = (values) => (key, max) => String(values[key] ?? "").trim().slice(0, max);

test("CL1. CPF: dígitos verificadores conferidos, com ou sem máscara", () => {
  for (const valid of ["411.797.058-58", "52998224725", "529.982.247-25", "123.456.789-09"]) assert.equal(isValidCpf(valid), true, valid);
  for (const invalid of ["411.797.058-59", "52998224724", "12345678900", "000.000.000-00", "111.111.111-11", "99999999999", "1234567890", "123456789012", ""]) assert.equal(isValidCpf(invalid), false, invalid);
  assert.deepEqual(normalizeCpf("529.982.247-25"), { ok: true, value: "52998224725" });
  assert.deepEqual(normalizeCpf("  "), { ok: true, value: null });
  assert.equal(normalizeCpf("529.982.247-24").ok, false);
  assert.match(cpfProblem("529.982.247-24"), /CPF inválido/);
  assert.match(cpfProblem("5299822"), /11 dígitos/);
  assert.equal(cpfProblem(""), null);
});

test("CL2. CNPJ: dígitos verificadores, máscara e formatação", () => {
  for (const valid of ["11.222.333/0001-81", "11222333000181", "45.997.418/0001-53"]) assert.equal(isValidCnpj(valid), true, valid);
  for (const invalid of ["11.222.333/0001-80", "11222333000182", "00000000000000", "11111111111111", "1122233300018", ""]) assert.equal(isValidCnpj(invalid), false, invalid);
  assert.deepEqual(normalizeCnpj("11.222.333/0001-81"), { ok: true, value: "11222333000181" });
  assert.equal(normalizeCnpj("11.222.333/0001-80").ok, false);
  assert.match(cnpjProblem("11.222.333/0001-80"), /CNPJ inválido/);
  assert.equal(maskCnpj("11222333000181"), "11.222.333/0001-81");
  assert.equal(formatCnpj("11222333000181"), "11.222.333/0001-81");
  assert.equal(formatCnpj("abc"), "abc");
});

test("CL3. dados bancários: tudo opcional; o que vier é conferido", () => {
  const empty = bankFields(form({}));
  assert.equal(empty.ok, true);
  assert.deepEqual(Object.values(empty.values), [null, null, null, null, null, null, null, null]);
  const full = bankFields(form({ bankHolderName: "Maria Cliente", bankHolderDocument: "529.982.247-25", bankName: "341 Itaú", bankBranch: "1234", bankAccount: "12345-x", bankAccountType: "CHECKING", pixKeyType: "EMAIL", pixKey: " Maria@Exemplo.COM " }));
  assert.equal(full.ok, true);
  assert.deepEqual(full.values, { bankHolderName: "Maria Cliente", bankHolderDocument: "52998224725", bankName: "341 Itaú", bankBranch: "1234", bankAccount: "12345-X", bankAccountType: "CHECKING", pixKeyType: "EMAIL", pixKey: "maria@exemplo.com" });
  assert.equal(bankFields(form({ bankHolderDocument: "11.222.333/0001-81" })).values.bankHolderDocument, "11222333000181");
  assert.match(bankFields(form({ bankHolderDocument: "529.982.247-24" })).error, /titular.*CPF inválido/);
  assert.match(bankFields(form({ bankBranch: "12a4" })).error, /Agência/);
  assert.match(bankFields(form({ bankAccount: "abc" })).error, /Conta/);
  assert.match(bankFields(form({ bankAccountType: "XPTO" })).error, /tipo de conta/);
  assert.match(bankFields(form({ pixKey: "abc" })).error, /tipo da chave Pix/);
  // Tipo sem chave: nada é gravado (o campo da chave fica vazio).
  assert.deepEqual([bankFields(form({ pixKeyType: "CPF" })).values.pixKeyType, bankFields(form({ pixKeyType: "CPF" })).values.pixKey], [null, null]);
  const summary = bankSummary(full.values);
  assert.equal(summary.account, "341 Itaú · ag. 1234 · conta 12345-X · Conta corrente");
  assert.equal(summary.holder, "Maria Cliente · 529.982.247-25");
  assert.equal(summary.pix, "E-mail: maria@exemplo.com");
});

test("CL4. chave Pix por tipo", () => {
  assert.deepEqual(normalizePixKey("CPF", "529.982.247-25"), { ok: true, value: "52998224725" });
  assert.equal(normalizePixKey("CPF", "529.982.247-24").ok, false);
  assert.deepEqual(normalizePixKey("CNPJ", "11.222.333/0001-81"), { ok: true, value: "11222333000181" });
  assert.equal(normalizePixKey("CNPJ", "11.222.333/0001-80").ok, false);
  assert.deepEqual(normalizePixKey("PHONE", "+55 (11) 98765-4321"), { ok: true, value: "11987654321" });
  assert.deepEqual(normalizePixKey("PHONE", "(11) 98765-4321"), { ok: true, value: "11987654321" });
  assert.equal(normalizePixKey("PHONE", "123").ok, false);
  assert.equal(normalizePixKey("EMAIL", "sem-arroba").ok, false);
  assert.deepEqual(normalizePixKey("RANDOM", "123E4567-E89B-12D3-A456-426614174000"), { ok: true, value: "123e4567-e89b-12d3-a456-426614174000" });
  assert.equal(normalizePixKey("RANDOM", "123").ok, false);
  assert.equal(formatPixKey("CPF", "52998224725"), "529.982.247-25");
  assert.equal(formatPixKey("PHONE", "11987654321"), "(11) 98765-4321");
});

test("CL5. busca: nome sem acentos, palavras em qualquer ordem; CPF e telefone com ou sem máscara", () => {
  assert.equal(normalizeName("  JOÃO   da  Conceição "), "joao da conceicao");
  assert.deepEqual(clientSearchTerms("joão  SOUZA"), { kind: "name", words: ["joao", "souza"], email: "joão  souza" });
  assert.deepEqual(clientSearchTerms("Ana"), { kind: "name", words: ["ana"], email: "ana" });
  assert.deepEqual(clientSearchTerms("529.982.247-25"), { kind: "digits", digits: "52998224725" });
  assert.deepEqual(clientSearchTerms("(11) 98765-4321"), { kind: "digits", digits: "11987654321" });
  assert.deepEqual(clientSearchTerms("98"), { kind: "none" });
  assert.deepEqual(clientSearchTerms("   "), { kind: "none" });
  assert.deepEqual(clientSearchTerms("Ana@Exemplo.com"), { kind: "email", email: "ana@exemplo.com" }, "com @ procura no e-mail");
  assert.deepEqual(clientSearchTerms("@gmail"), { kind: "email", email: "@gmail" });
  assert.deepEqual(clientSearchTerms("@"), { kind: "none" });
  assert.deepEqual(clientSearchTerms("%_"), { kind: "none" });
});

test("CL6. cadastro do cliente inclui empresa e dados bancários", () => {
  for (const key of ["businessCompanyName", "businessCnpj", "bankHolderName", "bankHolderDocument", "bankName", "bankBranch", "bankAccount", "bankAccountType", "pixKeyType", "pixKey"]) assert.ok(clientProfileKeys.includes(key), key);
});

test("avalista escolhido na base: nome, CPF e telefone no formato do formulário; WhatsApp quando não há telefone", () => {
  assert.deepEqual(guarantorFromClient({ name: "Alexandre Severiano", document: "52998224725", phone: "11925192705", whatsapp: "11900000000" }),
    { guarantorName: "Alexandre Severiano", guarantorDocument: "529.982.247-25", guarantorPhone: "(11) 92519-2705" });
  assert.deepEqual(guarantorFromClient({ name: "Só WhatsApp", document: null, phone: null, whatsapp: "1133334444" }),
    { guarantorName: "Só WhatsApp", guarantorDocument: "", guarantorPhone: "(11) 3333-4444" });
  assert.deepEqual(guarantorFromClient({ name: "Sem contato", document: null, phone: "", whatsapp: null }),
    { guarantorName: "Sem contato", guarantorDocument: "", guarantorPhone: "" });
});

test("lista do avalista: vazio mostra todos em ordem alfabética, filtra por nome sem acento, CPF, telefone e e-mail, sem o próprio cliente", () => {
  const clients = [
    { id: "c1", name: "Pedro Alcântara", document: "52998224725", phone: "11968638522", whatsapp: null, email: "pedro@x.com" },
    { id: "c2", name: "Ana Souza", document: null, phone: null, whatsapp: "21999990000", email: null },
    { id: "c3", name: "Bruno Lima", document: "11144477735", phone: null, whatsapp: null, email: "bruno@lima.com" },
  ];
  const ids = (query, exclude) => filterGuarantorCandidates(clients, query, exclude).map((client) => client.id);
  assert.deepEqual(ids(""), ["c2", "c3", "c1"]);
  assert.deepEqual(ids("", "c3"), ["c2", "c1"]);
  assert.deepEqual(ids("pedro alcantara"), ["c1"]);
  assert.deepEqual(ids("PED"), ["c1"]);
  assert.deepEqual(ids("529.982"), ["c1"]);
  assert.deepEqual(ids("(21) 99999"), ["c2"]);
  assert.deepEqual(ids("bruno@"), ["c3"]);
  assert.deepEqual(ids("zzz"), []);
});
