// Parcela renegociada para o final (modalidade 1): grava só a renegociação (original preservada, nova obrigação no fim), sem
// pagamento, sem lucro e sem mexer no capital; recusa sem confirmação, repetição, parcela paga, pagamento único, outro tenant;
// envios simultâneos gravam uma só; correção da operação fica bloqueada.
// SÓ em ambiente LOCAL e DESCARTÁVEL (ver tests/e2e/README.md). Usa os dados fictícios ten_roberio e ten_fernando.
import { after, test } from "node:test";
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

const TODAY = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
const dataHash = () => one(`select md5(string_agg(x, '|' order by x)) from (select 'o'||row(o.*)::text x from loan_operation o union all select 'p'||row(p.*)::text from payment p
  union all select 'm'||row(m.*)::text from capital_movement m union all select 'a'||row(a.*)::text from admin_audit_log a) t`);
const available = () => one(`select w.initial_capital_cents
  + coalesce((select sum(case when kind in ('CONTRIBUTION','OTHER_INCOME') then amount_cents else -amount_cents end) from capital_movement where tenant_id = 'ten_roberio' and cycle_number = w.cycle_number), 0)
  - coalesce((select sum(principal_cents) from loan_operation where tenant_id = 'ten_roberio' and status <> 'CANCELED' and cycle_number = w.cycle_number), 0)
  + coalesce((select sum(p.amount_cents) from payment p join loan_operation o on o.id = p.operation_id where p.tenant_id = 'ten_roberio' and o.cycle_number = w.cycle_number), 0)
  from wallet w where w.tenant_id = 'ten_roberio'`);
const otherTenants = () => one(`select md5(string_agg(x, '|' order by x)) from (select 'o'||row(o.*)::text x from loan_operation o where tenant_id <> 'ten_roberio' union all select 'p'||row(p.*)::text from payment p where tenant_id <> 'ten_roberio') t`);

let robério, fernando, op, single, othersBefore;

test("preparação: parcelado 9 × R$ 400 (R$ 3.600) com as 3 primeiras parcelas pagas e um pagamento único", async () => {
  await admin(`update wallet set initial_capital_cents = 2000000 where tenant_id = 'ten_roberio'`);
  await admin(`insert into client(id, tenant_id, name) values ('c_e2e_pr', 'ten_roberio', 'Cliente Parcela')`);
  robério = await login("roberio@teste.local");
  fernando = await login("fernando@teste.local");
  const created = await action(robério, "createOperationAction", { clientId: "c_e2e_pr", modality: "INSTALLMENT", loanAmount: "3.000,00", installment: "400,00", term: "9", loanDate: TODAY, firstDueDate: "2027-12-15" });
  assert.equal(created?.ok, true, JSON.stringify(created));
  const s = await action(robério, "createOperationAction", { clientId: "c_e2e_pr", modality: "SINGLE", frequency: "MONTHLY", principal: "1.000,00", rate: "10", loanDate: TODAY, dueDate: "2027-12-01" });
  assert.equal(s?.ok, true, JSON.stringify(s));
  op = await one(`select id from loan_operation where client_id = 'c_e2e_pr' and modality = 'INSTALLMENT'`);
  single = await one(`select id from loan_operation where client_id = 'c_e2e_pr' and modality = 'SINGLE'`);
  for (let i = 0; i < 3; i += 1) assert.equal((await action(robério, "registerPaymentAction", { operationId: op, amount: "400,00", paidAt: TODAY }))?.ok, true);
  othersBefore = await otherTenants();
});

test("DE1. recusas: sem confirmação, parcela paga, número inválido, acréscimo inválido, pagamento único, outro tenant; nada é gravado", async () => {
  const hash = await dataHash();
  assert.equal((await action(robério, "deferInstallmentAction", { operationId: op, number: "4", addition: "100,00", confirm: "no" }))?.ok, false);
  const paid = await action(robério, "deferInstallmentAction", { operationId: op, number: "2", addition: "100,00", confirm: "yes" });
  assert.equal(paid?.ok, false); assert.match(paid.error, /paga/i);
  assert.equal((await action(robério, "deferInstallmentAction", { operationId: op, number: "99", addition: "100,00", confirm: "yes" }))?.ok, false);
  assert.equal((await action(robério, "deferInstallmentAction", { operationId: op, number: "abc", addition: "100,00", confirm: "yes" }))?.ok, false);
  assert.equal((await action(robério, "deferInstallmentAction", { operationId: op, number: "4", addition: "-5,00", confirm: "yes" }))?.ok, false);
  assert.equal((await action(robério, "deferInstallmentAction", { operationId: op, number: "4", addition: "abc", confirm: "yes" }))?.ok, false);
  const sg = await action(robério, "deferInstallmentAction", { operationId: single, number: "1", addition: "0", confirm: "yes" });
  assert.equal(sg?.ok, false); assert.match(sg.error, /parcelados/i);
  assert.equal((await action(fernando, "deferInstallmentAction", { operationId: op, number: "4", addition: "100,00", confirm: "yes" }))?.ok, false, "outro tenant");
  assert.equal(await dataHash(), hash, "nenhuma recusa grava");
});

