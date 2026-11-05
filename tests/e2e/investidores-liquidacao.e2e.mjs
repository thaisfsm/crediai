// Liquidação antecipada do contrato de investidor, de ponta a ponta (HTTP + banco + navegador): confirmação e principal
// visto obrigatórios; só a própria carteira; devolve o principal que falta e o rendimento final como baixas (uma saída de
// capital cada), encerra as parcelas em aberto sem tocar nas pagas, fecha o contrato; reenvio e envios simultâneos gravam
// uma vez; tela no desktop e no celular; nada fora do previsto muda. SÓ em ambiente LOCAL e DESCARTÁVEL.
//   E2E_DATABASE_URL=postgres://dono:senha@127.0.0.1:5432/crediai node --test tests/e2e/investidores-liquidacao.e2e.mjs
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
const pay = (cookie, extra) => action(cookie, "registerInvestmentPaymentAction", { kind: "YIELD", amount: "600,00", paidOn: TODAY, method: "PIX", reference: "", notes: "", requestId: requestId(), ...extra });
const enter = (cookie, investmentId, extra = {}) => action(cookie, "registerInvestmentEntryAction", { investmentId, confirm: "1", requestId: requestId(), ...extra });
const settle = (cookie, investmentId, extra = {}) => action(cookie, "settleInvestmentEarlyAction", { investmentId, confirm: "1", settledOn: TODAY, principalCents: "2000000", yieldAmount: "300,00", settlementKind: "COMPANY_DECISION", feeAmount: "0,00", proRataCents: "0", method: "PIX", reference: "", notes: "", requestId: requestId(), ...extra });
const itemOf = async (investmentId, number) => one(`select id from investment_schedule_item where investment_id = '${investmentId}' and number = ${number}`);
const movements = () => count("capital_movement", "ten_roberio");
const capitalOut = () => one(`select coalesce(sum(amount_cents), 0)::int from capital_movement where tenant_id = 'ten_roberio' and kind = 'WITHDRAWAL'`);

// Contrato como o do print: R$ 20.000, 12 rendimentos de R$ 600 (3 pagos) e o principal no fim.
// dueDate(i): vencimento do i-ésimo rendimento (0 a 11); padrão: a cada 30 dias, o 4º vence hoje.
async function contract(contractNumber, { startDate = daysAgo(100), dueDate = (i) => daysAgo(90 - i * 30), amount = "20.000,00", amountCents = "2000000" } = {}) {
  const investment = await investorAction(robério, "createInvestmentAction", { investorId: ids.investor, amount, rate: "3", ratePeriod: "MONTHLY", startDate, investedOn: startDate, contractNumber, termCount: "400", termUnit: "DAYS" });
  assert.equal(investment?.ok, true, JSON.stringify(investment));
  const lines = Array.from({ length: 12 }, (_, i) => ({ kind: "YIELD", dueDate: dueDate(i), yieldAmount: "600,00", principalAmount: "" }));
  lines.push({ kind: "PRINCIPAL", dueDate: dueDate(11), yieldAmount: "", principalAmount: amount });
  const saved = await investorAction(robério, "saveInvestmentScheduleLinesAction", { investmentId: investment.id, mode: "replace", lines: JSON.stringify(lines) });
  assert.equal(saved?.ok, true, JSON.stringify(saved));
  assert.equal((await enter(robério, investment.id, { amountCents, enteredOn: startDate }))?.ok, true);
  for (const n of [1, 2, 3]) assert.equal((await pay(robério, { scheduleItemId: await itemOf(investment.id, n), paidOn: dueDate(n - 1) }))?.ok, true);
  return investment.id;
}
// Contrato como o do Gumercindo (dados fictícios): início 06/07/2026, rendimento de R$ 600 todo dia 06, 3 pagos (ago–out).
const gumercindoDue = (i) => { const month = 8 + i; return `${month > 12 ? 2027 : 2026}-${String(((month - 1) % 12) + 1).padStart(2, "0")}-06`; };
const gumercindo = (contractNumber) => contract(contractNumber, { startDate: "2026-07-06", dueDate: gumercindoDue });
// Saldo do capital pelos movimentos (entradas − saídas) da carteira A.
const capitalNet = () => one(`select coalesce(sum(case when kind in ('CONTRIBUTION', 'OTHER_INCOME') then amount_cents else -amount_cents end), 0)::bigint::text from capital_movement where tenant_id = 'ten_roberio'`).then(Number);

