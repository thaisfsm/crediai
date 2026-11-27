// Multa recebida no pagamento (pedido da Thaís, 27/11/2026), de ponta a ponta (HTTP + banco + navegador):
//   * parcela R$ 600,00 + multa R$ 100,00 = R$ 700,00 recebidos: o pagamento grava R$ 600,00 (juros/principal/saldo como
//     sempre) e a multa vira UMA receita de multa no caixa (Outras entradas › Multa recebida), ligada ao pagamento;
//   * multa vazia ou 0,00 = fluxo atual, sem lançamento; multa negativa recusada sem gravar nada;
//   * correção: aumentar, manter (tela antiga sem o campo), retirar e voltar a pôr atualizam a MESMA linha; correção
//     repetida e correções simultâneas nunca duplicam; o banco recusa uma segunda multa para o mesmo pagamento;
//   * isolamento: a outra carteira não registra nem corrige multa em pagamento alheio e não vê a multa;
//   * tela: campo, total recebido, histórico do pagamento, Financeiro e relatório; nada do que já existia muda.
// Só em ambiente LOCAL e DESCARTÁVEL, com os dados fictícios ten_roberio (A) e ten_fernando (B).
//   E2E_DATABASE_URL=… PLAYWRIGHT_MODULE=/caminho/playwright/index.mjs node --test tests/e2e/multa-recebida.e2e.mjs
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
// Tudo que já existia antes do teste (operações, pagamentos, renovações e capital de todos os tenants) não pode mudar.
const existingHash = () => one(`select md5(string_agg(x, '|' order by x)) from (select 'o'||row(o.*)::text x from loan_operation o where o.client_id not like 'c\\_e2e\\_mr%'
  union all select 'p'||row(p.*)::text from payment p join loan_operation o on o.id = p.operation_id where o.client_id not like 'c\\_e2e\\_mr%'
  union all select 'r'||row(r.*)::text from loan_renewal r join loan_operation o on o.id = r.operation_id where o.client_id not like 'c\\_e2e\\_mr%'
  union all select 'm'||row(m.*)::text from capital_movement m where coalesce(m.idempotency_key, '') not like 'pen-%') t`);
const penalties = (paymentId) => admin(`select id, tenant_id, kind::text kind, category, source, amount_cents::int amount_cents, occurred_at::text occurred, description, notes from capital_movement where idempotency_key = 'pen-${paymentId}'`);
const paymentsOf = (operationId) => admin(`select id, amount_cents::int amount_cents, paid_at::text paid from payment where operation_id = '${operationId}' order by created_at`);
const ledgerOf = (operationId) => admin(`select status::text status, (select coalesce(sum(amount_cents), 0)::int from payment where operation_id = o.id) paid, total_cents::int total from loan_operation o where id = '${operationId}'`).then((rows) => rows[0]);

let robério, fernando, before;
const ops = {};
// Parcelado 5 × R$ 600,00 (R$ 3.000,00), primeira parcela daqui a 30 dias.
async function installment(key) {
  await admin(`insert into client(id, tenant_id, name) values ('c_e2e_mr_${key}', 'ten_roberio', 'Multa ${key}')`);
  const created = await action(robério, "createOperationAction", { clientId: `c_e2e_mr_${key}`, modality: "INSTALLMENT", loanAmount: "2.500,00", installment: "600,00", term: "5", loanDate: day(-1), firstDueDate: day(30) });
  assert.equal(created?.ok, true, JSON.stringify(created));
  ops[key] = await one(`select id from loan_operation where client_id = 'c_e2e_mr_${key}'`);
  assert.equal(await one(`select total_cents::int from loan_operation where id = '${ops[key]}'`), 300000);
}

test("preparação: logins, capital e contratos parcelados de R$ 600,00", async () => {
  before = await existingHash();
  robério = await login("roberio@teste.local");
  fernando = await login("fernando@teste.local");
  await admin(`update wallet set initial_capital_cents = 5000000, created_at = now() - interval '200 days', cycle_started_at = now() - interval '200 days' where tenant_id = 'ten_roberio'`);
  for (const key of ["a", "zero", "edit", "tela"]) await installment(key);
});

