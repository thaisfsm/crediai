// Correção de operação sem pagamentos (Etapa G, parte 1) de ponta a ponta (HTTP + banco): prévia antes/depois sem gravar,
// confirmação com motivo, histórico e auditoria, capital, bloqueio com pagamento, modalidade fixa, correções simultâneas,
// isolamento entre tenants, tela no desktop e no celular, e nada que já existia muda.
// SÓ em ambiente LOCAL e DESCARTÁVEL (ver tests/e2e/README.md). Usa os dados fictícios ten_roberio (A) e ten_fernando (B).
//   E2E_DATABASE_URL=… PLAYWRIGHT_MODULE=/caminho/playwright/index.mjs node --test tests/e2e/edicao-operacao.e2e.mjs
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
const available = async (tenantId) => Number(await one(`select w.initial_capital_cents
  + coalesce((select sum(case when m.kind in ('CONTRIBUTION','OTHER_INCOME') then m.amount_cents else -m.amount_cents end) from capital_movement m where m.tenant_id = w.tenant_id and m.cycle_number = w.cycle_number), 0)
  - coalesce((select sum(o.principal_cents) from loan_operation o where o.tenant_id = w.tenant_id and o.cycle_number = w.cycle_number and o.status <> 'CANCELED'), 0)
  + coalesce((select sum(p.amount_cents) from payment p join loan_operation o on o.id = p.operation_id where p.tenant_id = w.tenant_id and o.cycle_number = w.cycle_number), 0)
  from wallet w where w.tenant_id = '${tenantId}'`));
// Tudo o que existia antes do teste (operações, pagamentos, renovações, clientes, capital de outras carteiras).
const existingHash = () => one(`select md5(string_agg(x, '|' order by x)) from (
  select 'o'||row(o.*)::text x from loan_operation o where o.client_id not like 'c_e2e_ed%'
  union all select 'p'||row(p.*)::text from payment p join loan_operation o on o.id = p.operation_id where o.client_id not like 'c_e2e_ed%'
  union all select 'r'||row(r.*)::text from loan_renewal r join loan_operation o on o.id = r.operation_id where o.client_id not like 'c_e2e_ed%' union all select 'c'||row(c.*)::text from client c where c.id not like 'c_e2e_ed%'
  union all select 'm'||row(m.*)::text from capital_movement m) t`);
const row = async (operationId) => (await admin(`select client_id, principal_cents::int, interest_cents::int, total_cents::int, loan_date::text, due_date::text, first_due_date::text, installment_count, installment_cents::int, modality, frequency, calculation_rule, updated_at from loan_operation where id = '${operationId}'`))[0];
const SINGLE = { modality: "SINGLE", frequency: "MONTHLY", principal: "1.000,00", rate: "30", loanDate: "2026-10-13", dueDate: "2026-11-13" };

let robério, fernando, before, ids = {};
test("preparação: carteira A com capital e clientes", async () => {
  await admin(`update wallet set initial_capital_cents = 500000 where tenant_id = 'ten_roberio'`);
  await admin(`insert into client(id, tenant_id, name) values ('c_e2e_ed1', 'ten_roberio', 'Cliente Edição'), ('c_e2e_ed2', 'ten_roberio', 'Outro Cliente Edição'), ('c_e2e_edf', 'ten_fernando', 'Cliente Edição B')`);
  before = await existingHash();
  robério = await login("roberio@teste.local");
  fernando = await login("fernando@teste.local");
  const created = await action(robério, "createOperationAction", { clientId: "c_e2e_ed1", ...SINGLE });
  assert.equal(created?.ok, true, JSON.stringify(created));
  ids.single = await one(`select id from loan_operation where client_id = 'c_e2e_ed1'`);
});

