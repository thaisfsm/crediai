// Investidores, Etapa B, de ponta a ponta (HTTP + banco): CPF/CNPJ com dígitos verificadores, dados bancários e Pix do
// investidor, novos campos do contrato, cronograma de pagamentos com valores digitados (sem duplicar), histórico de
// alterações, isolamento entre tenants, visão do MASTER, e nenhum efeito no capital ou nos dados que já existiam.
// SÓ em ambiente LOCAL e DESCARTÁVEL (ver tests/e2e/README.md). Usa os dados fictícios ten_roberio (A), ten_fernando (B)
// e ten_thais (MASTER).
//   E2E_DATABASE_URL=… PLAYWRIGHT_MODULE=/caminho/playwright/index.mjs node --test tests/e2e/investidores-cronograma.e2e.mjs
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
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;| /g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
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
  const response = await fetch(`${BASE}/investidores`, { method: "POST", headers: { cookie, "next-action": actionId(name), accept: "text/x-component", origin: BASE }, body: form });
  const result = (await response.text()).match(/^1:(\{.*\})$/m)?.[1];
  return result ? JSON.parse(result) : null;
}
const page = async (cookie, path) => {
  const response = await fetch(`${BASE}${path}`, { redirect: "manual", headers: { cookie } });
  return { status: response.status, html: response.status === 200 ? text(await response.text()) : "" };
};
// Tudo o que este módulo não pode tocar: operações, pagamentos, capital, carteiras, clientes, tenants e usuários.
const protectedHash = () => one(`select md5(string_agg(x, '|' order by x)) from (
  select 'o'||row(o.*)::text x from loan_operation o union all select 'p'||row(p.*)::text from payment p union all select 'r'||row(r.*)::text from loan_renewal r
  union all select 'w'||row(w.*)::text from wallet w union all select 'm'||row(m.*)::text from capital_movement m union all select 'c'||row(c.*)::text from client c
  union all select 't'||row(t.*)::text from tenant t union all select 'u'||concat_ws(',', u.id, u.name, u.email, u.role, u.tenant_id, u.active) from "user" u) t`);
const items = (investmentId) => admin(`select number, due_date::text, yield_cents::int, principal_cents::int, description from investment_schedule_item where investment_id = '${investmentId}' order by due_date, number`);

let robério, fernando, thais, hashBefore;
const ids = {};

test("preparação", async () => {
  hashBefore = await protectedHash();
  robério = await login("roberio@teste.local");
  fernando = await login("fernando@teste.local");
  thais = await login("thais@teste.local");
});

test("IC1. investidor: CPF/CNPJ com dígitos verificadores; dados bancários e Pix gravados e fora da auditoria", async () => {
  const invalid = await action(robério, "createInvestorAction", { name: "CPF Errado", document: "411.797.058-59" });
  assert.equal(invalid?.ok, false);
  assert.match(invalid.error, /CPF inválido/);
  assert.equal((await action(robério, "createInvestorAction", { name: "CNPJ Errado", document: "12.345.678/0001-90" }))?.ok, false);
  assert.equal(await one("select count(*)::int from investor where name in ('CPF Errado', 'CNPJ Errado')"), 0);
  const created = await action(robério, "createInvestorAction", {
    name: "Marta Cronograma", document: "411.797.058-58", bankHolderName: "Marta Cronograma", bankHolderDocument: "411.797.058-58", bankName: "001 Banco do Brasil",
    bankBranch: "1234-5", bankAccount: "99887-6", bankAccountType: "SAVINGS", pixKeyType: "PHONE", pixKey: "+55 (11) 91234-5678",
  });
  assert.equal(created?.ok, true, JSON.stringify(created));
  ids.investor = created.id;
  const [row] = await admin(`select * from investor where id = '${ids.investor}'`);
  assert.equal(row.tenant_id, "ten_roberio");
  assert.equal(row.bank_account, "99887-6");
  assert.equal(row.bank_account_type, "SAVINGS");
  assert.equal(row.pix_key_type, "PHONE");
  assert.equal(row.pix_key, "11912345678");
  assert.equal((await action(robério, "updateInvestorAction", { investorId: ids.investor, name: "Marta Cronograma", document: "411.797.058-58", pixKeyType: "CPF", pixKey: "111.111.111-11" }))?.ok, false);
  const audit = JSON.stringify(await admin(`select before, after from admin_audit_log where entity_id = '${ids.investor}'`));
  assert.ok(!audit.includes("99887") && !audit.includes("11912345678"), "conta e chave Pix não vão para a auditoria");
  assert.ok(audit.includes('"bank":"preenchidos"'));
  const profile = await page(robério, `/investidores/${ids.investor}`);
  assert.match(profile.html, /001 Banco do Brasil · ag\. 1234-5 · conta 99887-6 · Conta poupança/);
  assert.match(profile.html, /Celular: \(11\) 91234-5678/);
});

