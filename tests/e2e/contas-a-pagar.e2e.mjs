// Contas a Pagar (Etapa C) de ponta a ponta (HTTP + banco): entrada do contrato no capital, baixas parciais e totais,
// datas, capital insuficiente, envio duplicado e concorrência, falha no meio da transação, travas do banco, cronograma
// travado depois da baixa, isolamento entre tenants e MASTER, telas no desktop e no celular.
// SÓ em ambiente LOCAL e DESCARTÁVEL (ver tests/e2e/README.md), com os dados fictícios ten_roberio (A), ten_fernando (B)
// e ten_thais (MASTER com carteira própria). Rodar com o servidor usando um papel COM BYPASSRLS (como a produção) e, de
// novo, sem ele.
//   E2E_DATABASE_URL=postgres://dono:senha@127.0.0.1:5432/crediai node --test tests/e2e/contas-a-pagar.e2e.mjs
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
const money = (cents) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100).replace(/\s/g, " ");
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

// Capital disponível pela mesma fórmula do servidor, direto do banco.
const available = async (tenantId) => Number(await one(`select w.initial_capital_cents
  + coalesce((select sum(case when m.kind in ('CONTRIBUTION','OTHER_INCOME') then m.amount_cents else -m.amount_cents end) from capital_movement m where m.tenant_id = w.tenant_id and m.cycle_number = w.cycle_number), 0)
  - coalesce((select sum(o.principal_cents) from loan_operation o where o.tenant_id = w.tenant_id and o.cycle_number = w.cycle_number and o.status <> 'CANCELED'), 0)
  + coalesce((select sum(p.amount_cents) from payment p join loan_operation o on o.id = p.operation_id where p.tenant_id = w.tenant_id and o.cycle_number = w.cycle_number), 0)
  from wallet w where w.tenant_id = '${tenantId}'`));
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

test("preparação: carteira A com R$ 10.000 há 40 dias, contrato de R$ 20.000 com cronograma (dados fictícios)", async () => {
  await admin(`update wallet set initial_capital_cents = 1000000, created_at = '${daysAgo(40)} 12:00:00+00' where tenant_id = 'ten_roberio'`);
  hashBefore = await protectedHash();
  robério = await login("roberio@teste.local");
  fernando = await login("fernando@teste.local");
  thais = await login("thais@teste.local");
  const investor = await investorAction(robério, "createInvestorAction", { name: "Paula Pagamentos", document: "411.797.058-58", bankName: "001 Banco do Brasil", bankAccount: "99887-6", pixKeyType: "CPF", pixKey: "411.797.058-58" });
  assert.equal(investor?.ok, true, JSON.stringify(investor));
  ids.investor = investor.id;
  const investment = await investorAction(robério, "createInvestmentAction", { investorId: ids.investor, amount: "20.000,00", rate: "1,5", ratePeriod: "MONTHLY", startDate: daysAgo(30), investedOn: daysAgo(30), contractNumber: "CP-A" });
  assert.equal(investment?.ok, true, JSON.stringify(investment));
  ids.investment = investment.id;
  for (const [dueDate, yieldAmount, principalAmount] of [[daysAgo(10), "500,00", ""], [TODAY, "500,00", ""], [daysAgo(-20), "500,00", "20.000,00"]]) {
    const added = await investorAction(robério, "addInvestmentScheduleItemAction", { investmentId: ids.investment, dueDate, yieldAmount, principalAmount, description: "" });
    assert.equal(added?.ok, true, JSON.stringify(added));
  }
  const rows = await admin(`select id, number from investment_schedule_item where investment_id = '${ids.investment}' order by number`);
  [ids.item1, ids.item2, ids.item3] = rows.map((row) => row.id);
  // O cadastro do investidor, do contrato e do cronograma não mexe no capital.
  assert.equal(await available("ten_roberio"), 1_000_000);
  assert.equal(await count("capital_movement", "ten_roberio"), 0);
});