test("EO1. prévia mostra antes e depois e não grava nada", async () => {
  const original = await row(ids.single);
  const preview = await action(robério, "previewOperationEditAction", { operationId: ids.single, clientId: "c_e2e_ed2", ...SINGLE, principal: "1.200,00" });
  assert.equal(preview?.ok, true, JSON.stringify(preview));
  assert.deepEqual(preview.changes.map((change) => change.field), ["Cliente", "Valor emprestado", "Juros", "Total a receber"]);
  assert.deepEqual(preview.changes[0], { field: "Cliente", before: "Cliente Edição", after: "Outro Cliente Edição" });
  assert.equal(preview.version, new Date(original.updated_at).toISOString());
  assert.deepEqual(await row(ids.single), original, "a prévia não grava");
  ids.version = preview.version;
});

test("EO2. confirmação exige motivo, confirmação e a versão da prévia; grava operação, histórico e auditoria", async () => {
  const availableBefore = await available("ten_roberio");
  const fields = { operationId: ids.single, clientId: "c_e2e_ed2", ...SINGLE, principal: "1.200,00", version: ids.version };
  assert.equal((await action(robério, "updateOperationAction", { ...fields, confirmed: "1" }))?.ok, false, "sem motivo");
  assert.equal((await action(robério, "updateOperationAction", { ...fields, reason: "valor digitado errado" }))?.ok, false, "sem confirmar");
  const stale = await action(robério, "updateOperationAction", { ...fields, reason: "valor digitado errado", confirmed: "1", version: "2000-01-01T00:00:00.000Z" });
  assert.equal(stale?.ok, false);
  assert.match(stale.error, /mudou depois da prévia/);
  const saved = await action(robério, "updateOperationAction", { ...fields, reason: "valor digitado errado", confirmed: "1" });
  assert.equal(saved?.ok, true, JSON.stringify(saved));
  const after = await row(ids.single);
  assert.deepEqual([after.client_id, after.principal_cents, after.interest_cents, after.total_cents, after.due_date], ["c_e2e_ed2", 120_000, 36_000, 156_000, "2026-11-13"]);
  assert.equal(await available("ten_roberio"), availableBefore - 20_000, "só a diferença sai do capital");
  const [revision] = await admin(`select reason, changes, before, after, edited_by_user_id from loan_operation_revision where operation_id = '${ids.single}'`);
  assert.equal(revision.reason, "valor digitado errado");
  assert.equal(revision.changes.length, 4);
  assert.equal(revision.before.principalCents, 100_000);
  assert.equal(revision.after.principalCents, 120_000);
  assert.ok(revision.edited_by_user_id);
  assert.equal(await one(`select count(*)::int from admin_audit_log where action = 'OPERATION_UPDATED' and entity_id = '${ids.single}' and tenant_id = 'ten_roberio'`), 1);
});

test("EO3. modalidade e periodicidade não mudam; capital insuficiente é recusado", async () => {
  const version = (await action(robério, "previewOperationEditAction", { operationId: ids.single, ...SINGLE, principal: "1.200,00" })).version;
  const modality = await action(robério, "previewOperationEditAction", { operationId: ids.single, modality: "SINGLE", frequency: "BIWEEKLY", principal: "1.200,00", rate: "15", loanDate: "2026-10-13", dueDate: "2026-10-28" });
  assert.equal(modality?.ok, false);
  assert.match(modality.error, /modalidade e a periodicidade não mudam/);
  const installment = await action(robério, "updateOperationAction", { operationId: ids.single, modality: "INSTALLMENT", loanAmount: "1.200,00", installment: "500,00", term: "3", loanDate: "2026-10-13", firstDueDate: "2026-11-13", reason: "teste", confirmed: "1", version });
  assert.equal(installment?.ok, false);
  const tooMuch = await action(robério, "previewOperationEditAction", { operationId: ids.single, ...SINGLE, principal: "9.000,00" });
  assert.equal(tooMuch?.ok, false);
  assert.match(tooMuch.error, /Capital disponível insuficiente/);
  assert.equal((await row(ids.single)).principal_cents, 120_000);
});

