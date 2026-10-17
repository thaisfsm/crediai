// Cronograma livre e datas negociadas, de ponta a ponta (HTTP + banco), SÓ com dados fictícios em banco LOCAL descartável:
//   * contrato com início num dia e pagamentos em outro (início no dia 10, pagamentos todo dia 25); o dia combinado fica
//     gravado e as linhas são gravadas exatamente com as datas e valores digitados (datas irregulares, fim de mês,
//     fevereiro, vencimento final), rendimento separado da devolução de principal;
//   * contrato antigo com início antes da carteira: a entrada nova com data anterior ao ciclo é recusada com mensagem
//     verdadeira (pode já estar no capital); o aporte comum do ciclo atual com data antiga pode ser indicado; o mesmo
//     dinheiro nunca é contado duas vezes; aporte de ciclo encerrado é recusado com a razão real;
//   * baixas parciais e totais, envio repetido, valor acima do saldo, capital insuficiente (nunca negativo);
//   * Contas a pagar e Dashboard com as obrigações cadastradas e atualizados depois das baixas;
//   * isolamento: outra carteira e o MASTER não veem nem pagam as obrigações da carteira A.
// Fixtures: ten_roberio (A), ten_fernando (B), ten_thais (MASTER).
//   E2E_DATABASE_URL=postgres://dono:senha@127.0.0.1:5432/crediai node --test tests/e2e/cronograma-flexivel.e2e.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
// Dia 10 de N meses atrás/à frente (início de contrato fictício) e dia `day` de um mês relativo a hoje.
const monthDay = (offset, day) => {
  const [year, month] = TODAY.split("-").map(Number);
  const index = year * 12 + month - 1 + offset, y = Math.floor(index / 12), m = (index % 12) + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
};
const br = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
after(async () => { await sql.end(); });

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
const requestId = () => `e2e-cf-${Date.now()}-${++counter}-abcdef`;
const available = async (tenantId) => Number(await one(`select w.initial_capital_cents
  + coalesce((select sum(case when m.kind in ('CONTRIBUTION','OTHER_INCOME') then m.amount_cents else -m.amount_cents end) from capital_movement m where m.tenant_id = w.tenant_id and m.cycle_number = w.cycle_number), 0)
  - coalesce((select sum(o.principal_cents) from loan_operation o where o.tenant_id = w.tenant_id and o.cycle_number = w.cycle_number and o.status <> 'CANCELED'), 0)
  + coalesce((select sum(p.amount_cents) from payment p join loan_operation o on o.id = p.operation_id where p.tenant_id = w.tenant_id and o.cycle_number = w.cycle_number), 0)
  from wallet w where w.tenant_id = '${tenantId}'`));
const count = (table, where) => one(`select count(*)::int from ${table} where ${where}`);
// CPF fictício válido (dígitos verificadores calculados).
const cpf = (base) => {
  const digits = base.split("").map(Number);
  for (const size of [9, 10]) { const sum = digits.slice(0, size).reduce((total, digit, index) => total + digit * (size + 1 - index), 0); digits.push(((sum * 10) % 11) % 10); }
  return digits.join("");
};
// Tudo que não pode mudar fora da carteira A: carteira B inteira e o MASTER.
const otherWallets = () => one(`select md5(string_agg(x, '|' order by x)) from (
  select 'm'||row(m.*)::text x from capital_movement m where tenant_id <> 'ten_roberio' union all select 'v'||row(v.*)::text from investor v where tenant_id <> 'ten_roberio'
  union all select 'i'||row(i.*)::text from investment i where tenant_id <> 'ten_roberio' union all select 's'||row(s.*)::text from investment_schedule_item s where tenant_id <> 'ten_roberio'
  union all select 'p'||row(p.*)::text from investment_payment p where tenant_id <> 'ten_roberio' union all select 'w'||row(w.*)::text from wallet w where tenant_id <> 'ten_roberio') t`);
