// Renegociação GRAVADA (Etapa H, parte 2): encerra as operações antigas como renegociadas, cria o contrato novo ligado a
// elas, sem mexer no capital disponível, com auditoria; recusa repetição, desconto acima dos juros, edição/exclusão/pagamento
// indevidos, ids de outro tenant; envios simultâneos gravam uma só; tela completa no desktop e no celular.
// SÓ em ambiente LOCAL e DESCARTÁVEL (ver tests/e2e/README.md). Usa os dados fictícios ten_roberio.
//   E2E_DATABASE_URL=… PLAYWRIGHT_MODULE=/caminho/playwright/index.mjs node --test tests/e2e/renegociacao-gravacao.e2e.mjs
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


// Capital disponível pela fórmula da carteira, direto do banco (inicial + movimentos − principais + devolvidos + recebidos).
const available = () => one(`select w.initial_capital_cents
  + coalesce((select sum(case when kind in ('CONTRIBUTION','OTHER_INCOME') then amount_cents else -amount_cents end) from capital_movement where tenant_id = 'ten_roberio' and cycle_number = w.cycle_number), 0)
  - coalesce((select sum(principal_cents) from loan_operation where tenant_id = 'ten_roberio' and status <> 'CANCELED' and cycle_number = w.cycle_number), 0)
  + coalesce((select sum(renegotiated_principal_cents) from loan_operation where tenant_id = 'ten_roberio' and cycle_number = w.cycle_number), 0)
  + coalesce((select sum(p.amount_cents) from payment p join loan_operation o on o.id = p.operation_id where p.tenant_id = 'ten_roberio' and o.cycle_number = w.cycle_number), 0)
  from wallet w where w.tenant_id = 'ten_roberio'`);
const otherTenants = () => one(`select md5(string_agg(x, '|' order by x)) from (select 'o'||row(o.*)::text x from loan_operation o where tenant_id <> 'ten_roberio' union all select 'p'||row(p.*)::text from payment p where tenant_id <> 'ten_roberio') t`);

let robério, fernando, ids = [], newId, capitalBefore, othersBefore;
const fields = (extra = {}) => ({ clientId: "c_e2e_rg", modality: "INSTALLMENT", frequency: "MONTHLY", rate: "5", count: "3", firstDueDate: "2026-11-20", adjustmentKind: "NONE", adjustment: "", reason: "", confirm: "1", ...extra });
const renegotiate = (cookie, extra, operationIds = ids) => {
  // operationIds repetido: a ação lê getAll("operationIds").
  const form = new FormData();
  for (const [key, value] of Object.entries(fields(extra))) form.append(`_1_${key}`, value);
  for (const operationId of operationIds) form.append("_1_operationIds", operationId);
  form.append("0", '["$K1"]');
  return fetch(`${BASE}/`, { method: "POST", headers: { cookie, "next-action": actionId("renegotiateAction"), accept: "text/x-component", origin: BASE }, body: form })
    .then(async (response) => { const result = (await response.text()).match(/^1:(\{.*\})$/m)?.[1]; return result ? JSON.parse(result) : null; });
};

test("preparação: duas operações em aberto, uma com pagamento de juros", async () => {
  await admin(`update wallet set initial_capital_cents = 1000000 where tenant_id = 'ten_roberio'`);
  await admin(`insert into client(id, tenant_id, name) values ('c_e2e_rg', 'ten_roberio', 'Cliente Renegociado')`);
  robério = await login("roberio@teste.local");
  fernando = await login("fernando@teste.local");
  const create = (fields) => action(robério, "createOperationAction", { clientId: "c_e2e_rg", modality: "SINGLE", frequency: "MONTHLY", ...fields });
  assert.equal((await create({ principal: "1.000,00", rate: "30", loanDate: "2026-10-01", dueDate: "2026-11-01" }))?.ok, true);
  assert.equal((await create({ principal: "500,00", rate: "20", loanDate: "2026-10-05", dueDate: "2026-11-05" }))?.ok, true);
  ids = (await admin(`select id from loan_operation where client_id = 'c_e2e_rg' order by principal_cents desc`)).map((row) => row.id);
  assert.equal(ids.length, 2);
  const paid = await action(robério, "registerPaymentAction", { operationId: ids[0], amount: "300,00", paidAt: "2026-10-10" });
  assert.equal(paid?.ok, true, JSON.stringify(paid));
  capitalBefore = Number(await available());
  othersBefore = await otherTenants();
});