test("CP1. tela: menu, seções vencidas/hoje/próximas/pagas e totais derivados do cronograma", async () => {
  const dashboard = await fetch(`${BASE}/`, { headers: { cookie: robério } }).then((response) => response.text());
  assert.match(dashboard, /href="\/contas-a-pagar"/, "item Contas a pagar no menu");
  const { status, html } = await page(robério, "/contas-a-pagar");
  assert.equal(status, 200);
  for (const label of ["Contas a pagar", "Vence hoje", "Total vencido", "Pago no período", "Vencidas", "Vencem hoje", "Próximas", "Pagas", "Paula Pagamentos", "Contrato CP-A"]) assert.ok(html.includes(label), label);
  assert.match(html, new RegExp(`Vence hoje ${money(50_000).replace("$", "\\$")}`));
  assert.match(html, new RegExp(`Total vencido ${money(50_000).replace("$", "\\$")}`));
  assert.ok(html.includes("Vencida") && html.includes("Prevista"));
  // Busca por investidor e filtro por tipo.
  assert.ok((await page(robério, "/contas-a-pagar?q=paula&tipo=principal")).html.includes(money(2_000_000)));
  assert.ok((await page(robério, "/contas-a-pagar?q=ninguem")).html.includes("0 de 4 obrigações"));
  const anonymous = await page(null, "/contas-a-pagar");
  assert.ok([303, 307, 308].includes(anonymous.status) && anonymous.location?.startsWith("/login"), `${anonymous.status} ${anonymous.location}`);
});

test("CP2. entrada no capital: só com confirmação e com os dados vistos; uma vez; Financeiro e auditoria", async () => {
  assert.match((await enter(robério, ids.investment, { confirm: "" })).error, /Confirme/);
  assert.match((await enter(robério, ids.investment, { amountCents: "2000001", enteredOn: daysAgo(30) })).error, /mudaram/);
  assert.equal(await count("capital_movement", "ten_roberio"), 0);
  const fields = { amountCents: "2000000", enteredOn: daysAgo(30), requestId: requestId() };
  const created = await enter(robério, ids.investment, fields);
  assert.equal(created?.ok, true, JSON.stringify(created));
  assert.equal(await available("ten_roberio"), 3_000_000);
  // Mesmo envio de novo: reconhecido; outro envio: recusado. Uma única entrada e um único aporte.
  assert.match((await enter(robério, ids.investment, fields)).message, /já estava registrada/);
  assert.match((await enter(robério, ids.investment, { amountCents: "2000000", enteredOn: daysAgo(30) })).error, /já foi registrada/);
  assert.equal(await count("investment_capital_entry", "ten_roberio"), 1);
  const [movement] = await admin(`select * from capital_movement where tenant_id = 'ten_roberio'`);
  assert.deepEqual([movement.kind, movement.category, movement.source, Number(movement.amount_cents), movement.created_by_user_id], ["CONTRIBUTION", "INVESTOR_CONTRIBUTION", "INVESTOR", 2_000_000, "u_roberio"]);
  assert.equal(await one(`select occurred_at::text from capital_movement where id = '${movement.id}'`), daysAgo(30));
  ids.entryMovement = movement.id;
  const [audit] = await admin(`select * from admin_audit_log where entity_id = '${movement.id}'`);
  assert.equal(audit.action, "INVESTMENT_CAPITAL_ENTRY_REGISTERED");
  assert.equal(audit.actor_user_id, "u_roberio");
  assert.equal(audit.after.investmentId, ids.investment);
  const finance = await page(robério, `/financeiro?de=${daysAgo(40)}&ate=${TODAY}`);
  assert.ok(finance.html.includes("Entrada de investidor") && finance.html.includes("Investidores · entrada do contrato"));
  // Não é um aporte comum: sem "Estornar aporte" na tela Capital e o estorno é recusado no servidor.
  const capital = await fetch(`${BASE}/?tela=capital`, { headers: { cookie: robério } }).then((response) => response.text());
  assert.ok(!capital.includes("Estornar aporte"));
  const reversal = await action(robério, "reverseContributionAction", { movementId: movement.id }, "/");
  assert.equal(reversal?.ok, false);
  assert.match(reversal.error, /contrato de investimento/);
  assert.equal(await available("ten_roberio"), 3_000_000);
  // Envios simultâneos com chaves diferentes em outro contrato: uma única entrada.
  const other = await investorAction(robério, "createInvestmentAction", { investorId: ids.investor, amount: "1.000,00", rate: "1", ratePeriod: "MONTHLY", startDate: daysAgo(2), contractNumber: "CP-C" });
  ids.investmentC = other.id;
  const results = await Promise.all([1, 2, 3].map(() => enter(robério, ids.investmentC, { amountCents: "100000", enteredOn: daysAgo(2) })));
  assert.equal(results.filter((result) => result?.ok).length, 1, JSON.stringify(results));
  assert.equal(await one(`select count(*)::int from investment_capital_entry where investment_id = '${ids.investmentC}'`), 1);
  assert.equal(await available("ten_roberio"), 3_100_000);
});