async function makeLegacy(investmentId) {
  await sql.unsafe(`alter table investment disable trigger investment_entry_rule`);
  try { await admin(`update investment set capital_entry_rule = null where id = '${investmentId}'`); } finally { await sql.unsafe(`alter table investment enable trigger investment_entry_rule`); }
}
const pay = (cookie, scheduleItemId, extra = {}) => action(cookie, "registerInvestmentPaymentAction", { scheduleItemId, kind: "YIELD", amount: "500,00", paidOn: TODAY, method: "PIX", reference: "", notes: "", requestId: requestId(), ...extra });
const saveLines = (cookie, investmentId, list, extra = {}) => investorAction(cookie, "saveInvestmentScheduleLinesAction", { investmentId, mode: "replace", seen: "", lines: JSON.stringify(list), ...extra });
const itemOn = (investmentId, dueDate, extra = "") => one(`select id from investment_schedule_item where investment_id = '${investmentId}' and due_date = '${dueDate}' ${extra}`);

let robério, fernando, thais, othersBefore;
const ids = {};
// Contrato fictício A: início no dia 10 de dois meses atrás, pagamentos todo dia 25, vencimento final no dia 25 de daqui a 8 meses.
const START = monthDay(-2, 10);
const MATURITY = monthDay(8, 25);
// Datas negociadas: a primeira (dia 25 do mês do início), uma irregular (dia 12, combinada assim), o dia de hoje (para o
// painel do dia), fevereiro e o vencimento final; a devolução do principal é uma linha separada no vencimento.
const LINES = [
  { kind: "YIELD", dueDate: monthDay(-2, 25), yieldAmount: "500,00", principalAmount: "", description: "rendimento 1" },
  { kind: "YIELD", dueDate: monthDay(-1, 12), yieldAmount: "500,00", principalAmount: "", description: "rendimento 2 (dia combinado à parte)" },
  { kind: "YIELD", dueDate: TODAY, yieldAmount: "500,00", principalAmount: "", description: "rendimento de hoje" },
  { kind: "YIELD", dueDate: `${Number(TODAY.slice(0, 4)) + 1}-02-25`, yieldAmount: "500,00", principalAmount: "", description: "rendimento de fevereiro" },
  { kind: "YIELD", dueDate: MATURITY, yieldAmount: "500,00", principalAmount: "", description: "último rendimento" },
  { kind: "PRINCIPAL", dueDate: MATURITY, yieldAmount: "", principalAmount: "10.000,00", description: "devolução do principal" },
];

test("preparação: carteira A criada há 10 dias com R$ 1.000, aporte comum de R$ 10.000 lançado com data de 60 dias atrás (fictício)", async () => {
  await admin(`update wallet set initial_capital_cents = 100000, created_at = '${daysAgo(10)} 12:00:00+00', cycle_started_at = null where tenant_id = 'ten_roberio'`);
  othersBefore = await otherWallets();
  robério = await login("roberio@teste.local");
  fernando = await login("fernando@teste.local");
  thais = await login("thais@teste.local");
  // Aporte comum com data anterior à criação da carteira: a tela Capital aceita, e ele entra no capital do ciclo atual.
  const before = await available("ten_roberio");
  const contribution = await action(robério, "registerContributionAction", { amount: "10.000,00", occurredAt: daysAgo(60), notes: "" }, "/");
  assert.equal(contribution?.ok, true, JSON.stringify(contribution));
  ids.aporte = await one(`select id from capital_movement where tenant_id = 'ten_roberio' and kind = 'CONTRIBUTION' and occurred_at = '${daysAgo(60)}'`);
  assert.equal(await available("ten_roberio"), before + 1_000_000, "o aporte com data antiga conta no capital");
  const investor = await investorAction(robério, "createInvestorAction", { personType: "PF", document: cpf("285619734"), name: "Iara Flexível" });
  assert.equal(investor?.ok, true, JSON.stringify(investor));
  ids.investor = investor.id;
});

