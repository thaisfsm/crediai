// "Só os juros e renovar" nos contratos novos (principal primeiro), de ponta a ponta (HTTP + banco + navegador):
//   * a escolha do usuário prevalece: o valor vai todo para juros, o principal não muda e o período renova;
//   * sem a escolha, o pagamento continua abatendo o principal; amortização e liquidação antecipada seguem as regras;
//   * histórico e indicadores na tela; capital soma cada recebimento uma vez; o tenant B não mexe no A.
// Só em ambiente LOCAL e DESCARTÁVEL, com os dados fictícios ten_roberio (A) e ten_fernando (B).
//   E2E_DATABASE_URL=… PLAYWRIGHT_MODULE=/caminho/playwright/index.mjs node --test tests/e2e/juros-renovacao.e2e.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import postgres from "postgres";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Teste destrutivo: só roda em localhost.");
const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl || !/@(localhost|127\.0\.0\.1)[:/]/.test(databaseUrl)) throw new Error("E2E_DATABASE_URL precisa apontar para um banco local.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
const admin = async (query) => sql.begin(async (tx) => { await tx`select set_config('app.crediai_role', 'SUPER_ADMIN', true)`; return tx.unsafe(query); });
const one = async (query) => Object.values((await admin(query))[0] ?? {})[0];
const manifest = JSON.parse(readFileSync(".next/server/server-reference-manifest.json", "utf8")).node;
const actionId = (name) => Object.entries(manifest).find(([, value]) => value.exportedName === name)?.[0] ?? assert.fail(`ação ${name} não encontrada no build`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SHOTS = process.env.E2E_SCREENSHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
after(async () => { await browser.close(); await sql.end(); });

const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const day = (offset) => { const date = new Date(`${TODAY}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + offset); return date.toISOString().slice(0, 10); };

let lastLogin = 0;
const spaced = async () => { const wait = 11_000 - (Date.now() - lastLogin); if (wait > 0) await sleep(wait); lastLogin = Date.now(); };
async function login(email) {
  await spaced();
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
const dataHash = () => one(`select md5(string_agg(x, '|' order by x)) from (select 'o'||row(o.*)::text x from loan_operation o union all select 'p'||row(p.*)::text from payment p
  union all select 'r'||row(r.*)::text from loan_renewal r union all select 'm'||row(m.*)::text from capital_movement m) t`);
const otherTenants = () => one(`select md5(string_agg(x, '|' order by x)) from (select 'o'||row(o.*)::text x from loan_operation o where tenant_id <> 'ten_roberio'
  union all select 'p'||row(p.*)::text from payment p where tenant_id <> 'ten_roberio' union all select 'r'||row(r.*)::text from loan_renewal r where tenant_id <> 'ten_roberio') t`);

let robério, fernando, opA, opB, othersBefore;
const createSingle = async (clientId) => {
  // R$ 5.000 a 2% ao mês: juros do período R$ 100 (o exemplo das imagens).
  const created = await action(robério, "createOperationAction", { clientId, modality: "SINGLE", frequency: "MONTHLY", principal: "5.000,00", rate: "2", loanDate: day(-20), dueDate: day(10) });
  assert.equal(created?.ok, true, JSON.stringify(created));
  return one(`select id from loan_operation where client_id = '${clientId}'`);
};

test("preparação: dois contratos novos de R$ 5.000 a 2% (juros R$ 100), gravados como principal primeiro", async () => {
  await admin(`update wallet set initial_capital_cents = 2000000 where tenant_id = 'ten_roberio'`);
  await admin(`insert into client(id, tenant_id, name) values ('c_e2e_jr_a', 'ten_roberio', 'Juros Renovação A'), ('c_e2e_jr_b', 'ten_roberio', 'Juros Renovação B')`);
  robério = await login("roberio@teste.local");
  fernando = await login("fernando@teste.local");
  opA = await createSingle("c_e2e_jr_a");
  opB = await createSingle("c_e2e_jr_b");
  assert.equal(await one(`select count(*)::int from loan_operation where id in ('${opA}','${opB}') and payment_order = 'PRINCIPAL_FIRST' and interest_cents = 10000`), 2);
  othersBefore = await otherTenants();
});

test("JE1. recusas sem gravar: só juros com valor diferente dos juros, e o tenant B usando a operação do A", async () => {
  const hash = await dataHash();
  const wrong = await action(robério, "registerPaymentAction", { operationId: opA, amount: "90,00", paidAt: TODAY, paymentMode: "INTEREST_ONLY" });
  assert.equal(wrong?.ok, false); assert.match(wrong.error, /Só os juros e renovar/);
  assert.equal((await action(fernando, "registerPaymentAction", { operationId: opA, amount: "100,00", paidAt: TODAY, paymentMode: "INTEREST_ONLY" }))?.ok, false, "outro tenant");
  assert.equal(await dataHash(), hash, "nada gravado");
});

test("JE2. quatro pagamentos de R$ 100 por 'Só os juros e renovar': 4 renovações, juros +400, principal intacto, capital +400 uma vez", async () => {
  const capitalBefore = await available();
  const due0 = await one(`select due_date::text from loan_operation where id = '${opA}'`);
  for (let index = 0; index < 4; index += 1) {
    const result = await action(robério, "registerPaymentAction", { operationId: opA, amount: "100,00", paidAt: TODAY, paymentMode: "INTEREST_ONLY" });
    assert.equal(result?.ok, true, JSON.stringify(result));
    assert.match(result.message, /somente de juros/);
  }
  assert.equal(await one(`select count(*)::int from payment where operation_id = '${opA}'`), 4);
  assert.equal(await one(`select count(*)::int from loan_renewal where operation_id = '${opA}' and principal_base_cents = 500000 and interest_cents = 10000`), 4);
  assert.notEqual(await one(`select due_date::text from loan_operation where id = '${opA}'`), due0, "vencimento renovado");
  assert.equal(await one(`select status from loan_operation where id = '${opA}'`), "OPEN");
  assert.equal(await available(), capitalBefore + 40000, "o recebido entra uma vez");
});

test("JE3. sem a escolha, R$ 1.000 no contrato B abatem o principal (regra do principal primeiro mantida)", async () => {
  const result = await action(robério, "registerPaymentAction", { operationId: opB, amount: "1.000,00", paidAt: TODAY });
  assert.equal(result?.ok, true, JSON.stringify(result));
  assert.equal(await one(`select count(*)::int from loan_renewal where operation_id = '${opB}'`), 0);
});

const panelOf = async (page, client) => {
  await page.goto(`${BASE}/?tela=cobrancas`);
  await page.locator("main .table-panel table.data-table > tbody > tr", { hasText: client }).getByRole("button", { name: "Registrar pagamento" }).click();
  const panel = page.getByRole("dialog", { name: `Pagamentos de ${client}` });
  await panel.waitFor();
  return panel;
};
const summary = async (panel) => Object.fromEntries(await panel.locator(".payment-summary div").evaluateAll((items) => items.map((item) => [item.querySelector("dt")?.textContent?.trim(), item.querySelector("dd")?.textContent?.replace(/\s/g, " ").trim()])));

test("JE4. tela: histórico 'Pagamento de juros / Renovação' e indicadores; clique em 'Só os juros e renovar' grava juros; amortização e liquidação", async () => {
  await spaced();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel("E-mail").fill("roberio@teste.local");
  await page.getByLabel("Senha").fill(process.env.E2E_PASSWORD ?? "Senha-Teste-Local-123");
  await page.getByRole("button", { name: /Entrar/ }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20_000 });

  let panel = await panelOf(page, "Juros Renovação A");
  const history = panel.locator(".payment-history li");
  assert.equal(await history.count(), 4);
  for (const label of await history.locator(".status-chip").allInnerTexts()) assert.equal(label.trim(), "Pagamento de juros / Renovação");
  for (const line of await history.locator("small").allInnerTexts()) assert.match(line, /^Juros R\$\s?100,00 · Principal R\$\s?0,00/);
  let numbers = await summary(panel);
  assert.equal(numbers["Juros recebidos"], "R$ 400,00");
  assert.equal(numbers["Principal recebido"], "R$ 0,00");
  assert.equal(numbers["Principal restante"], "R$ 5.000,00");
  assert.equal(numbers["Juros restantes"], "R$ 100,00");
  assert.equal(numbers["Saldo"], "R$ 5.100,00");
  if (SHOTS) await panel.screenshot({ path: `${SHOTS}/1-historico-4-renovacoes.png` });

  // Pelo botão: o 5º pagamento de juros mostra a prévia "Para juros R$ 100 / Para principal R$ 0" e grava como juros.
  await panel.getByRole("button", { name: /^Só os juros e renovar/ }).click();
  await panel.getByText("Pagamento somente de juros / Renovação de período.").waitFor();
  const preview = await panel.locator(".operation-preview").innerText();
  assert.match(preview, /Para juros\s+R\$\s?100,00/); assert.match(preview, /Para principal\s+R\$\s?0,00/);
  if (SHOTS) await panel.screenshot({ path: `${SHOTS}/2-so-juros-previa.png` });
  await panel.locator("form").getByRole("button", { name: "Registrar pagamento" }).click();
  await panel.getByText(/somente de juros de R\$\s?100,00 registrado/).waitFor({ timeout: 15_000 });
  assert.equal(await one(`select count(*)::int from loan_renewal where operation_id = '${opA}'`), 5);
  // Digitar outro valor depois de escolher o atalho desfaz a escolha (vira amortização).
  await panel.getByRole("button", { name: /^Só os juros e renovar/ }).click();
  await panel.getByLabel("Valor recebido (R$)").fill("1.000,00");
  await panel.getByText("Pagamento somente de juros / Renovação de período.").waitFor({ state: "detached" });
  await panel.locator("form").getByRole("button", { name: "Registrar pagamento" }).click();
  await panel.getByText(/Pagamento de R\$\s?1\.000,00 registrado/).waitFor({ timeout: 15_000 });
  await page.waitForTimeout(800);
  await panel.getByRole("button", { name: "Fechar" }).click();

  panel = await panelOf(page, "Juros Renovação A");
  const labels = (await panel.locator(".payment-history li .status-chip").allInnerTexts()).map((label) => label.trim());
  assert.equal(labels.filter((label) => label === "Pagamento de juros / Renovação").length, 5);
  assert.equal(labels.filter((label) => label === "Amortização do principal").length, 1);
  numbers = await summary(panel);
  assert.equal(numbers["Juros recebidos"], "R$ 500,00");
  assert.equal(numbers["Principal recebido"], "R$ 1.000,00");
  assert.equal(numbers["Principal restante"], "R$ 4.000,00");
  assert.equal(numbers["Recebido"], "R$ 1.500,00");
  if (SHOTS) await panel.screenshot({ path: `${SHOTS}/3-historico-juros-e-amortizacao.png` });
  await panel.getByRole("button", { name: "Fechar" }).click();

  // Liquidação antecipada do A pelo servidor: R$ 4.050 (principal 4.000 + 50 de juros) encerra a operação.
  const settled = await action(robério, "settleOperationEarlyAction", { operationId: opA, amount: "4.050,00", confirm: "yes" });
  assert.equal(settled?.ok, true, JSON.stringify(settled));
  assert.equal(await one(`select status from loan_operation where id = '${opA}'`), "PAID");
  await page.goto(`${BASE}/?tela=operacoes`);
  const list = page.getByRole("region", { name: "Lista de operações" });
  await list.getByRole("button", { name: /^Quitadas/ }).click();
  await list.getByRole("searchbox", { name: "Filtrar operações por cliente" }).fill("Juros Renovação A");
  await list.getByRole("button", { name: "Ver pagamentos" }).first().click();
  panel = page.getByRole("dialog", { name: "Pagamentos de Juros Renovação A" });
  await panel.waitFor();
  numbers = await summary(panel);
  assert.equal(numbers["Juros recebidos"], "R$ 550,00");
  assert.equal(numbers["Principal recebido"], "R$ 5.000,00");
  assert.equal(numbers["Principal restante"], "R$ 0,00");
  assert.equal(numbers["Saldo"], "R$ 0,00");
  const finalLabels = (await panel.locator(".payment-history li .status-chip").allInnerTexts()).map((label) => label.trim());
  assert.deepEqual([finalLabels.filter((label) => label === "Quitação").length, finalLabels.length], [1, 7], "um pagamento de quitação entre os 7");
  if (SHOTS) await panel.screenshot({ path: `${SHOTS}/4-liquidacao-antecipada.png` });

  // Contrato B: R$ 1.000 sem a escolha → "Amortização do principal".
  panel = await panelOf(page, "Juros Renovação B");
  assert.equal((await panel.locator(".payment-history li .status-chip").first().innerText()).trim(), "Amortização do principal");
  numbers = await summary(panel);
  assert.equal(numbers["Principal recebido"], "R$ 1.000,00");
  assert.equal(numbers["Juros recebidos"], "R$ 0,00");
  if (SHOTS) await panel.screenshot({ path: `${SHOTS}/5-amortizacao-sem-escolha.png` });
  await context.close();
  assert.equal(await otherTenants(), othersBefore, "o tenant B não muda");
});
