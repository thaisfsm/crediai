// Entrada de investimento com data anterior ao início do ciclo: confirmação explícita validada no servidor (HTTP + banco).
// Dados fictícios ten_roberio (A) e ten_fernando (B), SÓ em banco local e descartável.
//   E2E_DATABASE_URL=postgres://dono:senha@127.0.0.1:5432/crediai node --test tests/e2e/entrada-antes-ciclo.e2e.mjs
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;| /g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const daysAgo = (days) => { const date = new Date(`${TODAY}T00:00:00Z`); date.setUTCDate(date.getUTCDate() - days); return date.toISOString().slice(0, 10); };
const SHOTS = process.env.E2E_SCREENSHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
let browser;
after(async () => { await browser?.close(); await sql.end(); });

let lastLogin = 0;
async function login(email) {
  const wait = 11_000 - (Date.now() - lastLogin);
  if (wait > 0) await sleep(wait);
  lastLogin = Date.now();
  const response = await fetch(`${BASE}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email, password: process.env.E2E_PASSWORD ?? "Senha-Teste-Local-123" }) });
  assert.equal(response.status, 200, `login de ${email}`);
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}
async function action(cookie, name, fields, path = "/contas-a-pagar") {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(`_1_${key}`, value);
  form.append("0", '["$K1"]');
  const response = await fetch(`${BASE}${path}`, { method: "POST", redirect: "manual", headers: { cookie, "next-action": actionId(name), accept: "text/x-component", origin: BASE }, body: form });
  const result = (await response.text()).match(/^1:(\{.*\})$/m)?.[1];
  return result ? JSON.parse(result) : null;
}
const investorAction = (cookie, name, fields) => action(cookie, name, fields, "/investidores");
const page = async (cookie, path) => {
  const response = await fetch(`${BASE}${path}`, { redirect: "manual", headers: cookie ? { cookie } : {} });
  return { status: response.status, html: response.status === 200 ? text(await response.text()) : "" };
};
let counter = 0;
const requestId = () => `e2e-ec-${Date.now()}-${++counter}-abcdef`;
const available = async (tenantId) => Number(await one(`select w.initial_capital_cents
  + coalesce((select sum(case when m.kind in ('CONTRIBUTION','OTHER_INCOME') then m.amount_cents else -m.amount_cents end) from capital_movement m where m.tenant_id = w.tenant_id and m.cycle_number = w.cycle_number), 0)
  - coalesce((select sum(o.principal_cents) from loan_operation o where o.tenant_id = w.tenant_id and o.cycle_number = w.cycle_number and o.status <> 'CANCELED'), 0)
  + coalesce((select sum(p.amount_cents) from payment p join loan_operation o on o.id = p.operation_id where p.tenant_id = w.tenant_id and o.cycle_number = w.cycle_number), 0)
  from wallet w where w.tenant_id = '${tenantId}'`));
const count = (table, where) => one(`select count(*)::int from ${table} where ${where}`);
// Tudo que não pode mudar: operações, pagamentos de clientes, clientes, tenants, carteiras, usuários e o tenant B inteiro.
const protectedHash = () => one(`select md5(string_agg(x, '|' order by x)) from (
  select 'o'||row(o.*)::text x from loan_operation o union all select 'p'||row(p.*)::text from payment p union all select 'r'||row(r.*)::text from loan_renewal r
  union all select 'c'||row(c.*)::text from client c union all select 't'||row(t.*)::text from tenant t union all select 's'||row(s.*)::text from subscription s
  union all select 'w'||row(w.*)::text from wallet w union all select 'u'||concat_ws(',', u.id, u.name, u.email, u.role, u.tenant_id, u.active) from "user" u
  union all select 'mB'||row(m.*)::text from capital_movement m where tenant_id = 'ten_fernando'
  union all select 'vB'||row(v.*)::text from investor v where tenant_id = 'ten_fernando' union all select 'iB'||row(i.*)::text from investment i where tenant_id = 'ten_fernando') t`);
// Simula um contrato que já existia antes da 0023 (a marca fica NULL, como a migração deixa os contratos existentes).
async function makeLegacy(investmentId) {
  await sql.unsafe(`alter table investment disable trigger investment_entry_rule`);
  try { await admin(`update investment set capital_entry_rule = null where id = '${investmentId}'`); } finally { await sql.unsafe(`alter table investment enable trigger investment_entry_rule`); }
}

let robério, fernando, thais, hashBefore;
const ids = {};
const pay = (cookie, scheduleItemId, extra = {}) => action(cookie, "registerInvestmentPaymentAction", { scheduleItemId, kind: "YIELD", amount: "100,00", paidOn: TODAY, method: "PIX", reference: "", notes: "", requestId: requestId(), ...extra });
const enter = (cookie, investmentId, amountCents, enteredOn, extra = {}) => action(cookie, "registerInvestmentEntryAction", { investmentId, amountCents: String(amountCents), enteredOn, confirm: "1", requestId: requestId(), ...extra });
const declare = (cookie, investmentId, movementId, extra = {}) => action(cookie, "declarePriorContributionAction", { investmentId, movementId, confirm: "1", requestId: requestId(), ...extra });

async function contract(cookie, number, amount, startDate) {
  const created = await investorAction(cookie, "createInvestmentAction", { investorId: ids.investor, amount, rate: "1", ratePeriod: "MONTHLY", startDate, contractNumber: number });
  assert.equal(created?.ok, true, JSON.stringify(created));
  const item = await investorAction(cookie, "addInvestmentScheduleItemAction", { investmentId: created.id, dueDate: TODAY, yieldAmount: "100,00", principalAmount: "", description: "" });
  assert.equal(item?.ok, true, JSON.stringify(item));
  return { id: created.id, item: await one(`select id from investment_schedule_item where investment_id = '${created.id}'`) };
}
const entries = (id) => count("investment_capital_entry", `investment_id = '${id}'`);
const movements = () => count("capital_movement", "tenant_id = 'ten_roberio'");
const BEFORE = "confirmBeforeCycle";

test("preparação: carteira A criada há 40 dias com R$ 10.000, aporte de R$ 5.000 e contratos de 60 dias atrás", async () => {
  await admin(`update wallet set initial_capital_cents = 1000000, created_at = '${daysAgo(40)} 12:00:00+00' where tenant_id = 'ten_roberio'`);
  hashBefore = await protectedHash();
  robério = await login("roberio@teste.local");
  fernando = await login("fernando@teste.local");
  const investor = await investorAction(robério, "createInvestorAction", { personType: "PF", document: "31972257323", name: "Rita Ciclo" });
  assert.equal(investor?.ok, true, JSON.stringify(investor));
  ids.investor = investor.id;
  const contribution = await action(robério, "registerContributionAction", { amount: "5.000,00", occurredAt: daysAgo(20), notes: "aporte comum" }, "/");
  assert.equal(contribution?.ok, true, JSON.stringify(contribution));
  ids.livre = await contract(robério, "EC-LIVRE", "3.000,00", daysAgo(60));
  ids.aporte = await contract(robério, "EC-APORTE", "5.000,00", daysAgo(60));
  ids.inicial = await contract(robério, "EC-INICIAL", "10.000,00", daysAgo(60));
  ids.corrida = await contract(robério, "EC-CORRIDA", "2.500,00", daysAgo(60));
  ids.tela = await contract(robério, "EC-TELA", "4.200,00", daysAgo(60));
  ids.dentro = await contract(robério, "EC-DENTRO", "1.500,00", daysAgo(10));
});

test("EC1. sem a confirmação extra: recusada e nada gravado; a baixa continua bloqueada", async () => {
  const before = { m: await movements(), e: await entries(ids.livre.id), cap: await available("ten_roberio") };
  const result = await enter(robério, ids.livre.id, 300_000, daysAgo(60));
  assert.equal(result?.ok, false);
  assert.match(result.error, /anterior ao início do ciclo atual/);
  assert.match(result.error, /Nada foi registrado/);
  assert.deepEqual({ m: await movements(), e: await entries(ids.livre.id), cap: await available("ten_roberio") }, before);
  const blocked = await pay(robério, ids.livre.item);
  assert.equal(blocked?.ok, false);
  assert.match(blocked.error, /Registre primeiro a entrada/);
  assert.equal(await count("investment_payment", `investment_id = '${ids.livre.id}'`), 0);
});

test("EC2. com a confirmação: entrada antiga ainda não contabilizada é registrada uma vez, com auditoria, e libera a baixa", async () => {
  const capital = await available("ten_roberio");
  const result = await enter(robério, ids.livre.id, 300_000, daysAgo(60), { [BEFORE]: "1" });
  assert.equal(result?.ok, true, JSON.stringify(result));
  assert.equal(await available("ten_roberio") - capital, 300_000);
  assert.equal(await entries(ids.livre.id), 1);
  const audit = (await admin(`select description, after from admin_audit_log where action = 'INVESTMENT_CAPITAL_ENTRY_REGISTERED' order by created_at desc limit 1`))[0];
  assert.match(audit.description, /confirmação do usuário/);
  assert.equal(JSON.parse(typeof audit.after === "string" ? audit.after : JSON.stringify(audit.after)).confirmedBeforeCycle, true);
  assert.equal((await pay(robério, ids.livre.item))?.ok, true);
  // Nova tentativa, mesmo confirmada: nada em dobro.
  assert.match((await enter(robério, ids.livre.id, 300_000, daysAgo(60), { [BEFORE]: "1" }))?.error, /já foi registrada/);
  assert.equal(await entries(ids.livre.id), 1);
});

test("EC3. duplicidade identificada (mesmo valor num aporte do ciclo ou no capital inicial): bloqueada mesmo com confirmação", async () => {
  const before = { m: await movements(), cap: await available("ten_roberio") };
  for (const [contractIds, cents, pattern] of [[ids.aporte, 500_000, /aporte de R\$\s?5\.000,00/], [ids.inicial, 1_000_000, /capital inicial da carteira/]]) {
    const result = await enter(robério, contractIds.id, cents, daysAgo(60), { [BEFORE]: "1" });
    assert.equal(result?.ok, false);
    assert.match(result.error, pattern);
    assert.equal(await entries(contractIds.id), 0);
  }
  assert.deepEqual({ m: await movements(), cap: await available("ten_roberio") }, before);
  assert.equal((await pay(robério, ids.aporte.item))?.ok, false, "baixa continua bloqueada sem entrada válida");
});

test("EC4. cliques repetidos e envios simultâneos com confirmação registram uma única entrada", async () => {
  const same = requestId();
  const results = await Promise.all([
    ...Array.from({ length: 4 }, () => enter(robério, ids.corrida.id, 250_000, daysAgo(60), { [BEFORE]: "1", requestId: same })),
    ...Array.from({ length: 4 }, () => enter(robério, ids.corrida.id, 250_000, daysAgo(60), { [BEFORE]: "1" })),
  ]);
  assert.ok(results.some((result) => result?.ok === true));
  assert.equal(await entries(ids.corrida.id), 1);
  assert.equal(await count("capital_movement", `tenant_id = 'ten_roberio' and description like '%EC-CORRIDA%' and kind = 'CONTRIBUTION'`) , 1);
});

test("EC5. investimento dentro do ciclo atual segue normal, sem a confirmação extra", async () => {
  const result = await enter(robério, ids.dentro.id, 150_000, daysAgo(10));
  assert.equal(result?.ok, true, JSON.stringify(result));
  assert.equal(await entries(ids.dentro.id), 1);
  assert.doesNotMatch(String((await admin(`select description from admin_audit_log where action = 'INVESTMENT_CAPITAL_ENTRY_REGISTERED' order by created_at desc limit 1`))[0].description), /confirmação do usuário/);
});

test("EC6. isolamento: outro tenant não registra a entrada e nada fora da carteira A mudou", async () => {
  const other = await enter(fernando, ids.inicial.id, 1_000_000, daysAgo(60), { [BEFORE]: "1" });
  assert.equal(other?.ok, false);
  assert.match(other.error, /não encontrado/);
  assert.equal(await entries(ids.inicial.id), 0);
  assert.equal(await protectedHash(), hashBefore);
});

test("EC7. navegador: confirmação mostra valor, data e início do ciclo; Cancelar não grava; Confirmar entrada registra", async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const [name, value] = robério.split("; ").find((cookie) => cookie.includes("session_token")).split(/=(.*)/s);
  await context.addCookies([{ name, value, domain: new URL(BASE).hostname, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
  const browserPage = await context.newPage();
  await browserPage.goto(`${BASE}/investidores/investimentos/${ids.tela.id}`);
  const open = browserPage.getByRole("button", { name: "Registrar a entrada deste investimento no capital" });
  await open.click();
  const dialog = browserPage.getByRole("alert").filter({ hasText: "anterior ao início do ciclo atual" });
  await dialog.waitFor();
  const shown = await dialog.innerText();
  assert.match(shown, /R\$\s?4\.200,00/);
  assert.ok(shown.includes(`Data do investimento: ${daysAgo(60).split("-").reverse().join("/")}`), shown);
  assert.match(shown, /Início do ciclo: \d\d\/\d\d\/\d{4}/);
  if (SHOTS) await browserPage.screenshot({ path: `${SHOTS}/entrada-confirmacao.png`, fullPage: true });
  await browserPage.getByRole("button", { name: "Cancelar" }).first().click();
  assert.equal(await entries(ids.tela.id), 0, "Cancelar não grava");
  await open.click();
  await browserPage.getByRole("button", { name: "Confirmar entrada" }).click();
  await sleep(300);
  assert.equal(await entries(ids.tela.id), 0, "sem marcar as caixas, nada é gravado");
  await browserPage.locator('input[name="confirmBeforeCycle"]').check();
  await browserPage.locator('input[name="confirm"]').check();
  await browserPage.getByRole("button", { name: "Confirmar entrada" }).click();
  await browserPage.getByText(/Entrada de R\$\s?4\.200,00 .* registrada no capital/).first().waitFor();
  assert.equal(await entries(ids.tela.id), 1);
  if (SHOTS) await browserPage.screenshot({ path: `${SHOTS}/entrada-registrada.png`, fullPage: true });
});