test("CF1. contrato com início no dia 10 e pagamento todo dia 25: aceito e gravado sem mexer em nenhuma data", async () => {
  const created = await investorAction(robério, "createInvestmentAction", { investorId: ids.investor, amount: "10.000,00", rate: "5", ratePeriod: "MONTHLY", startDate: START, maturityDate: MATURITY, dueDay: "25", contractNumber: "CF-FLEX" });
  assert.equal(created?.ok, true, JSON.stringify(created));
  ids.contract = created.id;
  const row = (await admin(`select start_date::text, maturity_date::text, due_day, amount_cents::int as amount_cents, agreed_rate_bps from investment where id = '${ids.contract}'`))[0];
  assert.deepEqual({ ...row }, { start_date: START, maturity_date: MATURITY, due_day: 25, amount_cents: 1_000_000, agreed_rate_bps: 500 });
  assert.equal(await count("investment_schedule_item", `investment_id = '${ids.contract}'`), 0, "cadastrar o contrato não cria cronograma por conta própria");
  const { html } = await page(robério, `/investidores/investimentos/${ids.contract}`);
  assert.ok(html.includes("Dia do pagamento Dia 25"), "o dia combinado aparece no contrato");
  assert.ok(html.includes("Nenhum pagamento no cronograma ainda."));
  // Contrato antigo (cadastrado antes da regra da entrada), como o caso real que motivou a correção.
  await makeLegacy(ids.contract);
});

test("CF2. cronograma livre: datas e valores gravados exatamente como digitados (dia 25, dia irregular, fevereiro, vencimento final, principal separado)", async () => {
  const saved = await saveLines(robério, ids.contract, LINES);
  assert.equal(saved?.ok, true, JSON.stringify(saved));
  const rows = await admin(`select due_date::text as d, yield_cents::int as y, principal_cents::int as p, description from investment_schedule_item where investment_id = '${ids.contract}' order by due_date, principal_cents`);
  assert.deepEqual(rows.map((row) => [row.d, row.y, row.p]), [...LINES].sort((a, b) => (a.dueDate + (a.principalAmount ? "1" : "0")).localeCompare(b.dueDate + (b.principalAmount ? "1" : "0")))
    .map((line) => [line.dueDate, line.yieldAmount ? 50_000 : 0, line.principalAmount ? 1_000_000 : 0]));
  assert.equal(await count("investment_payment", `investment_id = '${ids.contract}'`), 0, "nenhuma linha virou paga por ter a data no passado");
  // Uma linha pode ser editada livremente para outra data negociada (ex.: rendimento de fevereiro passa para 28/02).
  const febId = await itemOn(ids.contract, LINES[3].dueDate);
  const newFeb = `${LINES[3].dueDate.slice(0, 4)}-02-28`;
  const edited = await investorAction(robério, "updateInvestmentScheduleItemAction", { investmentId: ids.contract, itemId: febId, kind: "YIELD", dueDate: newFeb, yieldAmount: "500,00", principalAmount: "", description: "rendimento de fevereiro" });
  assert.equal(edited?.ok, true, JSON.stringify(edited));
  assert.equal(await one(`select due_date::text from investment_schedule_item where id = '${febId}'`), newFeb);
  // Proteções que continuam: data antes do início do contrato e principal acima do contratado.
  const seen = "";
  assert.match((await investorAction(robério, "saveInvestmentScheduleLinesAction", { investmentId: ids.contract, mode: "append", seen, lines: JSON.stringify([{ ...LINES[0], dueDate: daysAgo(400) }]) }))?.error, /anterior ao início/);
  assert.match((await investorAction(robério, "saveInvestmentScheduleLinesAction", { investmentId: ids.contract, mode: "append", seen, lines: JSON.stringify([{ ...LINES[5], principalAmount: "0,01" }]) }))?.error, /principal/i);
});

test("CF3. Contas a pagar e Dashboard mostram as obrigações cadastradas com datas e valores reais, nada pago por suposição", async () => {
  const { html } = await page(robério, "/contas-a-pagar?aba=todos&q=Iara");
  for (const line of LINES.filter((item) => item.dueDate !== LINES[3].dueDate)) assert.ok(html.includes(br(line.dueDate)), `vencimento ${br(line.dueDate)} na tela`);
  assert.ok(html.includes("R$ 10.000,00"), "devolução do principal separada");
  assert.equal(await count("investment_payment", `investment_id = '${ids.contract}'`), 0, "nenhuma obrigação paga por suposição");
  const dashboard = (await page(robério, "/")).html;
  assert.ok(dashboard.includes("A pagar hoje R$ 500,00"), "o Dashboard mostra o rendimento de hoje");
  assert.ok(dashboard.includes("Iara Flexível"));
});

