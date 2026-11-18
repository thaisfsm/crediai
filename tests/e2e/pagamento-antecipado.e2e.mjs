// Pagamento antecipado (pedido da Thaís, 18/11/2026), de ponta a ponta (HTTP + banco + navegador):
//   * pagamento com data anterior à data do empréstimo é aceito (registro e correção), com a data real gravada;
//   * juros e principal pelo contrato; data de início e vencimentos não mudam; renovação e quitação como sempre;
//   * os mesmos contratos pagos no vencimento e em atraso dão a mesma divisão; capital recebe o valor uma vez;
//   * data futura e liquidação antes do empréstimo continuam recusadas; o tenant B não paga contrato do A;
//   * a tela aceita a data anterior ao empréstimo; nada do que já existia muda.
// Só em ambiente LOCAL e DESCARTÁVEL, com os dados fictícios ten_roberio (A) e ten_fernando (B).
//   E2E_DATABASE_URL=… PLAYWRIGHT_MODULE=/caminho/playwright/index.mjs node --test tests/e2e/pagamento-antecipado.e2e.mjs
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
const SHOTS = process.env.E2E_SCREENSHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
let browser;
after(async () => { await browser?.close(); await sql.end(); });

const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const day = (offset) => { const date = new Date(`${TODAY}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + offset); return date.toISOString().slice(0, 10); };

let lastLogin = 0;
async function login(email) {
  const wait = 11_000 - (Date.now() - lastLogin);
  if (wait > 0) await sleep(wait);
  lastLogin = Date.now();
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
const available = () => one(`select (w.initial_capital_cents
  + coalesce((select sum(case when kind in ('CONTRIBUTION','OTHER_INCOME') then amount_cents else -amount_cents end) from capital_movement where tenant_id = 'ten_roberio' and cycle_number = w.cycle_number), 0)
  - coalesce((select sum(principal_cents) from loan_operation where tenant_id = 'ten_roberio' and status <> 'CANCELED' and cycle_number = w.cycle_number), 0)
  + coalesce((select sum(p.amount_cents) from payment p join loan_operation o on o.id = p.operation_id where p.tenant_id = 'ten_roberio' and o.cycle_number = w.cycle_number), 0))::bigint
  from wallet w where w.tenant_id = 'ten_roberio'`).then(Number);
// Tudo que já existia antes do teste (operações, pagamentos, renovações, capital de todos os tenants) não pode mudar.
const existingHash = () => one(`select md5(string_agg(x, '|' order by x)) from (select 'o'||row(o.*)::text x from loan_operation o where o.client_id not like 'c\\_e2e\\_pa%'
  union all select 'p'||row(p.*)::text from payment p join loan_operation o on o.id = p.operation_id where o.client_id not like 'c\\_e2e\\_pa%'
  union all select 'r'||row(r.*)::text from loan_renewal r join loan_operation o on o.id = r.operation_id where o.client_id not like 'c\\_e2e\\_pa%'
  union all select 'm'||row(m.*)::text from capital_movement m) t`);

let robério, fernando, before;
const ops = {};
const op = (id) => admin(`select status, loan_date::text loan, due_date::text due, first_due_date::text first, settled_at::text settled from loan_operation where id = '${id}'`).then((rows) => rows[0]);
const payments = (id) => admin(`select id, amount_cents::int amount_cents, paid_at::text paid, payment_mode mode from payment where operation_id = '${id}' order by created_at`);
// R$ 180,00 a 11,12% (juros R$ 20,02, saldo total R$ 200,02), como o contrato do print.
async function single(key, loanDate, dueDate) {
  await admin(`insert into client(id, tenant_id, name) values ('c_e2e_pa_${key}', 'ten_roberio', 'Antecipado ${key}')`);
  const created = await action(robério, "createOperationAction", { clientId: `c_e2e_pa_${key}`, modality: "SINGLE", frequency: "MONTHLY", principal: "180,00", rate: "11,12", loanDate, dueDate });
  assert.equal(created?.ok, true, JSON.stringify(created));
  ops[key] = await one(`select id from loan_operation where client_id = 'c_e2e_pa_${key}'`);
  assert.equal(await one(`select interest_cents::int from loan_operation where id = '${ops[key]}'`), 2002);
}

test("preparação: logins, capital e contratos (empréstimo futuro, vencendo hoje e em atraso)", async () => {
  before = await existingHash();
  robério = await login("roberio@teste.local");
  fernando = await login("fernando@teste.local");
  await admin(`update wallet set initial_capital_cents = 1000000, created_at = now() - interval '200 days', cycle_started_at = now() - interval '200 days' where tenant_id = 'ten_roberio'`);
  await single("futuro", day(8), day(38));      // empréstimo daqui a 8 dias: hoje é antes do empréstimo
  await single("futuro2", day(8), day(38));
  await single("parcial", day(8), day(38));
  await single("vence", day(-30), TODAY);       // vencimento hoje
  await single("atraso", day(-60), day(-30));   // vencido há 30 dias
  await single("liq", day(8), day(38));
  await single("tela", day(8), day(38));
});

test("PA-E1. saldo total antes da data do empréstimo: aceito, quita com R$ 20,02 de juros + R$ 180,00 de principal, data real gravada, datas do contrato intactas, capital +R$ 200,02 uma vez", async () => {
  const terms = await op(ops.futuro);
  const cash = await available();
  const paid = await action(robério, "registerPaymentAction", { operationId: ops.futuro, amount: "200,02", paidAt: TODAY, paymentMode: "FULL_SETTLEMENT" });
  assert.equal(paid?.ok, true, JSON.stringify(paid));
  const [row] = await payments(ops.futuro);
  assert.equal(row.paid, TODAY, "data real do recebimento");
  assert.equal(row.amount_cents, 20002);
  const after = await op(ops.futuro);
  assert.equal(after.status, "PAID");
  assert.deepEqual([after.loan, after.due, after.first], [terms.loan, terms.due, terms.first], "início e vencimento não mudam");
  assert.equal(await available(), cash + 20002, "entra no capital uma vez");
  assert.equal(await one(`select count(*)::int from loan_renewal where operation_id = '${ops.futuro}'`), 0);
});

test("PA-E2. mesma quitação no vencimento e em atraso: mesma divisão e mesmo valor", async () => {
  for (const key of ["vence", "atraso"]) {
    const paid = await action(robério, "registerPaymentAction", { operationId: ops[key], amount: "200,02", paidAt: TODAY, paymentMode: "FULL_SETTLEMENT" });
    assert.equal(paid?.ok, true, `${key}: ${JSON.stringify(paid)}`);
    assert.equal((await op(ops[key])).status, "PAID", key);
  }
});

test("PA-E3. só os juros e renovar antes do empréstimo: R$ 20,02 de juros, principal intacto, renova pelo calendário do contrato (como no vencimento)", async () => {
  const terms = await op(ops.futuro2);
  const paid = await action(robério, "registerPaymentAction", { operationId: ops.futuro2, amount: "20,02", paidAt: TODAY, paymentMode: "INTEREST_ONLY_RENEWAL", period: "1" });
  assert.equal(paid?.ok, true, JSON.stringify(paid));
  assert.match(paid.message, /Principal mantido em R\$\s?180,00/);
  const [renewal] = await admin(`select previous_due_date::text prev, new_due_date::text next, principal_base_cents::int base, interest_cents::int interest_cents from loan_renewal where operation_id = '${ops.futuro2}'`);
  assert.equal(renewal.prev, terms.due);
  assert.equal(renewal.base, 18000);
  assert.equal(renewal.interest_cents, 2002);
  const after = await op(ops.futuro2);
  assert.equal(after.status, "OPEN");
  assert.equal(after.loan, terms.loan, "data de início igual");
  assert.equal(after.due, renewal.next, "vencimento só muda pela renovação, como sempre");
});

test("PA-E4. pagamento parcial antes do empréstimo e correção da data para antes do empréstimo: aceitos; contrato continua em aberto com o vencimento original", async () => {
  const terms = await op(ops.parcial);
  const paid = await action(robério, "registerPaymentAction", { operationId: ops.parcial, amount: "50,00", paidAt: TODAY, paymentMode: "MANUAL" });
  assert.equal(paid?.ok, true, JSON.stringify(paid));
  const [row] = await payments(ops.parcial);
  const edited = await action(robério, "editPaymentAction", { paymentId: row.id, amount: "50,00", paidAt: day(-3), notes: "recebido antes" });
  assert.equal(edited?.ok, true, JSON.stringify(edited));
  assert.equal((await payments(ops.parcial))[0].paid, day(-3));
  const after = await op(ops.parcial);
  assert.deepEqual([after.status, after.loan, after.due], ["OPEN", terms.loan, terms.due]);
});

test("PA-E5. continuam recusados: data futura, liquidação antes do empréstimo e o tenant B pagando contrato do A (nada gravado)", async () => {
  const count = await one(`select count(*)::int from payment`);
  const future = await action(robério, "registerPaymentAction", { operationId: ops.liq, amount: "200,02", paidAt: day(1), paymentMode: "FULL_SETTLEMENT" });
  assert.equal(future?.ok, false); assert.match(future.error, /depois de hoje/);
  const settle = await action(robério, "settleOperationEarlyAction", { operationId: ops.liq, amount: "190,00", paidAt: TODAY, confirm: "yes" });
  assert.equal(settle?.ok, false); assert.match(settle.error, /antes da data do empréstimo/);
  const other = await action(fernando, "registerPaymentAction", { operationId: ops.liq, amount: "200,02", paidAt: TODAY, paymentMode: "FULL_SETTLEMENT" });
  assert.equal(other?.ok, false);
  assert.equal(await one(`select count(*)::int from payment`), count);
  assert.equal((await op(ops.liq)).status, "OPEN");
});

test("PA-E6. tela: data de hoje (antes do empréstimo) aceita no Saldo total e a operação fica quitada", async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  browser ??= await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "pt-BR" });
  const [name, value] = robério.split("; ").find((cookie) => cookie.includes("session_token")).split(/=(.*)/s);
  await context.addCookies([{ name, value, domain: new URL(BASE).hostname, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage();
  await page.goto(`${BASE}/?tela=operacoes`);
  const row = page.getByRole("row", { name: /Antecipado tela/ });
  await row.getByRole("button", { name: "Registrar pagamento" }).click();
  await page.locator(".payment-overlay").getByRole("button", { name: /Saldo total/ }).click();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/pagamento-antecipado-tela.png` });
  await page.locator(".payment-overlay").getByRole("button", { name: "Registrar pagamento" }).click();
  await page.getByText(/Operação quitada/).waitFor({ timeout: 15_000 });
  assert.equal(await page.getByText(/antes da data do empréstimo/).count(), 0);
  assert.equal((await op(ops.tela)).status, "PAID");
  assert.equal((await payments(ops.tela))[0].paid, TODAY);
  await context.close();
});

test("PA-E7. nada que já existia mudou", async () => {
  assert.equal(await existingHash(), before);
});
