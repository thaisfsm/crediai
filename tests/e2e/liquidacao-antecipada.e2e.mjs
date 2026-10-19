// Liquidação antecipada: valor negociado encerra a operação, grava UM pagamento (capital uma vez), guarda saldo e desconto,
// encerra as parcelas futuras e preserva o histórico; recusa repetição, sem confirmação, abaixo do principal, acima do saldo,
// edição do pagamento, outro tenant; envios simultâneos gravam uma só.
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

let robério, fernando, single, parcelado, othersBefore;

test("preparação: pagamento único de R$ 3.000 e parcelado 6 × R$ 600 (total R$ 3.600, com 1 parcela paga)", async () => {
  await admin(`update wallet set initial_capital_cents = 2000000 where tenant_id = 'ten_roberio'`);
  await admin(`insert into client(id, tenant_id, name) values ('c_e2e_lq', 'ten_roberio', 'Cliente Liquidação')`);
  robério = await login("roberio@teste.local");
  fernando = await login("fernando@teste.local");
  const s = await action(robério, "createOperationAction", { clientId: "c_e2e_lq", modality: "SINGLE", frequency: "MONTHLY", principal: "3.000,00", rate: "10", loanDate: TODAY, dueDate: "2027-12-01" });
  assert.equal(s?.ok, true, JSON.stringify(s));
  const p = await action(robério, "createOperationAction", { clientId: "c_e2e_lq", modality: "INSTALLMENT", loanAmount: "3.000,00", installment: "600,00", term: "6", loanDate: TODAY, firstDueDate: "2027-12-01" });
  assert.equal(p?.ok, true, JSON.stringify(p));
  [single, parcelado] = (await admin(`select id from loan_operation where client_id = 'c_e2e_lq' order by modality`)).map((row) => row.id).reverse();
  // order by modality: INSTALLMENT, SINGLE → reverse = [SINGLE, INSTALLMENT]
  assert.equal(await one(`select modality from loan_operation where id = '${single}'`), "SINGLE");
  const paid = await action(robério, "registerPaymentAction", { operationId: parcelado, amount: "600,00", paidAt: TODAY });
  assert.equal(paid?.ok, true, JSON.stringify(paid));
  othersBefore = await otherTenants();
});

test("LQ1. recusas: sem confirmação, abaixo do principal, acima do saldo, valor vazio, outro tenant, data futura; nada é gravado", async () => {
  const hash = await dataHash();
  assert.equal((await action(robério, "settleOperationEarlyAction", { operationId: single, amount: "3.300,00", confirm: "no" }))?.ok, false);
  const low = await action(robério, "settleOperationEarlyAction", { operationId: single, amount: "2.000,00", confirm: "yes" });
  assert.equal(low?.ok, false); assert.match(low.error, /principal/i);
  const lowP = await action(robério, "settleOperationEarlyAction", { operationId: parcelado, amount: "1.000,00", confirm: "yes" });
  assert.equal(lowP?.ok, false); assert.match(lowP.error, /principal/i);
  const high = await action(robério, "settleOperationEarlyAction", { operationId: single, amount: "9.000,00", confirm: "yes" });
  assert.equal(high?.ok, false); assert.match(high.error, /saldo/i);
  assert.equal((await action(robério, "settleOperationEarlyAction", { operationId: single, amount: "", confirm: "yes" }))?.ok, false);
  assert.equal((await action(robério, "settleOperationEarlyAction", { operationId: single, amount: "3.300,00", paidAt: "2999-01-01", confirm: "yes" }))?.ok, false);
  assert.equal((await action(fernando, "settleOperationEarlyAction", { operationId: single, amount: "3.300,00", confirm: "yes" }))?.ok, false, "outro tenant");
  assert.equal(await dataHash(), hash, "nenhuma recusa grava");
});

test("LQ2. liquidar o parcelado: R$ 2.600 sobre saldo de R$ 3.000 (3.600 − 600) → quitada, desconto, um pagamento, capital soma só o recebido", async () => {
  const capitalBefore = Number(await available());
  const balance = 300000;
  const result = await action(robério, "settleOperationEarlyAction", { operationId: parcelado, amount: "2.600,00", confirm: "yes", notes: "acordo" });
  assert.equal(result?.ok, true, JSON.stringify(result));
  const [op] = await admin(`select status, settled_at::text s, settlement_payment_id id, settlement_balance_cents::int bal, settlement_discount_cents::int disc from loan_operation where id = '${parcelado}'`);
  // saldo antes: 3.600 − 600 = 3.000; principal que ainda não voltou 2.500; paga 2.600 → desconto 400.
  assert.deepEqual([op.status, op.s, op.bal, op.disc], ["PAID", TODAY, balance, 40000]);
  assert.equal(await one(`select count(*)::int from payment where operation_id = '${parcelado}'`), 2, "o pagamento antigo + um da liquidação");
  assert.equal(await one(`select amount_cents::int from payment where id = '${op.id}'`), 260000);
  assert.equal(await one(`select amount_cents::int from payment where operation_id = '${parcelado}' and id <> '${op.id}'`), 60000, "pagamento anterior intacto");
  assert.equal(Number(await available()), capitalBefore + 260000, "o recebido entra uma vez");
  assert.equal(await one(`select count(*)::int from admin_audit_log where action = 'OPERATION_SETTLED_EARLY' and entity_id = '${parcelado}'`), 1);
  assert.equal(await otherTenants(), othersBefore, "o outro tenant não muda");
});

test("LQ3. liquidar de novo, pagar, editar pagamento e excluir ficam recusados", async () => {
  const hash = await dataHash();
  const again = await action(robério, "settleOperationEarlyAction", { operationId: parcelado, amount: "2.600,00", confirm: "yes" });
  assert.equal(again?.ok, false); assert.match(again.error, /não está em aberto/i);
  assert.equal((await action(robério, "registerPaymentAction", { operationId: parcelado, amount: "10,00", paidAt: TODAY }))?.ok, false);
  const settlementPayment = await one(`select settlement_payment_id from loan_operation where id = '${parcelado}'`);
  const edit = await action(robério, "editPaymentAction", { paymentId: settlementPayment, amount: "1.000,00", paidAt: TODAY });
  assert.equal(edit?.ok, false); assert.match(edit.error, /liquidada antecipadamente/i);
  assert.equal((await action(robério, "cancelOperationAction", { operationId: parcelado }))?.ok, false);
  assert.equal(await dataHash(), hash, "nada mudou");
  await assert.rejects(admin(`update loan_operation set status = 'OPEN' where id = '${parcelado}'`), /loan_operation_settlement_consistent/);
});

test("LQ4. duas liquidações simultâneas do pagamento único gravam uma só", async () => {
  const results = await Promise.all([1, 2, 3].map(() => action(robério, "settleOperationEarlyAction", { operationId: single, amount: "3.300,00", confirm: "yes" })));
  assert.equal(results.filter((r) => r?.ok).length, 1, JSON.stringify(results));
  assert.equal(await one(`select count(*)::int from payment where operation_id = '${single}'`), 1);
  const [op] = await admin(`select status, settlement_discount_cents::int disc, settlement_balance_cents::int bal from loan_operation where id = '${single}'`);
  assert.deepEqual([op.status, op.disc, op.bal], ["PAID", 0, 330000]);
});
