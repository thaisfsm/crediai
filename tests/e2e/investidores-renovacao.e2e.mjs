// Renovação explícita de contratos de investimento (migração 0024), de ponta a ponta (HTTP + banco + navegador): exige
// o dinheiro no capital, confirmação e o principal restante visto; cria um contrato novo ligado ao anterior com novas
// condições, sem nova entrada no capital e sem renovar nada sozinho; o anterior fica encerrado com o histórico, seus
// rendimentos pendentes continuam pagáveis e o principal passa a ser devolvido só no novo; valores contratados não mudam
// em silêncio (servidor e gatilhos do banco); concorrência; isolamento; tela no desktop e no celular.
// SÓ em ambiente LOCAL e DESCARTÁVEL (ver tests/e2e/README.md), com os dados fictícios ten_roberio (A), ten_fernando (B)
// e ten_thais (MASTER).
//   E2E_DATABASE_URL=postgres://dono:senha@127.0.0.1:5432/crediai node --test tests/e2e/investidores-renovacao.e2e.mjs
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
  return { status: response.status, location: response.headers.get("location"), html: response.status === 200 ? text(await response.text()) : "" };
};
let counter = 0;
const requestId = () => `e2e-cp-${Date.now()}-${++counter}-abcdef`;

const count = (table, tenantId) => one(`select count(*)::int from ${table} where tenant_id = '${tenantId}'`);
// Operações, pagamentos, renovações, clientes, tenants, usuários e TUDO do tenant B (Fernando): nada disso pode mudar.
const protectedHash = () => one(`select md5(string_agg(x, '|' order by x)) from (
  select 'o'||row(o.*)::text x from loan_operation o union all select 'p'||row(p.*)::text from payment p union all select 'r'||row(r.*)::text from loan_renewal r
  union all select 'c'||row(c.*)::text from client c union all select 't'||row(t.*)::text from tenant t union all select 's'||row(s.*)::text from subscription s
  union all select 'w'||row(w.*)::text from wallet w union all select 'u'||concat_ws(',', u.id, u.name, u.email, u.role, u.tenant_id, u.active) from "user" u
  union all select 'mB'||row(m.*)::text from capital_movement m where tenant_id = 'ten_fernando'
  union all select 'vB'||row(v.*)::text from investor v where tenant_id = 'ten_fernando' union all select 'iB'||row(i.*)::text from investment i where tenant_id = 'ten_fernando') t`);

let robério, fernando, thais, hashBefore;
const ids = {};
const pay = (cookie, extra) => action(cookie, "registerInvestmentPaymentAction", { kind: "YIELD", amount: "100,00", paidOn: TODAY, method: "PIX", reference: "", notes: "", requestId: requestId(), ...extra });
const enter = (cookie, investmentId, extra = {}) => action(cookie, "registerInvestmentEntryAction", { investmentId, confirm: "1", requestId: requestId(), ...extra });
const renew = (cookie, investmentId, extra = {}) => investorAction(cookie, "renewInvestmentAction", { investmentId, confirm: "1", rate: "1,2", ratePeriod: "MONTHLY", startDate: daysAgo(1), termCount: "6", termUnit: "MONTHS", principalTerms: "50% no 3º mês e 50% no 6º", ...extra });
const itemOf = async (investmentId, number) => one(`select id from investment_schedule_item where investment_id = '${investmentId}' and number = ${number}`);
const movements = () => count("capital_movement", "ten_roberio");

