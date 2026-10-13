// Relatório de rentabilidade com filtros (Etapa E) na tela: período (recebidos pela data do pagamento, emprestado pela
// data do empréstimo), situação, abrir cada operação, desktop e celular. O relatório só lê: nada é gravado.
// SÓ em ambiente LOCAL e DESCARTÁVEL (ver tests/e2e/README.md). Usa os dados fictícios ten_roberio.
//   E2E_DATABASE_URL=… PLAYWRIGHT_MODULE=/caminho/playwright/index.mjs node --test tests/e2e/relatorio.e2e.mjs
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
const dataHash = () => one(`select md5(string_agg(x, '|' order by x)) from (select 'o'||row(o.*)::text x from loan_operation o union all select 'p'||row(p.*)::text from payment p
  union all select 'r'||row(r.*)::text from loan_renewal r union all select 'm'||row(m.*)::text from capital_movement m union all select 'w'||row(w.*)::text from wallet w) t`);
const opOf = (clientId, principal) => one(`select id from loan_operation where client_id = '${clientId}' and principal_cents = ${principal}`);

let robério, before;
test("preparação: operações de setembro, agosto e de hoje, com pagamentos", async () => {
  await admin(`update wallet set initial_capital_cents = 1000000 where tenant_id = 'ten_roberio'`);
  await admin(`insert into client(id, tenant_id, name) values ('c_e2e_rel1', 'ten_roberio', 'Cliente Relatório A'), ('c_e2e_rel2', 'ten_roberio', 'Cliente Relatório B')`);
  robério = await login("roberio@teste.local");
  const create = (fields) => action(robério, "createOperationAction", { modality: "SINGLE", frequency: "MONTHLY", ...fields });
  assert.equal((await create({ clientId: "c_e2e_rel1", principal: "1.000,00", rate: "30", loanDate: "2026-09-10", dueDate: "2026-10-10" }))?.ok, true);
  assert.equal((await create({ clientId: "c_e2e_rel1", principal: "500,00", rate: "20", loanDate: "2026-08-01", dueDate: "2026-09-01" }))?.ok, true);
  assert.equal((await create({ clientId: "c_e2e_rel2", principal: "2.000,00", rate: "30", loanDate: "2026-10-02", dueDate: "2026-11-02" }))?.ok, true);
  // Setembro: R$ 300 de juros (renova). Agosto: quitação de R$ 600 (R$ 100 de juros).
  assert.equal((await action(robério, "registerPaymentAction", { operationId: await opOf("c_e2e_rel1", 100000), amount: "300,00", paidAt: "2026-09-25" }))?.ok, true);
  assert.equal((await action(robério, "registerPaymentAction", { operationId: await opOf("c_e2e_rel1", 50000), amount: "600,00", paidAt: "2026-08-30" }))?.ok, true);
  before = await dataHash();
});