test("CP3. baixa parcial: uma saída de capital, ligada à obrigação; vencida com saldo continua vencida", async () => {
  const before = await available("ten_roberio");
  const result = await pay(robério, { scheduleItemId: ids.item1, amount: "200,00", paidOn: daysAgo(5), reference: "Pix 12345678901", notes: "pago por transferência" });
  assert.equal(result?.ok, true, JSON.stringify(result));
  assert.match(result.message, /Saldo da obrigação: R\$\s300,00/);
  assert.equal(before - await available("ten_roberio"), 20_000);
  const [row] = await admin(`select p.*, p.paid_on::text paid, m.kind, m.category, m.source, m.amount_cents mov, m.occurred_at::text occurred from investment_payment p join capital_movement m on m.id = p.capital_movement_id where p.schedule_item_id = '${ids.item1}'`);
  assert.deepEqual([row.kind, row.category, row.source, Number(row.mov), row.occurred, row.paid, row.method, row.investment_id], ["WITHDRAWAL", "INVESTOR_YIELD_PAYMENT", "INVESTOR", 20_000, daysAgo(5), daysAgo(5), "PIX", ids.investment]);
  const [audit] = await admin(`select * from admin_audit_log where entity = 'investment_payment' and entity_id = '${row.id}'`);
  assert.equal(audit.action, "INVESTMENT_PAYMENT_REGISTERED");
  assert.equal(audit.after.reference, "Pix •••8901");
  const auditText = JSON.stringify(audit);
  assert.ok(!auditText.includes("12345678901") && !auditText.includes("99887") && !auditText.includes("41179705858") && !auditText.includes("transferência"), "sem dados bancários, referência completa ou observações");
  const { html } = await page(robério, "/contas-a-pagar?situacao=vencida");
  assert.ok(html.includes(money(30_000)) && html.includes("Vencida"));
});

test("CP4. baixa total quita; acima do saldo e obrigação paga são recusadas", async () => {
  assert.match((await pay(robério, { scheduleItemId: ids.item1, amount: "300,01" })).error, /maior que o saldo/);
  const full = await pay(robério, { scheduleItemId: ids.item1, amount: "300,00" });
  assert.equal(full?.ok, true, JSON.stringify(full));
  assert.match(full.message, /Obrigação paga/);
  assert.match((await pay(robério, { scheduleItemId: ids.item1, amount: "0,01" })).error, /já está paga/);
  assert.match((await pay(robério, { scheduleItemId: ids.item2, kind: "PRINCIPAL", amount: "1,00" })).error, /não tem devolução de principal/);
  const paid = await page(robério, "/contas-a-pagar?situacao=paga");
  assert.ok(paid.html.includes("Paga") && paid.html.includes("1 de 4 obrigações"));
  assert.equal(await one(`select sum(amount_cents)::int from investment_payment where schedule_item_id = '${ids.item1}'`), 50_000);
});

test("CP5. datas e campos: entre o início do contrato e hoje; valor positivo; forma de pagamento", async () => {
  const before = await count("investment_payment", "ten_roberio");
  for (const [extra, message] of [
    [{ paidOn: daysAgo(-1) }, /depois de hoje/], [{ paidOn: daysAgo(31) }, /início do contrato/], [{ paidOn: "2026-02-30" }, /data efetiva/],
    [{ amount: "0" }, /maior que zero/], [{ amount: "-5,00" }, /menos/], [{ method: "BOLETO" }, /forma/], [{ kind: "JUROS" }, /tipo/], [{ requestId: "x" }, /expirado/],
  ]) {
    const result = await pay(robério, { scheduleItemId: ids.item2, ...extra });
    assert.equal(result?.ok, false, JSON.stringify(extra));
    assert.match(result.error, message, JSON.stringify(extra));
  }
  assert.equal(await count("investment_payment", "ten_roberio"), before);
});

