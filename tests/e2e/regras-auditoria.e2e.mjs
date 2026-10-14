// Auditoria geral (14/10/2026): regras de data e de capital corrigidas na auditoria, enviadas direto às server actions.
//  • pagamento com data futura recusado (cadastro e correção);
//  • empréstimo retroativo que deixaria o extrato do capital negativo recusado (antes só o saldo de hoje era conferido);
//  • correção de pagamento para uma data mais tarde que descobre uma saída feita no meio recusada;
//  • cronograma do investidor com devolução de principal acima do valor investido recusado.
// SÓ em ambiente LOCAL e DESCARTÁVEL (ver tests/e2e/README.md). Usa os dados fictícios ten_roberio (A) e ten_fernando (B).
//   E2E_DATABASE_URL=… node --test tests/e2e/cpf-auditoria.e2e.mjs
import { test, after } from "node:test";
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
async function action(cookie, name, fields, path = "/") {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(`_1_${key}`, value);
  form.append("0", '["$K1"]');
  const response = await fetch(`${BASE}${path}`, { method: "POST", headers: { cookie, "next-action": actionId(name), accept: "text/x-component", origin: BASE }, body: form });
  const result = (await response.text()).match(/^1:(\{.*\})$/m)?.[1];
  return result ? JSON.parse(result) : null;
}

const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
const shift = (days) => { const date = new Date(`${TODAY}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); };
const ledgerHash = () => one(`select md5(string_agg(x, '|' order by x)) from (select row(o.*)::text x from loan_operation o union all select row(p.*)::text from payment p union all select row(m.*)::text from capital_movement m) t`);
let robério;
const ids = {};

test("preparação: carteira do tenant A com aporte de R$ 5.000 há 4 dias", async () => {
  robério = await login("roberio@teste.local");
  assert.equal((await action(robério, "registerContributionAction", { amount: "5.000,00", occurredAt: shift(-4) }))?.ok, true);
  assert.equal((await action(robério, "createClientAction", { name: "Cliente Regras Auditoria" }))?.ok, true);
  ids.client = await one(`select id from client where name = 'Cliente Regras Auditoria'`);
});

test("REG1. empréstimo retroativo antes do dinheiro entrar é recusado; na data do aporte ou depois, aceito", async () => {
  const before = await ledgerHash();
  const early = await action(robério, "createOperationAction", { clientId: ids.client, loanDate: shift(-6), principal: "5.000,00", rate: "10", dueDate: shift(20) });
  assert.equal(early?.ok, false, JSON.stringify(early));
  assert.match(early.error, /ficaria negativo/);
  assert.equal(await ledgerHash(), before, "nada gravado");
  const ok = await action(robério, "createOperationAction", { clientId: ids.client, loanDate: shift(-3), principal: "4.000,00", rate: "10", dueDate: shift(20) });
  assert.equal(ok?.ok, true, JSON.stringify(ok));
  ids.operation = await one(`select id from loan_operation where client_id = '${ids.client}'`);
});

test("REG2. pagamento com data futura é recusado (cadastro e correção) e nada entra no capital", async () => {
  const before = await ledgerHash();
  for (const days of [1, 30, 365]) {
    const result = await action(robério, "registerPaymentAction", { operationId: ids.operation, amount: "4.400,00", paidAt: shift(days) });
    assert.equal(result?.ok, false, JSON.stringify(result));
    assert.match(result.error, /depois de hoje/);
  }
  assert.equal(await ledgerHash(), before);
  assert.equal(await one(`select status from loan_operation where id = '${ids.operation}'`), "OPEN");
  assert.equal((await action(robério, "registerPaymentAction", { operationId: ids.operation, amount: "1.000,00", paidAt: shift(-2) }))?.ok, true);
  ids.payment = await one(`select id from payment where operation_id = '${ids.operation}'`);
  const future = await action(robério, "editPaymentAction", { paymentId: ids.payment, amount: "1.000,00", paidAt: shift(3) });
  assert.equal(future?.ok, false);
  assert.match(future.error, /depois de hoje/);
});

test("REG3. corrigir o pagamento para uma data mais tarde que descobre uma retirada feita no meio é recusado", async () => {
  // Disponível: 1.000 (aporte 5.000 − empréstimo 4.000) + 1.000 recebido há 2 dias = 2.000. Retirada de 2.000 ontem.
  assert.equal((await action(robério, "registerWithdrawalAction", { amount: "2.000,00", occurredAt: shift(-1) }))?.ok, true);
  const before = await ledgerHash();
  const moved = await action(robério, "editPaymentAction", { paymentId: ids.payment, amount: "1.000,00", paidAt: TODAY });
  assert.equal(moved?.ok, false, JSON.stringify(moved));
  assert.match(moved.error, /ficaria negativo/);
  assert.equal(await ledgerHash(), before);
  // Mudar só a observação continua liberado.
  assert.equal((await action(robério, "editPaymentAction", { paymentId: ids.payment, amount: "1.000,00", paidAt: shift(-2), notes: "conferido" }))?.ok, true);
});

test("REG4. cronograma: devolução de principal acima do valor investido é recusada (montagem, inclusão e edição)", async () => {
  const investor = await action(robério, "createInvestorAction", { name: "Investidor Regras Auditoria" }, "/investidores");
  const investment = await action(robério, "createInvestmentAction", { investorId: investor.id, amount: "20.000,00", rate: "1", ratePeriod: "MONTHLY", startDate: shift(-1), contractNumber: "AUD-1" }, "/investidores");
  assert.equal(investment?.ok, true, JSON.stringify(investment));
  const add = (principalAmount, yieldAmount = "") => action(robério, "addInvestmentScheduleItemAction", { investmentId: investment.id, dueDate: shift(60), principalAmount, yieldAmount }, "/investidores");
  assert.equal((await add("20.000,00"))?.ok, true);
  const second = await add("20.000,00");
  assert.equal(second?.ok, false, JSON.stringify(second));
  assert.match(second.error, /mais que o valor investido/);
  assert.equal((await add("", "200,00"))?.ok, true, "rendimento continua livre");
  const item = await one(`select id from investment_schedule_item where investment_id = '${investment.id}' and principal_cents > 0`);
  const edit = await action(robério, "updateInvestmentScheduleItemAction", { investmentId: investment.id, itemId: item, dueDate: shift(60), principalAmount: "20.000,01" }, "/investidores");
  assert.equal(edit?.ok, false);
  const build = await action(robério, "buildInvestmentScheduleAction", { investmentId: investment.id, replace: "1", frequency: "MONTHLY", firstDueDate: shift(30), count: "3", yieldAmount: "200,00", principalAmount: "25.000,00" }, "/investidores");
  assert.equal(build?.ok, false);
  assert.match(build.error, /mais que o valor investido/);
  assert.equal(await one(`select sum(principal_cents)::int from investment_schedule_item where investment_id = '${investment.id}'`), 2_000_000);
});