test("MR-E1. parcela R$ 600,00 + multa R$ 100,00: pagamento de R$ 600,00, uma receita de multa de R$ 100,00, caixa +R$ 700,00, saldo do contrato só −R$ 600,00", async () => {
  const cash = await available();
  const paid = await action(robério, "registerPaymentAction", { operationId: ops.a, amount: "600,00", penalty: "100,00", paidAt: TODAY, paymentMode: "MANUAL" });
  assert.equal(paid?.ok, true, JSON.stringify(paid));
  assert.match(paid.message, /Multa recebida: R\$\s?100,00/);
  assert.match(paid.message, /Total recebido: R\$\s?700,00/);
  const [payment] = await paymentsOf(ops.a);
  assert.equal(payment.amount_cents, 60000, "a multa não entra no valor do pagamento");
  const rows = await penalties(payment.id);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].tenant_id, rows[0].kind, rows[0].category, rows[0].source, rows[0].amount_cents, rows[0].occurred], ["ten_roberio", "OTHER_INCOME", "OTHER_INCOME", "FINANCE", 10000, TODAY]);
  assert.match(rows[0].description, /^Multa recebida · Multa a · Op\. #/);
  assert.equal(await available(), cash + 70000, "caixa recebe parcela + multa, uma vez");
  const ledger = await ledgerOf(ops.a);
  assert.deepEqual([ledger.status, ledger.paid, ledger.total], ["OPEN", 60000, 300000], "saldo devedor cai só a parcela");
});

test("MR-E2. multa vazia e 0,00: funcionamento atual, sem lançamento de multa", async () => {
  const cash = await available();
  for (const penalty of [undefined, "0,00", ""]) {
    const fields = { operationId: ops.zero, amount: "600,00", paidAt: TODAY, paymentMode: "MANUAL", ...(penalty === undefined ? {} : { penalty }) };
    const paid = await action(robério, "registerPaymentAction", fields);
    assert.equal(paid?.ok, true, JSON.stringify(paid));
    assert.doesNotMatch(paid.message, /Multa/);
  }
  for (const payment of await paymentsOf(ops.zero)) assert.equal((await penalties(payment.id)).length, 0);
  assert.equal(await available(), cash + 180000);
});

test("MR-E3. multa negativa ou inválida: recusada e nada é gravado", async () => {
  const [count, movements] = [await one(`select count(*)::int from payment`), await one(`select count(*)::int from capital_movement`)];
  for (const penalty of ["-100,00", "dez reais"]) {
    const paid = await action(robério, "registerPaymentAction", { operationId: ops.edit, amount: "600,00", penalty, paidAt: TODAY, paymentMode: "MANUAL" });
    assert.equal(paid?.ok, false, penalty);
    assert.match(paid.error, /multa/i);
  }
  assert.equal(await one(`select count(*)::int from payment`), count);
  assert.equal(await one(`select count(*)::int from capital_movement`), movements);
});