test("CP6. envio duplicado e concorrência: uma baixa e uma saída por envio; nunca acima do previsto", async () => {
  const movementsBefore = await count("capital_movement", "ten_roberio");
  const fields = { scheduleItemId: ids.item3, amount: "100,00", requestId: requestId() };
  const repeated = await Promise.all([1, 2, 3].map(() => pay(robério, fields)));
  assert.ok(repeated.every((result) => result?.ok), JSON.stringify(repeated));
  assert.match((await pay(robério, fields)).message, /já estava registrado/);
  assert.equal(await count("capital_movement", "ten_roberio"), movementsBefore + 1);
  // Duas baixas diferentes, cada uma do saldo inteiro da mesma obrigação, ao mesmo tempo: só uma passa.
  const racing = await Promise.all([1, 2].map(() => pay(robério, { scheduleItemId: ids.item2, amount: "500,00" })));
  assert.equal(racing.filter((result) => result?.ok).length, 1, JSON.stringify(racing));
  assert.equal(await one(`select sum(amount_cents)::int from investment_payment where schedule_item_id = '${ids.item2}'`), 50_000);
  assert.equal(await count("capital_movement", "ten_roberio"), movementsBefore + 2);
  // Cada baixa tem exatamente uma saída, do mesmo valor e data, e toda saída de investidor tem baixa ou entrada.
  assert.equal(await one(`select count(*)::int from investment_payment p join capital_movement m on m.id = p.capital_movement_id
    where p.amount_cents <> m.amount_cents or p.paid_on <> m.occurred_at or m.kind <> 'WITHDRAWAL'`), 0);
  assert.equal(await one(`select count(*)::int from capital_movement m where m.source = 'INVESTOR'
    and not exists (select 1 from investment_payment p where p.capital_movement_id = m.id) and not exists (select 1 from investment_capital_entry e where e.capital_movement_id = m.id)`), 0);
});

test("CP7. capital insuficiente (hoje e retroativo) bloqueia a baixa sem gravar nada", async () => {
  const investment = await investorAction(robério, "createInvestmentAction", { investorId: ids.investor, amount: "60.000,00", rate: "1", ratePeriod: "MONTHLY", startDate: daysAgo(38), contractNumber: "CP-B" });
  ids.investmentB = investment.id;
  await investorAction(robério, "addInvestmentScheduleItemAction", { investmentId: ids.investmentB, dueDate: TODAY, yieldAmount: "", principalAmount: "60.000,00", description: "" });
  ids.itemB = await one(`select id from investment_schedule_item where investment_id = '${ids.investmentB}'`);
  const before = { balance: await available("ten_roberio"), payments: await count("investment_payment", "ten_roberio") };
  const today = await pay(robério, { scheduleItemId: ids.itemB, kind: "PRINCIPAL", amount: "60.000,00" });
  assert.equal(today?.ok, false);
  assert.match(today.error, /Saldo insuficiente/);
  // Há 35 dias o capital era R$ 10.000: uma devolução de R$ 15.000 nessa data deixaria aquele ponto negativo.
  const backdated = await pay(robério, { scheduleItemId: ids.itemB, kind: "PRINCIPAL", amount: "15.000,00", paidOn: daysAgo(35) });
  assert.equal(backdated?.ok, false);
  assert.match(backdated.error, /ficaria negativo/);
  assert.deepEqual({ balance: await available("ten_roberio"), payments: await count("investment_payment", "ten_roberio") }, before);
});