test("preparação: dois contratos de R$ 20.000 com 3 rendimentos pagos (dados fictícios)", async () => {
  await admin(`update wallet set initial_capital_cents = 10000000, created_at = '${daysAgo(400)} 12:00:00+00' where tenant_id = 'ten_roberio'`);
  hashBefore = await protectedHash();
  robério = await login("roberio@teste.local");
  fernando = await login("fernando@teste.local");
  thais = await login("thais@teste.local");
  const investor = await investorAction(robério, "createInvestorAction", { personType: "PF", name: "Gil Liquidação", document: "411.797.058-58" });
  assert.equal(investor?.ok, true, JSON.stringify(investor));
  ids.investor = investor.id;
  ids.a = await contract("LIQ-A");
  ids.b = await contract("LIQ-B");
});

test("LQ1. recusas não gravam nada: sem confirmação, principal diferente do visto, data futura ou antes do início, rendimento negativo, outra carteira e MASTER", async () => {
  const before = { movements: await movements(), items: await one(`select count(*)::int from investment_schedule_item where investment_id = '${ids.a}'`) };
  assert.match((await settle(robério, ids.a, { confirm: "" }))?.error, /Confirme/);
  assert.match((await settle(robério, ids.a, { principalCents: "1900000" }))?.error, /mudou/);
  assert.match((await settle(robério, ids.a, { settledOn: daysAgo(-1) }))?.error, /depois de hoje/);
  assert.match((await settle(robério, ids.a, { settledOn: daysAgo(200) }))?.error, /início do contrato/);
  assert.match((await settle(robério, ids.a, { yieldAmount: "-5" }))?.error, /rendimento/i);
  assert.match((await settle(fernando, ids.a))?.error, /não encontrado/, "outra carteira");
  assert.match((await settle(thais, ids.a))?.error, /não encontrado/, "MASTER não mexe no capital de outra carteira");
  assert.match((await settle(robério, ids.a, { settlementKind: "" }))?.error, /Escolha o tipo/);
  assert.match((await settle(robério, ids.a, { feeAmount: "500,00" }))?.error, /só se aplica ao resgate/, "decisão da empresa não aceita taxa");
  assert.match((await settle(robério, ids.a, { settlementKind: "INVESTOR_REQUEST", feeAmount: "20.300,01" }))?.error, /negativo/);
  assert.match((await settle(robério, ids.a, { settlementKind: "INVESTOR_REQUEST", feeAmount: "-1" }))?.error, /zero ou um valor positivo/);
  assert.match((await settle(robério, ids.a, { proRataCents: "100" }))?.error, /pro-rata mudou/);
  assert.match((await settle(robério, ids.a, { yieldAmount: "700,00" }))?.error, /acima do devido/);
  assert.match((await settle(robério, ids.a, { settledOn: daysAgo(70), yieldAmount: "0" }))?.error, /última baixa/);
  assert.equal(await movements(), before.movements);
  assert.equal(await one(`select count(*)::int from investment_schedule_item where investment_id = '${ids.a}'`), before.items);
  assert.equal(await one(`select status from investment where id = '${ids.a}'`), "ACTIVE");
});