test("preparação: contrato de R$ 20.000 com rendimentos e principal em duas partes (dados fictícios)", async () => {
  await admin(`update wallet set initial_capital_cents = 1000000, created_at = '${daysAgo(400)} 12:00:00+00' where tenant_id = 'ten_roberio'`);
  hashBefore = await protectedHash();
  robério = await login("roberio@teste.local");
  fernando = await login("fernando@teste.local");
  thais = await login("thais@teste.local");
  const investor = await investorAction(robério, "createInvestorAction", { personType: "PF", name: "Rui Renovação", document: "411.797.058-58" });
  assert.equal(investor?.ok, true, JSON.stringify(investor));
  ids.investor = investor.id;
  const create = async (contractNumber) => {
    const investment = await investorAction(robério, "createInvestmentAction", { investorId: ids.investor, amount: "20.000,00", rate: "2", ratePeriod: "MONTHLY", startDate: daysAgo(200), investedOn: daysAgo(200), contractNumber, termCount: "200", termUnit: "DAYS" });
    assert.equal(investment?.ok, true, JSON.stringify(investment));
    const lines = [
      { kind: "YIELD", dueDate: daysAgo(150), yieldAmount: "400,00", principalAmount: "" },
      { kind: "PRINCIPAL", dueDate: daysAgo(100), yieldAmount: "", principalAmount: "10.000,00" },
      { kind: "YIELD", dueDate: daysAgo(30), yieldAmount: "200,00", principalAmount: "" },
      { kind: "PRINCIPAL", dueDate: daysAgo(5), yieldAmount: "", principalAmount: "10.000,00" },
    ];
    const saved = await investorAction(robério, "saveInvestmentScheduleLinesAction", { investmentId: investment.id, mode: "replace", lines: JSON.stringify(lines) });
    assert.equal(saved?.ok, true, JSON.stringify(saved));
    return investment.id;
  };
  ids.a = await create("REN-A");
  ids.b = await create("REN-B");
});

test("RN1. renovar exige o dinheiro no capital, confirmação e o principal restante visto; nada muda sem isso", async () => {
  const before = await movements();
  assert.match((await renew(robério, ids.a, { principalCents: "2000000" }))?.error, /ainda não está registrado no capital/);
  const entry = await enter(robério, ids.a, { amountCents: "2000000", enteredOn: daysAgo(200) });
  assert.equal(entry?.ok, true, JSON.stringify(entry));
  assert.equal((await pay(robério, { scheduleItemId: await itemOf(ids.a, 1), kind: "YIELD", amount: "400,00", paidOn: daysAgo(150) }))?.ok, true);
  assert.equal((await pay(robério, { scheduleItemId: await itemOf(ids.a, 2), kind: "PRINCIPAL", amount: "10.000,00", paidOn: daysAgo(100) }))?.ok, true);
  assert.equal(await movements(), before + 3, "entrada + uma saída por baixa");
  assert.match((await renew(robério, ids.a, { confirm: "", principalCents: "1000000" }))?.error, /Confirme/);
  assert.match((await renew(robério, ids.a, { principalCents: "2000000" }))?.error, /mudou/, "valor diferente do restante");
  assert.match((await renew(robério, ids.a, { principalCents: "1000000", startDate: daysAgo(300) }))?.error, /antes do início/);
  assert.match((await renew(fernando, ids.a, { principalCents: "1000000" }))?.error, /não encontrado/, "outra carteira");
  assert.equal(await one(`select count(*)::int from investment where renewed_from_investment_id = '${ids.a}'`), 0);
  assert.equal(await one(`select status from investment where id = '${ids.a}'`), "ACTIVE");
});

test("RN2. renovação explícita: contrato novo com o principal restante, novas condições, sem nova entrada; o anterior fica encerrado com o histórico", async () => {
  const before = await movements();
  const renewed = await renew(robério, ids.a, { principalCents: "1000000", contractNumber: "REN-A2" });
  assert.equal(renewed?.ok, true, JSON.stringify(renewed));
  ids.a2 = renewed.id;
  const [child] = await admin(`select amount_cents::int, agreed_rate_bps, term_count, term_unit, status, renewed_from_investment_id, invested_on, principal_terms, capital_entry_rule from investment where id = '${ids.a2}'`);
  assert.deepEqual({ ...child }, { amount_cents: 1_000_000, agreed_rate_bps: 120, term_count: 6, term_unit: "MONTHS", status: "ACTIVE", renewed_from_investment_id: ids.a, invested_on: null, principal_terms: "50% no 3º mês e 50% no 6º", capital_entry_rule: child.capital_entry_rule });
  assert.equal(await one(`select status from investment where id = '${ids.a}'`), "CLOSED");
  assert.equal(await movements(), before, "nenhuma entrada nova no capital");
  assert.equal(await one(`select count(*)::int from investment_schedule_item where investment_id = '${ids.a}'`), 4, "cronograma anterior preservado");
  assert.equal(await one(`select count(*)::int from investment_payment where investment_id = '${ids.a}'`), 2, "baixas anteriores preservadas");
  assert.equal(await one(`select count(*)::int from admin_audit_log where action = 'INVESTMENT_RENEWED' and entity_id = '${ids.a2}'`), 1);
  const revisions = await admin(`select investment_id, description from investment_revision where description like 'Contrato%renova%' order by investment_id`);
  assert.equal(revisions.length, 2);
  // Nenhuma renovação automática: o contrato B, também vencido, continua como estava.
  assert.equal(await one(`select count(*)::int from investment where renewed_from_investment_id = '${ids.b}'`), 0);
  // Segunda renovação do mesmo contrato e entrada no contrato novo: recusadas.
  assert.match((await renew(robério, ids.a, { principalCents: "1000000" }))?.error, /já foi renovado/);
  assert.match((await enter(robério, ids.a2, { amountCents: "1000000", enteredOn: daysAgo(1) }))?.error, /renovação/);
});

