// Pagamento histórico de investidores (migração 0033), de ponta a ponta (HTTP + banco). Data anterior ao início do capital:
//   * baixa na data real sem saída de capital, só para datas anteriores ao início do capital; recusas no servidor e no banco;
//   * a regra da entrada no capital continua valendo para pagamentos dentro do ciclo; isolamento entre tenants.
// Só em ambiente LOCAL e DESCARTÁVEL, com os dados fictícios ten_roberio (A), ten_fernando (B) e ten_thais (MASTER).
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
const requestId = () => `e2e-hist-${Date.now()}-${++counter}-abcdef`;
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
async function contract(cookie, number, amount, startDate, yieldAmount = "100,00") {
  const created = await investorAction(cookie, "createInvestmentAction", { investorId: ids.investor, amount, rate: "1", ratePeriod: "MONTHLY", startDate, contractNumber: number });
  assert.equal(created?.ok, true, JSON.stringify(created));
  const item = await investorAction(cookie, "addInvestmentScheduleItemAction", { investmentId: created.id, dueDate: TODAY, yieldAmount, principalAmount: "", description: "" });
  assert.equal(item?.ok, true, JSON.stringify(item));
  return { id: created.id, item: await one(`select id from investment_schedule_item where investment_id = '${created.id}'`) };
}
const nothingWritten = async () => ({ payments: await count("investment_payment", "tenant_id = 'ten_roberio'"), movements: await count("capital_movement", "tenant_id = 'ten_roberio'"), priors: await count("investment_prior_contribution", "true") });

// Contrato com início e vencimento antes do início do capital (o capital da carteira A começa há 40 dias).
async function oldContract(cookie, number, startDate, dueDate, yieldAmount) {
  const created = await investorAction(cookie, "createInvestmentAction", { investorId: ids.investor, amount: "5.000,00", rate: "1", ratePeriod: "MONTHLY", startDate, contractNumber: number });
  assert.equal(created?.ok, true, JSON.stringify(created));
  const item = await investorAction(cookie, "addInvestmentScheduleItemAction", { investmentId: created.id, dueDate, yieldAmount, principalAmount: "", description: "" });
  assert.equal(item?.ok, true, JSON.stringify(item));
  return { id: created.id, item: await one(`select id from investment_schedule_item where investment_id = '${created.id}'`) };
}
const CYCLE = daysAgo(40);

test("preparação: carteira A com capital há 40 dias e contratos que começaram antes disso (dados fictícios)", async () => {
  await admin(`update wallet set initial_capital_cents = 1000000, created_at = '${CYCLE} 12:00:00+00' where tenant_id = 'ten_roberio'`);
  hashBefore = await protectedHash();
  robério = await login("roberio@teste.local");
  fernando = await login("fernando@teste.local");
  const investor = await investorAction(robério, "createInvestorAction", { personType: "PF", document: "31972257323", name: "Hugo Histórico" });
  assert.equal(investor?.ok, true, JSON.stringify(investor));
  ids.investor = investor.id;
  const contribution = await action(robério, "registerContributionAction", { amount: "1.000,00", occurredAt: daysAgo(10), notes: "aporte comum" }, "/");
  assert.equal(contribution?.ok, true, JSON.stringify(contribution));
  ids.a = await oldContract(robério, "HI-A", daysAgo(100), daysAgo(90), "500,00");
  ids.b = await oldContract(robério, "HI-B", daysAgo(100), daysAgo(80), "300,00");
});

test("H1. data anterior ao capital sem marcar histórico, e histórico com data de hoje, são recusados; nada gravado", async () => {
  const before = await nothingWritten();
  const semMarca = await pay(robério, ids.a.item, { paidOn: daysAgo(90) });
  assert.equal(semMarca?.ok, false);
  assert.match(semMarca.error, /anterior ao início do capital/);
  const hojeHistorico = await pay(robério, ids.a.item, { paidOn: TODAY, historical: "1" });
  assert.equal(hojeHistorico?.ok, false);
  assert.match(hojeHistorico.error, /só vale para datas anteriores ao início do capital/);
  assert.deepEqual(await nothingWritten(), before);
});

test("H2. contrato novo sem entrada: dentro do ciclo continua bloqueado, mas o histórico não depende da entrada", async () => {
  const before = await nothingWritten();
  const hoje = await pay(robério, ids.a.item);
  assert.equal(hoje?.ok, false);
  assert.match(hoje.error, /entrada/i);
  assert.deepEqual(await nothingWritten(), before);
});

test("H3. pagamento histórico parcial: baixa na data real, sem movimento de capital, capital intacto, repetição não duplica", async () => {
  const capitalBefore = await available("ten_roberio");
  const movementsBefore = await count("capital_movement", "tenant_id = 'ten_roberio'");
  const key = requestId();
  const first = await pay(robério, ids.a.item, { paidOn: daysAgo(90), amount: "200,00", historical: "1", requestId: key });
  assert.equal(first?.ok, true, JSON.stringify(first));
  assert.match(first.message, /histórico/i);
  const row = (await admin(`select historical, capital_movement_id, amount_cents::int, to_char(paid_on, 'YYYY-MM-DD') d from investment_payment where schedule_item_id = '${ids.a.item}'`))[0];
  assert.equal(row.historical, true);
  assert.equal(row.capital_movement_id, null);
  assert.equal(row.amount_cents, 20000);
  assert.equal(row.d, daysAgo(90));
  assert.equal(await count("capital_movement", "tenant_id = 'ten_roberio'"), movementsBefore, "nenhuma saída de capital");
  assert.equal(await available("ten_roberio"), capitalBefore, "capital disponível não mudou");
  const again = await pay(robério, ids.a.item, { paidOn: daysAgo(90), amount: "200,00", historical: "1", requestId: key });
  assert.equal(again?.ok, true);
  assert.equal(await count("investment_payment", `schedule_item_id = '${ids.a.item}'`), 1, "mesma chave grava uma vez");
  const audit = await count("admin_audit_log", `action = 'INVESTMENT_PAYMENT_REGISTERED' and after::text like '%"historical": true%'`);
  assert.equal(audit, 1, "auditoria da baixa histórica");
});

