// Regra da entrada no capital para a baixa de investidores (migração 0023), de ponta a ponta (HTTP + banco):
//   * contrato novo sem entrada: baixa bloqueada; com a entrada: liberada;
//   * contrato antigo com aporte anterior indicado: liberada se houver capital; sem evidência: bloqueada com explicação;
//   * tentativas de burla pela API, ids forjados, envios simultâneos e direto no banco; isolamento entre tenants e MASTER.
// "Contrato antigo" = contrato que já existia quando a 0023 rodou (capital_entry_rule NULL). Aqui ele é simulado no banco
// descartável desligando o gatilho que marca todo contrato novo e limpando a marca (o mesmo estado que a migração deixa
// nos contratos existentes, sem backfill). SÓ em ambiente LOCAL e DESCARTÁVEL, com os dados fictícios ten_roberio (A),
// ten_fernando (B) e ten_thais (MASTER). Rodar com o servidor COM BYPASSRLS (como a produção) e, de novo, sem ele.
//   E2E_DATABASE_URL=postgres://dono:senha@127.0.0.1:5432/crediai node --test tests/e2e/regra-entrada.e2e.mjs
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
const requestId = () => `e2e-re-${Date.now()}-${++counter}-abcdef`;
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

test("preparação: carteira A com R$ 10.000, um aporte comum de R$ 5.000 e contratos novos e antigos (dados fictícios)", async () => {
  await admin(`update wallet set initial_capital_cents = 1000000, created_at = '${daysAgo(40)} 12:00:00+00' where tenant_id = 'ten_roberio'`);
  hashBefore = await protectedHash();
  robério = await login("roberio@teste.local");
  fernando = await login("fernando@teste.local");
  thais = await login("thais@teste.local");
  const investor = await investorAction(robério, "createInvestorAction", { personType: "PF", document: "31972257323", name: "Rita Regra" });
  assert.equal(investor?.ok, true, JSON.stringify(investor));
  ids.investor = investor.id;
  const contribution = await action(robério, "registerContributionAction", { amount: "5.000,00", occurredAt: daysAgo(20), notes: "aporte comum" }, "/");
  assert.equal(contribution?.ok, true, JSON.stringify(contribution));
  ids.aporte = await one(`select id from capital_movement where tenant_id = 'ten_roberio' and kind = 'CONTRIBUTION'`);
  ids.novo = await contract(robério, "RE-NOVO", "3.000,00", daysAgo(15));
  ids.antigo = await contract(robério, "RE-ANTIGO", "5.000,00", daysAgo(20));
  ids.semEvidencia = await contract(robério, "RE-SEM", "2.000,00", daysAgo(20));
  ids.corrida = await contract(robério, "RE-CORRIDA", "1.000,00", daysAgo(20));
  ids.caro = await contract(robério, "RE-CARO", "1.000,00", daysAgo(20), "90.000,00");
  // Contrato cadastrado agora nasce com a regra; os "antigos" ficam sem a marca, como a migração deixa os existentes.
  assert.equal(await one(`select capital_entry_rule from investment where id = '${ids.novo.id}'`), "REQUIRED");
  for (const legacy of [ids.antigo, ids.semEvidencia, ids.corrida, ids.caro]) await makeLegacy(legacy.id);
  assert.equal(await count("investment", `id in ('${ids.antigo.id}','${ids.semEvidencia.id}') and capital_entry_rule is null`), 2);
});

test("RE1. contrato novo sem entrada: baixa bloqueada na tela, no servidor e no banco; nada gravado", async () => {
  const before = await nothingWritten();
  const result = await pay(robério, ids.novo.item);
  assert.equal(result?.ok, false);
  assert.match(result.error, /Registre primeiro a entrada deste investimento no capital/);
  const { html } = await page(robério, "/contas-a-pagar?q=RE-NOVO");
  assert.ok(html.includes("Baixa bloqueada") && html.includes("registre a entrada no capital"), "a tela explica o bloqueio");
  assert.ok(!html.includes("Registrar baixa"), "sem botão de baixa no contrato novo sem entrada");
  const detail = await page(robério, `/investidores/investimentos/${ids.novo.id}`);
  assert.ok(detail.html.includes("ficam bloqueadas até a entrada do investimento ser registrada no capital"));
  // Direto no banco (papel dono, sem RLS), com a saída certa: o gatilho recusa.
  await assert.rejects(admin(`insert into capital_movement (id, tenant_id, kind, amount_cents, occurred_at, category, description, source, idempotency_key, cycle_number)
      values ('cap_re1', 'ten_roberio', 'WITHDRAWAL', 100, '${TODAY}', 'INVESTOR_YIELD_PAYMENT', 'x', 'INVESTOR', 'k-re1', 1);
    insert into investment_payment (id, tenant_id, investment_id, schedule_item_id, kind, amount_cents, paid_on, method, capital_movement_id, idempotency_key)
      values ('ivp_re1', 'ten_roberio', '${ids.novo.id}', '${ids.novo.item}', 'YIELD', 100, '${TODAY}', 'PIX', 'cap_re1', 'k-re1')`), /registre antes a entrada/);
  assert.deepEqual(await nothingWritten(), before);
});

