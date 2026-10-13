// Módulo Financeiro de ponta a ponta (HTTP + banco): entradas e saídas manuais, integração com o capital disponível,
// envio duplicado, falha no meio da gravação, isolamento entre tenants, MASTER/TENANT_USER, filtros e regressão.
// SÓ em ambiente LOCAL e DESCARTÁVEL (ver tests/e2e/README.md). Usa os dados fictícios ten_roberio (A), ten_fernando (B)
// e ten_thais (MASTER com carteira própria). Rodar com o servidor usando um papel COM BYPASSRLS (como a produção) e, de
// novo, sem ele.
//   E2E_DATABASE_URL=postgres://dono:senha@127.0.0.1:5432/crediai node --test tests/e2e/financeiro.e2e.mjs
import { test } from "node:test";
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
const money = (cents) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100).replace(/\s/g, " ");

let lastLogin = 0;
async function login(email) {
  const wait = 11_000 - (Date.now() - lastLogin);
  if (wait > 0) await sleep(wait);
  lastLogin = Date.now();
  const response = await fetch(`${BASE}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email, password: process.env.E2E_PASSWORD ?? "Senha-Teste-Local-123" }) });
  assert.equal(response.status, 200, `login de ${email}`);
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}
async function action(cookie, name, fields, path = "/financeiro") {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(`_1_${key}`, value);
  form.append("0", '["$K1"]');
  const response = await fetch(`${BASE}${path}`, { method: "POST", redirect: "manual", headers: { cookie, "next-action": actionId(name), accept: "text/x-component", origin: BASE }, body: form });
  const result = (await response.text()).match(/^1:(\{.*\})$/m)?.[1];
  return { status: response.status, result: result ? JSON.parse(result) : null };
}
const page = async (cookie, path) => {
  const response = await fetch(`${BASE}${path}`, { redirect: "manual", headers: cookie ? { cookie } : {} });
  return { status: response.status, location: response.headers.get("location"), html: response.status === 200 ? text(await response.text()) : "" };
};
let requestCounter = 0;
const requestId = () => `e2e-fin-${Date.now()}-${++requestCounter}-abcdef`;
const movement = (extra) => ({ direction: "OUT", category: "SALARY_WITHDRAWAL", amount: "1.500,00", occurredAt: TODAY, description: "Salário de teste", notes: "", requestId: requestId(), ...extra });
const register = (cookie, extra) => action(cookie, "registerFinanceMovementAction", movement(extra));

// Capital disponível pela mesma fórmula do servidor (actions.ts → availableCapitalCents), lido direto do banco.
const available = async (tenantId) => Number(await one(`select w.initial_capital_cents
  + coalesce((select sum(case when m.kind in ('CONTRIBUTION','OTHER_INCOME') then m.amount_cents else -m.amount_cents end) from capital_movement m where m.tenant_id = w.tenant_id and m.cycle_number = w.cycle_number), 0)
  - coalesce((select sum(o.principal_cents) from loan_operation o where o.tenant_id = w.tenant_id and o.cycle_number = w.cycle_number and o.status <> 'CANCELED'), 0)
  + coalesce((select sum(p.amount_cents) from payment p join loan_operation o on o.id = p.operation_id where p.tenant_id = w.tenant_id and o.cycle_number = w.cycle_number), 0)
  from wallet w where w.tenant_id = '${tenantId}'`));
const movementCount = (tenantId) => one(`select count(*)::int from capital_movement where tenant_id = '${tenantId}'`);
// Tudo do tenant B (Fernando) e da plataforma: nada disso pode mudar.
const tenantBHash = () => one(`select md5(string_agg(x, '|' order by x)) from (
  select 'c'||row(c.*)::text x from client c where tenant_id = 'ten_fernando' union all select 'o'||row(o.*)::text from loan_operation o where tenant_id = 'ten_fernando'
  union all select 'p'||row(p.*)::text from payment p where tenant_id = 'ten_fernando' union all select 'w'||row(w.*)::text from wallet w where tenant_id = 'ten_fernando'
  union all select 'm'||row(m.*)::text from capital_movement m where tenant_id = 'ten_fernando' union all select 'r'||row(r.*)::text from loan_renewal r where tenant_id = 'ten_fernando'
  union all select 'i'||row(i.*)::text from investment i where tenant_id = 'ten_fernando' union all select 'v'||row(v.*)::text from investor v where tenant_id = 'ten_fernando'
  union all select 't'||row(t.*)::text from tenant t union all select 's'||row(s.*)::text from subscription s
  union all select 'u'||concat_ws(',', u.id, u.name, u.email, u.role, u.tenant_id, u.active) from "user" u) t`);
// Pagamentos, operações, contratos e investimentos já existentes de todos os tenants.
const existingHash = () => one(`select md5(string_agg(x, '|' order by x)) from (
  select 'o'||row(o.*)::text x from loan_operation o union all select 'p'||row(p.*)::text from payment p union all select 'r'||row(r.*)::text from loan_renewal r
  union all select 'i'||row(i.*)::text from investment i union all select 'd'||concat_ws(',', d.id, md5(d.content)) from investment_document d) t`);

let robério, fernando, thais, bBefore, existingBefore;
const ids = {};

test("preparação", async () => {
  // Carteira A (Robério) com R$ 10.000 e ciclo iniciado há 20 dias, para testar datas retroativas. Banco local fictício.
  await admin(`update wallet set initial_capital_cents = 1000000, created_at = '${daysAgo(20)} 12:00:00+00' where tenant_id = 'ten_roberio'`);
  bBefore = await tenantBHash();
  existingBefore = await existingHash();
  robério = await login("roberio@teste.local");
  fernando = await login("fernando@teste.local");
  thais = await login("thais@teste.local");
});

test("FE1. menu e painel: Financeiro no menu lateral, saldo atual igual ao capital disponível", async () => {
  const dashboard = await fetch(`${BASE}/`, { headers: { cookie: robério } }).then((response) => response.text());
  assert.match(dashboard, /href="\/financeiro"/, "item Financeiro no menu do dashboard");
  const { status, html } = await page(robério, "/financeiro");
  assert.equal(status, 200);
  for (const label of ["Saldo disponível atual", "Entradas no período", "Saídas no período", "Saldo líquido do período", "Nova entrada", "Nova saída", "Movimentações"]) assert.ok(html.includes(label), label);
  assert.ok(html.includes(money(await available("ten_roberio"))), "saldo da página = fórmula do servidor");
  // Sem sessão: login.
  const anonymous = await page(null, "/financeiro");
  assert.ok([303, 307, 308].includes(anonymous.status) && anonymous.location?.startsWith("/login"), `${anonymous.status} ${anonymous.location}`);
});

test("FE2. aporte pelo Financeiro aumenta o saldo uma única vez (mesmo tipo da tela Capital) e gera auditoria", async () => {
  const before = await available("ten_roberio");
  const response = await register(robério, { direction: "IN", category: "CAPITAL_CONTRIBUTION", amount: "2.000,00", description: "Aporte do sócio", notes: "transferência 123" });
  assert.equal(response.result?.ok, true, JSON.stringify(response.result));
  assert.equal(await available("ten_roberio") - before, 200_000);
  const [row] = await admin(`select * from capital_movement where tenant_id = 'ten_roberio' and description = 'Aporte do sócio'`);
  assert.equal(row.kind, "CONTRIBUTION");
  assert.equal(row.category, "CAPITAL_CONTRIBUTION");
  assert.equal(row.source, "FINANCE");
  assert.equal(row.created_by_user_id, "u_roberio");
  assert.equal(Number(row.amount_cents), 200_000);
  const [audit] = await admin(`select * from admin_audit_log where entity = 'capital_movement' and entity_id = '${row.id}'`);
  assert.equal(audit.action, "FINANCE_MOVEMENT_REGISTERED");
  assert.equal(audit.tenant_id, "ten_roberio");
  assert.equal(audit.actor_user_id, "u_roberio");
  assert.ok(!JSON.stringify(audit.after).includes("transferência") && !JSON.stringify(audit.after).includes("Aporte do sócio"), "auditoria sem descrição/observações");
  // O aporte aparece na tela Capital (mesma fonte) e uma única vez no Financeiro.
  const capital = await page(robério, "/?tela=capital");
  assert.ok(capital.html.includes("Aporte do sócio"));
  // Uma única linha no histórico (conta as células renderizadas, não os dados enviados ao navegador).
  const raw = await fetch(`${BASE}/financeiro`, { headers: { cookie: robério } }).then((response) => response.text());
  assert.equal(raw.match(/<td>Aporte do sócio</g)?.length, 1);
});

test("FE3. envio duplicado (clique duplo, reenvio) grava uma única vez", async () => {
  const before = await movementCount("ten_roberio");
  const balance = await available("ten_roberio");
  const fields = movement({ direction: "IN", category: "OTHER_INCOME", amount: "100,00", description: "Reembolso de teste" });
  const results = await Promise.all([1, 2, 3].map(() => action(robério, "registerFinanceMovementAction", fields)));
  assert.ok(results.every((response) => response.result?.ok === true), JSON.stringify(results.map((response) => response.result)));
  const again = await action(robério, "registerFinanceMovementAction", fields);
  assert.match(again.result.message, /já estava registrada/);
  assert.equal(await movementCount("ten_roberio"), before + 1);
  assert.equal(await available("ten_roberio") - balance, 10_000);
});

test("FE4. empréstimo concedido reduz o saldo pelo fluxo atual (sem lançamento no Financeiro)", async () => {
  const before = await available("ten_roberio");
  const movementsBefore = await movementCount("ten_roberio");
  const created = await action(robério, "createOperationAction", { clientId: "c_rob", modality: "SINGLE", frequency: "MONTHLY", principal: "3.000,00", rate: "30", loanDate: TODAY, dueDate: daysAgo(-30) }, "/");
  assert.equal(created.result?.ok, true, JSON.stringify(created.result));
  ids.operation = await one(`select id from loan_operation where tenant_id = 'ten_roberio' order by created_at desc limit 1`);
  assert.equal(before - await available("ten_roberio"), 300_000);
  assert.equal(await movementCount("ten_roberio"), movementsBefore, "nenhum movimento de capital criado");
  const { html } = await page(robério, "/financeiro?tipo=saida&categoria=LOAN");
  assert.ok(html.includes("Empréstimo concedido") && html.includes("Cliente do Robério"));
});

test("FE5. recebimento de parcela atualiza o saldo uma vez, separado em principal e juros", async () => {
  const before = await available("ten_roberio");
  const movementsBefore = await movementCount("ten_roberio");
  const paid = await action(robério, "registerPaymentAction", { operationId: ids.operation, amount: "1.200,00", paidAt: TODAY, notes: "" }, "/");
  assert.equal(paid.result?.ok, true, JSON.stringify(paid.result));
  assert.equal(await available("ten_roberio") - before, 120_000);
  assert.equal(await movementCount("ten_roberio"), movementsBefore, "o recebimento não vira lançamento do Financeiro");
  const { html } = await page(robério, "/financeiro?categoria=PAYMENT");
  assert.equal(html.split("Recebimento de operação").length - 1 >= 1, true);
  // Juros primeiro: R$ 900 de juros e R$ 300 de principal.
  assert.ok(html.includes(`Principal ${money(30_000)} · Juros ${money(90_000)}`), "divisão principal/juros");
  assert.ok(html.includes("Recebimento de juros") && html.includes("Recebimento de principal"));
});

test("FE6. retirada de salário: saída que reduz o saldo uma vez e não altera a operação do cliente", async () => {
  const operationBefore = await one(`select row(o.*)::text from loan_operation o where id = '${ids.operation}'`);
  const before = await available("ten_roberio");
  const response = await register(robério, { amount: "1.500,00", description: "Salário de outubro" });
  assert.equal(response.result?.ok, true, JSON.stringify(response.result));
  assert.equal(before - await available("ten_roberio"), 150_000);
  const [row] = await admin(`select * from capital_movement where tenant_id = 'ten_roberio' and description = 'Salário de outubro'`);
  assert.equal(row.kind, "WITHDRAWAL");
  assert.equal(row.category, "SALARY_WITHDRAWAL");
  assert.equal(Number(row.amount_cents), 150_000, "valor positivo; o sinal vem do tipo");
  assert.equal(await one(`select row(o.*)::text from loan_operation o where id = '${ids.operation}'`), operationBefore, "operação do cliente intacta");
  assert.equal(await one(`select count(*)::int from loan_operation where tenant_id = 'ten_roberio'`), 1, "a retirada não cria operação");
  // O dashboard reflete a saída: card de capital disponível com o novo valor.
  const dashboard = await fetch(`${BASE}/`, { headers: { cookie: robério } }).then((response) => response.text());
  assert.equal(Number(dashboard.match(/availableCents\\?":(-?\d+)/)?.[1]), await available("ten_roberio"), "card Capital disponível do dashboard");
  const finance = await page(robério, "/financeiro?tipo=saida");
  assert.ok(finance.html.includes("Retirada de salário") && finance.html.includes("Robério Santos") && finance.html.includes("Financeiro · lançamento manual"));
});

test("FE7. valores zero, negativos, categoria, data e descrição inválidos são recusados sem gravar nada", async () => {
  const before = await movementCount("ten_roberio");
  const balance = await available("ten_roberio");
  const attempts = [
    [{ amount: "0" }, /maior que zero/], [{ amount: "0,00" }, /maior que zero/], [{ amount: "-150,00" }, /sem sinal de menos/], [{ amount: "abc" }, /valor/],
    [{ category: "CAPITAL_CONTRIBUTION" }, /categoria de saída/], [{ category: "LOAN" }, /categoria/], [{ direction: "IN", category: "TAXES_AND_FEES" }, /categoria de entrada/],
    [{ occurredAt: daysAgo(-1) }, /depois de hoje/], [{ occurredAt: daysAgo(30) }, /início do ciclo/], [{ occurredAt: "2026-02-30" }, /data válida/],
    [{ description: "   " }, /Descreva/], [{ requestId: "" }, /Recarregue/],
  ];
  for (const [extra, message] of attempts) {
    const response = await register(robério, extra);
    assert.equal(response.result?.ok, false, JSON.stringify(extra));
    assert.match(response.result.error, message, JSON.stringify(extra));
  }
  assert.equal(await movementCount("ten_roberio"), before);
  assert.equal(await available("ten_roberio"), balance);
});

test("FE8. saída maior que o saldo (hoje ou retroativa) é recusada com mensagem explícita", async () => {
  const balance = await available("ten_roberio");
  const before = await movementCount("ten_roberio");
  const tooMuch = await register(robério, { amount: (balance / 100 + 0.01).toFixed(2).replace(".", ","), category: "OPERATING_EXPENSE", description: "Despesa grande" });
  assert.equal(tooMuch.result?.ok, false);
  assert.match(tooMuch.result.error, /Saldo insuficiente/);
  // Há 10 dias o saldo era R$ 10.000 (capital inicial); uma saída de R$ 10.500 nessa data deixaria aquele ponto negativo.
  const backdated = await register(robério, { amount: "10.500,00", occurredAt: daysAgo(10), category: "PARTNER_WITHDRAWAL", description: "Retirada retroativa" });
  assert.equal(backdated.result?.ok, false);
  assert.match(backdated.result.error, /ficaria negativo|Saldo insuficiente/);
  // O valor exato do saldo passa (deixa zero, não negativo)... e é desfeito no banco local para continuar o roteiro.
  assert.equal(await movementCount("ten_roberio"), before);
  const exact = await register(robério, { amount: (balance / 100).toFixed(2).replace(".", ","), category: "TAXES_AND_FEES", description: "Saída do saldo inteiro" });
  assert.equal(exact.result?.ok, true, JSON.stringify(exact.result));
  assert.equal(await available("ten_roberio"), 0);
  await admin(`delete from capital_movement where tenant_id = 'ten_roberio' and description = 'Saída do saldo inteiro'`);
});

test("FE9. falha no meio da gravação (auditoria recusada) não deixa saldo nem movimento pela metade", async () => {
  const before = await movementCount("ten_roberio");
  const balance = await available("ten_roberio");
  await sql.unsafe(`create or replace function e2e_fail_finance_audit() returns trigger language plpgsql as $$ begin if new.entity = 'capital_movement' then raise exception 'falha simulada'; end if; return new; end $$;
    create trigger e2e_fail_finance_audit before insert on admin_audit_log for each row execute function e2e_fail_finance_audit();`);
  try {
    const response = await register(robério, { amount: "100,00", description: "Não pode ficar gravado" });
    assert.notEqual(response.result?.ok, true, "a ação não pode dizer que gravou");
  } finally {
    await sql.unsafe(`drop trigger e2e_fail_finance_audit on admin_audit_log; drop function e2e_fail_finance_audit();`);
  }
  assert.equal(await movementCount("ten_roberio"), before, "transação desfeita");
  assert.equal(await available("ten_roberio"), balance);
  assert.equal(await one(`select count(*)::int from capital_movement where description = 'Não pode ficar gravado'`), 0);
});

test("FE10. isolamento: o tenant vem da sessão; A não vê nem grava em B", async () => {
  const response = await register(robério, { tenantId: "ten_fernando", tenant_id: "ten_fernando", amount: "10,00", description: "Tentativa no tenant B" });
  assert.equal(response.result?.ok, true);
  assert.equal(await one(`select tenant_id from capital_movement where description = 'Tentativa no tenant B'`), "ten_roberio", "gravado na carteira da sessão");
  const a = await page(robério, "/financeiro?de=2026-01-01");
  for (const name of ["Alexandre Teste", "Willian Teste", "Amany Teste", "aporte antigo"]) assert.ok(!a.html.includes(name), `A viu ${name}`);
  const b = await page(fernando, "/financeiro?de=2026-01-01");
  assert.equal(b.status, 200);
  for (const name of ["Salário de outubro", "Aporte do sócio", "Tentativa no tenant B", "Cliente do Robério"]) assert.ok(!b.html.includes(name), `B viu ${name}`);
  assert.ok(b.html.includes("Alexandre Teste"), "B vê os próprios empréstimos");
  assert.ok(b.html.includes(money(await available("ten_fernando"))), "saldo do B pela mesma fórmula");
});

test("FE11. permissões: MASTER usa a própria carteira; TENANT_USER a dele; nenhum vê o log de auditoria", async () => {
  const before = await available("ten_thais");
  const response = await register(thais, { amount: "20,00", category: "OTHER_OUTFLOW", description: "Saída da MASTER" });
  assert.equal(response.result?.ok, true, JSON.stringify(response.result));
  assert.equal(await one(`select tenant_id from capital_movement where description = 'Saída da MASTER'`), "ten_thais");
  assert.equal(before - await available("ten_thais"), 2_000);
  const master = await page(thais, "/financeiro?de=2026-01-01");
  assert.ok(master.html.includes("Saída da MASTER") && master.html.includes("Retirada (sem categoria)"), "retirada antiga sem categoria aparece");
  assert.ok(!master.html.includes("Salário de outubro"), "MASTER no Financeiro vê só a própria carteira");
  // TENANT_USER continua sem a administração (auditoria).
  const registros = await page(robério, "/admin/registros?aba=auditoria");
  assert.ok([303, 307, 308].includes(registros.status) && registros.location === "/");
  const audit = await page(thais, "/admin/registros?aba=auditoria");
  assert.equal(audit.status, 200);
  assert.ok(audit.html.includes("Movimentação financeira registrada"));
});

test("FE12. histórico e filtros por período, tipo e categoria", async () => {
  const outs = await page(robério, "/financeiro?tipo=saida");
  assert.ok(outs.html.includes("Salário de outubro") && !outs.html.includes("Aporte do sócio"));
  const salaries = await page(robério, "/financeiro?categoria=SALARY_WITHDRAWAL");
  assert.ok(salaries.html.includes("Salário de outubro") && !salaries.html.includes("Reembolso de teste"));
  const past = await page(robério, `/financeiro?de=${daysAgo(9)}&ate=${daysAgo(8)}`);
  assert.ok(past.html.includes("Nenhuma movimentação neste período."));
  for (const column of ["Data", "Tipo", "Categoria", "Descrição", "Valor", "Saldo após", "Responsável", "Origem"]) assert.ok(outs.html.includes(column), column);
  // Filtro inválido não quebra a página.
  assert.equal((await page(robério, "/financeiro?de=lixo&tipo=x&categoria=%27%3Bdrop")).status, 200);
});

test("FE13. regressão: telas existentes funcionam e nada fora do lançado mudou", async () => {
  for (const tela of ["", "?tela=capital", "?tela=operacoes", "?tela=pagamentos", "?tela=relatorios", "?tela=configuracoes"]) {
    assert.equal((await page(robério, `/${tela}`)).status, 200, tela || "dashboard");
  }
  assert.equal((await page(robério, "/investidores")).status, 200);
  assert.equal(await tenantBHash(), bBefore, "nenhum dado do Fernando (B) nem da plataforma mudou");
  // Fora a operação e o pagamento criados em FE4/FE5 (só no tenant A), operações, pagamentos e investimentos ficam iguais.
  const created = await one(`select md5(string_agg(x, '|' order by x)) from (
    select 'o'||row(o.*)::text x from loan_operation o where id <> '${ids.operation}' union all select 'p'||row(p.*)::text from payment p where operation_id <> '${ids.operation}'
    union all select 'r'||row(r.*)::text from loan_renewal r where operation_id <> '${ids.operation}'
    union all select 'i'||row(i.*)::text from investment i union all select 'd'||concat_ws(',', d.id, md5(d.content)) from investment_document d) t`);
  assert.equal(created, existingBefore);
  await sql.end();
});