test("H4. completa o saldo em histórico; acima do saldo, antes do início do contrato e principal em linha sem principal são recusados", async () => {
  const over = await pay(robério, ids.a.item, { paidOn: daysAgo(90), amount: "300,01", historical: "1" });
  assert.equal(over?.ok, false);
  const beforeContract = await pay(robério, ids.a.item, { paidOn: daysAgo(110), amount: "10,00", historical: "1" });
  assert.equal(beforeContract?.ok, false);
  assert.match(beforeContract.error, /anterior ao início do contrato/);
  const rest = await pay(robério, ids.a.item, { paidOn: daysAgo(85), amount: "300,00", historical: "1" });
  assert.equal(rest?.ok, true, JSON.stringify(rest));
  const extra = await pay(robério, ids.a.item, { paidOn: daysAgo(85), amount: "0,01", historical: "1" });
  assert.equal(extra?.ok, false, "obrigação já paga");
  assert.equal(await one(`select sum(amount_cents)::int from investment_payment where schedule_item_id = '${ids.a.item}'`), 50000);
});

test("H5. o banco recusa baixa histórica fora da regra (data dentro do ciclo, com saída ligada ou sem marca sem saída)", async () => {
  const insert = (id, historical, movement, paidOn) => admin(`insert into investment_payment (id, tenant_id, investment_id, schedule_item_id, kind, amount_cents, paid_on, method, capital_movement_id, historical, idempotency_key)
    values ('${id}', 'ten_roberio', '${ids.b.id}', '${ids.b.item}', 'YIELD', 100, '${paidOn}', 'PIX', ${movement ? `'${movement}'` : "null"}, ${historical}, 'k-${id}')`);
  await assert.rejects(insert("ivp_h5a", true, null, TODAY), /Baixa histórica|anterior ao início do capital/);
  await assert.rejects(insert("ivp_h5b", false, null, daysAgo(80)), /Baixa|investment_payment_historical_no_movement|check/);
  const movement = await one(`select id from capital_movement where tenant_id = 'ten_roberio' limit 1`);
  await assert.rejects(insert("ivp_h5c", true, movement, daysAgo(80)), /investment_payment_historical_no_movement|check|Baixa histórica/);
  assert.equal(await count("investment_payment", `schedule_item_id = '${ids.b.item}'`), 0);
});

test("H6. isolamento: o tenant B não vê nem usa baixas históricas de A", async () => {
  const forged = await pay(fernando, ids.b.item, { paidOn: daysAgo(80), amount: "10,00", historical: "1" });
  assert.equal(forged?.ok, false);
  assert.equal(await count("investment_payment", "tenant_id = 'ten_fernando'"), 0);
  const view = await page(fernando, "/contas-a-pagar");
  assert.ok(!view.html.includes("Hugo Histórico") && !view.html.includes("HI-A"));
});

test("H7. tela: data anterior ao capital mostra o aviso de pagamento histórico e registra sem sair do capital", async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "pt-BR" });
  const [name, value] = robério.split("; ").find((cookie) => cookie.includes("session_token")).split(/=(.*)/s);
  await context.addCookies([{ name, value, domain: new URL(BASE).hostname, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
  const browserPage = await context.newPage();
  await browserPage.goto(`${BASE}/contas-a-pagar?aba=vencidos&q=HI-B`);
  await browserPage.getByRole("button", { name: "Registrar pagamento" }).first().click();
  const dialog = browserPage.getByRole("dialog");
  await dialog.getByLabel("Valor pago (R$)").waitFor();
  const date = daysAgo(80).split("-").reverse().join("/");
  await dialog.getByPlaceholder("dd/mm/aaaa").fill(date);
  await dialog.getByText("Pagamento histórico:").waitFor();
  assert.equal(await dialog.getByText("Sai do capital uma única vez").count(), 0);
  await dialog.getByRole("button", { name: /^Parcela \d+ \(/ }).click();
  if (SHOTS) await browserPage.screenshot({ path: `${SHOTS}/pagamento-historico-janela.png` });
  const capitalBefore = await available("ten_roberio");
  await dialog.getByRole("button", { name: "Registrar pagamento" }).click();
  await dialog.waitFor({ state: "detached", timeout: 20_000 });
  assert.equal(await one(`select historical from investment_payment where schedule_item_id = '${ids.b.item}'`), true);
  assert.equal(await available("ten_roberio"), capitalBefore);
  await context.close();
});

test("H8. nada fora do previsto mudou: o tenant B e os dados protegidos continuam iguais", async () => {
  assert.equal(await protectedHash(), hashBefore);
});