test("RG1. recusas: sem confirmação, vencimento passado, desconto acima dos juros, sem motivo, ids do outro tenant; nada é gravado", async () => {
  const hash = await dataHash();
  assert.equal((await renegotiate(robério, { confirm: "0" }))?.ok, false);
  assert.equal((await renegotiate(robério, { firstDueDate: "2026-10-01" }))?.ok, false);
  const deep = await renegotiate(robério, { adjustmentKind: "DISCOUNT", adjustment: "500,00", reason: "acima dos juros" });
  assert.equal(deep?.ok, false); assert.match(deep.error, /desconto passa dos juros/i);
  const noReason = await renegotiate(robério, { adjustmentKind: "DISCOUNT", adjustment: "10,00", reason: "" });
  assert.equal(noReason?.ok, false); assert.match(noReason.error, /motivo/i);
  assert.equal((await renegotiate(robério, {}, [])).ok, false);
  // O tenant B não renegocia operações do A, nem com o cliente do A.
  assert.equal((await renegotiate(fernando, {})).ok, false);
  assert.equal((await renegotiate(fernando, { clientId: "c_alex" })).ok, false);
  assert.equal(await dataHash(), hash, "nenhuma recusa grava");
});

test("RG2. gravar: antigas renegociadas e ligadas ao novo, principal do novo = principal em aberto, capital disponível igual, auditoria", async () => {
  const [before] = await admin(`select count(*)::int n from admin_audit_log where action = 'OPERATION_RENEGOTIATED'`);
  const result = await renegotiate(robério, { adjustmentKind: "DISCOUNT", adjustment: "50,00", reason: "acordo para parcelar em 3 vezes" });
  assert.equal(result?.ok, true, JSON.stringify(result));
  newId = result.operationId;
  const olds = await admin(`select id, status, renegotiated_into_id, renegotiated_principal_cents::int p, renegotiated_interest_cents::int i, renegotiated_on from loan_operation where id in ('${ids.join("','")}') order by principal_cents desc`);
  assert.deepEqual(olds.map((row) => [row.status, row.renegotiated_into_id]), [["RENEGOTIATED", newId], ["RENEGOTIATED", newId]]);
  // 1.000 a 30% com R$ 300 de juros pagos RENOVA o período (regra oficial): principal 1.000 e novo período de R$ 300 em aberto;
  // 500 a 20%: principal 500 e juros 100.
  assert.deepEqual(olds.map((row) => [row.p, row.i]), [[100000, 30000], [50000, 10000]]);
  const [fresh] = await admin(`select principal_cents::int principal, interest_cents::int interest, total_cents::int total, installment_cents::int installment, installment_count count, status, modality, client_id from loan_operation where id = '${newId}'`);
  // Juros em aberto 400 − desconto 50 + juros novos 1.500 × 5% × 3 = 225 → 575; total 2.075 em 3 parcelas (arredondadas para cima).
  assert.equal(fresh.principal, 150000);
  assert.equal(fresh.status, "OPEN"); assert.equal(fresh.modality, "INSTALLMENT"); assert.equal(fresh.client_id, "c_e2e_rg");
  assert.equal(fresh.total, fresh.installment * 3);
  assert.ok(fresh.total >= 207500 && fresh.total < 207503, `total ${fresh.total}`);
  assert.equal(Number(await available()), capitalBefore, "nenhum dinheiro entra ou sai");
  const [audit] = await admin(`select count(*)::int n from admin_audit_log where action = 'OPERATION_RENEGOTIATED' and entity_id = '${newId}' and tenant_id = 'ten_roberio'`);
  assert.equal(audit.n, 1);
  assert.equal((await one(`select count(*)::int from admin_audit_log where action = 'OPERATION_RENEGOTIATED'`)), before.n + 1);
  assert.equal(await otherTenants(), othersBefore, "o outro tenant não muda");
  assert.equal(await one(`select count(*)::int from payment where operation_id = '${ids[0]}'`), 1, "o pagamento antigo continua na operação antiga");
});