test("CF4. origem do dinheiro: entrada com data anterior ao ciclo recusada com mensagem verdadeira; aporte antigo do ciclo atual pode ser indicado; nada em dobro", async () => {
  const itemToday = await itemOn(ids.contract, TODAY);
  const blocked = await pay(robério, itemToday);
  assert.equal(blocked?.ok, false);
  assert.match(blocked.error, /indique, na página do contrato, o aporte/);
  const capital = await available("ten_roberio");
  // Entrada nova com a data do investimento (antes da criação da carteira): recusada, sem dizer que o dinheiro não existe.
  const entry = await action(robério, "registerInvestmentEntryAction", { investmentId: ids.contract, amountCents: "1000000", enteredOn: START, confirm: "1", requestId: requestId() });
  assert.equal(entry?.ok, false);
  assert.match(entry.error, /pode já estar no capital inicial ou num aporte comum/);
  assert.match(entry.error, /indique esse aporte/);
  assert.doesNotMatch(entry.error, /não existe|não está disponível|não está mais no capital/);
  assert.equal(await available("ten_roberio"), capital, "nada lançado no capital");
  // O aporte de 60 dias atrás é do ciclo atual (está no capital): pode ser indicado. Antes desta correção era recusado.
  const page1 = (await page(robério, `/investidores/investimentos/${ids.contract}`)).html;
  assert.ok(page1.includes("O sistema não comprova sozinho de onde veio o dinheiro"), "a tela explica que o vínculo depende da confirmação");
  const declared = await action(robério, "declarePriorContributionAction", { investmentId: ids.contract, movementId: ids.aporte, confirm: "1", requestId: requestId() });
  assert.equal(declared?.ok, true, JSON.stringify(declared));
  assert.equal(await available("ten_roberio"), capital, "indicar o aporte não lança nada no capital");
  // Nada em dobro: nem a entrada, nem uma segunda indicação.
  assert.match((await action(robério, "registerInvestmentEntryAction", { investmentId: ids.contract, amountCents: "1000000", enteredOn: TODAY, confirm: "1", requestId: requestId() }))?.error, /aporte anterior|em dobro/);
  assert.match((await action(robério, "declarePriorContributionAction", { investmentId: ids.contract, movementId: ids.aporte, confirm: "1", requestId: requestId() }))?.error, /já foi indicado/);
  assert.equal(await count("investment_capital_entry", `investment_id = '${ids.contract}'`), 0);
  assert.equal(await count("investment_prior_contribution", `investment_id = '${ids.contract}'`), 1);
});

test("CF5. baixas parciais e totais, envio repetido, valor acima do saldo; capital e painéis atualizados", async () => {
  const itemToday = await itemOn(ids.contract, TODAY);
  const capital = await available("ten_roberio");
  const repeated = requestId();
  const partial = await pay(robério, itemToday, { amount: "200,00", requestId: repeated });
  assert.equal(partial?.ok, true, JSON.stringify(partial));
  await pay(robério, itemToday, { amount: "200,00", requestId: repeated });
  assert.equal(await count("investment_payment", `schedule_item_id = '${itemToday}'`), 1, "o mesmo envio não baixa duas vezes");
  assert.match((await pay(robério, itemToday, { amount: "300,01" }))?.error, /maior que o saldo/);
  const parallel = await Promise.all([pay(robério, itemToday, { amount: "300,00" }), pay(robério, itemToday, { amount: "300,00" })]);
  assert.equal(parallel.filter((result) => result?.ok).length, 1, "duas baixas simultâneas do saldo: só uma passa");
  assert.equal(Number(await one(`select sum(amount_cents) from investment_payment where schedule_item_id = '${itemToday}'`)), 50_000);
  assert.equal(await available("ten_roberio"), capital - 50_000, "uma saída de capital por baixa, no valor exato");
  assert.equal(Number(await one(`select coalesce(sum(amount_cents), 0) from capital_movement where tenant_id = 'ten_roberio' and source = 'INVESTOR' and kind = 'WITHDRAWAL'`)), 50_000);
  assert.match((await pay(robério, itemToday, { amount: "0,01" }))?.error, /já está paga/);
  // Linha vencida (passada): pode ser paga hoje, parcialmente.
  const pastItem = await itemOn(ids.contract, LINES[0].dueDate);
  assert.equal((await pay(robério, pastItem, { amount: "100,00" }))?.ok, true);
  const dashboard = (await page(robério, "/")).html;
  assert.ok(dashboard.includes("Pago hoje R$ 600,00"), "o Dashboard soma as baixas de hoje");
  assert.ok(dashboard.includes("A pagar hoje R$ 0,00"));
  const payables = (await page(robério, "/contas-a-pagar?aba=pagos&q=Iara")).html;
  assert.ok(payables.includes("Pago hoje R$ 600,00"), "Contas a pagar mostra o mesmo valor pago hoje");
});