test("LQ2. liquidação: principal R$ 20.000 + rendimento final R$ 300 saem do capital uma vez cada; parcelas em aberto encerradas; pagas intactas; contrato encerrado", async () => {
  const paidBefore = await one(`select md5(string_agg(row(p.*)::text, '|' order by id)) from investment_payment p where investment_id = '${ids.a}'`);
  const before = { movements: await movements(), out: await capitalOut() };
  const request = requestId();
  const result = await settle(robério, ids.a, { requestId: request });
  assert.equal(result?.ok, true, JSON.stringify(result));
  assert.equal(await movements(), before.movements + 2);
  assert.equal(await capitalOut(), before.out + 2_030_000);
  assert.equal(await one(`select status from investment where id = '${ids.a}'`), "CLOSED");
  assert.equal(await one(`select md5(string_agg(row(p.*)::text, '|' order by id)) from investment_payment p where investment_id = '${ids.a}' and idempotency_key not like '${request}%'`), paidBefore, "baixas anteriores sem mudança");
  const items = await admin(`select number, due_date::text, yield_cents::int, principal_cents::int, description from investment_schedule_item where investment_id = '${ids.a}' order by number`);
  assert.deepEqual(items.map((item) => item.number), [1, 2, 3, 14]);
  assert.deepEqual({ ...items[3] }, { number: 14, due_date: TODAY, yield_cents: 30_000, principal_cents: 2_000_000, description: "Liquidação antecipada" });
  const open = await one(`select coalesce(sum(s.yield_cents + s.principal_cents), 0)::int - coalesce((select sum(amount_cents) from investment_payment where investment_id = '${ids.a}'), 0)::int from investment_schedule_item s where s.investment_id = '${ids.a}'`);
  assert.equal(open, 0, "nada em aberto no cronograma");
  assert.equal(await one(`select count(*)::int from investment_payment p join capital_movement m on m.id = p.capital_movement_id where p.investment_id = '${ids.a}' and p.idempotency_key like '${request}%' and m.kind = 'WITHDRAWAL' and m.amount_cents = p.amount_cents`), 2);
  assert.equal(await one(`select count(*)::int from admin_audit_log where action = 'INVESTMENT_SETTLED_EARLY' and entity_id = '${ids.a}'`), 1);
  assert.equal(await one(`select count(*)::int from investment_revision where investment_id = '${ids.a}' and description in ('Liquidação antecipada', 'Cronograma encerrado na liquidação antecipada')`), 2);
  // Reenvio do mesmo formulário: não lança em dobro. Nova tentativa: contrato já encerrado.
  assert.match((await settle(robério, ids.a, { requestId: request }))?.message, /já estava registrada/);
  assert.match((await settle(robério, ids.a))?.error, /encerrado/);
  assert.equal(await movements(), before.movements + 2);
  // Nada mais a pagar nem a renovar neste contrato.
  assert.match((await pay(robério, { scheduleItemId: await itemOf(ids.a, 14), kind: "PRINCIPAL", amount: "1,00" }))?.error, /já está paga/);
  assert.match((await investorAction(robério, "renewInvestmentAction", { investmentId: ids.a, confirm: "1", principalCents: "0", rate: "1", ratePeriod: "MONTHLY", startDate: TODAY }))?.error, /já foi devolvido/);
  const detail = await page(robério, `/investidores/investimentos/${ids.a}`);
  assert.equal(detail.status, 200);
  assert.match(detail.html, /Este contrato foi liquidado antecipadamente/);
  assert.equal((await page(robério, "/contas-a-pagar?aba=todos&q=LIQ-A")).status, 200);
});

test("LQ3. envios simultâneos de liquidação do mesmo contrato gravam uma só", async () => {
  const before = await movements();
  const results = await Promise.all([settle(robério, ids.b, { yieldAmount: "0" }), settle(robério, ids.b, { yieldAmount: "0" })]);
  assert.equal(results.filter((result) => result?.ok).length, 1, JSON.stringify(results));
  assert.equal(await movements(), before + 1, "só o principal (rendimento final zero)");
  assert.equal(await one(`select count(*)::int from investment_schedule_item where investment_id = '${ids.b}' and description = 'Liquidação antecipada'`), 1);
});