test("MR-E4. correção: muda a multa na mesma linha, mantém sem o campo, retira, volta a pôr; repetida e simultânea nunca duplicam", async () => {
  const paid = await action(robério, "registerPaymentAction", { operationId: ops.edit, amount: "600,00", penalty: "100,00", paidAt: TODAY, paymentMode: "MANUAL" });
  assert.equal(paid?.ok, true, JSON.stringify(paid));
  const [payment] = await paymentsOf(ops.edit);
  const [first] = await penalties(payment.id);
  let cash = await available();

  const raised = await action(robério, "editPaymentAction", { paymentId: payment.id, amount: "600,00", penalty: "150,00", paidAt: TODAY, notes: "" });
  assert.equal(raised?.ok, true, JSON.stringify(raised));
  assert.match(raised.message, /Multa recebida: R\$\s?150,00 \(antes R\$\s?100,00\)/);
  let rows = await penalties(payment.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, first.id, "mesma linha, sem lançamento novo");
  assert.equal(rows[0].amount_cents, 15000);
  assert.match(rows[0].notes, /antes R\$\s?100,00, depois R\$\s?150,00/);
  assert.equal(await available(), cash + 5000);
  assert.equal(await one(`select count(*)::int from payment_revision where payment_id = '${payment.id}'`), 0, "só a multa mudou: o pagamento não ganha revisão");

  const again = await action(robério, "editPaymentAction", { paymentId: payment.id, amount: "600,00", penalty: "150,00", paidAt: TODAY, notes: "" });
  assert.equal(again?.ok, false); assert.match(again.error, /Nada foi alterado/);

  // Tela antiga (sem o campo): corrige o pagamento e a multa fica como está, na nova data.
  const oldScreen = await action(robério, "editPaymentAction", { paymentId: payment.id, amount: "610,00", paidAt: day(-1), notes: "" });
  assert.equal(oldScreen?.ok, true, JSON.stringify(oldScreen));
  rows = await penalties(payment.id);
  assert.deepEqual([rows.length, rows[0].id, rows[0].amount_cents, rows[0].occurred], [1, first.id, 15000, day(-1)], "multa acompanha a data do pagamento");
  assert.equal((await paymentsOf(ops.edit))[0].amount_cents, 61000);

  cash = await available();
  const removed = await action(robério, "editPaymentAction", { paymentId: payment.id, amount: "610,00", penalty: "0,00", paidAt: day(-1), notes: "" });
  assert.equal(removed?.ok, true, JSON.stringify(removed));
  assert.match(removed.message, /Multa recebida retirada/);
  assert.equal((await penalties(payment.id)).length, 0, "sem multa ativa no pagamento");
  // Dinheiro não se apaga: a receita fica estornada e entra a saída do estorno, de mesmo valor (o caixa perde R$ 150,00).
  const voided = await admin(`select kind::text kind, category, amount_cents::int amount_cents from capital_movement where idempotency_key like 'pen-void-%-${payment.id}-%' order by kind`);
  assert.deepEqual(voided.map((row) => [row.kind, row.category, row.amount_cents]), [["OTHER_INCOME", "OTHER_INCOME", 15000], ["WITHDRAWAL", "OTHER_OUTFLOW", 15000]]);
  assert.equal(await available(), cash - 15000);

  const readded = await action(robério, "editPaymentAction", { paymentId: payment.id, amount: "610,00", penalty: "50,00", paidAt: day(-1), notes: "" });
  assert.equal(readded?.ok, true, JSON.stringify(readded));
  assert.equal((await penalties(payment.id)).length, 1);

  const simultaneous = await Promise.all(["70,00", "80,00", "90,00"].map((penalty) => action(robério, "editPaymentAction", { paymentId: payment.id, amount: "610,00", penalty, paidAt: day(-1), notes: "" })));
  assert.ok(simultaneous.some((result) => result?.ok), JSON.stringify(simultaneous));
  rows = await penalties(payment.id);
  assert.equal(rows.length, 1, "correções simultâneas: uma única multa");
  assert.ok([7000, 8000, 9000].includes(rows[0].amount_cents));
  assert.equal(await one(`select count(*)::int from capital_movement where idempotency_key like 'pen-%' and tenant_id = 'ten_roberio' and idempotency_key = 'pen-${payment.id}'`), 1);
});

test("MR-E5. o banco recusa uma segunda multa para o mesmo pagamento", async () => {
  const [payment] = await paymentsOf(ops.a);
  await assert.rejects(admin(`insert into capital_movement(id, tenant_id, kind, category, source, amount_cents, occurred_at, cycle_number, description, idempotency_key)
    values ('cap_dup_e2e', 'ten_roberio', 'OTHER_INCOME', 'OTHER_INCOME', 'FINANCE', 10000, '${TODAY}', 1, 'duplicada', 'pen-${payment.id}')`), /unique|duplicate/i);
  assert.equal((await penalties(payment.id)).length, 1);
});

