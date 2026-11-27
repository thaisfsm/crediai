// Controle CPG (Comissão Paga por recebimento de juros) de ponta a ponta: servidor + banco + PDF + telas.
// SÓ em ambiente LOCAL e DESCARTÁVEL (ver tests/e2e/README.md). Os contratos de teste têm os MESMOS valores, datas e pagamentos dos
// contratos do fechamento de 19/11/2026 (Aline 300,00 de juros, Bruna 450,00, Thaina 111,75; 50%), com nomes de teste.
//   E2E_DATABASE_URL=… PLAYWRIGHT_MODULE=… node --test tests/e2e/cpg-comissao-paga.e2e.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import postgres from "postgres";
import { pdfText } from "../helpers/pdf-text.mjs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Teste destrutivo: só roda em localhost.");
const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl || !/@(localhost|127\.0\.0\.1)[:/]/.test(databaseUrl)) throw new Error("E2E_DATABASE_URL precisa apontar para um banco local.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const sql = postgres(databaseUrl, { max: 2, onnotice: () => {} });
const admin = async (query) => sql.begin(async (tx) => { await tx`select set_config('app.crediai_role', 'SUPER_ADMIN', true)`; return tx.unsafe(query); });
const one = async (query) => { const value = Object.values((await admin(query))[0] ?? {})[0]; return typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : value; };
const manifest = JSON.parse(readFileSync(".next/server/server-reference-manifest.json", "utf8")).node;
const actionId = (name) => Object.entries(manifest).find(([, value]) => value.exportedName === name)?.[0] ?? assert.fail(`ação ${name} não encontrada no build`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SHOTS = process.env.E2E_SCREENSHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
after(async () => { await browser.close(); await sql.end(); });

const PASSWORD = process.env.E2E_PASSWORD ?? "Senha-Teste-Local-123";
// Dados financeiros reais do tenant (contratos, pagamentos, renovações, carteira, caixa): o controle CPG nunca os altera.
const financeHash = (tenant, skipPayments = "''") => one(`select md5(string_agg(x, '|' order by x)) from (
  select 'o'||row(o.*)::text x from loan_operation o where tenant_id = '${tenant}' union all select 'p'||row(p.*)::text from payment p where tenant_id = '${tenant}' and id not in (${skipPayments})
  union all select 'r'||row(r.*)::text from loan_renewal r where tenant_id = '${tenant}' and payment_id not in (${skipPayments})
  union all select 'w'||row(w.*)::text from wallet w where tenant_id = '${tenant}' union all select 'm'||row(m.*)::text from capital_movement m where tenant_id = '${tenant}'
  union all select 'c'||row(c.*)::text from client c where tenant_id = '${tenant}') t`);

let lastLogin = 0;
async function throttle() { const wait = 11_000 - (Date.now() - lastLogin); if (wait > 0) await sleep(wait); lastLogin = Date.now(); }
async function signIn(email, viewport = { width: 1440, height: 900 }) {
  await throttle();
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(PASSWORD);
  await page.getByRole("button", { name: /Entrar/ }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20_000 });
  return page;
}
async function apiLogin(email) {
  await throttle();
  const response = await fetch(`${BASE}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email, password: PASSWORD }) });
  assert.equal(response.status, 200, `login de ${email}`);
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}
async function action(cookie, name, fields, path = "/gerentes") {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) for (const item of [value].flat()) form.append(`_1_${key}`, item);
  form.append("0", '["$K1"]');
  const response = await fetch(`${BASE}${path}`, { method: "POST", redirect: "manual", headers: { cookie, "next-action": actionId(name), accept: "text/x-component", origin: BASE }, body: form });
  const result = (await response.text()).match(/^1:(\{.*\})$/m)?.[1];
  return { status: response.status, result: result ? JSON.parse(result) : null };
}
const get = (cookie, path) => fetch(`${BASE}${path}`, { redirect: "manual", headers: { cookie } });
const pdfOf = async (cookie, path) => {
  const response = await get(cookie, path);
  const type = response.headers.get("content-type") ?? "";
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { status: response.status, type, text: type.includes("pdf") ? pdfText(bytes).replace(/ /g, " ") : "" };
};

const G = "mgr_cpg_g", F = "mgr_cpg_f", OLD = "mgp_cpg_1911";
const RULE = "RATE_PER_OPERATION_SINGLE_PAYMENT_V1";
let owner, fernando, master, payoutRow, robHash, fernandoHash;
const cpgNet = (payment) => one(`select coalesce(sum(case when kind='PAID' then commission_cents else -commission_cents end),0)::int from account_manager_commission_paid where payment_id='${payment}'`);

test("preparação: gerente com 4 contratos (valores do caso real), fechamento ANTIGO de R$ 430,88 sem composição e gerente de outra carteira", async () => {
  await admin(`insert into account_manager(id, tenant_id, name, commission_bps) values ('${G}','ten_roberio','Gerente CPG',4500), ('${F}','ten_fernando','Gerente do Fernando',5000)`);
  await admin(`insert into client(id, tenant_id, name, account_manager_id, account_manager_bps) values
    ('c_cpg_aline','ten_roberio','Aline Teste CPG','${G}',5000), ('c_cpg_bruna','ten_roberio','Bruna Teste CPG','${G}',5000),
    ('c_cpg_thaina','ten_roberio','Thaina Teste CPG','${G}',5000), ('c_cpg_sabrina','ten_roberio','Sabrina Teste CPG','${G}',5000),
    ('c_cpg_fer','ten_fernando','Cliente do Fernando CPG','${F}',5000)`);
  await admin(`insert into loan_operation(id,tenant_id,client_id,principal_cents,interest_rate_bps,interest_cents,total_cents,loan_date,due_date,first_due_date,calculation_rule,status,settled_at,modality,payment_order) values
    ('op_cpg_aline','ten_roberio','c_cpg_aline',100000,3000,30000,130000,'2026-10-13','2026-12-13','2026-11-13','${RULE}','OPEN',null,'SINGLE','INTEREST_FIRST'),
    ('op_cpg_bruna','ten_roberio','c_cpg_bruna',150000,3000,45000,195000,'2026-10-09','2026-11-09','2026-11-09','${RULE}','PAID','2026-11-09','SINGLE','INTEREST_FIRST'),
    ('op_cpg_thaina','ten_roberio','c_cpg_thaina',50000,1500,7500,57500,'2026-10-13','2026-11-13','2026-11-13','${RULE}','PAID','2026-11-16','SINGLE','INTEREST_FIRST'),
    ('op_cpg_sabrina','ten_roberio','c_cpg_sabrina',50000,3000,15000,65000,'2026-10-13','2026-11-13','2026-11-13','${RULE}','PAID','2026-11-10','SINGLE','INTEREST_FIRST'),
    ('op_cpg_fer','ten_fernando','c_cpg_fer',100000,3000,30000,130000,'2026-10-13','2026-11-13','2026-11-13','${RULE}','PAID','2026-11-13','SINGLE','INTEREST_FIRST')`);
  await admin(`insert into payment(id,tenant_id,operation_id,amount_cents,paid_at,payment_mode,allocation_order,interest_period_number,created_at) values
    ('pay_cpg_aline','ten_roberio','op_cpg_aline',30000,'2026-11-14','INTEREST_ONLY_RENEWAL','INTEREST_FIRST',1,'2026-11-14 15:18:38+00'),
    ('pay_cpg_bruna','ten_roberio','op_cpg_bruna',195000,'2026-11-09','FULL_SETTLEMENT','INTEREST_FIRST',null,'2026-11-09 13:48:57+00'),
    ('pay_cpg_thaina1','ten_roberio','op_cpg_thaina',33000,'2026-10-21',null,null,null,'2026-10-21 16:00:51+00'),
    ('pay_cpg_thaina2','ten_roberio','op_cpg_thaina',28175,'2026-11-16','FULL_SETTLEMENT','INTEREST_FIRST',null,'2026-11-16 22:19:57+00'),
    ('pay_cpg_sabrina','ten_roberio','op_cpg_sabrina',65000,'2026-11-10','FULL_SETTLEMENT','INTEREST_FIRST',null,'2026-11-10 21:50:42+00'),
    ('pay_cpg_fer','ten_fernando','op_cpg_fer',130000,'2026-11-13','FULL_SETTLEMENT','INTEREST_FIRST',null,'2026-11-13 12:00:00+00')`);
  await admin(`insert into loan_renewal(id,tenant_id,operation_id,payment_id,period_number,previous_due_date,new_due_date,principal_base_cents,interest_cents,created_by_user_id) values
    ('ren_cpg_aline','ten_roberio','op_cpg_aline','pay_cpg_aline',2,'2026-11-13','2026-12-13',100000,30000,'u_roberio')`);
  // Fechamento de 19/11 registrado ANTES do controle por contrato: só o valor (como o da produção).
  await admin(`insert into account_manager_payout(id,tenant_id,manager_id,amount_cents,paid_on,created_at) values ('${OLD}','ten_roberio','${G}',43088,'2026-11-19','2026-11-20 01:03:24+00')`);
  payoutRow = await one(`select row(p.*)::text from account_manager_payout p where id='${OLD}'`);
  robHash = await financeHash("ten_roberio");
  fernandoHash = await financeHash("ten_fernando");
  owner = await apiLogin("roberio@teste.local");
});

test("C1. sem composição registrada: o PDF mostra R$ 430,88 numa linha só (sem rateio entre contratos, sem R$ 30,62)", async () => {
  const pdf = await pdfOf(owner, `/gerentes/fechamentos/${OLD}`);
  assert.equal(pdf.status, 200);
  for (const piece of ["Composição não registrada", "R$ 430,88", "0 contratos Total"]) assert.ok(pdf.text.includes(piece), `PDF sem "${piece}"\n${pdf.text}`);
  for (const piece of ["Aline Teste CPG", "R$ 30,62", "Sabrina Teste CPG"]) assert.ok(!pdf.text.includes(piece), `PDF com "${piece}"`);
});

test("C2. composição histórica: só o MASTER registra; dono da carteira e outra carteira não conseguem", async () => {
  const entries = "pay_cpg_aline:15000,pay_cpg_bruna:22500,pay_cpg_thaina1:3750,pay_cpg_thaina2:1838";
  const byOwner = await action(owner, "adminRecordHistoricalCompositionAction", { tenantId: "ten_roberio", payoutId: OLD, entries, reason: "x" }, "/admin/clientes/ten_roberio");
  assert.notEqual(byOwner.result?.ok, true, "TENANT_USER não registra composição histórica");
  fernando = await apiLogin("fernando@teste.local");
  const byFernando = await action(fernando, "adminRecordHistoricalCompositionAction", { tenantId: "ten_roberio", payoutId: OLD, entries, reason: "x" }, "/admin/clientes/ten_roberio");
  assert.notEqual(byFernando.result?.ok, true);
  assert.equal(await one(`select count(*) from account_manager_commission_paid where payout_id='${OLD}'`), 0);
  master = await apiLogin("thais@teste.local");
  // Recusas sem gravar: soma diferente, recebimento de outra carteira, sem motivo.
  for (const [fields, message] of [
    [{ entries: "pay_cpg_aline:15000,pay_cpg_bruna:22500", reason: "conferido" }, /soma/],
    [{ entries: "pay_cpg_aline:15000,pay_cpg_bruna:22500,pay_cpg_fer:5588", reason: "conferido" }, /não é de um contrato deste gerente/],
    [{ entries, reason: "" }, /motivo/],
    [{ entries: "pay_cpg_aline:15001,pay_cpg_bruna:22500,pay_cpg_thaina1:3750,pay_cpg_thaina2:1837", reason: "conferido" }, /passa da comissão pendente/],
  ]) {
    const refused = await action(master, "adminRecordHistoricalCompositionAction", { tenantId: "ten_roberio", payoutId: OLD, ...fields }, "/admin/clientes/ten_roberio");
    assert.equal(refused.result?.ok, false);
    assert.match(refused.result.error, message);
  }
  assert.equal(await one(`select count(*) from account_manager_commission_paid where payout_id='${OLD}'`), 0);
  const ok = await action(master, "adminRecordHistoricalCompositionAction", { tenantId: "ten_roberio", payoutId: OLD, entries, reason: "Composição confirmada pela responsável em 27/11/2026" }, "/admin/clientes/ten_roberio");
  assert.equal(ok.result?.ok, true, JSON.stringify(ok.result));
  const rows = await admin(`select operation_id, payment_id, interest_cents::int i, commission_bps b, commission_due_cents::int d, commission_cents::int v, source from account_manager_commission_paid where payout_id='${OLD}' order by receipt_paid_on`);
  assert.deepEqual(rows.map((row) => [row.payment_id, row.i, row.b, row.d, row.v, row.source]), [
    ["pay_cpg_thaina1", 7500, 5000, 3750, 3750, "HISTORICAL"], ["pay_cpg_bruna", 45000, 5000, 22500, 22500, "HISTORICAL"],
    ["pay_cpg_aline", 30000, 5000, 15000, 15000, "HISTORICAL"], ["pay_cpg_thaina2", 3675, 5000, 1838, 1838, "HISTORICAL"],
  ]);
  const byContract = await admin(`select operation_id, sum(commission_cents)::int v from account_manager_commission_paid where payout_id='${OLD}' group by 1 order by 1`);
  assert.deepEqual(byContract.map((row) => [row.operation_id, row.v]), [["op_cpg_aline", 15000], ["op_cpg_bruna", 22500], ["op_cpg_thaina", 5588]]);
  assert.equal(await one(`select sum(commission_cents)::int from account_manager_commission_paid where payout_id='${OLD}'`), 43088);
  assert.equal(await one(`select row(p.*)::text from account_manager_payout p where id='${OLD}'`), payoutRow, "fechamento original intacto (R$ 430,88, data, lançamentos)");
  assert.equal(await one(`select count(*) from account_manager_payout`), 1, "nenhum segundo pagamento criado");
  assert.equal(await one(`select count(*) from admin_audit_log where action='MANAGER_COMMISSION_COMPOSITION_RECORDED' and entity_id='${OLD}' and tenant_id='ten_roberio'`), 1, "trilha de auditoria");
  // Uma vez só: pela regra e pelo banco.
  const again = await action(master, "adminRecordHistoricalCompositionAction", { tenantId: "ten_roberio", payoutId: OLD, entries: "pay_cpg_sabrina:7500", reason: "de novo" }, "/admin/clientes/ten_roberio");
  assert.equal(again.result?.ok, false);
  await assert.rejects(admin(`insert into account_manager_commission_paid(id,tenant_id,manager_id,payout_id,kind,operation_id,payment_id,client_name,principal_cents,interest_rate_bps,commission_bps,receipt_paid_on,interest_cents,commission_due_cents,commission_cents,source,reason)
    values ('cpg_x','ten_roberio','${G}','${OLD}','PAID','op_cpg_sabrina','pay_cpg_sabrina','Sabrina',50000,3000,5000,'2026-11-10',15000,7500,7500,'HISTORICAL','burla')`), /uma vez só|não somam/);
  assert.equal(await financeHash("ten_roberio"), robHash, "contratos, pagamentos, carteira e caixa intactos");
});

test("C2b. PDF e tela do fechamento de 19/11: Aline 150,00, Bruna 225,00, Thaina 55,88 = R$ 430,88", async () => {
  const pdf = await pdfOf(owner, `/gerentes/fechamentos/${OLD}`);
  for (const piece of ["Aline Teste CPG", "R$ 1.000,00", "R$ 300,00", "R$ 150,00", "Bruna Teste CPG", "R$ 1.500,00", "R$ 450,00", "R$ 225,00", "Thaina Teste CPG", "R$ 500,00", "R$ 111,75", "R$ 55,88",
    "3 contratos Total R$ 3.000,00", "R$ 430,88", "reconstrução histórica confirmada pela responsável"]) assert.ok(pdf.text.includes(piece), `PDF sem "${piece}"\n${pdf.text}`);
  assert.ok(!pdf.text.includes("Sabrina") && !pdf.text.includes("R$ 30,62") && !pdf.text.includes("Composição não registrada"));
  const consolidated = await pdfOf(owner, `/gerentes/fechamentos/data/2026-11-19`);
  assert.ok(consolidated.text.includes("R$ 430,88") && consolidated.text.includes("3 contratos Total R$ 3.000,00"), consolidated.text);
});

test("C3. a mesma comissão não é paga duas vezes; só a Sabrina (R$ 75,00) está pendente", async () => {
  const again = await action(owner, "registerManagerPayoutAction", { managerId: G, amount: "75,00", paidOn: "2026-11-27", pendingIds: "", includedOperationIds: "op_cpg_aline" });
  assert.equal(again.result?.ok, false);
  assert.match(again.result.error, /pendente|já foi paga/);
  const tooMuch = await action(owner, "registerManagerPayoutAction", { managerId: G, amount: "75,01", paidOn: "2026-11-27", pendingIds: "" });
  assert.equal(tooMuch.result?.ok, false);
  const ok = await action(owner, "registerManagerPayoutAction", { managerId: G, amount: "75,00", paidOn: "2026-11-27", pendingIds: "", includedOperationIds: "op_cpg_sabrina" });
  assert.equal(ok.result?.ok, true, JSON.stringify(ok.result));
  assert.equal(await cpgNet("pay_cpg_sabrina"), 7500);
  const none = await action(owner, "registerManagerPayoutAction", { managerId: G, amount: "0,01", paidOn: "2026-11-27", pendingIds: "" });
  assert.equal(none.result?.ok, false, "tudo pago");
  // Banco: PAID acima do que o recebimento gerou é recusado mesmo inserido direto.
  await assert.rejects(admin(`insert into account_manager_payout(id,tenant_id,manager_id,amount_cents,paid_on) values ('mgp_cpg_burla','ten_roberio','${G}',100,'2026-11-27');
    insert into account_manager_commission_paid(id,tenant_id,manager_id,payout_id,kind,operation_id,payment_id,client_name,principal_cents,interest_rate_bps,commission_bps,receipt_paid_on,interest_cents,commission_due_cents,commission_cents,source)
    values ('cpg_burla','ten_roberio','${G}','mgp_cpg_burla','PAID','op_cpg_aline','pay_cpg_aline','Aline',100000,3000,5000,'2026-11-14',30000,15000,100,'CLOSING')`), /já foi paga/);
});

test("C4. juros novos no mesmo contrato geram comissão nova; dois fechamentos simultâneos pagam uma vez só", async () => {
  // Aline paga mais um período de juros (R$ 300,00) em 26/11: R$ 150,00 de comissão nova.
  await admin(`insert into payment(id,tenant_id,operation_id,amount_cents,paid_at,payment_mode,allocation_order,interest_period_number,created_at) values ('pay_cpg_aline2','ten_roberio','op_cpg_aline',30000,'2026-11-26','INTEREST_ONLY_RENEWAL','INTEREST_FIRST',2,'2026-11-26 15:00:00+00')`);
  await admin(`insert into loan_renewal(id,tenant_id,operation_id,payment_id,period_number,previous_due_date,new_due_date,principal_base_cents,interest_cents,created_by_user_id) values ('ren_cpg_aline2','ten_roberio','op_cpg_aline','pay_cpg_aline2',3,'2026-12-13','2027-01-13',100000,30000,'u_roberio')`);
  const fields = { managerId: G, amount: "150,00", paidOn: "2026-11-27", pendingIds: "", includedOperationIds: "op_cpg_aline" };
  const [a, b] = await Promise.all([action(owner, "registerManagerPayoutAction", fields), action(owner, "registerManagerPayoutAction", fields)]);
  assert.equal([a, b].filter((item) => item.result?.ok === true).length, 1, JSON.stringify([a.result, b.result]));
  assert.equal(await cpgNet("pay_cpg_aline2"), 15000);
  assert.equal(await cpgNet("pay_cpg_aline"), 15000, "o recebimento antigo continua pago uma vez");
});

test("C5. estorno: parcial com motivo volta a ficar pendente e pode ser pago de novo; nada além do pago; outra carteira não estorna", async () => {
  const bruna = await one(`select id from account_manager_commission_paid where payment_id='pay_cpg_bruna' and kind='PAID'`);
  assert.equal((await action(owner, "reverseCommissionAction", { commissionPaidId: bruna, amount: "50,00", reason: "" })).result?.ok, false, "motivo obrigatório");
  assert.equal((await action(owner, "reverseCommissionAction", { commissionPaidId: bruna, amount: "225,01", reason: "teste" })).result?.ok, false, "acima do pago");
  const forged = await action(fernando, "reverseCommissionAction", { commissionPaidId: bruna, amount: "50,00", reason: "burla" });
  assert.equal(forged.result?.ok, false, "outra carteira");
  const ok = await action(owner, "reverseCommissionAction", { commissionPaidId: bruna, amount: "50,00", reason: "Gerente devolveu R$ 50,00" });
  assert.equal(ok.result?.ok, true, JSON.stringify(ok.result));
  assert.equal(await cpgNet("pay_cpg_bruna"), 17500);
  assert.equal(await one(`select row(p.*)::text from account_manager_payout p where id='${OLD}'`), payoutRow, "fechamento original não muda com o estorno");
  assert.equal(await one(`select count(*) from admin_audit_log where action='MANAGER_COMMISSION_REVERSED' and entity_id='${OLD}'`), 1);
  // O MASTER também estorna pela administração.
  const byMaster = await action(master, "adminReverseCommissionAction", { tenantId: "ten_roberio", commissionPaidId: bruna, amount: "10,00", reason: "Ajuste pelo MASTER" }, "/admin/clientes/ten_roberio");
  assert.equal(byMaster.result?.ok, true, JSON.stringify(byMaster.result));
  assert.equal(await cpgNet("pay_cpg_bruna"), 16500);
  const pdf = await pdfOf(owner, `/gerentes/fechamentos/${OLD}`);
  for (const piece of ["Gerente devolveu R$ 50,00", "− R$ 50,00", "Comissão líquida após estornos", "R$ 370,88"]) assert.ok(pdf.text.includes(piece), `PDF sem "${piece}"\n${pdf.text}`);
  // Pendente de novo só o estornado (R$ 60,00), pagável num novo fechamento.
  const repay = await action(owner, "registerManagerPayoutAction", { managerId: G, amount: "60,00", paidOn: "2026-11-27", pendingIds: "", includedOperationIds: "op_cpg_bruna" });
  assert.equal(repay.result?.ok, true, JSON.stringify(repay.result));
  assert.equal(await cpgNet("pay_cpg_bruna"), 22500);
  // Banco: CPG não se altera nem se apaga; estorno acima do pago recusado.
  await assert.rejects(admin(`update account_manager_commission_paid set commission_cents=1 where id='${bruna}'`), /não podem ser alterados/);
  await assert.rejects(admin(`delete from account_manager_commission_paid where id='${bruna}'`), /não podem ser alterados/);
  await assert.rejects(admin(`insert into account_manager_commission_paid(id,tenant_id,manager_id,payout_id,kind,reverses_id,operation_id,payment_id,client_name,principal_cents,interest_rate_bps,commission_bps,receipt_paid_on,interest_cents,commission_due_cents,commission_cents,source,reason)
    values ('cpg_rev_x','ten_roberio','${G}','${OLD}','REVERSAL','${bruna}','op_cpg_bruna','pay_cpg_bruna','Bruna',150000,3000,5000,'2026-11-09',45000,22500,99999,'HISTORICAL','burla')`), /passa do que foi pago/);
});

test("C6. saldo do gerente e isolamento: tela do dono, MASTER e outra carteira", async () => {
  // Gerado: Aline 300 (2 recebimentos) + Bruna 225 + Thaina 55,88 + Sabrina 75 = 655,88. Pago: 430,88 + 75 + 150 + 60 − 60 estornados = 655,88.
  const page = await signIn("roberio@teste.local");
  await page.goto(`${BASE}/gerentes`);
  const region = page.getByRole("region", { name: "Gerente Gerente CPG" });
  const summary = await region.locator(".manager-summary").innerText().then((t) => t.replace(/\u00a0/g, " "));
  assert.ok(summary.includes("R$ 655,88") && summary.includes("A pagar agora\nR$ 0,00"), summary);
  await region.getByRole("button", { name: "Comissões (CPG)" }).click();
  await region.getByRole("tab", { name: /Pagas \(CPG\) \(4\)/ }).click();
  const paid = await region.locator(".cpg-table tbody").innerText().then((t) => t.replace(/\u00a0/g, " "));
  for (const piece of ["Aline Teste CPG", "Bruna Teste CPG", "Thaina Teste CPG", "Sabrina Teste CPG"]) assert.ok(paid.includes(piece), paid);
  await region.getByRole("tab", { name: /Pendentes \(0\)/ }).click();
  await region.getByText("Nenhum contrato neste filtro.").waitFor();
  await region.getByRole("button", { name: /Fechamentos \(/ }).click();
  await region.getByRole("button", { name: "Contratos do fechamento de 19/11/2026" }).click();
  const composition = await region.locator(".payout-composition").first().innerText().then((t) => t.replace(/\u00a0/g, " "));
  for (const piece of ["Aline Teste CPG", "R$ 150,00", "Bruna Teste CPG", "R$ 225,00", "Thaina Teste CPG", "R$ 55,88", "3 contratos · total", "R$ 430,88"]) assert.ok(composition.includes(piece), composition);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  if (SHOTS) await region.screenshot({ path: `${SHOTS}/cpg-desktop.png` });
  await page.context().close();
  const phone = await signIn("roberio@teste.local", { width: 390, height: 844 });
  await phone.goto(`${BASE}/gerentes`);
  const mobile = phone.getByRole("region", { name: "Gerente Gerente CPG" });
  await mobile.getByRole("button", { name: "Comissões (CPG)" }).click();
  await mobile.getByRole("tab", { name: /Todas/ }).click();
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "sem rolagem lateral no celular");
  if (SHOTS) await mobile.screenshot({ path: `${SHOTS}/cpg-celular.png` });
  await phone.context().close();
  // Outra carteira: não vê o PDF e o gerente dela não é afetado.
  assert.equal((await get(fernando, `/gerentes/fechamentos/${OLD}`)).status, 404);
  assert.equal(await one(`select count(*) from account_manager_commission_paid where tenant_id='ten_fernando'`), 0);
  const fPay = await action(fernando, "registerManagerPayoutAction", { managerId: G, amount: "1,00", paidOn: "2026-11-27", pendingIds: "" });
  assert.equal(fPay.result?.ok, false, "gerente de outra carteira");
  assert.equal(await financeHash("ten_roberio", "'pay_cpg_aline2'"), robHash, "nada financeiro mudou além do recebimento de teste");
  assert.equal(await financeHash("ten_fernando"), fernandoHash, "outra carteira intacta");
});