test("RE2. contrato novo com a entrada registrada: baixa liberada (uma saída ligada)", async () => {
  assert.equal((await enter(robério, ids.novo.id, 300_000, daysAgo(15)))?.ok, true);
  const before = await available("ten_roberio");
  const result = await pay(robério, ids.novo.item);
  assert.equal(result?.ok, true, JSON.stringify(result));
  assert.equal(before - await available("ten_roberio"), 10_000);
  // Aporte anterior não serve para contrato novo (nem pela API).
  assert.match((await declare(robério, ids.novo.id, ids.aporte)).error, /cadastrado com a regra da entrada/);
});

test("RE3. contrato antigo com aporte anterior indicado: baixa liberada se houver capital; sem capital, recusada", async () => {
  const { html } = await page(robério, `/investidores/investimentos/${ids.antigo.id}`);
  assert.ok(html.includes("Contrato cadastrado antes da regra da entrada no capital") && html.includes("Indicar aporte anterior"));
  assert.match((await pay(robério, ids.antigo.item)).error, /Contrato cadastrado antes da regra da entrada/);
  const movementsBefore = await count("capital_movement", "tenant_id = 'ten_roberio'");
  const balanceBefore = await available("ten_roberio");
  assert.match((await declare(robério, ids.antigo.id, ids.aporte, { confirm: "" })).error, /Confirme/);
  const declared = await declare(robério, ids.antigo.id, ids.aporte);
  assert.equal(declared?.ok, true, JSON.stringify(declared));
  // Indicar o aporte não lança nada no capital; fica auditado.
  assert.equal(await count("capital_movement", "tenant_id = 'ten_roberio'"), movementsBefore);
  assert.equal(await available("ten_roberio"), balanceBefore);
  const [audit] = await admin(`select * from admin_audit_log where action = 'INVESTMENT_PRIOR_CONTRIBUTION_DECLARED' and entity_id = '${ids.antigo.id}'`);
  assert.equal(audit.actor_user_id, "u_roberio");
  assert.equal(audit.after.capitalMovementId, ids.aporte);
  const paid = await pay(robério, ids.antigo.item);
  assert.equal(paid?.ok, true, JSON.stringify(paid));
  assert.equal(balanceBefore - await available("ten_roberio"), 10_000);
  // Outro contrato antigo, com o mesmo aporte indicado, mas obrigação maior que o capital: a regra de capital continua valendo.
  assert.equal((await declare(robério, ids.caro.id, ids.aporte))?.ok, true);
  const before = await nothingWritten();
  const expensive = await pay(robério, ids.caro.item, { amount: "90.000,00" });
  assert.equal(expensive?.ok, false);
  assert.match(expensive.error, /Saldo insuficiente|ficaria negativo/);
  assert.deepEqual(await nothingWritten(), before);
  const detail = await page(robério, `/investidores/investimentos/${ids.antigo.id}`);
  assert.ok(detail.html.includes("Por aporte anterior") && !detail.html.includes("Registrar a entrada deste investimento no capital"));
});

test("RE4. contrato antigo sem evidência: baixa bloqueada com explicação; nada é classificado sozinho", async () => {
  const before = await nothingWritten();
  const result = await pay(robério, ids.semEvidencia.item);
  assert.equal(result?.ok, false);
  assert.match(result.error, /registre a entrada do investimento no capital ou indique, na página do contrato, o aporte/);
  const { html } = await page(robério, "/contas-a-pagar?q=RE-SEM");
  assert.ok(html.includes("indique a entrada ou o aporte anterior"));
  // A tentativa não grava nada nem marca o contrato: continua antigo, sem entrada e sem aporte indicado.
  assert.deepEqual(await nothingWritten(), before);
  assert.equal(await one(`select capital_entry_rule from investment where id = '${ids.semEvidencia.id}'`), null);
  assert.equal(await count("investment_capital_entry", `investment_id = '${ids.semEvidencia.id}'`), 0);
});