test("DE2. jogar a 4/9 para o final com R$ 100: só grava a renegociação; pagamentos, capital e totais gravados ficam iguais", async () => {
  const capital = await available();
  const payments = await one(`select count(*)::int from payment where operation_id = '${op}'`);
  const operationBefore = await one(`select md5(row(principal_cents, interest_cents, total_cents, installment_count, installment_cents, first_due_date, status)::text) from loan_operation where id = '${op}'`);
  const paymentsHash = await one(`select md5(string_agg(row(p.*)::text, '|' order by p.id)) from payment p where operation_id = '${op}'`);
  const result = await action(robério, "deferInstallmentAction", { operationId: op, number: "4", addition: "100,00", reason: "Cliente sem renda este mês", confirm: "yes" });
  assert.equal(result?.ok, true, JSON.stringify(result));
  const rows = await admin(`select original_number, original_due_date::text d, original_amount_cents::int o, addition_cents::int a, new_due_date::text nd, new_amount_cents::int n, reason from installment_deferral where operation_id = '${op}'`);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].original_number, rows[0].o, rows[0].a, rows[0].n, rows[0].reason], [4, 40_000, 10_000, 50_000, "Cliente sem renda este mês"]);
  assert.equal(rows[0].d, "2028-03-15");
  assert.equal(rows[0].nd, "2028-09-15", "um período depois do último vencimento (15/08/2028 + 1 mês)");
  assert.equal(await one(`select count(*)::int from payment where operation_id = '${op}'`), payments, "nenhum pagamento");
  assert.equal(await one(`select md5(string_agg(row(p.*)::text, '|' order by p.id)) from payment p where operation_id = '${op}'`), paymentsHash, "pagamentos intactos");
  assert.equal(await one(`select md5(row(principal_cents, interest_cents, total_cents, installment_count, installment_cents, first_due_date, status)::text) from loan_operation where id = '${op}'`), operationBefore, "contrato gravado intacto");
  assert.equal(await available(), capital, "capital não muda");
  assert.equal(await one(`select count(*)::int from admin_audit_log where action = 'OPERATION_INSTALLMENT_DEFERRED' and entity_id = '${op}'`), 1);
});

test("DE3. a parcela já renegociada e a obrigação criada não podem ser renegociadas de novo; envios simultâneos da 5/9 gravam uma só", async () => {
  const again = await action(robério, "deferInstallmentAction", { operationId: op, number: "4", addition: "0", confirm: "yes" });
  assert.equal(again?.ok, false); assert.match(again.error, /já foi renegociada/i);
  const results = await Promise.all([1, 2, 3].map(() => action(robério, "deferInstallmentAction", { operationId: op, number: "5", addition: "50,00", confirm: "yes" })));
  assert.equal(results.filter((item) => item?.ok).length, 1, JSON.stringify(results));
  assert.equal(await one(`select count(*)::int from installment_deferral where operation_id = '${op}'`), 2);
  assert.equal(await one(`select count(*)::int from installment_deferral where operation_id = '${op}' and original_number = 5`), 1);
});

test("DE4. correção da operação fica bloqueada com parcela renegociada; outros tenants continuam intactos", async () => {
  const preview = await action(robério, "previewOperationEditAction", { operationId: op, reason: "teste", modality: "INSTALLMENT", frequency: "MONTHLY", loanAmount: "3.000,00", installment: "400,00", term: "9", loanDate: TODAY, firstDueDate: "2027-12-15" });
  assert.equal(preview?.ok, false);
  assert.match(preview.error, /renegociada|bloqueada/i);
  assert.equal(await otherTenants(), othersBefore, "nada mudou em outro tenant");
  assert.equal(await one(`select count(*)::int from installment_deferral where tenant_id <> 'ten_roberio'`), 0);
});