test("LQ4. tela: botão, resumo com os valores e confirmação obrigatória (desktop); contrato liquidado no celular", async () => {
  const id = await contract("LIQ-UI");
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  for (const [label, viewport] of [["desktop", { width: 1440, height: 900 }], ["celular", { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport });
    const [name, value] = robério.split("; ").find((cookie) => cookie.includes("session_token")).split(/=(.*)/s);
    await context.addCookies([{ name, value, domain: new URL(BASE).hostname, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
    const browserPage = await context.newPage();
    await browserPage.goto(`${BASE}/investidores/investimentos/${id}`);
    const section = browserPage.getByRole("region", { name: "Liquidação antecipada do contrato" });
    if (label === "desktop") {
      await section.getByRole("button", { name: "Liquidar contrato antecipadamente" }).click();
      const form = section.getByRole("form", { name: "Confirmar liquidação antecipada" });
      await form.getByText("Principal a devolver agora").waitFor();
      await form.getByLabel("Tipo da liquidação").selectOption("COMPANY_DECISION");
      const summary = text(await form.innerHTML());
      assert.match(summary, /Principal a devolver agora R\$ 20\.000,00/);
      assert.match(summary, /Em aberto no cronograma hoje R\$ 25\.400,00 \(10 parcelas\)/);
      assert.match(summary, /Rendimentos vencidos não pagos até a data R\$ 600,00/, "o rendimento que vence hoje entra na sugestão");
      await form.getByLabel("Rendimento final negociado (R$)").fill("450,00");
      assert.match(text(await form.innerHTML()), /Valor que sai do capital R\$ 20\.450,00/);
      assert.match(text(await form.innerHTML()), /Rendimento pro-rata temporis R\$ 0,00/, "no dia do vencimento não há pro-rata");
      assert.equal(await form.getByRole("button", { name: "Confirmar liquidação" }).isDisabled(), true, "sem a confirmação marcada o botão fica desabilitado");
      if (SHOTS) await section.screenshot({ path: `${SHOTS}/liquidacao-formulario-${label}.png` });
      await form.getByLabel(/Confirmo a liquidação antecipada por decisão da empresa/).check();
      await form.getByRole("button", { name: "Confirmar liquidação" }).click();
      await section.getByText("Este contrato foi liquidado antecipadamente").waitFor();
      assert.equal(await one(`select status from investment where id = '${id}'`), "CLOSED");
      assert.equal(await one(`select yield_cents::int from investment_schedule_item where investment_id = '${id}' and description = 'Liquidação antecipada'`), 45_000);
    } else {
      await section.getByText("Este contrato foi liquidado antecipadamente").waitFor();
      assert.equal(await browserPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "sem rolagem horizontal (celular)");
    }
    if (SHOTS) await browserPage.screenshot({ path: `${SHOTS}/liquidacao-contrato-${label}.png`, fullPage: true });
    await context.close();
  }
});

test("LQ6. Gumercindo (fictício), resgate pedido pelo investidor: pro-rata R$ 560 (28 dias), taxa R$ 500 separada, líquido R$ 20.060, capital muda só pelo líquido", async () => {
  const id = await gumercindo("LIQ-GUM");
  ids.gum = id;
  const before = { movements: await movements(), net: await capitalNet(), otherIncome: await one(`select count(*)::int from capital_movement where tenant_id = 'ten_roberio' and kind = 'OTHER_INCOME'`) };
  const request = requestId();
  const base = { settledOn: "2026-11-04", yieldAmount: "0,00", proRataCents: "56000", requestId: request };
  // O pro-rata visto precisa ser o calculado no servidor.
  assert.match((await settle(robério, id, { ...base, settlementKind: "INVESTOR_REQUEST", feeAmount: "500,00", proRataCents: "58000" }))?.error, /pro-rata mudou/);
  const result = await settle(robério, id, { ...base, settlementKind: "INVESTOR_REQUEST", feeAmount: "500,00" });
  assert.equal(result?.ok, true, JSON.stringify(result));
  assert.match(result.message, /R\$\s20\.060,00 líquidos/);
  assert.equal(await movements(), before.movements + 3, "principal, pro-rata e a taxa (rendimento final zero)");
  assert.equal(await capitalNet(), before.net - 2_006_000, "o capital diminui exatamente o líquido");
  const payments = await admin(`select kind, amount_cents::int, notes from investment_payment where investment_id = '${id}' and idempotency_key like '${request}%' order by kind, amount_cents`);
  assert.deepEqual(payments.map((payment) => [payment.kind, payment.amount_cents]), [["PRINCIPAL", 2_000_000], ["YIELD", 56_000]], "taxa não é baixa de principal nem de rendimento");
  const fee = await admin(`select kind, category, source, amount_cents::int, occurred_at::text, description from capital_movement where tenant_id = 'ten_roberio' and idempotency_key = 'ivf-${request}'`);
  assert.equal(fee.length, 1);
  assert.deepEqual({ kind: fee[0].kind, category: fee[0].category, source: fee[0].source, amount: fee[0].amount_cents, on: fee[0].occurred_at }, { kind: "OTHER_INCOME", category: "OTHER_INCOME", source: "FINANCE", amount: 50_000, on: "2026-11-04" });
  assert.match(fee[0].description, /^Taxa de liquidação antecipada · Gil Liquidação/);
  const item = (await admin(`select yield_cents::int, principal_cents::int, due_date::text from investment_schedule_item where investment_id = '${id}' and description = 'Liquidação antecipada'`))[0];
  assert.deepEqual({ ...item }, { yield_cents: 56_000, principal_cents: 2_000_000, due_date: "2026-11-04" });
  const audit = (await admin(`select after from admin_audit_log where action = 'INVESTMENT_SETTLED_EARLY' and entity_id = '${id}'`))[0].after;
  assert.equal(audit.settlementKind, "INVESTOR_REQUEST");
  assert.deepEqual([audit.principalCents, audit.proRataCents, audit.proRataDays, audit.grossCents, audit.feeCents, audit.netCents, audit.capitalNetChangeCents], [2_000_000, 56_000, 28, 2_056_000, 50_000, 2_006_000, -2_006_000]);
  assert.match(audit.proRataFormula, /600,00 ÷ 30 × 28 dias = R\$\s560,00/);
  const revision = (await admin(`select changes from investment_revision where investment_id = '${id}' and kind = 'CONTRACT' and description = 'Liquidação antecipada'`))[0].changes;
  assert.ok(revision.some((change) => change.field === "Tipo" && change.after === "Resgate antecipado solicitado pelo investidor"));
  assert.ok(revision.some((change) => change.field === "Taxa de liquidação antecipada" && /500,00 retida/.test(change.after)));
  // Reenvio: nada em dobro (nem a taxa).
  assert.match((await settle(robério, id, { ...base, settlementKind: "INVESTOR_REQUEST", feeAmount: "500,00" }))?.message, /já estava registrada/);
  assert.equal(await movements(), before.movements + 3);
  assert.equal(await one(`select count(*)::int from capital_movement where tenant_id = 'ten_roberio' and kind = 'OTHER_INCOME'`), before.otherIncome + 1);
  // A taxa aparece no Financeiro como entrada própria.
  assert.match((await page(robério, "/financeiro")).html, /Taxa de liquidação antecipada · Gil Liquidação/);
});

test("LQ7. decisão da empresa no meio do período: pro-rata proporcional + vencido não pago, sem taxa e sem entrada no capital", async () => {
  // Vencimentos a cada 30 dias: 4º venceu há 5 dias e não foi pago; o 5º vence daqui a 25 dias.
  const due = (i) => daysAgo(95 - i * 30);
  const id = await contract("LIQ-EMP", { dueDate: due });
  const c360 = (a, b) => { const [y1, m1, d1] = a.split("-").map(Number); const [y2, m2, d2] = b.split("-").map(Number); return 360 * (y2 - y1) + 30 * (m2 - m1) + Math.min(d2, 30) - Math.min(d1, 30); };
  const expected = Math.round((60000 * c360(due(3), TODAY)) / c360(due(3), due(4)));
  const before = { movements: await movements(), net: await capitalNet() };
  const result = await settle(robério, id, { yieldAmount: "600,00", proRataCents: String(expected) });
  assert.equal(result?.ok, true, JSON.stringify(result));
  assert.equal(await movements(), before.movements + 3, "principal, rendimento vencido e pro-rata");
  assert.equal(await capitalNet(), before.net - (2_000_000 + 60_000 + expected));
  assert.equal(await one(`select count(*)::int from capital_movement where tenant_id = 'ten_roberio' and description like 'Taxa de liquidação antecipada%' and description like '%LIQ-EMP%'`), 0);
  const audit = (await admin(`select after from admin_audit_log where action = 'INVESTMENT_SETTLED_EARLY' and entity_id = '${id}'`))[0].after;
  assert.deepEqual([audit.settlementKind, audit.feeCents, audit.overdueYieldCents, audit.yieldCents, audit.proRataCents], ["COMPANY_DECISION", 0, 60_000, 60_000, expected]);
});

test("LQ8. tela do Gumercindo (fictício) antes de confirmar: os dois cenários com a memória de cálculo", async () => {
  const id = await gumercindo("LIQ-GUM-UI");
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  browser ??= await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  for (const [label, viewport] of [["desktop", { width: 1440, height: 900 }], ["celular", { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport });
    const [name, value] = robério.split("; ").find((cookie) => cookie.includes("session_token")).split(/=(.*)/s);
    await context.addCookies([{ name, value, domain: new URL(BASE).hostname, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
    const browserPage = await context.newPage();
    await browserPage.goto(`${BASE}/investidores/investimentos/${id}`);
    const section = browserPage.getByRole("region", { name: "Liquidação antecipada do contrato" });
    await section.getByRole("button", { name: "Liquidar contrato antecipadamente" }).click();
    const form = section.getByRole("form", { name: "Confirmar liquidação antecipada" });
    const date = form.getByLabel("Data da liquidação");
    await date.fill("04/11/2026");
    await date.blur();
    await form.getByLabel("Tipo da liquidação").selectOption("COMPANY_DECISION");
    await form.getByText(/R\$\s600,00 ÷ 30 × 28 dias/).waitFor();
    let summary = text(await form.innerHTML());
    assert.match(summary, /Rendimento pro-rata temporis R\$\s560,00/);
    assert.match(summary, /Total bruto R\$\s20\.560,00/);
    assert.match(summary, /Taxa de liquidação antecipada \(desconto\) Não se aplica/);
    assert.match(summary, /Valor líquido a pagar R\$\s20\.560,00/);
    assert.equal(await form.getByLabel("Taxa de Liquidação Antecipada (R$)").isEditable(), false, "empresa: taxa travada em zero");
    if (SHOTS) await section.screenshot({ path: `${SHOTS}/gumercindo-A-empresa-${label}.png` });
    await form.getByLabel("Tipo da liquidação").selectOption("INVESTOR_REQUEST");
    await form.getByLabel("Taxa de Liquidação Antecipada (R$)").fill("500,00");
    await form.getByText(/R\$\s20\.060,00 pagos ao investidor/).waitFor();
    summary = text(await form.innerHTML());
    assert.match(summary, /Taxa de liquidação antecipada \(desconto\) − R\$\s500,00/);
    assert.match(summary, /Valor líquido a pagar R\$\s20\.060,00/);
    assert.match(summary, /Valor que sai do capital R\$\s20\.060,00/);
    assert.equal(await form.getByRole("button", { name: "Confirmar liquidação" }).isDisabled(), true, "sem a confirmação marcada");
    if (label === "celular") assert.equal(await browserPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "sem rolagem horizontal (celular)");
    if (SHOTS) await section.screenshot({ path: `${SHOTS}/gumercindo-B-investidor-${label}.png` });
    await context.close();
  }
  assert.equal(await one(`select status from investment where id = '${id}'`), "ACTIVE", "a tela não grava nada sem confirmar");
});

test("LQ9. status Liquidado automático e abas Ativos/Liquidados/Todos com a contagem de contratos (dados fictícios)", async () => {
  const investor = await investorAction(robério, "createInvestorAction", { personType: "PF", name: "Hugo Abas Teste", document: "529.982.247-25" });
  assert.equal(investor?.ok, true, JSON.stringify(investor));
  const saved = ids.investor; ids.investor = investor.id;
  const id = await contract("LIQ-ABAS");
  ids.investor = saved;
  const tabs = (html) => Object.fromEntries([...html.matchAll(/(Ativos|Liquidados|Todos) (\d+)/g)].map((match) => [match[1], Number(match[2])]));
  let list = await page(robério, "/investidores?q=Hugo+Abas");
  assert.deepEqual(tabs(list.html), { Ativos: 1, Liquidados: 0, Todos: 1 });
  assert.match(list.html, /Hugo Abas Teste/);
  assert.doesNotMatch((await page(robério, "/investidores?q=Hugo+Abas&situacao=liquidados")).html, /Hugo Abas Teste/);
  const paidBefore = await one(`select md5(string_agg(row(p.*)::text, '|' order by id)) from investment_payment p where investment_id = '${id}'`);
  const request = requestId();
  assert.equal((await settle(robério, id, { requestId: request }))?.ok, true);
  // O status muda sozinho na confirmação, sem edição manual; as baixas anteriores não mudam.
  assert.equal(await one(`select status from investment where id = '${id}'`), "CLOSED");
  assert.equal(await one(`select md5(string_agg(row(p.*)::text, '|' order by id)) from investment_payment p where investment_id = '${id}' and idempotency_key not like '${request}%'`), paidBefore);
  list = await page(robério, "/investidores?q=Hugo+Abas");
  assert.deepEqual(tabs(list.html), { Ativos: 0, Liquidados: 1, Todos: 1 });
  assert.doesNotMatch(list.html, /Hugo Abas Teste/, "liquidado não aparece entre os ativos");
  const closed = await page(robério, "/investidores?q=Hugo+Abas&situacao=liquidados");
  assert.match(closed.html, /Hugo Abas Teste/);
  assert.match(closed.html, /Liquidado/);
  assert.match(closed.html, new RegExp(`R\\$\\s20\\.000,00 · liquidado em ${TODAY.split("-").reverse().join("/")}`));
  const all = await page(robério, "/investidores?q=Hugo+Abas&situacao=todos");
  assert.match(all.html, /Hugo Abas Teste/);
  const detail = await page(robério, `/investidores/investimentos/${id}`);
  assert.match(detail.html, /Liquidado/);
  // Isolamento: o tenant B não vê o investidor nem conta os contratos do A.
  const other = await page(fernando, "/investidores?q=Hugo+Abas&situacao=todos");
  assert.doesNotMatch(other.html, /Hugo Abas Teste/);
  assert.deepEqual(tabs(other.html), { Ativos: 0, Liquidados: 0, Todos: 0 });
});

test("LQ5. nada fora do previsto mudou (operações, clientes, tenants, usuários e tudo do tenant B)", async () => {
  assert.equal(await protectedHash(), hashBefore);
});