test("IC2. contrato: identificação única na carteira, data do investimento, prazo, periodicidade e parcelas", async () => {
  const created = await action(robério, "createInvestmentAction", {
    investorId: ids.investor, amount: "50.000,00", rate: "1,5", ratePeriod: "MONTHLY", startDate: "2026-10-10", contractNumber: "INV-2026/001",
    investedOn: "2026-10-08", termMonths: "12", maturityDate: "2027-10-10", paymentFrequency: "MONTHLY", installmentCount: "12",
  });
  assert.equal(created?.ok, true, JSON.stringify(created));
  ids.investment = created.id;
  const [row] = await admin(`select contract_number, invested_on::text, term_months, payment_frequency, installment_count, calculation_rule from investment where id = '${ids.investment}'`);
  assert.deepEqual({ ...row }, { contract_number: "INV-2026/001", invested_on: "2026-10-08", term_months: 12, payment_frequency: "MONTHLY", installment_count: 12, calculation_rule: null });
  const duplicate = await action(robério, "createInvestmentAction", { investorId: ids.investor, amount: "1.000,00", rate: "1", ratePeriod: "MONTHLY", startDate: "2026-10-10", contractNumber: "INV-2026/001" });
  assert.equal(duplicate?.ok, false);
  assert.match(duplicate.error, /identificação/);
  // Outra carteira pode usar a mesma identificação.
  const other = await action(fernando, "createInvestorAction", { name: "Investidor B Cronograma" });
  ids.investorB = other.id;
  const otherInvestment = await action(fernando, "createInvestmentAction", { investorId: ids.investorB, amount: "1.000,00", rate: "1", ratePeriod: "MONTHLY", startDate: "2026-10-10", contractNumber: "INV-2026/001" });
  assert.equal(otherInvestment?.ok, true, JSON.stringify(otherInvestment));
  ids.investmentB = otherInvestment.id;
});

test("IC3. alteração do contrato fica no histórico visível do tenant (antes e depois)", async () => {
  const updated = await action(robério, "updateInvestmentAction", {
    investmentId: ids.investment, amount: "50.000,00", rate: "1,5", ratePeriod: "MONTHLY", startDate: "2026-10-10", contractNumber: "INV-2026/001",
    investedOn: "2026-10-08", termMonths: "12", maturityDate: "2027-10-10", paymentFrequency: "QUARTERLY", installmentCount: "4",
  });
  assert.equal(updated?.ok, true, JSON.stringify(updated));
  const [revision] = await admin(`select kind, changes from investment_revision where investment_id = '${ids.investment}'`);
  assert.equal(revision.kind, "CONTRACT");
  assert.deepEqual(revision.changes, [
    { field: "Periodicidade dos pagamentos", before: "Mensal", after: "Trimestral" },
    { field: "Quantidade de parcelas", before: "12", after: "4" },
  ]);
  // Salvar sem mudar nada não cria linha.
  await action(robério, "updateInvestmentAction", { investmentId: ids.investment, amount: "50.000,00", rate: "1,5", ratePeriod: "MONTHLY", startDate: "2026-10-10", contractNumber: "INV-2026/001", investedOn: "2026-10-08", termMonths: "12", maturityDate: "2027-10-10", paymentFrequency: "QUARTERLY", installmentCount: "4" });
  assert.equal(await one(`select count(*)::int from investment_revision where investment_id = '${ids.investment}'`), 1);
  const detail = await page(robério, `/investidores/investimentos/${ids.investment}`);
  assert.match(detail.html, /Histórico de alterações/);
  assert.match(detail.html, /Periodicidade dos pagamentos: de Mensal para Trimestral/);
  assert.match(detail.html, /Identificação do contrato INV-2026\/001/);
});