test("RE5. burla: ids forjados, aporte inválido, entrada × aporte, estorno e cancelamento (API e banco)", async () => {
  const entryMovement = await one(`select capital_movement_id from investment_capital_entry where investment_id = '${ids.novo.id}'`);
  // Aporte de investidor, aporte inexistente e aporte de outro tenant (Fernando tem um no fixture).
  assert.match((await declare(robério, ids.semEvidencia.id, entryMovement)).error, /não pode ser usado/);
  assert.match((await declare(robério, ids.semEvidencia.id, "cap_inexistente")).error, /não encontrado/);
  const fernandoMovement = await one(`select id from capital_movement where tenant_id = 'ten_fernando' limit 1`);
  assert.match((await declare(robério, ids.semEvidencia.id, fernandoMovement)).error, /não encontrado/);
  // Aporte já indicado no contrato: segunda indicação recusada; entrada depois do aporte anterior recusada (em dobro).
  assert.match((await declare(robério, ids.antigo.id, ids.aporte)).error, /já foi indicado/);
  assert.match((await enter(robério, ids.antigo.id, 500_000, daysAgo(20))).error, /em dobro/);
  // O aporte indicado não se estorna, nem pela API, nem direto no banco.
  assert.match((await action(robério, "reverseContributionAction", { movementId: ids.aporte }, "/")).error, /não pode ser estornado/);
  await assert.rejects(admin(`insert into capital_movement (id, tenant_id, kind, amount_cents, occurred_at, reversed_movement_id, cycle_number) values ('cap_rev', 'ten_roberio', 'CONTRIBUTION_REVERSAL', 500000, '${TODAY}', '${ids.aporte}', 1)`), /não pode ser estornado/);
  const capital = await fetch(`${BASE}/?tela=capital`, { headers: { cookie: robério } }).then((response) => response.text());
  assert.ok(text(capital).includes("Ligado a contrato de investidor"));
  // Contrato ligado ao capital não se cancela (servidor e banco) e a marca da regra não muda.
  assert.match((await investorAction(robério, "updateInvestmentAction", { investmentId: ids.antigo.id, amount: "5.000,00", rate: "1", ratePeriod: "MONTHLY", startDate: daysAgo(20), contractNumber: "RE-ANTIGO", status: "CANCELED" })).error, /não pode ser cancelado/);
  await assert.rejects(admin(`update investment set status = 'CANCELED' where id = '${ids.antigo.id}'`), /não pode ser cancelado/);
  await assert.rejects(admin(`update investment set amount_cents = 1 where id = '${ids.novo.id}'`), /valor e a data do investimento não mudam/);
  await assert.rejects(admin(`update investment set capital_entry_rule = null where id = '${ids.novo.id}'`), /não pode ser alterada/);
  await assert.rejects(admin(`update investment set capital_entry_rule = 'REQUIRED' where id = '${ids.semEvidencia.id}'`), /não pode ser alterada/);
  // Contrato inserido direto no banco "como antigo" (NULL forjado): o gatilho grava a regra mesmo assim.
  await admin(`insert into investment (id, tenant_id, investor_id, amount_cents, agreed_rate_bps, rate_period, start_date, capital_entry_rule) values ('inv_forjado', 'ten_roberio', '${ids.investor}', 100, 0, 'MONTHLY', '${TODAY}', null)`);
  assert.equal(await one(`select capital_entry_rule from investment where id = 'inv_forjado'`), "REQUIRED");
  await assert.rejects(admin(`insert into investment_prior_contribution (id, tenant_id, investment_id, capital_movement_id, idempotency_key) values ('ipc_x', 'ten_roberio', 'inv_forjado', '${ids.aporte}', 'k-ipc-x')`), /só vale para contrato cadastrado antes/);
  // Aporte indicado não se altera nem se apaga; aporte de outro tenant não entra nem direto no banco.
  await assert.rejects(admin(`update investment_prior_contribution set capital_movement_id = capital_movement_id where investment_id = '${ids.antigo.id}'`), /não podem ser alterados/);
  await assert.rejects(admin(`delete from investment_prior_contribution where investment_id = '${ids.antigo.id}'`), /não podem ser alterados/);
  await assert.rejects(admin(`insert into investment_prior_contribution (id, tenant_id, investment_id, capital_movement_id, idempotency_key) values ('ipc_y', 'ten_roberio', '${ids.semEvidencia.id}', '${fernandoMovement}', 'k-ipc-y')`), /foreign key|violates|não é um aporte/);
  await assert.rejects(admin(`insert into investment_prior_contribution (id, tenant_id, investment_id, capital_movement_id, idempotency_key) values ('ipc_z', 'ten_roberio', '${ids.semEvidencia.id}', '${entryMovement}', 'k-ipc-z')`), /não é um aporte comum/);
  assert.equal(await count("investment_prior_contribution", `investment_id = '${ids.semEvidencia.id}'`), 0);
});