test("RN3. depois da renovação: rendimento pendente do anterior ainda é pago; o principal só no contrato novo", async () => {
  const yieldItem = await itemOf(ids.a, 3);
  const principalItem = await itemOf(ids.a, 4);
  assert.equal((await pay(robério, { scheduleItemId: yieldItem, kind: "YIELD", amount: "200,00", paidOn: TODAY }))?.ok, true, "rendimento do contrato encerrado");
  assert.match((await pay(robério, { scheduleItemId: principalItem, kind: "PRINCIPAL", amount: "10.000,00", paidOn: TODAY }))?.error, /renovação/);
  // Cronograma do contrato novo: 50% e 50%, com rendimentos à parte; baixas do novo usam o capital da origem.
  const lines = [
    { kind: "YIELD", dueDate: daysAgo(-30), yieldAmount: "120,00", principalAmount: "" },
    { kind: "PRINCIPAL", dueDate: daysAgo(-90), yieldAmount: "", principalAmount: "5.000,00" },
    { kind: "PRINCIPAL", dueDate: daysAgo(-180), yieldAmount: "", principalAmount: "5.000,00" },
  ];
  assert.equal((await investorAction(robério, "saveInvestmentScheduleLinesAction", { investmentId: ids.a2, mode: "replace", lines: JSON.stringify(lines) }))?.ok, true);
  assert.match((await investorAction(robério, "saveInvestmentScheduleLinesAction", { investmentId: ids.a2, mode: "append", lines: JSON.stringify([{ kind: "PRINCIPAL", dueDate: daysAgo(-200), principalAmount: "0,01", yieldAmount: "" }]) }))?.error, /principal/i, "principal agendado acima do renovado");
  const principal = await itemOf(ids.a2, 2);
  assert.equal((await pay(robério, { scheduleItemId: principal, kind: "PRINCIPAL", amount: "5.000,00", paidOn: TODAY }))?.ok, true, "devolução antecipada no contrato novo");
  assert.equal((await pay(robério, { scheduleItemId: principal, kind: "PRINCIPAL", amount: "0,01", paidOn: TODAY }))?.ok, false, "não passa do saldo");
  // Painéis: o anterior mostra o principal que passou para a renovação; o novo mostra a origem.
  const old = await page(robério, `/investidores/investimentos/${ids.a}`);
  for (const expected of ["Este contrato foi renovado", "Principal restante R$ 0,00", "R$ 10.000,00 passaram para a renovação", "Principal renovado"]) assert.ok(old.html.includes(expected), `anterior sem "${expected}"`);
  assert.ok(!old.html.includes("Renovar contrato"));
  assert.ok((await page(thais, `/investidores/investimentos/${ids.a2}`)).html.includes("Este contrato é a renovação de"), "o MASTER vê a renovação");
  const fresh = await page(robério, `/investidores/investimentos/${ids.a2}`);
  for (const expected of ["Este contrato é a renovação de", "Veio da renovação", "Principal restante R$ 5.000,00", "Principal devolvido R$ 5.000,00", "Prazo 6 meses"]) assert.ok(fresh.html.includes(expected), `novo sem "${expected}"`);
  // Contas a Pagar: o principal que passou para a renovação não é mais dívida do contrato anterior.
  const payables = await page(robério, "/contas-a-pagar?q=rui&tipo=principal&situacao=vencida");
  assert.ok(payables.html.includes("Contrato REN-B"), "o contrato B (não renovado) continua com a devolução vencida");
  assert.ok(!/Contrato REN-A(?!2)/.test(payables.html), "o contrato renovado não tem devolução vencida");
});