test("MR-E6. isolamento: a outra carteira não registra nem corrige multa em pagamento alheio e não vê a multa", async () => {
  const [payment] = await paymentsOf(ops.a);
  const [penaltyBefore] = await penalties(payment.id);
  const [count, movements] = [await one(`select count(*)::int from payment`), await one(`select count(*)::int from capital_movement`)];
  const register = await action(fernando, "registerPaymentAction", { operationId: ops.a, amount: "600,00", penalty: "100,00", paidAt: TODAY, paymentMode: "MANUAL" });
  assert.equal(register?.ok, false);
  const edit = await action(fernando, "editPaymentAction", { paymentId: payment.id, amount: "600,00", penalty: "999,00", paidAt: TODAY, notes: "" });
  assert.equal(edit?.ok, false);
  assert.equal(await one(`select count(*)::int from payment`), count);
  assert.equal(await one(`select count(*)::int from capital_movement`), movements);
  assert.deepEqual((await penalties(payment.id))[0], penaltyBefore);
  assert.equal(await one(`select count(*)::int from capital_movement where tenant_id = 'ten_fernando' and idempotency_key like 'pen-%'`), 0);
  for (const path of ["/?tela=operacoes", "/financeiro"]) {
    const html = await (await fetch(`${BASE}${path}`, { headers: { cookie: fernando } })).text();
    assert.doesNotMatch(html, /Multa a/, `${path} do tenant B não mostra a multa do A`);
  }
});

test("MR-E7. tela: campo Multa recebida, total recebido, histórico, Financeiro e relatório (desktop e celular)", async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  browser ??= await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const [name, value] = robério.split("; ").find((cookie) => cookie.includes("session_token")).split(/=(.*)/s);
  for (const viewport of [{ width: 1440, height: 900, label: "desktop" }, { width: 390, height: 844, label: "celular" }]) {
    const context = await browser.newContext({ viewport, locale: "pt-BR" });
    await context.addCookies([{ name, value, domain: new URL(BASE).hostname, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage();
    await page.goto(`${BASE}/?tela=operacoes`);
    const row = page.getByRole("row", { name: /Multa tela/ }).first();
    await row.getByRole("button", { name: "Registrar pagamento" }).click();
    const panel = page.locator(".payment-overlay");
    await panel.getByLabel("Valor recebido (R$)").fill("600,00");
    await panel.getByLabel("Multa recebida (R$)").fill("100,00");
    const total = panel.getByTestId("payment-total");
    await total.getByText(/R\$\s?700,00/).waitFor({ timeout: 10_000 });
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/multa-recebida-registro-${viewport.label}.png` });
    await panel.getByRole("button", { name: "Registrar pagamento" }).click();
    await page.getByText(/Total recebido: R\$\s?700,00/).waitFor({ timeout: 15_000 });
    await panel.getByTestId("payment-penalty").first().waitFor({ timeout: 15_000 });
    assert.match(await panel.getByTestId("payment-penalty").first().innerText(), /Multa recebida R\$\s?100,00.*Total recebido R\$\s?700,00/s);
    assert.ok(await panel.getByText(/Multas recebidas \(à parte\)/).count() > 0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/multa-recebida-historico-${viewport.label}.png` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, "sem rolagem horizontal");
    await page.goto(`${BASE}/financeiro`);
    await page.getByRole("cell", { name: "Multa recebida" }).first().waitFor({ timeout: 15_000 });
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/multa-recebida-financeiro-${viewport.label}.png`, fullPage: true });
    await context.close();
  }
  const tela = await paymentsOf(ops.tela);
  assert.equal(tela.length, 2);
  for (const payment of tela) {
    assert.equal(payment.amount_cents, 60000);
    assert.equal((await penalties(payment.id))[0]?.amount_cents, 10000);
  }
});

test("MR-E8. nada que já existia mudou", async () => {
  assert.equal(await existingHash(), before);
});
