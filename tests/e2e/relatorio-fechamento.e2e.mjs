// Relatório em PDF de cada fechamento de comissão (e o consolidado por data), de ponta a ponta: servidor + banco + telas.
// SÓ em ambiente LOCAL e DESCARTÁVEL (ver tests/e2e/README.md): cria gerentes, clientes, operações e lançamentos fictícios.
//   E2E_DATABASE_URL=… PLAYWRIGHT_MODULE=… node --test tests/e2e/relatorio-fechamento.e2e.mjs
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
const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
const admin = async (query) => sql.begin(async (tx) => { await tx`select set_config('app.crediai_role', 'SUPER_ADMIN', true)`; return tx.unsafe(query); });
const one = async (query) => { const value = Object.values((await admin(query))[0] ?? {})[0]; return typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : value; };
const manifest = JSON.parse(readFileSync(".next/server/server-reference-manifest.json", "utf8")).node;
const actionId = (name) => Object.entries(manifest).find(([, value]) => value.exportedName === name)?.[0] ?? assert.fail(`ação ${name} não encontrada no build`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SHOTS = process.env.E2E_SCREENSHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
after(async () => { await browser.close(); await sql.end(); });

const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const day = (offset) => { const date = new Date(`${TODAY}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + offset); return date.toISOString().slice(0, 10); };
const PASSWORD = process.env.E2E_PASSWORD ?? "Senha-Teste-Local-123";
// Tudo que é financeiro e não é do módulo de lançamentos: não pode mudar.
const tenantHash = (tenant) => one(`select md5(string_agg(x, '|' order by x)) from (
  select 'c'||row(c.*)::text x from client c where tenant_id = '${tenant}' union all select 'o'||row(o.*)::text from loan_operation o where tenant_id = '${tenant}'
  union all select 'p'||row(p.*)::text from payment p where tenant_id = '${tenant}' union all select 'w'||row(w.*)::text from wallet w where tenant_id = '${tenant}'
  union all select 'm'||row(m.*)::text from capital_movement m where tenant_id = '${tenant}' union all select 'g'||row(g.*)::text from account_manager g where tenant_id = '${tenant}') t`);

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
const poll = async (query, expected) => { for (let i = 0; i < 60; i++) { if (String(await one(query)) === String(expected)) return; await sleep(250); } assert.equal(String(await one(query)), String(expected)); };


const R = "mgr_r_a", S = "mgr_r_b";
let ownerApi, fernandoBefore, oldRow, newPayoutId;
const pdfOf = async (cookie, path) => {
  const response = await get(cookie, path);
  const type = response.headers.get("content-type") ?? "";
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { status: response.status, type, disposition: response.headers.get("content-disposition") ?? "", text: type.includes("pdf") ? pdfText(bytes).replace(/ /g, " ") : "" };
};
const withoutEmission = (text) => text.replace(/Emissão: .*\n/g, "").replace(/Usuário: .*\n/g, "");

test("preparação: gerente com percentuais diferentes por cliente, fechamento ANTIGO (sem detalhamento) e um cliente sem comissão", async () => {
  fernandoBefore = await tenantHash("ten_fernando");
  await admin(`insert into account_manager(id, tenant_id, name, commission_bps) values ('${R}','ten_roberio','Gerente Relatório',4500), ('${S}','ten_roberio','Segunda Relatório',1000)`);
  await admin(`insert into client(id, tenant_id, name, account_manager_id, account_manager_bps) values
    ('c_r_ana','ten_roberio','Cliente Ana Relatório','${R}',4500), ('c_r_bia','ten_roberio','Cliente Bia Relatório','${R}',1000),
    ('c_r_caio','ten_roberio','Cliente Caio Relatório','${R}',null), ('c_r_zero','ten_roberio','Cliente Zero Relatório','${R}',4500),
    ('c_r_duda','ten_roberio','Cliente Duda Relatório','${S}',2000)`);
  // Ana: R$ 2.000 a 30% (juros R$ 600) × 45% = R$ 270. Bia: R$ 5.000 a 20% (R$ 1.000) × 10% = R$ 100. Caio: R$ 3.000 a 25% (R$ 750) × 45% (padrão do gerente) = R$ 337,50.
  // Zero: em aberto, sem recebimento (não pode aparecer). Duda (outro gerente): R$ 1.000 a 30% (R$ 300) × 20% = R$ 60.
  await admin(`insert into loan_operation(id,tenant_id,client_id,principal_cents,interest_rate_bps,interest_cents,total_cents,loan_date,due_date,calculation_rule,status,settled_at,modality) values
    ('op_r_ana','ten_roberio','c_r_ana',200000,3000,60000,260000,'${day(-60)}','${day(-30)}','RATE_PER_OPERATION_SINGLE_PAYMENT_V1','PAID','${day(-30)}','SINGLE'),
    ('op_r_bia','ten_roberio','c_r_bia',500000,2000,100000,600000,'${day(-60)}','${day(-30)}','RATE_PER_OPERATION_SINGLE_PAYMENT_V1','PAID','${day(-30)}','SINGLE'),
    ('op_r_caio','ten_roberio','c_r_caio',300000,2500,75000,375000,'${day(-40)}','${day(-10)}','RATE_PER_OPERATION_SINGLE_PAYMENT_V1','PAID','${day(-10)}','SINGLE'),
    ('op_r_zero','ten_roberio','c_r_zero',100000,3000,30000,130000,'${day(-5)}','${day(25)}','RATE_PER_OPERATION_SINGLE_PAYMENT_V1','OPEN',null,'SINGLE'),
    ('op_r_duda','ten_roberio','c_r_duda',100000,3000,30000,130000,'${day(-40)}','${day(-10)}','RATE_PER_OPERATION_SINGLE_PAYMENT_V1','PAID','${day(-10)}','SINGLE')`);
  await admin(`insert into payment(id,tenant_id,operation_id,amount_cents,paid_at) values ('pay_r_ana','ten_roberio','op_r_ana',260000,'${day(-30)}'), ('pay_r_bia','ten_roberio','op_r_bia',600000,'${day(-30)}'),
    ('pay_r_caio','ten_roberio','op_r_caio',375000,'${day(-10)}'), ('pay_r_duda','ten_roberio','op_r_duda',130000,'${day(-10)}')`);
  // Fechamento ANTIGO (antes desta versão, sem detalhamento): R$ 200 em day(-20). Na data só Ana (R$ 270) e Bia (R$ 100) tinham comissão.
  await admin(`insert into account_manager_payout(id,tenant_id,manager_id,amount_cents,paid_on,notes) values ('mgp_r_old','ten_roberio','${R}',20000,'${day(-20)}','fechamento antigo')`);
  oldRow = await one(`select row(p.*)::text from account_manager_payout p where id='mgp_r_old'`);
  fernandoBefore = await tenantHash("ten_fernando");
  ownerApi = await apiLogin("roberio@teste.local");
});

test("R1. novo fechamento grava o detalhamento por contrato (percentuais reais de cada contrato) somando exatamente o valor fechado", async () => {
  assert.equal((await action(ownerApi, "createAdjustmentAction", { managerId: R, kind: "DEBIT", amount: "10,00", description: "Adiantamento", entryDate: TODAY })).result?.ok, true);
  const pending = await one(`select id from account_manager_adjustment where manager_id='${R}' and payout_id is null`);
  // Saldo: 270 + 100 + 337,50 − 200 já pagos = 507,50.
  const result = await action(ownerApi, "registerManagerPayoutAction", { managerId: R, amount: "507,50", paidOn: TODAY, pendingIds: pending, includedClientIds: "c_r_ana,c_r_bia,c_r_caio" });
  assert.equal(result.result?.ok, true, JSON.stringify(result.result));
  newPayoutId = await one(`select id from account_manager_payout where manager_id='${R}' and id <> 'mgp_r_old'`);
  const items = await admin(`select operation_id, client_name, principal_cents::int p, interest_rate_bps::float r, commission_bps c, interest_received_cents::int i, commission_cents::int v, operation_code from account_manager_payout_item where payout_id='${newPayoutId}' order by client_name`);
  // O antigo (R$ 200) é reconstituído: Ana 145,95 e Bia 54,05 (proporcional ao que cada uma tinha a pagar na data). O novo leva o resto.
  assert.deepEqual(items.map((item) => [item.operation_id, item.p, item.r, item.c, item.i, item.v]), [
    ["op_r_ana", 200000, 3000, 4500, 60000, 27000 - 14595], ["op_r_bia", 500000, 2000, 1000, 100000, 10000 - 5405], ["op_r_caio", 300000, 2500, 4500, 75000, 33750],
  ]);
  assert.ok(items.every((item) => item.operation_code));
  assert.equal(items.reduce((sum, item) => sum + item.v, 0), 50750);
  assert.equal(await one(`select count(*) from account_manager_payout_item where operation_id='op_r_zero'`), 0, "contrato sem comissão fora");
  assert.equal(await one(`select row(p.*)::text from account_manager_payout p where id='mgp_r_old'`), oldRow, "fechamento antigo intacto");
  assert.equal(await one(`select count(*) from account_manager_payout_item where payout_id='mgp_r_old'`), 0, "nada gravado no fechamento antigo");
});

test("R2. PDF do fechamento: lista por contrato, percentuais e comissão de cada um, lançamentos e total igual ao pago", async () => {
  const pdf = await pdfOf(ownerApi, `/gerentes/fechamentos/${newPayoutId}`);
  assert.equal(pdf.status, 200);
  assert.match(pdf.type, /application\/pdf/);
  assert.match(pdf.disposition, /^inline; filename\*=UTF-8''fechamento-comissao-gerente-relatorio-\d{4}-\d{2}-\d{2}-02\.pdf$/);
  for (const piece of ["Relatório de Fechamento de Comissão", "Gerente Relatório", "Cliente Ana Relatório", "R$ 2.000,00", "30,00%", "45,00%", "13,50%", "R$ 124,05",
    "Cliente Bia Relatório", "R$ 5.000,00", "20,00%", "10,00%", "2,00%", "R$ 45,95", "Cliente Caio Relatório", "R$ 3.000,00", "25,00%", "11,25%", "R$ 337,50",
    "3 contratos Total R$ 10.000,00", "R$ 507,50", "Débito no fechamento · Adiantamento", "− R$ 10,00", "Valor pago a Gerente Relatório", "R$ 497,50", "Total pago ao gerente", "Usuário: Robério Santos",
    "Valores históricos gravados no momento do fechamento"]) assert.ok(pdf.text.includes(piece), `PDF sem "${piece}"\n${pdf.text}`);
  assert.ok(!pdf.text.includes("Cliente Zero") && !pdf.text.includes("Cliente Duda"), "só os contratos do fechamento");
  const download = await pdfOf(ownerApi, `/gerentes/fechamentos/${newPayoutId}?baixar=1`);
  assert.match(download.disposition, /^attachment;/);
});

test("R3. histórico preservado: mudar cliente/percentual depois não muda o PDF; fechamento antigo baixa de novo (reconstituído) e o banco protege o detalhamento", async () => {
  const before = withoutEmission((await pdfOf(ownerApi, `/gerentes/fechamentos/${newPayoutId}`)).text);
  await admin(`update client set name='Ana Renomeada', account_manager_bps=9000 where id='c_r_ana'`);
  const after = withoutEmission((await pdfOf(ownerApi, `/gerentes/fechamentos/${newPayoutId}`)).text);
  assert.equal(after, before, "PDF do fechamento igual depois da mudança no contrato");
  await admin(`update client set name='Cliente Ana Relatório', account_manager_bps=4500 where id='c_r_ana'`);
  const old = await pdfOf(ownerApi, `/gerentes/fechamentos/mgp_r_old`);
  assert.equal(old.status, 200);
  for (const piece of ["Cliente Ana Relatório", "R$ 145,95", "Cliente Bia Relatório", "R$ 54,05", "2 contratos Total R$ 7.000,00", "R$ 200,00", "reconstituída", "Observação do fechamento: fechamento antigo"]) assert.ok(old.text.includes(piece), `PDF antigo sem "${piece}"\n${old.text}`);
  assert.ok(!old.text.includes("Cliente Caio"), "Caio só recebeu depois do fechamento antigo");
  const item = await one(`select id from account_manager_payout_item where payout_id='${newPayoutId}' limit 1`);
  await assert.rejects(admin(`update account_manager_payout_item set commission_cents=1 where id='${item}'`), /não podem ser alterados/);
  await assert.rejects(admin(`delete from account_manager_payout_item where id='${item}'`), /não podem ser alterados/);
  await assert.rejects(admin(`insert into account_manager_payout_item(id,tenant_id,manager_id,payout_id,client_name,principal_cents,interest_rate_bps,commission_bps,interest_received_cents,commission_cents) values ('mgi_x','ten_roberio','${R}','mgp_r_old','Tardio',0,0,0,0,20000)`), /junto com o próprio fechamento/);
  await assert.rejects(admin(`insert into account_manager_payout(id,tenant_id,manager_id,amount_cents,paid_on) values ('mgp_r_fake','ten_roberio','${S}',1000,'${TODAY}');
    insert into account_manager_payout_item(id,tenant_id,manager_id,payout_id,client_name,principal_cents,interest_rate_bps,commission_bps,interest_received_cents,commission_cents) values ('mgi_y','ten_roberio','${S}','mgp_r_fake','Errado',0,0,0,0,999)`), /não soma o valor gravado/);
  assert.equal(await one(`select row(p.*)::text from account_manager_payout p where id='mgp_r_old'`), oldRow);
});

test("R4. consolidado da data: um grupo por gerente, com o total de cada um e o total geral", async () => {
  const result = await action(ownerApi, "registerManagerPayoutAction", { managerId: S, amount: "60,00", paidOn: TODAY, pendingIds: "" });
  assert.equal(result.result?.ok, true, JSON.stringify(result.result));
  assert.equal(await one(`select sum(commission_cents)::int from account_manager_payout_item i join account_manager_payout p on p.id=i.payout_id where p.manager_id='${S}'`), 6000);
  const pdf = await pdfOf(ownerApi, `/gerentes/fechamentos/data/${TODAY}`);
  assert.equal(pdf.status, 200);
  for (const piece of ["Relatório Consolidado de Fechamento de Comissão", "Gerente Relatório", "Valor pago a Gerente Relatório", "R$ 497,50", "Segunda Relatório", "Cliente Duda Relatório", "6,00%", "R$ 60,00",
    "1 contrato Total R$ 1.000,00", "Total pago aos gerentes", "R$ 557,50", "R$ 567,50"]) assert.ok(pdf.text.includes(piece), `consolidado sem "${piece}"\n${pdf.text}`);
  assert.ok(pdf.text.indexOf("Gerente Relatório") < pdf.text.indexOf("Segunda Relatório"), "gerentes em ordem alfabética");
  assert.equal((await get(ownerApi, `/gerentes/fechamentos/data/2001-01-01`)).status, 404);
  assert.equal((await get(ownerApi, `/gerentes/fechamentos/data/2026-02-31`)).status, 404);
});

test("R5. isolamento: outra carteira recebe 404 (id real ou forjado), sem login não abre e o MASTER abre pela administração", async () => {
  const fernando = await apiLogin("fernando@teste.local");
  for (const path of [`/gerentes/fechamentos/${newPayoutId}`, `/gerentes/fechamentos/mgp_r_old?baixar=1`, `/gerentes/fechamentos/data/${TODAY}`, `/gerentes/fechamentos/x'%20or%201=1`]) {
    const response = await get(fernando, path);
    assert.equal(response.status, 404, path);
    assert.doesNotMatch(response.headers.get("content-type") ?? "", /pdf/, path);
  }
  // Inquilino tentando a rota do MASTER (?tenantId=) é mandado embora sem PDF.
  const forged = await get(fernando, `/gerentes/fechamentos/${newPayoutId}?tenantId=ten_roberio`);
  assert.notEqual(forged.status, 200);
  assert.doesNotMatch(forged.headers.get("content-type") ?? "", /pdf/);
  const anonymous = await get("", `/gerentes/fechamentos/${newPayoutId}`);
  assert.notEqual(anonymous.status, 200);
  assert.doesNotMatch(anonymous.headers.get("content-type") ?? "", /pdf/);
  const master = await apiLogin("thais@teste.local");
  assert.equal((await get(master, `/gerentes/fechamentos/${newPayoutId}`)).status, 404, "MASTER na própria carteira não vê a do Robério por esta rota");
  const viaAdmin = await pdfOf(master, `/gerentes/fechamentos/${newPayoutId}?tenantId=ten_roberio`);
  assert.equal(viaAdmin.status, 200);
  assert.ok(viaAdmin.text.includes("Gerente Relatório") && viaAdmin.text.includes("R$ 497,50"));
  assert.equal(await tenantHash("ten_fernando"), fernandoBefore, "tenant B intacto");
});