test("CF6. capital nunca negativo: devolução do principal acima do capital disponível é recusada", async () => {
  // Deixa a carteira A (fictícia) com menos capital que o principal, para a devolução não caber.
  await admin(`update wallet set initial_capital_cents = 0 where tenant_id = 'ten_roberio'`);
  const capital = await available("ten_roberio");
  assert.ok(capital < 1_000_000, `capital de teste ${capital}`);
  const principalItem = await itemOn(ids.contract, MATURITY, "and principal_cents > 0");
  const before = await count("investment_payment", "tenant_id = 'ten_roberio'");
  const result = await pay(robério, principalItem, { kind: "PRINCIPAL", amount: "10.000,00" });
  assert.equal(result?.ok, false);
  assert.match(result.error, /capital|saldo/i);
  assert.equal(await count("investment_payment", "tenant_id = 'ten_roberio'"), before);
  assert.equal(await available("ten_roberio"), capital);
});

test("CF7. isolamento: outra carteira e o MASTER não veem nem pagam nem editam o cronograma da carteira A", async () => {
  const itemToday = await itemOn(ids.contract, LINES[1].dueDate);
  assert.equal((await pay(fernando, itemToday))?.ok, false);
  assert.equal((await pay(thais, itemToday))?.ok, false, "o MASTER não dá baixa em contrato de outra carteira");
  assert.equal((await saveLines(fernando, ids.contract, LINES))?.ok, false);
  assert.equal((await action(fernando, "declarePriorContributionAction", { investmentId: ids.contract, movementId: ids.aporte, confirm: "1", requestId: requestId() }))?.ok, false);
  for (const [cookie, who] of [[fernando, "B"], [thais, "MASTER"]]) {
    for (const path of ["/contas-a-pagar?aba=todos", "/"]) assert.ok(!(await page(cookie, path)).html.includes("Iara Flexível"), `${who} não vê a obrigação de A em ${path}`);
  }
  assert.equal(await otherWallets(), othersBefore, "nada mudou nas outras carteiras");
});

test("CF8. aporte de ciclo encerrado (depois de zerar a carteira) não pode ser indicado: recusado com a razão real", async () => {
  const other = await investorAction(robério, "createInvestmentAction", { investorId: ids.investor, amount: "1.000,00", rate: "1", ratePeriod: "MONTHLY", startDate: START, dueDay: "25", contractNumber: "CF-CICLO" });
  assert.equal(other?.ok, true, JSON.stringify(other));
  await makeLegacy(other.id);
  const oldContribution = await action(robério, "registerContributionAction", { amount: "1.000,00", occurredAt: TODAY, notes: "" }, "/");
  assert.equal(oldContribution?.ok, true);
  const movementId = await one(`select id from capital_movement where tenant_id = 'ten_roberio' and kind = 'CONTRIBUTION' and amount_cents = 100000 order by created_at desc limit 1`);
  assert.equal((await action(robério, "resetWalletAction", { confirmation: "ZERAR CARTEIRA" }, "/"))?.ok, true);
  const result = await action(robério, "declarePriorContributionAction", { investmentId: other.id, movementId, confirm: "1", requestId: requestId() });
  assert.equal(result?.ok, false);
  assert.match(result.error, /ciclo 1 da carteira, encerrado ao zerar a carteira/);
  assert.equal(await count("investment_prior_contribution", `investment_id = '${other.id}'`), 0);
});
