// Bateria de CPF e CNPJ da auditoria geral (14/10/2026). Só documentos fictícios, gerados aqui pelo próprio cálculo
// dos dígitos verificadores (módulo 11); nenhum documento de pessoa real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cnpjProblem, cpfCnpjProblem, cpfProblem, isValidCnpj, isValidCpf, normalizeCnpj, normalizeCpf, normalizeCpfCnpj } from "../src/lib/finance/format.ts";
import { bankFields, normalizePixKey } from "../src/lib/bank-account.ts";

// Gerador determinístico (sempre os mesmos documentos em toda execução).
let seed = 20261014;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const digit = (base, weights) => { const rest = weights.reduce((sum, weight, index) => sum + Number(base[index]) * weight, 0) % 11; return rest < 2 ? 0 : 11 - rest; };
function fakeCpf() {
  let base;
  do base = Array.from({ length: 9 }, () => Math.floor(random() * 10)).join(""); while (/^(\d)\1{8}$/.test(base));
  const first = digit(base, [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return base + first + digit(base + first, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
}
function fakeCnpj() {
  let base;
  do base = Array.from({ length: 12 }, () => Math.floor(random() * 10)).join(""); while (/^(\d)\1{11}$/.test(base));
  const first = digit(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return base + first + digit(base + first, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
}
const maskCpf = (d) => `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
const maskCnpj = (d) => `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
const cpfs = Array.from({ length: 300 }, fakeCpf);
const cnpjs = Array.from({ length: 300 }, fakeCnpj);

test("CPF1. 300 CPFs fictícios válidos: aceitos com e sem máscara e gravados só com dígitos", () => {
  for (const cpf of cpfs) {
    assert.equal(isValidCpf(cpf), true, cpf);
    assert.equal(cpfProblem(maskCpf(cpf)), null, cpf);
    assert.deepEqual(normalizeCpf(maskCpf(cpf)), { ok: true, value: cpf });
    assert.deepEqual(normalizeCpf(` ${cpf} `), { ok: true, value: cpf });
    assert.deepEqual(normalizeCpfCnpj(maskCpf(cpf)), { ok: true, value: cpf });
  }
});

test("CPF2. qualquer dígito verificador errado é recusado (9 trocas em cada um dos dois dígitos, 300 CPFs)", () => {
  let checked = 0;
  for (const cpf of cpfs) {
    for (const position of [9, 10]) {
      for (let change = 1; change <= 9; change += 1) {
        const wrong = cpf.slice(0, position) + ((Number(cpf[position]) + change) % 10) + cpf.slice(position + 1);
        assert.equal(isValidCpf(wrong), false, wrong);
        assert.match(cpfProblem(maskCpf(wrong)), /CPF inválido/);
        assert.equal(normalizeCpf(wrong).ok, false);
        assert.equal(normalizeCpfCnpj(wrong).ok, false);
        checked += 1;
      }
    }
  }
  assert.equal(checked, 300 * 2 * 9);
});

// Implementação de referência independente (fórmula "soma × 10 mod 11", resto 10 vira 0), para comparar com a do sistema.
function referenceCpf(value) {
  if (!/^\d{11}$/.test(value) || /^(\d)\1{10}$/.test(value)) return false;
  const n = [...value].map(Number);
  const dv = (length) => ((n.slice(0, length).reduce((sum, d, i) => sum + d * (length + 1 - i), 0) * 10) % 11) % 10;
  return dv(9) === n[9] && dv(10) === n[10];
}

test("CPF3. 20.000 sequências aleatórias de 11 dígitos: o sistema concorda com a implementação de referência", () => {
  let valid = 0;
  for (let i = 0; i < 20_000; i += 1) {
    const value = i % 2 ? Array.from({ length: 11 }, () => Math.floor(random() * 10)).join("") : cpfs[i % 300].slice(0, 9 + (i % 3)) + String(Math.floor(random() * 10 ** (2 - (i % 3)))).padStart(2 - (i % 3), "0").slice(0, 2 - (i % 3));
    assert.equal(isValidCpf(value), referenceCpf(value), value);
    if (referenceCpf(value)) valid += 1;
  }
  assert.ok(valid > 0, "a amostra precisa ter CPFs válidos e inválidos");
});

test("CPF4. sequências repetidas (000.000.000-00 a 999.999.999-99) são recusadas, mesmo passando na conta", () => {
  for (let d = 0; d <= 9; d += 1) {
    const repeated = String(d).repeat(11);
    assert.equal(isValidCpf(repeated), false, repeated);
    assert.match(cpfProblem(maskCpf(repeated)), /CPF inválido/);
    assert.equal(normalizeCpf(repeated).ok, false);
    const repeatedCnpj = String(d).repeat(14);
    assert.equal(isValidCnpj(repeatedCnpj), false, repeatedCnpj);
    assert.equal(normalizeCnpj(repeatedCnpj).ok, false);
  }
});

test("CPF5. tamanho errado (1 a 10 e 12 a 20 dígitos) é recusado com a mensagem de 11 dígitos", () => {
  for (let length = 1; length <= 20; length += 1) {
    if (length === 11) continue;
    const value = cpfs[0].repeat(2).slice(0, length);
    assert.equal(isValidCpf(value), false, value);
    assert.match(cpfProblem(value), /11 dígitos/);
    assert.equal(normalizeCpf(value).ok, false);
  }
});

test("CPF6. entrada malformada (letras, símbolos, dígitos de outros alfabetos) é recusada, não vira CPF vazio", () => {
  const valid = maskCpf(cpfs[0]);
  for (const bad of ["abc", "CPF", "não tenho", `${valid}x`, `x${cpfs[0]}`, `${cpfs[0]}abc`, "529,982,247,25", "５２９９８２２４７２５", "52998224725#", "1e10", "null", "undefined", "<script>"]) {
    assert.notEqual(cpfProblem(bad), null, `cpfProblem(${bad})`);
    assert.equal(normalizeCpf(bad).ok, false, `normalizeCpf(${bad})`);
    assert.equal(normalizeCpfCnpj(bad).ok, false, `normalizeCpfCnpj(${bad})`);
    assert.notEqual(cpfCnpjProblem(bad), null, `cpfCnpjProblem(${bad})`);
  }
  // Vazio continua sendo "sem CPF" (o CPF do cliente é opcional).
  for (const empty of ["", "   "]) assert.deepEqual(normalizeCpf(empty), { ok: true, value: null });
});

test("CNPJ1. 300 CNPJs fictícios válidos aceitos; dígito verificador errado e entrada malformada recusados", () => {
  for (const cnpj of cnpjs) {
    assert.equal(isValidCnpj(cnpj), true, cnpj);
    assert.deepEqual(normalizeCnpj(maskCnpj(cnpj)), { ok: true, value: cnpj });
    assert.deepEqual(normalizeCpfCnpj(maskCnpj(cnpj)), { ok: true, value: cnpj });
    for (const position of [12, 13]) {
      const wrong = cnpj.slice(0, position) + ((Number(cnpj[position]) + 1) % 10) + cnpj.slice(position + 1);
      assert.equal(isValidCnpj(wrong), false, wrong);
      assert.match(cnpjProblem(wrong), /CNPJ inválido/);
    }
  }
  for (const bad of ["abc", `${maskCnpj(cnpjs[0])}x`, "1122233300018", "112223330001811"]) {
    assert.notEqual(cnpjProblem(bad), null, bad);
    assert.equal(normalizeCnpj(bad).ok, false, bad);
  }
});

test("CPF7. dados bancários e Pix usam a mesma regra (titular, chave CPF/CNPJ)", () => {
  const form = (values) => (key, max) => String(values[key] ?? "").trim().slice(0, max);
  assert.equal(bankFields(form({ bankHolderDocument: maskCpf(cpfs[1]) })).ok, true);
  const wrong = cpfs[1].slice(0, 10) + ((Number(cpfs[1][10]) + 1) % 10);
  assert.equal(bankFields(form({ bankHolderDocument: wrong })).ok, false);
  assert.equal(bankFields(form({ bankHolderDocument: "abc" })).ok, false);
  assert.equal(normalizePixKey("CPF", maskCpf(cpfs[2])).ok, true);
  assert.equal(normalizePixKey("CPF", wrong).ok, false);
  assert.equal(normalizePixKey("CPF", "abc").ok, false);
  assert.equal(normalizePixKey("CNPJ", maskCnpj(cnpjs[2])).ok, true);
  assert.equal(normalizePixKey("CNPJ", "abc").ok, false);
});