test("CP8. falha no meio da transação (auditoria recusada): nem baixa nem saída ficam gravadas", async () => {
  const before = { balance: await available("ten_roberio"), payments: await count("investment_payment", "ten_roberio"), movements: await count("capital_movement", "ten_roberio") };
  await sql.unsafe(`create or replace function e2e_fail_payable_audit() returns trigger language plpgsql as $$ begin if new.entity = 'investment_payment' then raise exception 'falha simulada'; end if; return new; end $$;
    create trigger e2e_fail_payable_audit before insert on admin_audit_log for each row execute function e2e_fail_payable_audit();`);
  try {
    const result = await pay(robério, { scheduleItemId: ids.item3, amount: "50,00" });
    assert.notEqual(result?.ok, true, "a ação não pode dizer que gravou");
  } finally {
    await sql.unsafe(`drop trigger e2e_fail_payable_audit on admin_audit_log; drop function e2e_fail_payable_audit();`);
  }
  assert.deepEqual({ balance: await available("ten_roberio"), payments: await count("investment_payment", "ten_roberio"), movements: await count("capital_movement", "ten_roberio") }, before);
});

test("CP9. banco: baixa e entrada não se alteram nem se apagam; nada passa do previsto; vínculos obrigatórios", async () => {
  const paymentId = await one(`select id from investment_payment where schedule_item_id = '${ids.item1}' limit 1`);
  const movementId = await one(`select capital_movement_id from investment_payment where id = '${paymentId}'`);
  await assert.rejects(admin(`update investment_payment set amount_cents = 1 where id = '${paymentId}'`), /não podem ser alterados/);
  await assert.rejects(admin(`delete from investment_payment where id = '${paymentId}'`), /não podem ser alterados/);
  await assert.rejects(admin(`delete from investment_capital_entry where investment_id = '${ids.investment}'`), /não podem ser alterados/);
  await assert.rejects(admin(`update capital_movement set amount_cents = 1 where id = '${movementId}'`), /não podem ser alterados/);
  await assert.rejects(admin(`delete from capital_movement where id = '${movementId}'`), /foreign key|violates/);
  await assert.rejects(admin(`update investment_schedule_item set yield_cents = 100 where id = '${ids.item1}'`), /já tem pagamento/);
  await assert.rejects(admin(`delete from investment_schedule_item where id = '${ids.item1}'`), /foreign key|violates/);
  // Saída de investidor solta (sem baixa) não fecha a transação.
  await assert.rejects(admin(`insert into capital_movement (id, tenant_id, kind, amount_cents, occurred_at, category, description, source, idempotency_key)
    values ('cap_solto', 'ten_roberio', 'WITHDRAWAL', 100, '${TODAY}', 'INVESTOR_YIELD_PAYMENT', 'solta', 'INVESTOR', 'k-solta')`), /sem baixa/);
  // Baixa acima do previsto, mesmo direto no banco e com a saída certa.
  await assert.rejects(admin(`insert into capital_movement (id, tenant_id, kind, amount_cents, occurred_at, category, description, source, idempotency_key)
      values ('cap_acima', 'ten_roberio', 'WITHDRAWAL', 1, '${TODAY}', 'INVESTOR_YIELD_PAYMENT', 'acima', 'INVESTOR', 'k-acima');
    insert into investment_payment (id, tenant_id, investment_id, schedule_item_id, kind, amount_cents, paid_on, method, capital_movement_id, idempotency_key)
      values ('ivp_acima', 'ten_roberio', '${ids.investment}', '${ids.item1}', 'YIELD', 1, '${TODAY}', 'PIX', 'cap_acima', 'k-acima')`), /acima do saldo/);
  // Categoria de investidor fora da origem INVESTOR, e baixa apontando para obrigação de outro tenant.
  await assert.rejects(admin(`insert into capital_movement (id, tenant_id, kind, amount_cents, occurred_at, category, description, source, idempotency_key)
    values ('cap_cat', 'ten_roberio', 'WITHDRAWAL', 1, '${TODAY}', 'INVESTOR_YIELD_PAYMENT', 'x', 'FINANCE', 'k-cat')`), /capital_movement_investor_fields/);
  await assert.rejects(admin(`insert into investment_payment (id, tenant_id, investment_id, schedule_item_id, kind, amount_cents, paid_on, method, capital_movement_id, idempotency_key)
    values ('ivp_x', 'ten_fernando', '${ids.investment}', '${ids.item3}', 'YIELD', 1, '${TODAY}', 'PIX', '${movementId}', 'k-x')`), /não pertence|foreign key/);
});