test("EO4. parcelado quinzenal: mais uma parcela muda o último vencimento e o total, pela regra do cadastro", async () => {
  const created = await action(robério, "createOperationAction", { clientId: "c_e2e_ed1", modality: "INSTALLMENT", installmentFrequency: "BIWEEKLY", loanAmount: "600,00", installment: "300,00", term: "3", loanDate: "2026-10-13", firstDueDate: "2026-11-06" });
  assert.equal(created?.ok, true, JSON.stringify(created));
  ids.installment = await one(`select id from loan_operation where client_id = 'c_e2e_ed1' and modality = 'INSTALLMENT'`);
  const fields = { operationId: ids.installment, clientId: "c_e2e_ed1", modality: "INSTALLMENT", installmentFrequency: "BIWEEKLY", loanAmount: "600,00", installment: "300,00", term: "4", loanDate: "2026-10-13", firstDueDate: "2026-11-06" };
  const preview = await action(robério, "previewOperationEditAction", fields);
  assert.equal(preview?.ok, true, JSON.stringify(preview));
  assert.deepEqual(preview.changes.find((change) => change.field === "Último vencimento"), { field: "Último vencimento", before: "06/12/2026", after: "21/12/2026" });
  const saved = await action(robério, "updateOperationAction", { ...fields, reason: "cliente pediu 4 parcelas", confirmed: "1", version: preview.version });
  assert.equal(saved?.ok, true, JSON.stringify(saved));
  const after = await row(ids.installment);
  assert.deepEqual([after.installment_count, after.installment_cents, after.total_cents, after.interest_cents, after.due_date, after.frequency, after.calculation_rule],
    [4, 30_000, 120_000, 60_000, "2026-12-21", "BIWEEKLY", "FIXED_BIWEEKLY_INSTALLMENTS_V1"]);
});

test("EO5. duas correções simultâneas da mesma prévia: uma grava, a outra é recusada", async () => {
  const fields = { operationId: ids.installment, clientId: "c_e2e_ed1", modality: "INSTALLMENT", installmentFrequency: "BIWEEKLY", loanAmount: "600,00", installment: "300,00", term: "4", loanDate: "2026-10-13", firstDueDate: "2026-11-06" };
  const { version } = await action(robério, "previewOperationEditAction", { ...fields, installment: "310,00" });
  const results = await Promise.all([
    action(robério, "updateOperationAction", { ...fields, installment: "310,00", reason: "primeira", confirmed: "1", version }),
    action(robério, "updateOperationAction", { ...fields, installment: "320,00", reason: "segunda", confirmed: "1", version }),
  ]);
  assert.equal(results.filter((result) => result?.ok).length, 1, JSON.stringify(results));
  assert.equal(await one(`select count(*)::int from loan_operation_revision where operation_id = '${ids.installment}'`), 2);
});

test("EO6. com pagamento registrado a correção fica bloqueada e nada muda", async () => {
  const paid = await action(robério, "registerPaymentAction", { operationId: ids.single, amount: "100,00", paidAt: "2026-10-13" });
  assert.equal(paid?.ok, true, JSON.stringify(paid));
  const original = await row(ids.single);
  const blocked = await action(robério, "previewOperationEditAction", { operationId: ids.single, ...SINGLE, principal: "1.100,00" });
  assert.equal(blocked?.ok, false);
  assert.match(blocked.error, /já tem pagamento/);
  const forced = await action(robério, "updateOperationAction", { operationId: ids.single, ...SINGLE, principal: "1.100,00", reason: "forçar", confirmed: "1", version: new Date(original.updated_at).toISOString() });
  assert.equal(forced?.ok, false);
  assert.deepEqual(await row(ids.single), original);
});

