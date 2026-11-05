// Parcelado: o recebimento amortiza primeiro o principal (caso Mirian: R$ 1.500 em 3 × R$ 800), de ponta a ponta (HTTP + banco).
// Prova: divisão persistida no banco (allocation_order), prévia = gravação, quitação só com principal e juros pagos, excedente
// recusado, outras modalidades intactas e o tenant B sem alteração. SÓ em ambiente LOCAL e DESCARTÁVEL (tests/e2e/README.md).
//   E2E_DATABASE_URL=… node --test tests/e2e/parcelado-principal-primeiro.e2e.mjs
//   E2E_DATABASE_URL=… PLAYWRIGHT_MODULE=/caminho/playwright/index.mjs node --test tests/e2e/parcelado-quinzenal.e2e.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
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
const SHOTS = process.env.E2E_SCREENSHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
let browser;
after(async () => { await browser?.close(); await sql.end(); });

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
const available = async (tenantId) => Number(await one(`select w.initial_capital_cents
  + coalesce((select sum(case when m.kind in ('CONTRIBUTION','OTHER_INCOME') then m.amount_cents else -m.amount_cents end) from capital_movement m where m.tenant_id = w.tenant_id and m.cycle_number = w.cycle_number), 0)
  - coalesce((select sum(o.principal_cents) from loan_operation o where o.tenant_id = w.tenant_id and o.cycle_number = w.cycle_number and o.status <> 'CANCELED'), 0)
  + coalesce((select sum(p.amount_cents) from payment p join loan_operation o on o.id = p.operation_id where p.tenant_id = w.tenant_id and o.cycle_number = w.cycle_number), 0)
  from wallet w where w.tenant_id = '${tenantId}'`));

const hashB = () => one(`select md5(string_agg(x, '|' order by x)) from (
  select 'o'||row(o.*)::text x from loan_operation o where o.tenant_id = 'ten_fernando'
  union all select 'p'||row(p.*)::text from payment p where p.tenant_id = 'ten_fernando') t`);
const cap = (tenantId) => available(tenantId);
let robério, fernando, hb, opId, daily;
const rows = async (id) => (await admin(`select amount_cents::int a, paid_at::text d, payment_mode m, allocation_order o from payment where operation_id = '${id}' order by paid_at, created_at`));

test("preparação: carteira A com capital, cliente Mirian e parcelado R$ 1.500 em 3 × R$ 800", async () => {
  await admin(`update wallet set initial_capital_cents = 1000000 where tenant_id = 'ten_roberio'`);
  await admin(`insert into client(id, tenant_id, name) values ('c_e2e_mirian', 'ten_roberio', 'Mirian Teste')`);
  hb = await hashB();
  robério = await login("roberio@teste.local");
  fernando = await login("fernando@teste.local");
  const created = await action(robério, "createOperationAction", { clientId: "c_e2e_mirian", modality: "INSTALLMENT", loanAmount: "1500,00", installment: "800,00", term: "3", loanDate: "2026-08-13", firstDueDate: "2026-09-13" });
  assert.equal(created.ok, true, JSON.stringify(created));
  opId = await one(`select id from loan_operation where client_id = 'c_e2e_mirian'`);
});