test("RN4. valores contratados não mudam em silêncio: servidor e banco recusam alterar ou cancelar contratos da renovação", async () => {
  const fields = { amount: "10.000,00", rate: "1,2", ratePeriod: "MONTHLY", startDate: daysAgo(1), termCount: "6", termUnit: "MONTHS", contractNumber: "REN-A2" };
  assert.equal((await investorAction(robério, "updateInvestmentAction", { investmentId: ids.a2, ...fields, amount: "12.000,00", status: "ACTIVE" }))?.ok, false, "valor do contrato renovado não muda");
  assert.equal((await investorAction(robério, "updateInvestmentAction", { investmentId: ids.a2, ...fields, status: "CANCELED" }))?.ok, false, "renovação não é cancelada");
  assert.equal((await investorAction(robério, "updateInvestmentAction", { investmentId: ids.a2, ...fields, rate: "1,3", status: "ACTIVE" }))?.ok, true, "outras condições podem ser corrigidas, com histórico");
  await assert.rejects(admin(`update investment set amount_cents = 1 where id = '${ids.a2}'`));
  await assert.rejects(admin(`update investment set status = 'CANCELED' where id = '${ids.a}'`));
  await assert.rejects(admin(`update investment set amount_cents = 1 where id = '${ids.a}'`));
  await assert.rejects(admin(`update investment set renewed_from_investment_id = null where id = '${ids.a2}'`));
  await assert.rejects(admin(`insert into investment (id, tenant_id, investor_id, amount_cents, agreed_rate_bps, rate_period, start_date, status, renewed_from_investment_id) values ('ivt_dup', 'ten_roberio', '${ids.investor}', 1000000, 100, 'MONTHLY', '${TODAY}', 'ACTIVE', '${ids.a}')`), "segunda renovação do mesmo contrato");
  await assert.rejects(admin(`insert into investment (id, tenant_id, investor_id, amount_cents, agreed_rate_bps, rate_period, start_date, status, renewed_from_investment_id) values ('ivt_wrong', 'ten_roberio', '${ids.investor}', 2000000, 100, 'MONTHLY', '${TODAY}', 'ACTIVE', '${ids.b}')`), "renovação sem capital e com valor errado");
  await assert.rejects(admin(`insert into investment (id, tenant_id, investor_id, amount_cents, agreed_rate_bps, rate_period, start_date, status, renewed_from_investment_id) values ('ivt_x', 'ten_fernando', 'inv_old_f', 1000000, 100, 'MONTHLY', '${TODAY}', 'ACTIVE', '${ids.a}')`), "renovação em outra carteira");
});

test("RN5. concorrência: duas renovações simultâneas do mesmo contrato criam um só contrato novo; baixa e edição da mesma linha não travam", async () => {
  assert.equal((await enter(robério, ids.b, { amountCents: "2000000", enteredOn: daysAgo(200) }))?.ok, true);
  const results = await Promise.all([renew(robério, ids.b, { principalCents: "2000000" }), renew(robério, ids.b, { principalCents: "2000000" })]);
  assert.deepEqual(results.map((result) => Boolean(result?.ok)).sort(), [false, true], JSON.stringify(results));
  assert.equal(await one(`select count(*)::int from investment where renewed_from_investment_id = '${ids.b}'`), 1);
  ids.b2 = results.find((result) => result?.ok).id;
  // Edição do cronograma e baixa da mesma linha ao mesmo tempo: as duas terminam (sem impasse) e o resultado é coerente.
  assert.equal((await investorAction(robério, "saveInvestmentScheduleLinesAction", { investmentId: ids.b2, mode: "replace", lines: JSON.stringify([{ kind: "YIELD", dueDate: daysAgo(0), yieldAmount: "300,00", principalAmount: "" }]) }))?.ok, true);
  const item = await itemOf(ids.b2, 1);
  const [paid, edited] = await Promise.all([
    pay(robério, { scheduleItemId: item, kind: "YIELD", amount: "300,00", paidOn: TODAY }),
    investorAction(robério, "updateInvestmentScheduleItemAction", { investmentId: ids.b2, itemId: item, kind: "YIELD", dueDate: daysAgo(-10), yieldAmount: "250,00", principalAmount: "" }),
  ]);
  assert.ok(paid && edited, "as duas respostas chegaram");
  const [row] = await admin(`select yield_cents::int, (select coalesce(sum(amount_cents), 0)::int from investment_payment where schedule_item_id = '${item}') paid from investment_schedule_item where id = '${item}'`);
  assert.ok(row.paid <= row.yield_cents, `nunca pago acima da linha: ${JSON.stringify(row)} ${JSON.stringify([paid, edited])}`);
  if (paid.ok) assert.equal(edited.ok && row.yield_cents === 25_000, false, "linha paga não muda de valor depois da baixa");
});

