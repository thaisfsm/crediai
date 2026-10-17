// Taxa de juros com 3 casas decimais (ex.: 14,995%) de ponta a ponta (HTTP + banco): cadastro, valor gravado, juros
// calculados, recusa de 4 casas e operações antigas intactas.
// SÓ em ambiente LOCAL e DESCARTÁVEL (ver tests/e2e/README.md). Usa o tenant fictício ten_roberio (A).
//   E2E_DATABASE_URL=… node --test tests/e2e/taxa-tres-casas.e2e.mjs
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
const manifest = JSON.parse(readFileSync(".next/server/server-reference-manifest.json", "utf8")).node;
const actionId = (name) => Object.entries(manifest).find(([, value]) => value.exportedName === name)?.[0] ?? assert.fail(`ação ${name} não encontrada no build`);
after(async () => { await sql.end(); });

async function login(email) {
  const response = await fetch(`${BASE}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email, password: process.env.E2E_PASSWORD ?? "Senha-Teste-Local-123" }) });
  assert.equal(response.status, 200, `login de ${email}`);
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}
async function action(cookie, name, fields) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(`_1_${key}`, value);
  form.append("0", '["$K1"]');
  const response = await fetch(`${BASE}/`, { method: "POST", headers: { cookie, "next-action": actionId(name), accept: "text/x-component", origin: BASE }, body: form });
  const result = (await response.text()).match(/^1:(\{.*\})$/m)?.[1];
  return result ? JSON.parse(result) : null;
}
const base = { clientId: "c_e2e_taxa", principal: "7.334,75", loanDate: "2026-10-15", dueDate: "2026-11-15" };
let cookie;

test("preparação: carteira A com capital e cliente", async () => {
  await admin(`update wallet set initial_capital_cents = 5000000 where tenant_id = 'ten_roberio'`);
  await admin(`insert into client(id, tenant_id, name) values ('c_e2e_taxa', 'ten_roberio', 'Cliente Taxa')`);
  cookie = await login("roberio@teste.local");
});

test("TX2. 14,995% ao mês: gravado com a 3ª casa e juros calculados sobre ela", async () => {
  const result = await action(cookie, "createOperationAction", { ...base, rate: "14,995" });
  assert.equal(result?.ok, true, JSON.stringify(result));
  const [op] = await admin(`select interest_rate_bps::text as rate, interest_cents, total_cents from loan_operation where client_id = 'c_e2e_taxa'`);
  assert.equal(op.rate, "1499.5");
  assert.equal(Number(op.interest_cents), 109_985);
  assert.equal(Number(op.total_cents), 843_460);
});

test("TX3. taxas com 1 ou 2 casas continuam iguais e 4 casas são recusadas", async () => {
  for (const [rate, bps] of [["5", "500.0"], ["1,5", "150.0"], ["0,25", "25.0"]]) {
    const result = await action(cookie, "createOperationAction", { ...base, principal: "1.000,00", rate });
    assert.equal(result?.ok, true, `${rate}: ${JSON.stringify(result)}`);
    assert.equal((await admin(`select interest_rate_bps::text as rate from loan_operation where client_id = 'c_e2e_taxa' order by created_at desc limit 1`))[0].rate, bps);
  }
  const before = (await admin(`select count(*)::int as n from loan_operation where client_id = 'c_e2e_taxa'`))[0].n;
  const refused = await action(cookie, "createOperationAction", { ...base, rate: "14,9955" });
  assert.equal(refused?.ok, false);
  assert.match(refused.error, /taxa de juros/i);
  assert.equal((await admin(`select count(*)::int as n from loan_operation where client_id = 'c_e2e_taxa'`))[0].n, before, "nada é gravado");
});
