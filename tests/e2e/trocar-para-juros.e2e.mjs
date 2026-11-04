// Trocar o tipo de um recebimento para "Juros / Renovação" (Editar pagamento), de ponta a ponta (HTTP + banco + navegador).
//   * mesmo pagamento (id, valor, data, observação); só a classificação muda, com reclassificação auditada e renovação;
//   * recusas sem gravar (sem confirmação, outro tenant, recebimento posterior); envios simultâneos gravam uma vez;
//   * tela com prévia e confirmação, desktop e celular.
// Só em ambiente LOCAL e DESCARTÁVEL, com os dados fictícios ten_roberio (A) e ten_fernando (B).
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

const panelOf = async (page, client) => {
  await page.goto(`${BASE}/?tela=cobrancas`);
  await page.locator("main .table-panel table.data-table > tbody > tr", { hasText: client }).getByRole("button", { name: "Registrar pagamento" }).click();
  const panel = page.getByRole("dialog", { name: `Pagamentos de ${client}` });
  await panel.waitFor();
  return panel;
};
const summary = async (panel) => Object.fromEntries(await panel.locator(".payment-summary div").evaluateAll((items) => items.map((item) => [item.querySelector("dt")?.textContent?.trim(), item.querySelector("dd")?.textContent?.replace(/\s/g, " ").trim()])));
const previewOf = async (panel) => Object.fromEntries(await panel.locator(".payment-plan-preview div").evaluateAll((items) => items.map((item) => [item.querySelector("span")?.textContent?.trim(), item.querySelector("strong")?.textContent?.replace(/\s/g, " ").trim()])));



let robério, fernando, opA, opB, opC, othersBefore;
const createSingle = async (clientId) => {
  const created = await action(robério, "createOperationAction", { clientId, modality: "SINGLE", frequency: "MONTHLY", principal: "5.000,00", rate: "2", loanDate: day(-45), dueDate: day(-15) });
  assert.equal(created?.ok, true, JSON.stringify(created));
  return one(`select id from loan_operation where client_id = '${clientId}'`);
};
const manual = async (operationId, paidAt) => {
  const result = await action(robério, "registerPaymentAction", { operationId, paidAt, paymentMode: "MANUAL", amount: "100,00" });
  assert.equal(result?.ok, true, JSON.stringify(result));
  return one(`select id from payment where operation_id = '${operationId}' order by created_at desc limit 1`);
};
const reclassify = (paymentId, who = robério, confirm = "yes") => action(who, "reclassifyPaymentAsInterestAction", { paymentId, ...(confirm ? { confirm } : {}) });
const row = (paymentId) => admin(`select id, amount_cents::int a, paid_at::text d, notes, payment_mode m, interest_period_number p from payment where id = '${paymentId}'`).then((r) => r[0]);

test("preparação: contratos de R$ 5.000 a 2% com R$ 100 lançados como pagamento manual (abatendo principal)", async () => {
  await admin(`update wallet set initial_capital_cents = 4000000, created_at = now() - interval '2000 days', cycle_started_at = now() - interval '2000 days' where tenant_id = 'ten_roberio'`);
  await admin(`insert into client(id, tenant_id, name) values ('c_e2e_tj_a', 'ten_roberio', 'Troca Juros A'), ('c_e2e_tj_b', 'ten_roberio', 'Troca Juros B'), ('c_e2e_tj_c', 'ten_roberio', 'Troca Juros C')`);
  robério = await login("roberio@teste.local");
  fernando = await login("fernando@teste.local");
  opA = await createSingle("c_e2e_tj_a"); opB = await createSingle("c_e2e_tj_b"); opC = await createSingle("c_e2e_tj_c");
  othersBefore = await otherTenants();
});

test("TJE1. recusas sem gravar: sem confirmação, outro tenant, com recebimento posterior", async () => {
  const pA = await manual(opA, day(-15));
  const pC1 = await manual(opC, day(-15)); await manual(opC, day(-1));
  const hash = await dataHash();
  const noConfirm = await reclassify(pA, robério, null);
  assert.equal(noConfirm?.ok, false); assert.match(noConfirm.error, /Confirme/);
  const other = await reclassify(pA, fernando);
  assert.equal(other?.ok, false); assert.match(other.error, /não encontrado/);
  const later = await reclassify(pC1);
  assert.equal(later?.ok, false); assert.match(later.error, /recebimento mais recente/);
  assert.equal(await dataHash(), hash, "nada gravado");
});