test("CP10. cronograma e contrato travados depois da entrada e das baixas (linhas sem baixa continuam editáveis)", async () => {
  const update = await investorAction(robério, "updateInvestmentScheduleItemAction", { investmentId: ids.investment, itemId: ids.item1, dueDate: daysAgo(10), yieldAmount: "600,00", principalAmount: "", description: "" });
  assert.match(update.error, /já tem pagamento registrado/);
  assert.match((await investorAction(robério, "deleteInvestmentScheduleItemAction", { investmentId: ids.investment, itemId: ids.item1 })).error, /já tem pagamento registrado/);
  assert.match((await investorAction(robério, "buildInvestmentScheduleAction", { investmentId: ids.investment, frequency: "MONTHLY", firstDueDate: TODAY, count: "2", yieldAmount: "1,00", principalAmount: "", replace: "1" })).error, /não pode ser substituído/);
  const contract = { investmentId: ids.investment, amount: "20.000,00", rate: "1,5", ratePeriod: "MONTHLY", startDate: daysAgo(30), investedOn: daysAgo(30), contractNumber: "CP-A" };
  assert.match((await investorAction(robério, "updateInvestmentAction", { ...contract, amount: "25.000,00" })).error, /entrada deste investimento já foi registrada/);
  assert.match((await investorAction(robério, "updateInvestmentAction", { ...contract, investedOn: daysAgo(29) })).error, /entrada deste investimento já foi registrada/);
  assert.match((await investorAction(robério, "updateInvestmentAction", { ...contract, status: "CANCELED" })).error, /não pode ser cancelado/);
  // Outros dados do contrato e uma linha ainda sem baixa podem mudar.
  assert.equal((await investorAction(robério, "updateInvestmentAction", { ...contract, notes: "observação nova" }))?.ok, true);
  const free = await investorAction(robério, "addInvestmentScheduleItemAction", { investmentId: ids.investment, dueDate: daysAgo(-40), yieldAmount: "10,00", principalAmount: "", description: "" });
  assert.equal(free?.ok, true);
  const freeId = await one(`select id from investment_schedule_item where investment_id = '${ids.investment}' and number = 4`);
  assert.equal((await investorAction(robério, "deleteInvestmentScheduleItemAction", { investmentId: ids.investment, itemId: freeId }))?.ok, true);
});

test("CP11. isolamento: o tenant B e o MASTER não veem nem mexem no capital do A, nem com ids forjados", async () => {
  const before = { payments: await count("investment_payment", "ten_roberio"), balance: await available("ten_roberio") };
  const fernandoMovements = await count("capital_movement", "ten_fernando");
  for (const cookie of [fernando, thais]) {
    assert.match((await pay(cookie, { scheduleItemId: ids.item3, amount: "1,00" })).error, /não encontrada nesta carteira/);
    assert.match((await enter(cookie, ids.investmentB, { amountCents: "5000000", enteredOn: daysAgo(38) })).error, /não encontrado nesta carteira/);
    const { html } = await page(cookie, "/contas-a-pagar");
    assert.ok(!html.includes("Paula Pagamentos") && !html.includes("CP-A"), "nada da carteira A");
  }
  // O MASTER vê o contrato do A no módulo Investidores, mas só consulta: sem botão de entrada nem de baixa.
  const masterView = await page(thais, `/investidores/investimentos/${ids.investmentB}`);
  assert.ok(masterView.html.includes("outra carteira"));
  assert.ok(!masterView.html.includes("Registrar a entrada deste investimento no capital") && !masterView.html.includes("Registrar baixa"));
  const ownerView = await page(robério, `/investidores/investimentos/${ids.investmentB}`);
  assert.ok(ownerView.html.includes("Registrar a entrada deste investimento no capital"));
  assert.deepEqual({ payments: await count("investment_payment", "ten_roberio"), balance: await available("ten_roberio") }, before);
  assert.equal(await count("capital_movement", "ten_fernando"), fernandoMovements);
  assert.equal(await count("investment_payment", "ten_fernando") + await count("investment_capital_entry", "ten_fernando"), 0);
});