test("RG3. repetir, editar, excluir e pagar ficam recusados; o banco recusa renegociada sem vínculo", async () => {
  const hash = await dataHash();
  const again = await renegotiate(robério, {}); assert.equal(again?.ok, false); assert.match(again.error, /em aberto/);
  const cancelNew = await action(robério, "cancelOperationAction", { operationId: newId }); assert.equal(cancelNew?.ok, false); assert.match(cancelNew.error, /renegocia/i);
  const cancelOld = await action(robério, "cancelOperationAction", { operationId: ids[1] }); assert.equal(cancelOld?.ok, false);
  const edit = await action(robério, "previewOperationEditAction", { operationId: newId, clientId: "c_e2e_rg", modality: "INSTALLMENT", installmentFrequency: "MONTHLY", loanAmount: "1.600,00", installment: "600,00", term: "3", firstDueDate: "2026-11-20", loanDate: "2026-10-17" });
  assert.equal(edit?.ok, false); assert.match(edit.error, /renegocia/i);
  const payOld = await action(robério, "registerPaymentAction", { operationId: ids[1], amount: "10,00", paidAt: "2026-10-17" }); assert.equal(payOld?.ok, false);
  assert.equal(await dataHash(), hash, "nada mudou");
  await assert.rejects(admin(`update loan_operation set status = 'RENEGOTIATED' where id = '${newId}'`), /loan_operation_renegotiated_consistent/);
  await assert.rejects(admin(`update loan_operation set renegotiated_into_id = '${newId}' where id = '${newId}'`), /renegotiated_not_self/);
});

test("RG4. o novo contrato recebe pagamento normal e o capital soma só o recebido", async () => {
  const [{ installment }] = await admin(`select installment_cents::int installment from loan_operation where id = '${newId}'`);
  const paid = await action(robério, "registerPaymentAction", { operationId: newId, amount: (installment / 100).toFixed(2).replace(".", ","), paidAt: new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10) });
  assert.equal(paid?.ok, true, JSON.stringify(paid));
  assert.equal(Number(await available()), capitalBefore + installment);
});

test("RG5. envios simultâneos gravam uma renegociação só", async () => {
  await admin(`insert into client(id, tenant_id, name) values ('c_e2e_rg2', 'ten_roberio', 'Cliente Simultâneo')`);
  const created = await action(robério, "createOperationAction", { clientId: "c_e2e_rg2", modality: "SINGLE", frequency: "MONTHLY", principal: "400,00", rate: "10", loanDate: "2026-10-08", dueDate: "2026-11-08" });
  assert.equal(created?.ok, true);
  const [{ id }] = await admin(`select id from loan_operation where client_id = 'c_e2e_rg2'`);
  const results = await Promise.all([1, 2, 3].map(() => renegotiate(robério, { clientId: "c_e2e_rg2" }, [id])));
  assert.equal(results.filter((result) => result?.ok).length, 1, JSON.stringify(results));
  assert.equal(await one(`select count(*)::int from loan_operation where renegotiated_into_id is not null and client_id = 'c_e2e_rg2'`), 1);
  assert.equal(await one(`select count(*)::int from loan_operation where client_id = 'c_e2e_rg2' and status = 'OPEN'`), 1);
});