test("IC4. cronograma: valores digitados, sem duplicar ao enviar duas vezes; substituir exige confirmação", async () => {
  const build = { investmentId: ids.investment, frequency: "QUARTERLY", firstDueDate: "2027-01-10", count: "4", yieldAmount: "2.250,00", principalAmount: "50.000,00", description: "Rendimento trimestral" };
  const first = await action(robério, "buildInvestmentScheduleAction", build);
  assert.equal(first?.ok, true, JSON.stringify(first));
  const expected = [
    { number: 1, due_date: "2027-01-10", yield_cents: 225_000, principal_cents: 0, description: "Rendimento trimestral" },
    { number: 2, due_date: "2027-04-10", yield_cents: 225_000, principal_cents: 0, description: "Rendimento trimestral" },
    { number: 3, due_date: "2027-07-10", yield_cents: 225_000, principal_cents: 0, description: "Rendimento trimestral" },
    { number: 4, due_date: "2027-10-10", yield_cents: 225_000, principal_cents: 5_000_000, description: "Rendimento trimestral" },
  ];
  assert.deepEqual((await items(ids.investment)).map((row) => ({ ...row })), expected);
  // Reenvio sem confirmar a substituição: recusado e nada muda.
  const again = await action(robério, "buildInvestmentScheduleAction", build);
  assert.equal(again?.ok, false);
  assert.match(again.error, /Confirme/);
  // Dois envios simultâneos confirmando: o resultado continua com 4 linhas (a trava do investimento serializa).
  const results = await Promise.all([action(robério, "buildInvestmentScheduleAction", { ...build, replace: "1" }), action(robério, "buildInvestmentScheduleAction", { ...build, replace: "1" })]);
  assert.ok(results.every((result) => result?.ok), JSON.stringify(results));
  assert.deepEqual((await items(ids.investment)).map((row) => ({ ...row })), expected);
  assert.equal(await one(`select count(*)::int from investment_revision where investment_id = '${ids.investment}' and kind = 'SCHEDULE'`), 3);
  // O banco recusa linha sem valor e número repetido.
  await assert.rejects(admin(`insert into investment_schedule_item (id, tenant_id, investment_id, number, due_date) values ('ivs_zero', 'ten_roberio', '${ids.investment}', 9, '2027-12-01')`));
  await assert.rejects(admin(`insert into investment_schedule_item (id, tenant_id, investment_id, number, due_date, yield_cents) values ('ivs_dup', 'ten_roberio', '${ids.investment}', 1, '2027-12-01', 1)`));
  // Linha de um tenant apontando para investimento de outro: recusada pela chave composta.
  await assert.rejects(admin(`insert into investment_schedule_item (id, tenant_id, investment_id, number, due_date, yield_cents) values ('ivs_x', 'ten_fernando', '${ids.investment}', 50, '2027-12-01', 1)`));
});