test("TJE2. troca grava: mesmo pagamento (id, valor, data), Juros / Renovação do 1º período, principal intacto, renovação, auditoria", async () => {
  const pA = await one(`select id from payment where operation_id = '${opA}'`);
  const before = await row(pA);
  const sumBefore = Number(await one(`select sum(amount_cents) from payment where tenant_id = 'ten_roberio'`));
  const result = await reclassify(pA);
  assert.equal(result?.ok, true, JSON.stringify(result));
  assert.match(result.message, /Juros \/ Renovação do 1º período\. Principal em aberto: R\$\s?5\.000,00/);
  const after = await row(pA);
  assert.deepEqual([after.id, after.a, after.d, after.notes], [before.id, before.a, before.d, before.notes]);
  assert.deepEqual([after.m, after.p], ["INTEREST_ONLY_RENEWAL", 1]);
  const [renewal] = await admin(`select period_number n, previous_due_date::text a, new_due_date::text b, principal_base_cents::int c, interest_cents::int i from loan_renewal where operation_id = '${opA}'`);
  assert.deepEqual(renewal, { n: 2, a: day(-15), b: renewal.b, c: 500000, i: 10000 });
  assert.equal(await one(`select due_date::text from loan_operation where id = '${opA}'`), renewal.b);
  const [rec] = await admin(`select previous_mode a, new_mode b, previous_period_number c, new_period_number d, authorized_by e from payment_reclassification where payment_id = '${pA}'`);
  assert.deepEqual(rec, { a: "MANUAL", b: "INTEREST_ONLY_RENEWAL", c: null, d: 1, e: "Robério Santos" });
  assert.equal(await one(`select count(*)::int from admin_audit_log where action = 'PAYMENT_RECLASSIFIED_AS_INTEREST' and entity_id = '${opA}' and after->>'paymentId' = '${pA}'`), 1);
  assert.equal(Number(await one(`select sum(amount_cents) from payment where tenant_id = 'ten_roberio'`)), sumBefore, "capital: nenhum centavo a mais ou a menos");
  const again = await reclassify(pA);
  assert.equal(again?.ok, false); assert.match(again.error, /já está como juros/);
  assert.equal(await otherTenants(), othersBefore, "outros tenants intactos");
});

test("TJE3. envios simultâneos gravam uma troca só", async () => {
  const pB = await manual(opB, day(-15));
  const results = await Promise.all([1, 2, 3].map(() => reclassify(pB)));
  assert.equal(results.filter((r) => r?.ok).length, 1, JSON.stringify(results));
  assert.equal(await one(`select count(*)::int from payment_reclassification where payment_id = '${pB}'`), 1);
  assert.equal(await one(`select count(*)::int from loan_renewal where operation_id = '${opB}'`), 1);
});

test("TJE4. tela: Editar pagamento mostra a troca com prévia e grava Juros / Renovação (desktop e celular)", async () => {
  await admin(`insert into client(id, tenant_id, name) values ('c_e2e_tj_d', 'ten_roberio', 'Troca Juros Tela')`);
  const opD = await createSingle("c_e2e_tj_d");
  await manual(opD, day(-15));
  for (const [name, viewport] of [["desktop", { width: 1366, height: 900 }], ["celular", { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await spaced();
    await page.goto(`${BASE}/login`);
    await page.getByLabel("E-mail").fill("roberio@teste.local");
    await page.getByLabel("Senha").fill(process.env.E2E_PASSWORD ?? "Senha-Teste-Local-123");
    await page.getByRole("button", { name: /Entrar/ }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20_000 });
    const panel = await panelOf(page, "Troca Juros Tela");
    const item = panel.locator(".payment-history li").first();
    await item.getByRole("button", { name: "Editar pagamento" }).click();
    const form = panel.getByRole("form", { name: "Trocar para juros recebidos" });
    if (name === "desktop") {
      await form.waitFor();
      const text = (await form.textContent()).replace(/\s/g, " ");
      assert.match(text, /Juros do 1º período/); assert.match(text, /Principal em aberto após\s?R\$\s?5\.000,00/);
      assert.equal(await form.getByRole("button", { name: "Trocar para Juros / Renovação" }).isDisabled(), true, "só com confirmação");
      await form.getByRole("checkbox").check();
      await form.scrollIntoViewIfNeeded();
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/trocar-para-juros-${name}.png`, fullPage: false });
      await form.getByRole("button", { name: "Trocar para Juros / Renovação" }).click();
      await panel.locator(".payment-history li").first().getByText("Juros / Renovação").waitFor();
    } else {
      // Depois da troca o bloco não aparece mais (já é juros); o histórico mostra Juros / Renovação no celular.
      assert.equal(await form.count(), 0);
      await panel.locator(".payment-history li").first().getByText("Juros / Renovação").waitFor();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 1, `sem rolagem lateral (${overflow})`);
      await panel.locator(".payment-history li").first().scrollIntoViewIfNeeded();
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/trocar-para-juros-${name}.png`, fullPage: false });
    }
    await context.close();
  }
  assert.equal(await one(`select payment_mode from payment where operation_id = (select id from loan_operation where client_id = 'c_e2e_tj_d')`), "INTEREST_ONLY_RENEWAL");
});

test("TJE5. banco (papel sem BYPASSRLS): a carteira só grava reclassificação dos próprios pagamentos", async () => {
  const appUrl = databaseUrl.replace(/\/\/[^@]+@/, "//crediai_app:app_local_pw@");
  const app = postgres(appUrl, { max: 1, onnotice: () => {} });
  try {
    const target = await one(`select id from payment where tenant_id = 'ten_roberio' and payment_mode = 'MANUAL' limit 1`);
    const insert = (tenant) => app.begin(async (tx) => {
      await tx`select set_config('app.crediai_role', 'TENANT_USER', true), set_config('app.tenant_id', ${tenant}, true)`;
      await tx.unsafe(`insert into payment_reclassification(id, tenant_id, payment_id, previous_mode, new_mode, reason, authorized_by) values ('rec_tj5_${tenant}', 'ten_roberio', '${target}', 'MANUAL', 'MANUAL', 'teste de política da carteira', 'teste')`);
    });
    await assert.rejects(insert("ten_fernando"), /row-level security|política|policy/, "outro tenant não grava");
    await insert("ten_roberio");
    assert.equal(await one(`select count(*)::int from payment_reclassification where id = 'rec_tj5_ten_roberio'`), 1);
  } finally { await app.end(); }
});