test("RG6. tela: gravar exige a confirmação, mostra o resultado, o vínculo na ficha e no extrato (desktop e celular)", async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  await admin(`insert into client(id, tenant_id, name) values ('c_e2e_rg3', 'ten_roberio', 'Cliente da Tela')`);
  const create = (fields) => action(robério, "createOperationAction", { clientId: "c_e2e_rg3", modality: "SINGLE", frequency: "MONTHLY", ...fields });
  assert.equal((await create({ principal: "800,00", rate: "10", loanDate: "2026-10-02", dueDate: "2026-11-02" }))?.ok, true);
  let capital;
  for (const [label, viewport] of [["desktop", { width: 1440, height: 900 }], ["celular", { width: 390, height: 844 }]]) {
    if (label === "celular") {
      
      assert.equal((await create({ principal: "300,00", rate: "10", loanDate: "2026-10-03", dueDate: "2026-11-03" }))?.ok, true);
    }
    capital = Number(await available());
    const context = await browser.newContext({ viewport });
    const [name, value] = robério.split("; ").find((cookie) => cookie.includes("session_token")).split(/=(.*)/s);
    await context.addCookies([{ name, value, domain: new URL(BASE).hostname, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage();
    await page.goto(`${BASE}/?tela=renegociacao`);
    await page.getByRole("region", { name: "Operações a renegociar" }).getByLabel("Cliente").selectOption("c_e2e_rg3");
    const terms = page.getByRole("region", { name: "Novas condições" });
    await terms.getByLabel("Taxa de juros por mês (%)").fill("5");
    await terms.getByLabel("Quantidade de parcelas (meses)").fill("2");
    const result = page.getByRole("region", { name: "Resultado da simulação" });
    await result.waitFor();
    const save = result.getByRole("button", { name: "Gravar renegociação" });
    assert.equal(await save.isDisabled(), true, "sem confirmar, o botão fica desligado");
    await result.getByLabel(/Confirmo/).check();
    assert.equal(await save.isDisabled(), false);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/renegociacao-gravar-${label}.png`, fullPage: true });
    await save.click();
    await page.getByText(/Renegociação gravada/).waitFor();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/renegociacao-gravada-${label}.png`, fullPage: true });
    assert.equal(Number(await available()), capital, "o capital não muda pela tela");
    const [renegotiated] = await admin(`select count(*)::int n from loan_operation where client_id = 'c_e2e_rg3' and status = 'RENEGOTIATED'`);
    assert.ok(renegotiated.n >= 1);
    await page.goto(`${BASE}/?tela=operacoes`);
    await page.getByText("Renegociada").first().waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `sem rolagem horizontal (${label})`);
    await page.goto(`${BASE}/financeiro`);
    await page.getByText(/Principal levado à renegociação/).locator("visible=true").first().waitFor();
    await context.close();
  }
});

test("RG8. multa na última parcela: exige motivo, grava a parcela final = parcela + multa e o total com a multa", async () => {
  await admin(`insert into client(id, tenant_id, name) values ('c_e2e_rg4', 'ten_roberio', 'Cliente Multa')`);
  const created = await action(robério, "createOperationAction", { clientId: "c_e2e_rg4", modality: "SINGLE", frequency: "MONTHLY", principal: "900,00", rate: "10", loanDate: "2026-10-08", dueDate: "2026-11-08" });
  assert.equal(created?.ok, true);
  const [{ id }] = await admin(`select id from loan_operation where client_id = 'c_e2e_rg4'`);
  const semMotivo = await renegotiate(robério, { clientId: "c_e2e_rg4", penalty: "100,00" }, [id]);
  assert.equal(semMotivo?.ok, false, "multa sem motivo é recusada");
  const done = await renegotiate(robério, { clientId: "c_e2e_rg4", penalty: "100,00", reason: "parcela em atraso jogada para o final" }, [id]);
  assert.equal(done?.ok, true, JSON.stringify(done));
  const [contract] = await admin(`select installment_count c, installment_cents i, principal_cents + interest_cents t from loan_operation where client_id = 'c_e2e_rg4' and status = 'OPEN'`);
  assert.equal(Number(contract.t), Number(contract.i) * Number(contract.c) + 10_000, "total = parcelas iguais + multa");
});

test("RG7. o tenant B não vê as renegociações do A", async () => {
  const html = await (await fetch(`${BASE}/`, { headers: { cookie: fernando } })).text();
  assert.equal(html.includes("Cliente Renegociado"), false);
  assert.equal(await otherTenants(), othersBefore);
});
