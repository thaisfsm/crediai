// Auditoria geral (14/10/2026): CPF e CNPJ enviados DIRETO às server actions, sem passar pela tela (sem máscara, sem o
// aviso do navegador). Cadastro e edição de cliente, CPF do avalista, CNPJ da empresa, titular da conta, chave Pix e
// investidor. Só documentos fictícios gerados pelo cálculo dos dígitos verificadores.
// SÓ em ambiente LOCAL e DESCARTÁVEL (ver tests/e2e/README.md). Usa os dados fictícios ten_roberio (A) e ten_fernando (B).
//   E2E_DATABASE_URL=… node --test tests/e2e/cpf-auditoria.e2e.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import postgres from "postgres";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Teste destrutivo: só roda em localhost.");
const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl || !/@(localhost|127\.0\.0\.1)[:/]/.test(databaseUrl)) throw new Error("E2E_DATABASE_URL precisa apontar para um banco local.");
const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
const admin = async (query) => sql.begin(async (tx) => { await tx`select set_config('app.crediai_role', 'SUPER_ADMIN', true)`; return tx.unsafe(query); });
const one = async (query) => Object.values((await admin(query))[0] ?? {})[0];
const manifest = JSON.parse(readFileSync(".next/server/server-reference-manifest.json", "utf8")).node;
const actionId = (name) => Object.entries(manifest).find(([, value]) => value.exportedName === name)?.[0] ?? assert.fail(`ação ${name} não encontrada no build`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
after(async () => { await sql.end(); });

let lastLogin = 0;
async function login(email) {
  const wait = 11_000 - (Date.now() - lastLogin);
  if (wait > 0) await sleep(wait);
  lastLogin = Date.now();
  const response = await fetch(`${BASE}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email, password: process.env.E2E_PASSWORD ?? "Senha-Teste-Local-123" }) });
  assert.equal(response.status, 200, `login de ${email}`);
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}
async function action(cookie, name, fields, path = "/") {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(`_1_${key}`, value);
  form.append("0", '["$K1"]');
  const response = await fetch(`${BASE}${path}`, { method: "POST", headers: { cookie, "next-action": actionId(name), accept: "text/x-component", origin: BASE }, body: form });
  const result = (await response.text()).match(/^1:(\{.*\})$/m)?.[1];
  return result ? JSON.parse(result) : null;
}

// CPFs e CNPJs fictícios, calculados aqui.
const dv = (base, weights) => { const rest = weights.reduce((sum, weight, index) => sum + Number(base[index]) * weight, 0) % 11; return rest < 2 ? 0 : 11 - rest; };
const cpfFrom = (base) => { const first = dv(base, [10, 9, 8, 7, 6, 5, 4, 3, 2]); return base + first + dv(base + first, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]); };
const cnpjFrom = (base) => { const first = dv(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); return base + first + dv(base + first, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); };
const mask = (d) => `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
const wrongLast = (d) => d.slice(0, -1) + ((Number(d.at(-1)) + 1) % 10);
const CPF_OK = cpfFrom("731845209"), CPF_OK2 = cpfFrom("604918372"), CPF_OK3 = cpfFrom("285017364"), CNPJ_OK = cnpjFrom("483920170001");
const INVALID_CPFS = [
  wrongLast(CPF_OK), mask(wrongLast(CPF_OK)), CPF_OK.slice(0, 9) + String((Number(CPF_OK[9]) + 1) % 10) + CPF_OK[10],
  "00000000000", "111.111.111-11", "99999999999", "1234567890", "123456789012", CPF_OK.slice(0, 10),
  "abc", "CPF", `${CPF_OK}x`, `${mask(CPF_OK)}abc`, "５２９９８２２４７２５", "529,982,247,25", "<script>alert(1)</script>",
];
const count = (where) => one(`select count(*)::int from client where ${where}`);
let robério, fernando, before;
const financialHash = () => one(`select md5(string_agg(x, '|' order by x)) from (select row(o.*)::text x from loan_operation o union all select row(p.*)::text from payment p union all select row(m.*)::text from capital_movement m union all select row(w.*)::text from wallet w) t`);

test("preparação: login dos dois tenants", async () => {
  before = { clients: await count("true"), investors: await one("select count(*)::int from investor"), financial: await financialHash() };
  robério = await login("roberio@teste.local");
  fernando = await login("fernando@teste.local");
});

test("CPF-API1. cadastro de cliente: cada CPF inválido ou malformado é recusado pelo servidor e nada é gravado", async () => {
  for (const [index, document] of INVALID_CPFS.entries()) {
    const result = await action(robério, "createClientAction", { name: `CPF Ruim ${index}`, document });
    assert.equal(result?.ok, false, `${document} → ${JSON.stringify(result)}`);
    assert.match(result.error, /CPF/, document);
  }
  assert.equal(await count("name like 'CPF Ruim %'"), 0);
});

test("CPF-API2. cadastro com CPF válido grava só os dígitos; mesmo CPF de novo (com ou sem máscara) é recusado", async () => {
  const ok = await action(robério, "createClientAction", { name: "Cliente CPF Auditoria", document: mask(CPF_OK) });
  assert.equal(ok?.ok, true, JSON.stringify(ok));
  assert.equal(await one(`select document from client where name = 'Cliente CPF Auditoria'`), CPF_OK);
  for (const again of [CPF_OK, mask(CPF_OK), ` ${mask(CPF_OK)} `]) {
    const duplicate = await action(robério, "createClientAction", { name: "Cliente CPF Repetido", document: again });
    assert.equal(duplicate?.ok, false);
    assert.match(duplicate.error, /Já existe um cliente com o CPF/);
  }
  assert.equal(await count("name = 'Cliente CPF Repetido'"), 0);
  // Outra carteira pode ter o mesmo CPF.
  assert.equal((await action(fernando, "createClientAction", { name: "Cliente CPF Auditoria B", document: CPF_OK }))?.ok, true);
});

test("CPF-API3. edição: CPF inválido ou malformado recusado e o cadastro fica como estava", async () => {
  const client = (await admin(`select id, document, updated_at from client where name = 'Cliente CPF Auditoria'`))[0];
  for (const document of INVALID_CPFS) {
    const result = await action(robério, "updateClientAction", { clientId: client.id, name: "Cliente CPF Editado", document });
    assert.equal(result?.ok, false, `${document} → ${JSON.stringify(result)}`);
  }
  const after = (await admin(`select name, document, updated_at from client where id = '${client.id}'`))[0];
  assert.equal(after.name, "Cliente CPF Auditoria");
  assert.equal(after.document, CPF_OK);
  assert.equal(String(after.updated_at), String(client.updated_at));
  // Válido passa e troca o CPF.
  assert.equal((await action(robério, "updateClientAction", { clientId: client.id, name: "Cliente CPF Auditoria", document: CPF_OK2 }))?.ok, true);
  assert.equal(await one(`select document from client where id = '${client.id}'`), CPF_OK2);
});

test("CPF-API4. avalista, empresa, titular da conta e chave Pix com documento inválido são recusados no servidor", async () => {
  const cases = [
    [{ guarantorDocument: wrongLast(CPF_OK3) }, /avalista/],
    [{ guarantorDocument: "abc" }, /avalista/],
    [{ businessCnpj: wrongLast(CNPJ_OK) }, /CNPJ/],
    [{ businessCnpj: "abc" }, /CNPJ/],
    [{ bankHolderDocument: wrongLast(CPF_OK3) }, /titular/],
    [{ bankHolderDocument: "abc" }, /titular/],
    [{ pixKeyType: "CPF", pixKey: wrongLast(CPF_OK3) }, /Pix/],
    [{ pixKeyType: "CPF", pixKey: "abc" }, /Pix/],
    [{ pixKeyType: "CNPJ", pixKey: wrongLast(CNPJ_OK) }, /Pix/],
  ];
  for (const [index, [fields, message]] of cases.entries()) {
    const result = await action(robério, "createClientAction", { name: `Ficha Ruim ${index}`, document: CPF_OK3, ...fields });
    assert.equal(result?.ok, false, `${JSON.stringify(fields)} → ${JSON.stringify(result)}`);
    assert.match(result.error, message);
  }
  assert.equal(await count("name like 'Ficha Ruim %'"), 0);
  const full = await action(robério, "createClientAction", { name: "Ficha Boa", document: CPF_OK3, guarantorDocument: mask(CPF_OK), businessCnpj: CNPJ_OK, bankHolderDocument: CPF_OK3, pixKeyType: "CPF", pixKey: mask(CPF_OK3) });
  assert.equal(full?.ok, true, JSON.stringify(full));
  const row = (await admin(`select guarantor_document, business_cnpj, bank_holder_document, pix_key from client where name = 'Ficha Boa'`))[0];
  assert.deepEqual(row, { guarantor_document: CPF_OK, business_cnpj: CNPJ_OK, bank_holder_document: CPF_OK3, pix_key: CPF_OK3 });
});

test("CPF-API5. investidor: CPF/CNPJ inválido ou malformado recusado no servidor", async () => {
  for (const [index, document] of [wrongLast(CPF_OK), wrongLast(CNPJ_OK), "abc", "11111111111", "1234"].entries()) {
    const result = await action(robério, "createInvestorAction", { name: `Investidor Ruim ${index}`, document }, "/investidores");
    assert.equal(result?.ok, false, `${document} → ${JSON.stringify(result)}`);
  }
  assert.equal(await one("select count(*)::int from investor where name like 'Investidor Ruim %'"), 0);
  assert.equal((await action(robério, "createInvestorAction", { name: "Investidor CPF Bom", document: mask(CPF_OK) }, "/investidores"))?.ok, true);
});

test("CPF-API6. nada financeiro mudou e só os cadastros válidos foram gravados", async () => {
  assert.equal(await financialHash(), before.financial);
  assert.equal(await count("true"), before.clients + 3);
  assert.equal(await one("select count(*)::int from investor"), before.investors + 1);
});