test("CP12. MASTER na própria carteira: entrada e baixa só na carteira dele, sem misturar com a do A", async () => {
  const robérioMovements = await count("capital_movement", "ten_roberio");
  const investor = await investorAction(thais, "createInvestorAction", { name: "Investidor da Thaís", tenantId: "ten_thais" });
  const investment = await investorAction(thais, "createInvestmentAction", { investorId: investor.id, amount: "1.000,00", rate: "1", ratePeriod: "MONTHLY", startDate: TODAY });
  await investorAction(thais, "addInvestmentScheduleItemAction", { investmentId: investment.id, dueDate: TODAY, yieldAmount: "10,00", principalAmount: "", description: "" });
  const before = await available("ten_thais");
  assert.equal((await enter(thais, investment.id, { amountCents: "100000", enteredOn: TODAY }))?.ok, true);
  const itemId = await one(`select id from investment_schedule_item where investment_id = '${investment.id}'`);
  const paid = await pay(thais, { scheduleItemId: itemId, amount: "10,00" });
  assert.equal(paid?.ok, true, JSON.stringify(paid));
  assert.equal(await available("ten_thais") - before, 100_000 - 1_000);
  assert.equal(await count("capital_movement", "ten_roberio"), robérioMovements);
  const own = await page(thais, "/contas-a-pagar");
  assert.ok(own.html.includes("Investidor da Thaís") && !own.html.includes("Paula Pagamentos"));
  const finance = await page(robério, `/financeiro?de=${daysAgo(40)}&ate=${TODAY}`);
  assert.ok(!finance.html.includes("Investidor da Thaís"));
});

test("CP13. telas no desktop e no celular: contas a pagar, detalhe, formulário de baixa e capital do contrato", async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  for (const [label, viewport] of [["desktop", { width: 1440, height: 900 }], ["celular", { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport });
    const [name, value] = robério.split("; ").find((cookie) => cookie.includes("session_token")).split(/=(.*)/s);
    await context.addCookies([{ name, value, domain: new URL(BASE).hostname, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
    const browserPage = await context.newPage();
    await browserPage.goto(`${BASE}/contas-a-pagar`);
    await browserPage.getByRole("heading", { name: "Contas a pagar" }).waitFor();
    if (SHOTS) await browserPage.screenshot({ path: `${SHOTS}/contas-a-pagar-${label}.png`, fullPage: true });
    const upcoming = browserPage.getByRole("region", { name: "Próximas" });
    await upcoming.getByRole("button", { name: "Registrar baixa" }).first().click();
    const form = upcoming.locator('[aria-label="Registrar baixa"]');
    await form.getByLabel("Valor pago (R$)").waitFor();
    await form.getByLabel("Valor pago (R$)").fill("999.999,00");
    await form.getByText("maior que o saldo da obrigação").waitFor();
    assert.equal(await form.getByRole("button", { name: "Confirmar baixa" }).isDisabled(), true);
    await form.getByLabel("Valor pago (R$)").fill("1,00");
    await form.getByText("Sai do capital uma única vez").waitFor();
    if (SHOTS) await upcoming.screenshot({ path: `${SHOTS}/contas-a-pagar-baixa-${label}.png` });
    assert.equal(await browserPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `sem rolagem horizontal (${label})`);
    await browserPage.goto(`${BASE}/investidores/investimentos/${ids.investmentB}`);
    const cash = browserPage.getByRole("region", { name: "Capital e pagamentos do investimento" });
    await cash.getByRole("button", { name: "Registrar a entrada deste investimento no capital" }).click();
    await cash.getByText(`Confirmo que ${money(6_000_000)} entraram na carteira`).waitFor();
    if (SHOTS) await cash.screenshot({ path: `${SHOTS}/contrato-entrada-capital-${label}.png` });
    assert.equal(await browserPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `sem rolagem horizontal no contrato (${label})`);
    await context.close();
  }
  // Abrir formulários não grava nada.
  assert.equal(await one(`select count(*)::int from investment_capital_entry where investment_id = '${ids.investmentB}'`), 0);
});

test("CP14. nada fora do previsto mudou: operações, pagamentos de clientes, clientes, carteiras, tenants, usuários e o tenant B", async () => {
  assert.equal(await protectedHash(), hashBefore);
});