test("R6. tela: “Fechamentos” de cada gerente com Ver PDF/Baixar e relatórios por data (desktop e celular, sem rolagem lateral)", async () => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const page = await signIn("roberio@teste.local", viewport);
    await page.goto(`${BASE}/gerentes`);
    const region = page.getByRole("region", { name: "Gerente Gerente Relatório" });
    await region.getByRole("button", { name: "Fechamentos (2)" }).click();
    const links = region.locator(".closings-panel .payout-pdf-links a");
    assert.equal(await links.count(), 4);
    assert.ok((await links.evaluateAll((items) => items.map((item) => item.getAttribute("href")))).includes(`/gerentes/fechamentos/${newPayoutId}?baixar=1`));
    const consolidated = page.getByRole("region", { name: "Relatórios de fechamento por data" });
    await consolidated.getByRole("link", { name: /Ver PDF consolidado/ }).first().waitFor();
    // O link abre o PDF com a sessão da própria tela.
    const href = await region.getByRole("link", { name: /Ver PDF do fechamento/ }).first().getAttribute("href");
    const opened = await page.request.get(`${BASE}${href}`);
    assert.equal(opened.status(), 200);
    assert.match(opened.headers()["content-type"], /application\/pdf/);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `sem rolagem lateral em ${viewport.width}px`);
    if (SHOTS) { await region.scrollIntoViewIfNeeded(); await page.screenshot({ path: `${SHOTS}/fechamentos-${viewport.width}.png`, fullPage: true }); }
    await page.context().close();
  }
});