test("RN6. tela: renovar pelo formulário (desktop) e abrir o contrato novo", async () => {
  const investment = await investorAction(robério, "createInvestmentAction", { investorId: ids.investor, amount: "8.000,00", rate: "2", ratePeriod: "MONTHLY", startDate: daysAgo(60), investedOn: daysAgo(60), contractNumber: "REN-UI", termCount: "2", termUnit: "MONTHS" });
  assert.equal((await enter(robério, investment.id, { amountCents: "800000", enteredOn: daysAgo(60) }))?.ok, true);
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  for (const [label, viewport] of [["desktop", { width: 1440, height: 900 }], ["celular", { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport });
    const [name, value] = robério.split("; ").find((cookie) => cookie.includes("session_token")).split(/=(.*)/s);
    await context.addCookies([{ name, value, domain: new URL(BASE).hostname, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
    const browserPage = await context.newPage();
    await browserPage.goto(`${BASE}/investidores/investimentos/${investment.id}`);
    const section = browserPage.getByRole("region", { name: "Renovação do contrato" });
    if (label === "celular") {
      // O contrato já foi renovado no desktop: a seção some e o aviso aponta para o contrato novo.
      assert.equal(await section.count(), 0);
      await browserPage.getByText("Este contrato foi renovado").waitFor();
      assert.equal(await browserPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "sem rolagem horizontal (celular)");
      await context.close();
      continue;
    }
    await section.getByRole("button", { name: "Renovar contrato" }).click();
    const form = section.getByRole("form", { name: "Dados da renovação" });
    await form.getByLabel("Principal renovado").waitFor();
    assert.equal((await form.getByLabel("Principal renovado").inputValue()).replace(/\s/g, " "), "R$ 8.000,00");
    await form.getByLabel("Taxa combinada (%)").fill("1,8");
    await form.getByLabel("Prazo (opcional)").fill("3");
    await form.getByLabel("Regras de devolução do principal (opcional)").fill("Devolução integral no vencimento");
    if (SHOTS) await section.screenshot({ path: `${SHOTS}/renovacao-formulario-${label}.png` });
    await form.getByRole("button", { name: "Confirmar renovação" }).click();
    assert.equal(await one(`select count(*)::int from investment where renewed_from_investment_id = '${investment.id}'`), 0, "sem a confirmação marcada nada é gravado");
    await form.getByLabel(/Confirmo a renovação/).check();
    await form.getByRole("button", { name: "Confirmar renovação" }).click();
    await browserPage.getByText("Este contrato é a renovação de").waitFor();
    const childId = await one(`select id from investment where renewed_from_investment_id = '${investment.id}'`);
    assert.ok(browserPage.url().endsWith(`/investidores/investimentos/${childId}`), browserPage.url());
    assert.deepEqual({ ...(await admin(`select amount_cents::int, agreed_rate_bps, term_count from investment where id = '${childId}'`))[0] }, { amount_cents: 800_000, agreed_rate_bps: 180, term_count: 3 });
    if (SHOTS) await browserPage.screenshot({ path: `${SHOTS}/renovacao-contrato-novo-${label}.png`, fullPage: true });
    await context.close();
  }
});

test("RN7. nada fora do previsto mudou (operações, clientes, tenants, usuários e tudo do tenant B)", async () => {
  assert.equal(await protectedHash(), hashBefore);
});