test("RL1. tela: período de setembro, situação quitadas, abrir a operação (desktop e celular); nada é gravado", async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  for (const [label, viewport] of [["desktop", { width: 1440, height: 900 }], ["celular", { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport });
    const [name, value] = robério.split("; ").find((cookie) => cookie.includes("session_token")).split(/=(.*)/s);
    await context.addCookies([{ name, value, domain: new URL(BASE).hostname, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage();
    await page.goto(`${BASE}/?tela=relatorios`);
    const section = page.getByRole("region", { name: "Rentabilidade por cliente" });
    const rowA = () => section.locator("tr.report-client-row", { hasText: "Cliente Relatório A" });
    const rowB = () => section.locator("tr.report-client-row", { hasText: "Cliente Relatório B" });
    await rowA().waitFor();
    // Todo o ciclo: A tem R$ 1.500 emprestados e R$ 400 de juros recebidos; B aparece.
    assert.match(await rowA().innerText(), /R\$\s1\.500,00[\s\S]*R\$\s400,00/);
    assert.equal(await rowB().count(), 1);
    // Setembro: só o empréstimo de 10/09 e os R$ 300 de 25/09; B (outubro) sai.
    await section.getByLabel("Período").selectOption("CUSTOM");
    await section.getByLabel("De", { exact: true }).fill("01/09/2026");
    await section.getByLabel("De", { exact: true }).press("Tab");
    await section.getByLabel("Até", { exact: true }).fill("30/09/2026");
    await section.getByLabel("Até", { exact: true }).press("Tab");
    await section.getByText("De 01/09/2026 a 30/09/2026").waitFor();
    assert.equal(await rowB().count(), 0);
    const september = await rowA().innerText();
    assert.match(september, /R\$\s1\.000,00/);
    assert.match(september, /R\$\s300,00/);
    if (SHOTS) await section.screenshot({ path: `${SHOTS}/relatorio-setembro-${label}.png` });
    // Situação quitadas no ciclo todo: só a operação de agosto do cliente A.
    await section.getByLabel("Período").selectOption("CYCLE");
    await section.getByLabel("Situação").selectOption("PAID");
    await rowA().getByRole("button", { name: "Cliente Relatório A" }).click();
    const operations = section.locator("tr.report-operation-row");
    assert.equal(await operations.count(), await section.locator("tr.report-operation-row", { hasText: "Quitada" }).count());
    const mine = section.locator("tr.report-operation-row", { hasText: "01/08/2026" });
    await mine.waitFor();
    if (SHOTS) await section.screenshot({ path: `${SHOTS}/relatorio-quitadas-${label}.png` });
    await mine.getByRole("button", { name: /^Abrir #/ }).click();
    await page.locator(".payment-panel").getByText("Histórico de pagamentos").waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `sem rolagem horizontal (${label})`);
    await context.close();
  }
  assert.equal(await dataHash(), before, "o relatório não grava nada");
});

// Linha do cliente numa tabela: valores em R$ na ordem das colunas.
const moneyIn = (text) => [...text.matchAll(/R\$\s?([\d.]+,\d{2})/g)].map((match) => match[1]);

test("RL2. ficha (lista de clientes) e relatório do ciclo atual mostram os mesmos números do cliente", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const [name, value] = robério.split("; ").find((cookie) => cookie.includes("session_token")).split(/=(.*)/s);
  await context.addCookies([{ name, value, domain: new URL(BASE).hostname, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage();
  await page.goto(`${BASE}/?tela=clientes`);
  // Lista de clientes: principal emprestado, juros recebidos e saldo.
  const [lent, interest, balance] = moneyIn(await page.locator("tr", { hasText: "Cliente Relatório A" }).first().innerText());
  await page.goto(`${BASE}/?tela=relatorios`);
  const row = page.getByRole("region", { name: "Rentabilidade por cliente" }).locator("tr.report-client-row", { hasText: "Cliente Relatório A" });
  await row.waitFor();
  // Relatório: emprestado, recuperado, juros recebidos, juros previstos, saldo.
  const report = moneyIn(await row.innerText());
  assert.deepEqual([report[0], report[2], report[4]], [lent, interest, balance]);
  assert.deepEqual([lent, interest], ["1.500,00", "400,00"]);
  await context.close();
});

test("RL3. ciclos: depois de zerar a carteira, Ciclo atual mostra só o ciclo novo e Todos os ciclos inclui o encerrado, só para consulta", async () => {
  assert.equal((await action(robério, "resetWalletAction", { confirmation: "ZERAR CARTEIRA" }))?.ok, true);
  assert.equal((await action(robério, "saveWalletAction", { initialCapital: "10.000,00" }))?.ok, true);
  assert.equal((await action(robério, "createOperationAction", { modality: "SINGLE", frequency: "MONTHLY", clientId: "c_e2e_rel2", principal: "300,00", rate: "10", loanDate: "2026-10-05", dueDate: "2026-11-05" }))?.ok, true);
  const hash = await dataHash();
  for (const [label, viewport] of [["desktop", { width: 1440, height: 900 }], ["celular", { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport });
    const [name, value] = robério.split("; ").find((cookie) => cookie.includes("session_token")).split(/=(.*)/s);
    await context.addCookies([{ name, value, domain: new URL(BASE).hostname, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage();
    await page.goto(`${BASE}/?tela=relatorios`);
    const section = page.getByRole("region", { name: "Rentabilidade por cliente" });
    const rowA = () => section.locator("tr.report-client-row", { hasText: "Cliente Relatório A" });
    const rowB = () => section.locator("tr.report-client-row", { hasText: "Cliente Relatório B" });
    // Padrão: ciclo atual. Só a operação nova de B.
    assert.equal(await section.getByLabel("Ciclos").inputValue(), "CURRENT");
    await rowB().waitFor();
    assert.equal(await rowA().count(), 0);
    assert.equal(moneyIn(await rowB().innerText())[0], "300,00");
    // Todos os ciclos: A volta com o histórico do ciclo 1; B soma os dois ciclos.
    await section.getByLabel("Ciclos").selectOption("ALL");
    await rowA().waitFor();
    assert.deepEqual([moneyIn(await rowA().innerText())[0], moneyIn(await rowA().innerText())[2]], ["1.500,00", "400,00"]);
    assert.equal(moneyIn(await rowB().innerText())[0], "2.300,00");
    await rowA().getByRole("button", { name: "Cliente Relatório A" }).click();
    const old = section.locator("tr.report-operation-row", { hasText: "01/08/2026" });
    await old.getByText("ciclo 1").waitFor();
    if (SHOTS) await section.screenshot({ path: `${SHOTS}/relatorio-todos-ciclos-${label}.png` });
    // Operação de ciclo encerrado: abre só para consulta.
    await old.getByRole("button", { name: /^Abrir #/ }).click();
    const panel = page.locator(".payment-panel");
    await panel.getByText("Histórico de pagamentos").waitFor();
    assert.equal(await panel.getByRole("button", { name: "Editar pagamento" }).count(), 0);
    assert.equal(await panel.getByLabel("Valor recebido (R$)").count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `sem rolagem horizontal (${label})`);
    await context.close();
  }
  assert.equal(await dataHash(), hash, "o relatório de todos os ciclos não grava nada");
});