test("IC5. incluir, editar e retirar um pagamento; cada alteração no histórico e na auditoria", async () => {
  const added = await action(robério, "addInvestmentScheduleItemAction", { investmentId: ids.investment, dueDate: "2027-12-15", yieldAmount: "100,00", description: "Bônus combinado" });
  assert.equal(added?.ok, true, JSON.stringify(added));
  const [extra] = await admin(`select id, number from investment_schedule_item where investment_id = '${ids.investment}' and due_date = '2027-12-15'`);
  assert.equal(extra.number, 5);
  const edited = await action(robério, "updateInvestmentScheduleItemAction", { investmentId: ids.investment, itemId: extra.id, dueDate: "2027-12-20", yieldAmount: "150,00", principalAmount: "" });
  assert.equal(edited?.ok, true, JSON.stringify(edited));
  assert.deepEqual({ ...(await admin(`select due_date::text, yield_cents::int, principal_cents::int, description from investment_schedule_item where id = '${extra.id}'`))[0] },
    { due_date: "2027-12-20", yield_cents: 15_000, principal_cents: 0, description: null });
  assert.equal((await action(robério, "updateInvestmentScheduleItemAction", { investmentId: ids.investment, itemId: extra.id, dueDate: "2027-12-20" }))?.ok, false, "linha sem valor");
  const removed = await action(robério, "deleteInvestmentScheduleItemAction", { investmentId: ids.investment, itemId: extra.id });
  assert.equal(removed?.ok, true);
  assert.equal(await one(`select count(*)::int from investment_schedule_item where investment_id = '${ids.investment}'`), 4);
  const descriptions = (await admin(`select description from investment_revision where investment_id = '${ids.investment}' and kind = 'SCHEDULE' order by created_at`)).map((row) => row.description);
  assert.deepEqual(descriptions.slice(-3), ["Pagamento incluído no cronograma", "Pagamento do cronograma alterado", "Pagamento retirado do cronograma"]);
  assert.equal(await one(`select count(*)::int from admin_audit_log where entity_id = '${ids.investment}' and action = 'INVESTMENT_SCHEDULE_UPDATED' and tenant_id = 'ten_roberio'`), 6);
  const detail = await page(robério, `/investidores/investimentos/${ids.investment}`);
  assert.match(detail.html, /Cronograma de pagamentos/);
  assert.match(detail.html, /Rendimentos informados R\$ 9\.000,00/);
  assert.match(detail.html, /Devolução de principal informada R\$ 50\.000,00/);
});

test("IC6. isolamento: o tenant B não vê nem altera o cronograma do A, nem com ids forjados", async () => {
  const [item] = await admin(`select id from investment_schedule_item where investment_id = '${ids.investment}' order by number limit 1`);
  assert.equal((await action(fernando, "buildInvestmentScheduleAction", { investmentId: ids.investment, frequency: "MONTHLY", firstDueDate: "2027-01-01", count: "1", yieldAmount: "1", replace: "1" }))?.ok, false);
  assert.equal((await action(fernando, "addInvestmentScheduleItemAction", { investmentId: ids.investment, dueDate: "2027-01-01", yieldAmount: "1" }))?.ok, false);
  assert.equal((await action(fernando, "updateInvestmentScheduleItemAction", { investmentId: ids.investment, itemId: item.id, dueDate: "2027-01-01", yieldAmount: "1" }))?.ok, false);
  assert.equal((await action(fernando, "deleteInvestmentScheduleItemAction", { investmentId: ids.investment, itemId: item.id }))?.ok, false);
  // Investimento próprio com a linha de outro investimento: não encontrada.
  assert.equal((await action(fernando, "deleteInvestmentScheduleItemAction", { investmentId: ids.investmentB, itemId: item.id }))?.ok, false);
  assert.equal((await action(fernando, "updateInvestmentAction", { investmentId: ids.investment, amount: "1,00", rate: "1", ratePeriod: "MONTHLY", startDate: "2026-10-10" }))?.ok, false);
  assert.equal(await one(`select count(*)::int from investment_schedule_item where investment_id = '${ids.investment}'`), 4);
  assert.notEqual((await page(fernando, `/investidores/investimentos/${ids.investment}`)).status, 200);
  const own = await page(fernando, `/investidores/investimentos/${ids.investmentB}`);
  assert.ok(!own.html.includes("Rendimento trimestral"));
});

