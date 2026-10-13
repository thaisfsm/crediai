// Parcelado quinzenal de ponta a ponta (HTTP + banco + navegador): cadastro com a prévia dos vencimentos, as datas do
// exemplo (06/11, 21/11 e 06/12), pagamento parcial e quitação, capital uma única vez e operações antigas intactas.
// SÓ em ambiente LOCAL e DESCARTÁVEL (ver tests/e2e/README.md). Usa o tenant fictício ten_roberio (A); ten_fernando (B)
// tem as operações mensais, quinzenais e parceladas antigas que não podem mudar.
//   E2E_DATABASE_URL=… PLAYWRIGHT_MODULE=/caminho/playwright/index.mjs node --test tests/e2e/parcelado-quinzenal.e2e.mjs
import { test, after } from "node:test";
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
const SHOTS = process.env.E2E_SCREENSHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
let browser;
after(async () => { await browser?.close(); await sql.end(); });

async function login(email) {
  const response = await fetch(`${BASE}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email, password: process.env.E2E_PASSWORD ?? "Senha-Teste-Local-123" }) });
  assert.equal(response.status, 200, `login de ${email}`);
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}
async function action(cookie, name, fields) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(`_1_${key}`, value);
  form.append("0", '["$K1"]');
  const response = await fetch(`${BASE}/`, { method: "POST", headers: { cookie, "next-action": actionId(name), accept: "text/x-component", origin: BASE }, body: form });
  const result = (await response.text()).match(/^1:(\{.*\})$/m)?.[1];
  return result ? JSON.parse(result) : null;
}
const available = async (tenantId) => Number(await one(`select w.initial_capital_cents
  + coalesce((select sum(case when m.kind in ('CONTRIBUTION','OTHER_INCOME') then m.amount_cents else -m.amount_cents end) from capital_movement m where m.tenant_id = w.tenant_id and m.cycle_number = w.cycle_number), 0)
  - coalesce((select sum(o.principal_cents) from loan_operation o where o.tenant_id = w.tenant_id and o.cycle_number = w.cycle_number and o.status <> 'CANCELED'), 0)
  + coalesce((select sum(p.amount_cents) from payment p join loan_operation o on o.id = p.operation_id where p.tenant_id = w.tenant_id and o.cycle_number = w.cycle_number), 0)
  from wallet w where w.tenant_id = '${tenantId}'`));
// Operações, pagamentos e renovações já existentes (mensais, quinzenais, parceladas e diárias): não podem mudar.
const existingHash = () => one(`select md5(string_agg(x, '|' order by x)) from (
  select 'o'||row(o.*)::text x from loan_operation o where o.tenant_id <> 'ten_roberio'
  union all select 'p'||row(p.*)::text from payment p where p.tenant_id <> 'ten_roberio' union all select 'r'||row(r.*)::text from loan_renewal r) t`);
const FIRST_DUE = "2026-11-06";

let robério, before, availableBefore, opId;
test("preparação: carteira A com capital e cliente", async () => {
  await admin(`update wallet set initial_capital_cents = 500000 where tenant_id = 'ten_roberio'`);
  await admin(`insert into client(id, tenant_id, name) values ('c_e2e_quinz', 'ten_roberio', 'Cliente Quinzenal')`);
  before = await existingHash();
  robério = await login("roberio@teste.local");
  availableBefore = await available("ten_roberio");
});

test("PQ1. cadastra R$ 600 em 3 × R$ 300 quinzenais com as datas do exemplo", async () => {
  const result = await action(robério, "createOperationAction", { clientId: "c_e2e_quinz", modality: "INSTALLMENT", installmentFrequency: "BIWEEKLY", loanAmount: "600,00", installment: "300,00", term: "3", loanDate: "2026-10-13", firstDueDate: FIRST_DUE });
  assert.equal(result.ok, true, JSON.stringify(result));
  const [op] = await admin(`select *, first_due_date::text as first_due, due_date::text as due from loan_operation where client_id = 'c_e2e_quinz'`);
  opId = op.id;
  assert.deepEqual([op.modality, op.frequency, Number(op.principal_cents), Number(op.interest_cents), Number(op.total_cents), op.installment_count, Number(op.installment_cents), op.first_due, op.due, op.calculation_rule, op.interest_rate_bps],
    ["INSTALLMENT", "BIWEEKLY", 60000, 30000, 90000, 3, 30000, FIRST_DUE, "2026-12-06", "FIXED_BIWEEKLY_INSTALLMENTS_V1", 1667]);
  // O principal sai do capital uma única vez.
  assert.equal(await available("ten_roberio"), availableBefore - 60000);
  // Sem a periodicidade (formulário antigo) continua mensal.
  const monthly = await action(robério, "createOperationAction", { clientId: "c_e2e_quinz", modality: "INSTALLMENT", loanAmount: "600,00", installment: "300,00", term: "3", loanDate: "2026-10-13", firstDueDate: FIRST_DUE });
  assert.equal(monthly.ok, true);
  const [m] = await admin(`select frequency, due_date::text as due_date, calculation_rule from loan_operation where client_id = 'c_e2e_quinz' and id <> '${opId}'`);
  assert.deepEqual([m.frequency, m.due_date, m.calculation_rule], ["MONTHLY", "2027-01-06", "FIXED_MONTHLY_INSTALLMENTS_V1"]);
  await admin(`update loan_operation set status = 'CANCELED' where client_id = 'c_e2e_quinz' and id <> '${opId}'`);
});

test("PQ2. o banco aceita parcelado quinzenal só com parcelas coerentes e recusa periodicidade diária no parcelado", async () => {
  await assert.rejects(admin(`insert into loan_operation(id,tenant_id,client_id,principal_cents,interest_rate_bps,interest_cents,total_cents,loan_date,due_date,calculation_rule,modality,frequency,installment_count,installment_cents,first_due_date) values ('op_bad_daily','ten_roberio','c_e2e_quinz',60000,0,30000,90000,'2026-10-13','2026-12-06','X','INSTALLMENT','DAILY',3,30000,'2026-11-06')`));
  await assert.rejects(admin(`insert into loan_operation(id,tenant_id,client_id,principal_cents,interest_rate_bps,interest_cents,total_cents,loan_date,due_date,calculation_rule,modality,frequency,installment_count,installment_cents,first_due_date) values ('op_bad_total','ten_roberio','c_e2e_quinz',60000,0,30000,90000,'2026-10-13','2026-12-06','X','INSTALLMENT','BIWEEKLY',3,20000,'2026-11-06')`));
});

test("PQ3. pagamento parcial mantém a parcela em aberto; quitação fecha a operação; capital soma cada pagamento uma vez", async () => {
  const first = await action(robério, "registerPaymentAction", { operationId: opId, amount: "300,00", paidAt: "2026-11-06" });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.match(first.message, /Próximo vencimento: 21\/11\/2026/);
  const partial = await action(robério, "registerPaymentAction", { operationId: opId, amount: "150,00", paidAt: "2026-11-21" });
  assert.match(partial.message, /Saldo em aberto: R\$\s450,00\. Próximo vencimento: 21\/11\/2026/);
  // Acima do saldo: recusado.
  assert.equal((await action(robério, "registerPaymentAction", { operationId: opId, amount: "450,01", paidAt: "2026-11-25" })).ok, false);
  const last = await action(robério, "registerPaymentAction", { operationId: opId, amount: "450,00", paidAt: "2026-12-06" });
  assert.match(last.message, /Operação quitada/);
  const [op] = await admin(`select status, settled_at::text as settled_at from loan_operation where id = '${opId}'`);
  assert.deepEqual([op.status, op.settled_at], ["PAID", "2026-12-06"]);
  assert.equal(await available("ten_roberio"), availableBefore - 60000 + 90000);
});

test("PQ4. tela: prévia dos vencimentos 06/11, 21/11 e 06/12 antes de cadastrar (desktop e celular)", async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  for (const [label, viewport] of [["desktop", { width: 1440, height: 900 }], ["celular", { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport });
    const [name, value] = robério.split("; ").find((cookie) => cookie.includes("session_token")).split(/=(.*)/s);
    await context.addCookies([{ name, value, domain: new URL(BASE).hostname, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage();
    await page.goto(`${BASE}/?tela=operacoes`);
    const form = page.getByRole("region", { name: "Nova operação" });
    await form.getByRole("radio", { name: "Parcelado" }).click();
    await form.getByRole("radiogroup", { name: "Periodicidade das parcelas" }).getByRole("radio", { name: "Quinzenal" }).click();
    await form.getByLabel("Cliente").selectOption("c_e2e_quinz");
    await form.getByLabel("Valor emprestado (R$)").fill("600,00");
    await form.getByLabel("Valor de cada parcela (R$)").fill("300,00");
    await form.getByLabel("Quantidade de parcelas (quinzenas)").fill("3");
    await form.getByLabel("Primeiro vencimento").fill("06/11/2026");
    await form.getByLabel("Primeiro vencimento").press("Tab");
    const preview = form.getByLabel("Prévia dos vencimentos");
    await preview.waitFor();
    assert.deepEqual(await preview.locator("li strong").allInnerTexts(), ["06/11/2026", "21/11/2026", "06/12/2026"]);
    await form.getByText("16,67% por quinzena · 33,33% ao mês").waitFor();
    if (SHOTS) await form.screenshot({ path: `${SHOTS}/parcelado-quinzenal-previa-${label}.png` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `sem rolagem horizontal (${label})`);
    await context.close();
  }
});

test("PQ5. operações antigas (mensal, quinzenal, diário e parcelado mensal) e seus pagamentos não mudaram", async () => {
  assert.equal(await existingHash(), before);
});