test("RE6. concorrência: entrada e aporte anterior ao mesmo tempo no mesmo contrato antigo; só um passa", async () => {
  const [entry, prior, prior2] = await Promise.all([
    enter(robério, ids.corrida.id, 100_000, daysAgo(20)), declare(robério, ids.corrida.id, ids.aporte), declare(robério, ids.corrida.id, ids.aporte),
  ]);
  assert.equal([entry, prior, prior2].filter((result) => result?.ok).length, 1, JSON.stringify([entry, prior, prior2]));
  const evidence = await count("investment_capital_entry", `investment_id = '${ids.corrida.id}'`) + await count("investment_prior_contribution", `investment_id = '${ids.corrida.id}'`);
  assert.equal(evidence, 1);
  // Mesmo formulário reenviado: reconhecido, nada em dobro.
  const fields = { requestId: requestId() };
  const results = await Promise.all([1, 2].map(() => declare(robério, ids.semEvidencia.id, ids.aporte, fields)));
  assert.ok(results.every((result) => result?.ok), JSON.stringify(results));
  assert.equal(await count("investment_prior_contribution", `investment_id = '${ids.semEvidencia.id}'`), 1);
});

test("RE7. isolamento: tenant B e MASTER não indicam aporte nem pagam contratos do A, com ids forjados", async () => {
  const novoLegado = await contract(robério, "RE-ISOLADO", "1.000,00", daysAgo(20));
  await makeLegacy(novoLegado.id);
  const before = await nothingWritten();
  for (const cookie of [fernando, thais]) {
    assert.match((await declare(cookie, novoLegado.id, ids.aporte)).error, /não encontrado nesta carteira|Defina o capital/);
    assert.match((await pay(cookie, novoLegado.item)).error, /não encontrada nesta carteira/);
  }
  const master = await page(thais, `/investidores/investimentos/${novoLegado.id}`);
  assert.ok(master.html.includes("outra carteira") && !master.html.includes("Indicar aporte anterior"));
  assert.deepEqual(await nothingWritten(), before);
  assert.equal(await count("investment_prior_contribution", "tenant_id <> 'ten_roberio'"), 0);
});

test("RE8. telas no desktop e no celular: contrato antigo com a indicação de aporte e baixa bloqueada explicada", async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const legacyId = await one(`select id from investment where contract_number = 'RE-ISOLADO'`);
  for (const [label, viewport] of [["desktop", { width: 1440, height: 900 }], ["celular", { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport });
    const [name, value] = robério.split("; ").find((cookie) => cookie.includes("session_token")).split(/=(.*)/s);
    await context.addCookies([{ name, value, domain: new URL(BASE).hostname, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
    const browserPage = await context.newPage();
    await browserPage.goto(`${BASE}/contas-a-pagar?q=RE-ISOLADO`);
    await browserPage.getByText("Baixa bloqueada").first().waitFor();
    if (SHOTS) await browserPage.screenshot({ path: `${SHOTS}/regra-entrada-contas-${label}.png`, fullPage: true });
    await browserPage.goto(`${BASE}/investidores/investimentos/${legacyId}`);
    await browserPage.getByRole("button", { name: "Indicar aporte anterior" }).click();
    const form = browserPage.locator('[aria-label="Indicar aporte anterior"]');
    await form.locator('select[name="movementId"]').waitFor();
    if (SHOTS) await browserPage.screenshot({ path: `${SHOTS}/regra-entrada-contrato-${label}.png`, fullPage: true });
    assert.ok(await browserPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `sem rolagem horizontal (${label})`);
    await context.close();
  }
});

test("RE9. nada fora do previsto mudou: operações, pagamentos de clientes, clientes, carteiras, tenants, usuários e o tenant B", async () => {
  assert.equal(await protectedHash(), hashBefore);
});