test("IC7. MASTER vê e altera o cronograma de qualquer carteira; investimento cancelado fica só para consulta", async () => {
  const master = await page(thais, `/investidores/investimentos/${ids.investment}`);
  assert.equal(master.status, 200);
  assert.match(master.html, /Rendimento trimestral/);
  const added = await action(thais, "addInvestmentScheduleItemAction", { investmentId: ids.investmentB, dueDate: "2027-02-01", yieldAmount: "10,00" });
  assert.equal(added?.ok, true, JSON.stringify(added));
  assert.equal(await one(`select tenant_id from investment_schedule_item where investment_id = '${ids.investmentB}'`), "ten_fernando");
  await action(fernando, "updateInvestmentAction", { investmentId: ids.investmentB, amount: "1.000,00", rate: "1", ratePeriod: "MONTHLY", startDate: "2026-10-10", contractNumber: "INV-2026/001", status: "CANCELED" });
  const blocked = await action(fernando, "addInvestmentScheduleItemAction", { investmentId: ids.investmentB, dueDate: "2027-03-01", yieldAmount: "10,00" });
  assert.equal(blocked?.ok, false);
  assert.match(blocked.error, /encerrado ou cancelado/);
});

test("IC8. tela: cronograma com prévia das datas antes de gravar e histórico (desktop e celular)", async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  for (const [label, viewport] of [["desktop", { width: 1440, height: 900 }], ["celular", { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport });
    const [name, value] = robério.split("; ").find((cookie) => cookie.includes("session_token")).split(/=(.*)/s);
    await context.addCookies([{ name, value, domain: new URL(BASE).hostname, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
    const browserPage = await context.newPage();
    await browserPage.goto(`${BASE}/investidores/investimentos/${ids.investment}`);
    const schedule = browserPage.getByRole("region", { name: "Cronograma de pagamentos ao investidor" });
    await schedule.getByText("Rendimento trimestral").first().waitFor();
    assert.equal(await schedule.locator("tbody tr").count(), 4);
    if (SHOTS) await schedule.screenshot({ path: `${SHOTS}/investidor-cronograma-${label}.png` });
    await schedule.getByRole("button", { name: "Substituir cronograma" }).click();
    await schedule.getByLabel("Quantidade de pagamentos").fill("3");
    await schedule.getByLabel("Data do primeiro pagamento").fill("31/01/2027");
    await schedule.getByLabel("Data do primeiro pagamento").press("Tab");
    const preview = schedule.getByLabel("Prévia das datas");
    await preview.getByText("31/07/2027").waitFor();
    await preview.getByText("30/04/2027").waitFor();
    assert.equal(await preview.locator("li").count(), 3);
    if (SHOTS) await schedule.screenshot({ path: `${SHOTS}/investidor-cronograma-previa-${label}.png` });
    const history = browserPage.getByRole("region", { name: "Histórico de alterações do investimento" });
    await history.getByText("Periodicidade dos pagamentos: de Mensal para Trimestral").waitFor();
    if (SHOTS) await history.screenshot({ path: `${SHOTS}/investidor-historico-${label}.png` });
    await browserPage.goto(`${BASE}/investidores/${ids.investor}`);
    const profile = browserPage.getByRole("region", { name: "Dados de Marta Cronograma" });
    await profile.getByText("Celular: (11) 91234-5678").waitFor();
    if (SHOTS) await profile.screenshot({ path: `${SHOTS}/investidor-banco-${label}.png` });
    assert.equal(await browserPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `sem rolagem horizontal (${label})`);
    await context.close();
  }
  // Nada foi gravado pela prévia.
  assert.equal(await one(`select count(*)::int from investment_schedule_item where investment_id = '${ids.investment}'`), 4);
});

test("IC9. nada fora do módulo mudou: operações, pagamentos, capital, carteiras, clientes, tenants e usuários", async () => {
  assert.equal(await protectedHash(), hashBefore);
});
