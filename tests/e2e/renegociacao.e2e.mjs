// Simulação de renegociação (Etapa H, parte 1) na tela: cliente, operações escolhidas, posição, desconto, novas
// condições, resultado e parcelas, desktop e celular. A tela só simula: nenhum dado muda no banco.
// SÓ em ambiente LOCAL e DESCARTÁVEL (ver tests/e2e/README.md). Usa os dados fictícios ten_roberio.
//   E2E_DATABASE_URL=… PLAYWRIGHT_MODULE=/caminho/playwright/index.mjs node --test tests/e2e/renegociacao.e2e.mjs
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
// Tudo o que uma renegociação gravada mexeria: operações, pagamentos, renovações, capital, carteira, clientes e auditoria.
const dataHash = () => one(`select md5(string_agg(x, '|' order by x)) from (select 'o'||row(o.*)::text x from loan_operation o union all select 'p'||row(p.*)::text from payment p
  union all select 'r'||row(r.*)::text from loan_renewal r union all select 'm'||row(m.*)::text from capital_movement m union all select 'w'||row(w.*)::text from wallet w
  union all select 'c'||row(c.*)::text from client c union all select 'a'||row(a.*)::text from admin_audit_log a) t`);

let robério, before;
test("preparação: duas operações em aberto do mesmo cliente", async () => {
  await admin(`update wallet set initial_capital_cents = 1000000 where tenant_id = 'ten_roberio'`);
  await admin(`insert into client(id, tenant_id, name) values ('c_e2e_reneg', 'ten_roberio', 'Cliente Renegociação')`);
  robério = await login("roberio@teste.local");
  const create = (fields) => action(robério, "createOperationAction", { clientId: "c_e2e_reneg", modality: "SINGLE", frequency: "MONTHLY", ...fields });
  // Hoje (fictício) é depois de 13/10/2026: as duas estão em aberto, R$ 1.500 de principal e R$ 400 de juros.
  assert.equal((await create({ principal: "1.000,00", rate: "30", loanDate: "2026-10-01", dueDate: "2026-11-01" }))?.ok, true);
  assert.equal((await create({ principal: "500,00", rate: "20", loanDate: "2026-10-05", dueDate: "2026-11-05" }))?.ok, true);
  before = await dataHash();
});

test("RN1. tela: posição, desconto de R$ 100 com motivo, 3 parcelas mensais a 10%, comparação hoje × proposta e o aviso de desconto acima dos juros (desktop e celular); nada é gravado", async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  for (const [label, viewport] of [["desktop", { width: 1440, height: 900 }], ["celular", { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport });
    const [name, value] = robério.split("; ").find((cookie) => cookie.includes("session_token")).split(/=(.*)/s);
    await context.addCookies([{ name, value, domain: new URL(BASE).hostname, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage();
    await page.goto(`${BASE}/?tela=renegociacao`);
    const pick = page.getByRole("region", { name: "Operações a renegociar" });
    await pick.getByLabel("Cliente").selectOption("c_e2e_reneg");
    assert.equal(await pick.locator("tbody tr").count(), 2);
    const terms = page.getByRole("region", { name: "Novas condições" });
    await terms.getByText(/principal em aberto R\$\s1\.500,00, juros em aberto R\$\s400,00, saldo R\$\s1\.900,00/).waitFor();
    await terms.getByLabel("Ajuste").selectOption("DISCOUNT");
    await terms.getByLabel("Valor do desconto (R$)").fill("100,00");
    await terms.getByLabel("Taxa de juros por mês (%)").fill("10");
    await terms.getByLabel("Quantidade de parcelas (meses)").fill("3");
    await terms.getByLabel("Primeiro vencimento").fill("15/11/2026");
    await terms.getByLabel("Primeiro vencimento").press("Tab");
    // Sem motivo, o desconto não é simulado.
    await terms.getByText("Informe o motivo do desconto para ver a simulação.").waitFor();
    assert.equal(await page.getByRole("region", { name: "Resultado da simulação" }).count(), 0);
    await terms.getByLabel("Motivo do desconto").fill("acordo para quitar em 3 meses");
    const result = page.getByRole("region", { name: "Resultado da simulação" });
    await result.waitFor();
    const summary = await result.locator(".payment-summary").innerText();
    // Valor renegociado = 1.900 − 100 = 1.800; juros novos = 1.500 × 10% × 3 = 450 (nunca sobre os juros); total 2.250.
    for (const expected of [/Valor renegociado\s+R\$\s1\.800,00/, /Juros novos[^\n]*\s+R\$\s450,00/, /Total a receber \(depois\)\s+R\$\s2\.250,00/]) assert.match(summary, expected);
    // Comparação hoje × proposta: principal igual (sem dinheiro novo), juros 400 − 100 + 450 = 750, lucro realizado igual.
    const compare = result.getByRole("table", { name: "Atual e proposta" });
    const line = async (label) => (await compare.locator("tr", { hasText: label }).innerText()).replace(/\s+/g, " ");
    assert.match(await line("Principal em aberto"), /R\$ 1\.500,00 R\$ 1\.500,00/);
    assert.match(await line("Juros a receber"), /R\$ 400,00 R\$ 750,00/);
    assert.match(await line("Total a receber"), /R\$ 1\.900,00 R\$ 2\.250,00/);
    assert.match(await line("Último vencimento"), /05\/11\/2026 15\/01\/2027/);
    assert.match(await line("Lucro realizado"), /R\$ 0,00 R\$ 0,00/);
    assert.match(await line("Saída de caixa"), /R\$ 0,00/);
    await result.getByText("Motivo do desconto: acordo para quitar em 3 meses").waitFor();
    const payments = result.getByLabel("Pagamentos simulados");
    assert.deepEqual(await payments.locator("li strong").allInnerTexts(), ["15/11/2026", "15/12/2026", "15/01/2027"]);
    assert.equal((await payments.locator("li").allInnerTexts()).filter((text) => /R\$\s750,00/.test(text)).length, 3);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/renegociacao-simulacao-${label}.png`, fullPage: true });
    // Desconto maior que os juros em aberto: aviso de que parte do principal não voltaria.
    await terms.getByLabel("Valor do desconto (R$)").fill("500,00");
    await result.getByText("O desconto passa dos juros em aberto").waitFor();
    // Tirar uma operação refaz a posição.
    await pick.getByLabel(/Incluir #/).first().uncheck();
    await terms.getByText(/Posição atual de 1 operação/).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `sem rolagem horizontal (${label})`);
    await context.close();
  }
  assert.equal(await dataHash(), before, "a simulação não grava nada");
});

test("RN2. o tenant B não vê as operações do A na renegociação", async () => {
  const fernando = await login("fernando@teste.local");
  const html = await (await fetch(`${BASE}/?tela=renegociacao`, { headers: { cookie: fernando } })).text();
  assert.equal(html.includes("Cliente Renegociação"), false);
});