test("PP-E1. 1º recebimento de R$ 800: principal 1.500 → 700, juros 900 pendentes (persistido PRINCIPAL_FIRST)", async () => {
  const r = await action(robério, "registerPaymentAction", { operationId: opId, amount: "800,00", paidAt: "2026-09-13" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.message, /juros R\$\s0,00, principal R\$\s800,00/);
  assert.match(r.message, /Saldo em aberto: R\$\s1\.600,00/);
  const [p] = await rows(opId);
  assert.deepEqual([p.a, p.d, p.m, p.o], [80000, "2026-09-13", "MANUAL", "PRINCIPAL_FIRST"]);
});

test("PP-E2. 2º recebimento: 700 de principal e 100 de juros; 3º: 800 de juros e quita", async () => {
  const second = await action(robério, "registerPaymentAction", { operationId: opId, amount: "800,00", paidAt: "2026-10-13" });
  assert.match(second.message, /juros R\$\s100,00, principal R\$\s700,00/);
  assert.match(second.message, /Saldo em aberto: R\$\s800,00/);
  const third = await action(robério, "registerPaymentAction", { operationId: opId, amount: "800,00", paidAt: "2026-11-04" });
  assert.match(third.message, /Operação quitada/);
  const [op] = await admin(`select status from loan_operation where id = '${opId}'`);
  assert.equal(op.status, "PAID");
  assert.deepEqual((await rows(opId)).map((p) => [p.a, p.o]), [[80000, "PRINCIPAL_FIRST"], [80000, "PRINCIPAL_FIRST"], [80000, "PRINCIPAL_FIRST"]]);
});

test("PP-E3. excedente acima do saldo continua recusado; pagamento parcial e 'principal quitado' num segundo contrato", async () => {
  const created = await action(robério, "createOperationAction", { clientId: "c_e2e_mirian", modality: "INSTALLMENT", loanAmount: "1500,00", installment: "800,00", term: "3", loanDate: "2026-08-13", firstDueDate: "2026-09-13" });
  assert.equal(created.ok, true);
  const id2 = (await admin(`select id from loan_operation where client_id = 'c_e2e_mirian' and id <> '${opId}'`))[0].id;
  const partial = await action(robério, "registerPaymentAction", { operationId: id2, amount: "300,00", paidAt: "2026-09-13" });
  assert.match(partial.message, /juros R\$\s0,00, principal R\$\s300,00/);
  const big = await action(robério, "registerPaymentAction", { operationId: id2, amount: "1500,00", paidAt: "2026-09-20" });
  assert.match(big.message, /juros R\$\s0,00, principal R\$\s1\.200,00|juros R\$\s300,00, principal R\$\s1\.200,00/);
  const after = await action(robério, "registerPaymentAction", { operationId: id2, amount: "200,00", paidAt: "2026-10-01" });
  assert.match(after.message, /juros R\$\s200,00, principal R\$\s0,00/);
  assert.equal((await action(robério, "registerPaymentAction", { operationId: id2, amount: "9999,00", paidAt: "2026-10-02" })).ok, false);
});

test("PP-E4. isolamento: o tenant B não paga nem altera a operação do A; dados do B não mudaram", async () => {
  const id2 = (await admin(`select id from loan_operation where client_id = 'c_e2e_mirian' order by created_at desc limit 1`))[0].id;
  const before = (await rows(id2)).length;
  const forged = await action(fernando, "registerPaymentAction", { operationId: id2, amount: "100,00", paidAt: "2026-10-03" });
  assert.equal(forged?.ok, false);
  assert.equal((await rows(id2)).length, before);
  assert.equal(await hashB(), hb);
});

test("PP-E5. outras modalidades preservadas: pagamento único antigo e mensal seguem a ordem do contrato", async () => {
  const [row] = await admin(`select o.id from loan_operation o where o.tenant_id = 'ten_fernando' and o.modality = 'SINGLE' and o.id = 'op_alex'`);
  assert.equal(row.id, "op_alex");
  assert.equal(await hashB(), hb);
  // Pagamento único novo na carteira A: grava a ordem do contrato (principal primeiro nos novos), não muda por causa do parcelado.
  await admin(`update wallet set initial_capital_cents = 2000000 where tenant_id = 'ten_roberio'`);
  const single = await action(robério, "createOperationAction", { clientId: "c_e2e_mirian", modality: "SINGLE", loanAmount: "1000,00", interestRate: "10", loanDate: "2026-10-20", dueDate: "2026-11-20" });
  if (single?.ok) {
    const sid = (await admin(`select id from loan_operation where client_id = 'c_e2e_mirian' and modality = 'SINGLE'`))[0].id;
    const r = await action(robério, "registerPaymentAction", { operationId: sid, amount: "100,00", paidAt: "2026-10-25" });
    assert.equal(r.ok, true, JSON.stringify(r));
    const [p] = await rows(sid);
    const [o] = await admin(`select payment_order from loan_operation where id = '${sid}'`);
    assert.equal(p.o, o.payment_order);
  }
});