test("EO7. isolamento: o tenant B não corrige operação do A nem usa cliente do A", async () => {
  const preview = await action(fernando, "previewOperationEditAction", { operationId: ids.installment, clientId: "c_e2e_ed1", modality: "INSTALLMENT", installmentFrequency: "BIWEEKLY", loanAmount: "600,00", installment: "300,00", term: "4", loanDate: "2026-10-13", firstDueDate: "2026-11-06" });
  assert.equal(preview?.ok, false);
  assert.match(preview.error, /não encontrada/);
  const created = await action(fernando, "createOperationAction", { clientId: "c_e2e_edf", ...SINGLE });
  assert.equal(created?.ok, true, JSON.stringify(created));
  const own = await one(`select id from loan_operation where client_id = 'c_e2e_edf'`);
  const foreignClient = await action(fernando, "previewOperationEditAction", { operationId: own, clientId: "c_e2e_ed1", ...SINGLE });
  assert.equal(foreignClient?.ok, false);
  assert.match(foreignClient.error, /Cliente não encontrado/);
  assert.equal(await one(`select client_id from loan_operation where id = '${own}'`), "c_e2e_edf");
});

test("EO8. tela: Corrigir, revisar antes e depois, confirmar, ver a correção no histórico e o aviso de bloqueio com pagamento (desktop e celular)", async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  let term = 5;
  for (const [label, viewport] of [["desktop", { width: 1440, height: 900 }], ["celular", { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport });
    const [name, value] = robério.split("; ").find((cookie) => cookie.includes("session_token")).split(/=(.*)/s);
    await context.addCookies([{ name, value, domain: new URL(BASE).hostname, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage();
    await page.goto(`${BASE}/?tela=operacoes`);
    const rowLocator = page.locator("tr", { hasText: "Parcelado quinzenal" }).filter({ hasText: "Cliente Edição" }).first();
    await rowLocator.getByRole("button", { name: "Corrigir" }).click();
    const dialog = page.getByRole("dialog", { name: /Corrigir operação/ });
    await dialog.getByLabel("Quantidade de parcelas (quinzenas)").fill(String(term));
    await dialog.getByLabel("Motivo da correção").fill(`ajuste na tela ${label}`);
    await dialog.getByRole("button", { name: "Revisar alterações" }).click();
    const review = dialog.getByLabel("Antes e depois");
    await review.getByText("Quantidade de parcelas").waitFor();
    if (SHOTS) await dialog.screenshot({ path: `${SHOTS}/correcao-operacao-${label}.png` });
    assert.equal(await one(`select installment_count from loan_operation where id = '${ids.installment}'`), term - 1, "revisar não grava");
    await dialog.getByRole("button", { name: "Confirmar correção" }).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(await one(`select installment_count from loan_operation where id = '${ids.installment}'`), term);
    // Com pagamento (EO6): o botão explica o bloqueio e não abre o formulário.
    const code = `#OP-${ids.single.replace(/^op_/, "").slice(0, 6).toUpperCase()}`;
    await page.locator("tr", { hasText: code }).getByRole("button", { name: "Corrigir" }).click();
    const locked = page.getByRole("alertdialog", { name: /Corrigir operação/ });
    await locked.getByText("Correção bloqueada para preservar o histórico financeiro.").waitFor();
    assert.equal(await locked.getByLabel("Motivo da correção").count(), 0);
    if (SHOTS) await locked.screenshot({ path: `${SHOTS}/correcao-bloqueada-${label}.png` });
    await locked.getByRole("button", { name: "Entendi" }).click();
    await page.locator("tr", { hasText: "Parcelado quinzenal" }).filter({ hasText: "Cliente Edição" }).first().getByRole("button", { name: "Registrar pagamento" }).click();
    const history = page.getByText(`ajuste na tela ${label}`);
    await history.waitFor();
    await history.scrollIntoViewIfNeeded();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/correcao-historico-${label}.png` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `sem rolagem horizontal (${label})`);
    await context.close();
    term += 1;
  }
});

test("EO9. nada que já existia mudou (operações, pagamentos, renovações, clientes e capital)", async () => {
  assert.equal(await existingHash(), before);
});
