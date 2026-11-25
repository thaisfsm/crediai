// Lançamentos (débito/crédito) no fechamento de comissão dos gerentes, de ponta a ponta: servidor + banco + telas.
// SÓ em ambiente LOCAL e DESCARTÁVEL (ver tests/e2e/README.md): cria gerentes, clientes, operações e lançamentos fictícios.
//   E2E_DATABASE_URL=… PLAYWRIGHT_MODULE=… node --test tests/e2e/lancamentos-comissao.e2e.mjs
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
const one = async (query) => { const value = Object.values((await admin(query))[0] ?? {})[0]; return typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : value; };
const manifest = JSON.parse(readFileSync(".next/server/server-reference-manifest.json", "utf8")).node;
const actionId = (name) => Object.entries(manifest).find(([, value]) => value.exportedName === name)?.[0] ?? assert.fail(`ação ${name} não encontrada no build`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SHOTS = process.env.E2E_SCREENSHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
after(async () => { await browser.close(); await sql.end(); });

const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const day = (offset) => { const date = new Date(`${TODAY}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + offset); return date.toISOString().slice(0, 10); };
const PASSWORD = process.env.E2E_PASSWORD ?? "Senha-Teste-Local-123";
// Tudo que é financeiro e não é do módulo de lançamentos: não pode mudar.
const tenantHash = (tenant) => one(`select md5(string_agg(x, '|' order by x)) from (
  select 'c'||row(c.*)::text x from client c where tenant_id = '${tenant}' union all select 'o'||row(o.*)::text from loan_operation o where tenant_id = '${tenant}'
  union all select 'p'||row(p.*)::text from payment p where tenant_id = '${tenant}' union all select 'w'||row(w.*)::text from wallet w where tenant_id = '${tenant}'
  union all select 'm'||row(m.*)::text from capital_movement m where tenant_id = '${tenant}' union all select 'g'||row(g.*)::text from account_manager g where tenant_id = '${tenant}') t`);

let lastLogin = 0;
async function throttle() { const wait = 11_000 - (Date.now() - lastLogin); if (wait > 0) await sleep(wait); lastLogin = Date.now(); }
async function signIn(email, viewport = { width: 1440, height: 900 }) {
  await throttle();
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(PASSWORD);
  await page.getByRole("button", { name: /Entrar/ }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20_000 });
  return page;
}
async function apiLogin(email) {
  await throttle();
  const response = await fetch(`${BASE}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email, password: PASSWORD }) });
  assert.equal(response.status, 200, `login de ${email}`);
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}
async function action(cookie, name, fields, path = "/gerentes") {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) for (const item of [value].flat()) form.append(`_1_${key}`, item);
  form.append("0", '["$K1"]');
  const response = await fetch(`${BASE}${path}`, { method: "POST", redirect: "manual", headers: { cookie, "next-action": actionId(name), accept: "text/x-component", origin: BASE }, body: form });
  const result = (await response.text()).match(/^1:(\{.*\})$/m)?.[1];
  return { status: response.status, result: result ? JSON.parse(result) : null };
}
const get = (cookie, path) => fetch(`${BASE}${path}`, { redirect: "manual", headers: { cookie } });
const poll = async (query, expected) => { for (let i = 0; i < 60; i++) { if (String(await one(query)) === String(expected)) return; await sleep(250); } assert.equal(String(await one(query)), String(expected)); };

const A = "mgr_l_a", B = "mgr_l_b", F = "mgr_l_f";
let owner, ownerApi, fernandoBefore, ownerBefore, oldPayoutRow;

test("preparação: gerentes, clientes e comissões fictícias (A com R$ 2.000 a pagar, B com R$ 1.000, gerente do tenant B)", async () => {
  fernandoBefore = await tenantHash("ten_fernando");
  await admin(`insert into account_manager(id, tenant_id, name, commission_bps) values ('${A}','ten_roberio','Gerente Lançamentos',1000), ('${B}','ten_roberio','Outro Lançamentos',1000), ('${F}','ten_fernando','Gerente do Fernando',1000)`);
  await admin(`insert into client(id, tenant_id, name, account_manager_id, account_manager_bps) values ('c_l_a','ten_roberio','Cliente Lançamentos A','${A}',1000), ('c_l_b','ten_roberio','Cliente Lançamentos B','${B}',1000)`);
  // 10% de R$ 25.000 de juros = R$ 2.500 (A) e 10% de R$ 10.000 = R$ 1.000 (B), contratos quitados.
  await admin(`insert into loan_operation(id,tenant_id,client_id,principal_cents,interest_rate_bps,interest_cents,total_cents,loan_date,due_date,calculation_rule,status,settled_at,modality) values
    ('op_l_a','ten_roberio','c_l_a',12500000,2000,2500000,15000000,'${day(-60)}','${day(-30)}','RATE_PER_OPERATION_SINGLE_PAYMENT_V1','PAID','${day(-30)}','SINGLE'),
    ('op_l_b','ten_roberio','c_l_b',5000000,2000,1000000,6000000,'${day(-60)}','${day(-30)}','RATE_PER_OPERATION_SINGLE_PAYMENT_V1','PAID','${day(-30)}','SINGLE')`);
  await admin(`insert into payment(id,tenant_id,operation_id,amount_cents,paid_at) values ('pay_l_a','ten_roberio','op_l_a',15000000,'${day(-30)}'), ('pay_l_b','ten_roberio','op_l_b',6000000,'${day(-30)}')`);
  // Fechamento ANTERIOR (antes dos lançamentos existirem): R$ 500. Tem de continuar exatamente igual.
  await admin(`insert into account_manager_payout(id,tenant_id,manager_id,amount_cents,paid_on,notes) values ('mgp_l_old','ten_roberio','${A}',50000,'${day(-20)}','fechamento antigo')`);
  oldPayoutRow = await one(`select row(p.*)::text from account_manager_payout p where id='mgp_l_old'`);
  await admin(`insert into account_manager_adjustment(id,tenant_id,manager_id,kind,description,amount_cents,entry_date) values ('mga_l_f','ten_fernando','${F}','DEBIT','Segredo do tenant B',7700,'${TODAY}')`);
  fernandoBefore = await tenantHash("ten_fernando");
  ownerBefore = await tenantHash("ten_roberio");
  owner = await signIn("roberio@teste.local");
  ownerApi = await apiLogin("roberio@teste.local");
});

test("L1. dono cria lançamentos pela tela e pela ação: ficam pendentes para o próximo fechamento", async () => {
  await owner.goto(`${BASE}/gerentes`);
  const region = owner.getByRole("region", { name: "Gerente Gerente Lançamentos" });
  await region.waitFor();
  await region.getByRole("button", { name: /^Lançamentos/ }).click();
  await region.getByText("Lançamentos do fechamento").waitFor();
  await region.getByLabel("Tipo").selectOption("DEBIT");
  await region.getByLabel("Valor (R$)").fill("200,00");
  await region.getByLabel("Descrição").fill("Adiantamento");
  await region.getByRole("button", { name: "Registrar lançamento" }).click();
  await poll(`select count(*) from account_manager_adjustment where manager_id='${A}' and kind='DEBIT' and amount_cents=20000 and description='Adiantamento' and payout_id is null`, 1);
  const credit = await action(ownerApi, "createAdjustmentAction", { managerId: A, kind: "CREDIT", amount: "100,00", description: "Bônus", entryDate: TODAY });
  assert.equal(credit.result?.ok, true, JSON.stringify(credit.result));
  assert.equal(await one(`select count(*) from account_manager_adjustment where manager_id='${A}' and payout_id is null`), 2);
  await owner.reload();
  const again = owner.getByRole("region", { name: "Gerente Gerente Lançamentos" });
  await again.getByRole("button", { name: "Lançamentos (2)" }).click();
  await again.getByText("Bônus").first().waitFor();
  assert.equal(await again.getByText("Pendente · próximo fechamento").count(), 2);
  assert.ok((await again.locator(".manager-summary").innerText().then((t) => t.replace(/\u00a0/g, " "))).includes("− R$ 100,00"), "efeito líquido pendente (−200 + 100) no resumo");
  // Validações no servidor: nada é gravado.
  for (const bad of [{ kind: "OUTRO", amount: "10,00", description: "x" }, { kind: "DEBIT", amount: "0,00", description: "x" }, { kind: "CREDIT", amount: "10,00", description: "   " }, { kind: "DEBIT", amount: "-5,00", description: "x" }, { kind: "DEBIT", amount: "10,00", description: "x", entryDate: "2026-02-31" }]) {
    const result = await action(ownerApi, "createAdjustmentAction", { managerId: A, entryDate: TODAY, ...bad });
    assert.equal(result.result?.ok, false, JSON.stringify(bad));
  }
  assert.equal(await one(`select count(*) from account_manager_adjustment where tenant_id='ten_roberio'`), 2);
  // Pendente pode ser excluído (e volta a não existir); o aplicado não (ver L3).
  const temp = await action(ownerApi, "createAdjustmentAction", { managerId: A, kind: "DEBIT", amount: "1,00", description: "Temporário", entryDate: TODAY });
  assert.equal(temp.result?.ok, true);
  const tempId = await one(`select id from account_manager_adjustment where description='Temporário'`);
  assert.equal((await action(ownerApi, "deleteAdjustmentAction", { adjustmentId: tempId })).result?.ok, true);
  assert.equal(await one(`select count(*) from account_manager_adjustment where description='Temporário'`), 0);
  if (SHOTS) await again.screenshot({ path: `${SHOTS}/lancamentos-desktop.png` });
});

test("L2. fechamento: comissão R$ 2.000 − débito R$ 200 + crédito R$ 100 = R$ 1.900, aplicado automaticamente e mostrado no relatório", async () => {
  await owner.reload();
  const region = owner.getByRole("region", { name: "Gerente Gerente Lançamentos" });
  await region.getByRole("button", { name: "Pagar comissão" }).click();
  await region.getByText("Lançamentos deste fechamento").waitFor();
  assert.equal(await region.getByLabel("Comissão deste fechamento (R$)").inputValue(), "2.000,00");
  const totals = region.locator(".closing-totals");
  assert.match(await totals.innerText().then((t) => t.replace(/\u00a0/g, " ")), /Valor final a pagar\s*R\$\s1\.900,00/);
  // Um lançamento só deste fechamento aparece na conta e some ao remover (o valor final volta a R$ 1.900).
  await region.getByRole("button", { name: "+ Lançamento só neste fechamento" }).click();
  await region.locator(".closing-extra-row").getByLabel("Descrição").fill("Teste");
  await region.locator(".closing-extra-row").getByLabel("Valor (R$)").fill("50,00");
  assert.match(await totals.innerText().then((t) => t.replace(/\u00a0/g, " ")), /Valor final a pagar\s*R\$\s1\.850,00/);
  await region.getByRole("button", { name: "Remover lançamento 1 deste fechamento" }).click();
  assert.match(await totals.innerText().then((t) => t.replace(/\u00a0/g, " ")), /Valor final a pagar\s*R\$\s1\.900,00/);
  if (SHOTS) await region.screenshot({ path: `${SHOTS}/fechamento-desktop.png` });
  await region.getByRole("button", { name: "Registrar pagamento da comissão" }).click();
  await poll(`select count(*) from account_manager_payout where manager_id='${A}'`, 2);
  const payout = (await admin(`select id, amount_cents::int a, debit_cents::int d, credit_cents::int c from account_manager_payout where manager_id='${A}' and id <> 'mgp_l_old'`))[0];
  assert.deepEqual([payout.a, payout.d, payout.c, payout.a - payout.d + payout.c], [200000, 20000, 10000, 190000]);
  assert.equal(await one(`select count(*) from account_manager_adjustment where manager_id='${A}' and payout_id='${payout.id}' and applied_at is not null`), 2, "os dois pendentes aplicados neste fechamento");
  assert.equal(await one(`select count(*) from account_manager_adjustment where manager_id='${A}' and payout_id is null`), 0);
  assert.equal(await one(`select row(p.*)::text from account_manager_payout p where id='mgp_l_old'`), oldPayoutRow, "fechamento anterior intacto");
  await owner.reload();
  const report = owner.getByRole("region", { name: "Gerente Gerente Lançamentos" });
  await report.getByRole("button", { name: "Lançamentos" }).click();
  await report.getByText(/Aplicado no fechamento de/).first().waitFor();
  assert.equal(await report.getByText(/Aplicado no fechamento de/).count(), 2);
  await report.getByRole("button", { name: "Pagar comissão" }).click();
  const text = await report.locator(".payout-report").innerText().then((t) => t.replace(/\u00a0/g, " "));
  for (const piece of ["Adiantamento", "− R$ 200,00", "Bônus", "+ R$ 100,00", "R$ 1.900,00", "R$ 2.000,00", "Débito", "Crédito", "fechamento antigo", "R$ 500,00"]) assert.ok(text.includes(piece), `relatório mostra ${piece}`);
  assert.ok((await report.locator(".manager-summary").innerText().then((t) => t.replace(/\u00a0/g, " "))).includes("Nenhum"), "nenhum pendente depois do fechamento");
  if (SHOTS) await report.screenshot({ path: `${SHOTS}/relatorio-fechamento-desktop.png` });
});

test("L3. lançamento aplicado nunca é aplicado de novo, alterado, excluído nem jogado em fechamento antigo", async () => {
  const applied = await one(`select id from account_manager_adjustment where description='Adiantamento'`);
  assert.equal((await action(ownerApi, "deleteAdjustmentAction", { adjustmentId: applied })).result?.ok, false, "aplicado não se exclui pela tela");
  await assert.rejects(admin(`update account_manager_adjustment set payout_id='mgp_l_old' where id='${applied}'`), /não pode ser alterado nem aplicado de novo/);
  await assert.rejects(admin(`update account_manager_adjustment set amount_cents=1 where id='${applied}'`), /não pode ser alterado/);
  await assert.rejects(admin(`delete from account_manager_adjustment where id='${applied}'`), /não pode ser apagado/);
  // Lançamento novo direto num fechamento já feito: os totais gravados no fechamento não batem e o banco recusa (histórico intacto).
  await assert.rejects(admin(`insert into account_manager_adjustment(id,tenant_id,manager_id,kind,description,amount_cents,entry_date,payout_id,applied_at) values ('mga_l_x','ten_roberio','${A}','DEBIT','Tardio',100,'${TODAY}','mgp_l_old',now())`), /não batem/);
  // Pendente aplicado direto pelo banco num fechamento antigo: também recusado.
  await admin(`insert into account_manager_adjustment(id,tenant_id,manager_id,kind,description,amount_cents,entry_date) values ('mga_l_y','ten_roberio','${A}','CREDIT','Pendente novo',300,'${TODAY}')`);
  await assert.rejects(admin(`update account_manager_adjustment set payout_id='mgp_l_old', applied_at=now() where id='mga_l_y'`), /não batem/);
  // Fechamento de outro gerente não aceita lançamento deste (mesmo tenant): chave estrangeira por gerente.
  const payoutA = await one(`select id from account_manager_payout where manager_id='${A}' and id <> 'mgp_l_old'`);
  await assert.rejects(admin(`insert into account_manager_adjustment(id,tenant_id,manager_id,kind,description,amount_cents,entry_date,payout_id,applied_at) values ('mga_l_z','ten_roberio','${B}','DEBIT','Cruzado',100,'${TODAY}','${payoutA}',now())`), /account_manager_adjustment_payout_same_manager_fk/);
  await admin(`delete from account_manager_adjustment where id='mga_l_y'`);
  assert.equal(await one(`select row(p.*)::text from account_manager_payout p where id='mgp_l_old'`), oldPayoutRow);
  // Totais do fechamento sem lançamentos de verdade: recusado no fim da transação.
  await assert.rejects(admin(`insert into account_manager_payout(id,tenant_id,manager_id,amount_cents,paid_on,debit_cents) values ('mgp_l_fake','ten_roberio','${B}',1000,'${TODAY}',500)`), /não batem/);
  await assert.rejects(admin(`insert into account_manager_payout(id,tenant_id,manager_id,amount_cents,paid_on,debit_cents) values ('mgp_l_neg','ten_roberio','${B}',1000,'${TODAY}',2000)`), /account_manager_payout_adjustments_valid/);
});

test("L4. fechamentos simultâneos e reenvio: os pendentes entram uma única vez; valor final negativo é recusado", async () => {
  // B: comissão R$ 1.000; débito pendente de R$ 1.200 deixa o valor final negativo com R$ 1.000 de comissão: recusado, nada gravado.
  assert.equal((await action(ownerApi, "createAdjustmentAction", { managerId: B, kind: "DEBIT", amount: "1.200,00", description: "Adiantamento grande", entryDate: TODAY })).result?.ok, true);
  const big = await one(`select id from account_manager_adjustment where description='Adiantamento grande'`);
  const negative = await action(ownerApi, "registerManagerPayoutAction", { managerId: B, amount: "1.000,00", paidOn: TODAY, pendingIds: big });
  assert.equal(negative.result?.ok, false);
  assert.match(negative.result.error, /não pode ficar negativo/);
  assert.equal(await one(`select count(*) from account_manager_payout where manager_id='${B}'`), 0);
  assert.equal((await action(ownerApi, "deleteAdjustmentAction", { adjustmentId: big })).result?.ok, true);
  // Débito de R$ 100 pendente; dois fechamentos de R$ 400 ao mesmo tempo com a mesma tela: só um aplica o débito.
  assert.equal((await action(ownerApi, "createAdjustmentAction", { managerId: B, kind: "DEBIT", amount: "100,00", description: "Vale", entryDate: TODAY })).result?.ok, true);
  const vale = await one(`select id from account_manager_adjustment where description='Vale'`);
  const fields = { managerId: B, amount: "400,00", paidOn: TODAY, pendingIds: vale };
  const results = await Promise.all([action(ownerApi, "registerManagerPayoutAction", fields), action(ownerApi, "registerManagerPayoutAction", fields), action(ownerApi, "registerManagerPayoutAction", fields)]);
  assert.equal(results.filter((item) => item.result?.ok).length, 1, JSON.stringify(results.map((item) => item.result)));
  assert.equal(await one(`select count(*) from account_manager_payout where manager_id='${B}'`), 1);
  assert.equal(await one(`select debit_cents from account_manager_payout where manager_id='${B}'`), 10000);
  assert.equal(await one(`select count(*) from account_manager_adjustment where id='${vale}' and payout_id is not null`), 1);
  // Reenvio do mesmo formulário: recusado (o pendente já não existe) e nada mais gravado.
  const resend = await action(ownerApi, "registerManagerPayoutAction", fields);
  assert.equal(resend.result?.ok, false);
  assert.equal(await one(`select count(*) from account_manager_payout where manager_id='${B}'`), 1);
  // Sem a lista da tela (chamada direta), o fechamento aplica sozinho TODOS os pendentes do gerente, e só os dele.
  assert.equal((await action(ownerApi, "createAdjustmentAction", { managerId: B, kind: "CREDIT", amount: "50,00", description: "Prêmio", entryDate: day(-3) })).result?.ok, true);
  assert.equal((await action(ownerApi, "createAdjustmentAction", { managerId: B, kind: "DEBIT", amount: "20,00", description: "Desconto", entryDate: day(-2) })).result?.ok, true);
  const auto = await action(ownerApi, "registerManagerPayoutAction", { managerId: B, amount: "100,00", paidOn: TODAY, extraKind: "CREDIT", extraDescription: "Bônus na hora", extraAmount: "10,00" });
  assert.equal(auto.result?.ok, true, JSON.stringify(auto.result));
  const last = (await admin(`select id, amount_cents::int a, debit_cents::int d, credit_cents::int c from account_manager_payout where manager_id='${B}' order by created_at desc limit 1`))[0];
  assert.deepEqual([last.a, last.d, last.c, last.a - last.d + last.c], [10000, 2000, 6000, 14000], "100 − 20 + 50 + 10 = 140");
  assert.equal(await one(`select count(*) from account_manager_adjustment where payout_id='${last.id}'`), 3, "dois pendentes + o lançamento só deste fechamento");
  assert.equal(await one(`select count(*) from account_manager_adjustment where manager_id='${B}' and payout_id is null`), 0);
  assert.equal(await one(`select count(*) from account_manager_adjustment where manager_id='${A}' and payout_id is null`), 0, "nada do gerente A foi tocado");
  // Lançamento só deste fechamento inválido: recusado inteiro.
  const badExtra = await action(ownerApi, "registerManagerPayoutAction", { managerId: B, amount: "10,00", paidOn: TODAY, extraKind: "DEBIT", extraDescription: "", extraAmount: "5,00" });
  assert.equal(badExtra.result?.ok, false);
  assert.equal(await one(`select count(*) from account_manager_payout where manager_id='${B}'`), 2);
});

test("L5. isolamento entre carteiras: o tenant B não vê, não cria, não exclui e não fecha com lançamentos do A (e vice-versa)", async () => {
  const fernando = await apiLogin("fernando@teste.local");
  const page = (await (await get(fernando, "/gerentes")).text()).replace(/\u00a0/g, " ");
  assert.ok(!page.includes("Adiantamento") && !page.includes("Gerente Lançamentos") && !page.includes("Bônus"), "tenant B não vê os lançamentos do A");
  assert.ok(page.includes("Segredo do tenant B"), "tenant B vê os próprios");
  assert.equal((await action(fernando, "createAdjustmentAction", { managerId: A, kind: "CREDIT", amount: "999,00", description: "Invasão", entryDate: TODAY })).result?.ok, false);
  const ownPending = await action(ownerApi, "createAdjustmentAction", { managerId: A, kind: "DEBIT", amount: "5,00", description: "Pendente do A", entryDate: TODAY });
  assert.equal(ownPending.result?.ok, true);
  const pendingA = await one(`select id from account_manager_adjustment where description='Pendente do A'`);
  assert.equal((await action(fernando, "deleteAdjustmentAction", { adjustmentId: pendingA })).result?.ok, false, "B não exclui pendente do A");
  assert.equal((await action(fernando, "registerManagerPayoutAction", { managerId: A, amount: "1,00", paidOn: TODAY })).result?.ok, false, "B não fecha comissão do A");
  assert.equal(await one(`select count(*) from account_manager_adjustment where id='${pendingA}' and payout_id is null`), 1);
  const ownerPage = await (await get(ownerApi, "/gerentes")).text();
  assert.ok(!ownerPage.includes("Segredo do tenant B"), "A não vê os lançamentos do B");
  assert.equal((await action(ownerApi, "deleteAdjustmentAction", { adjustmentId: "mga_l_f" })).result?.ok, false, "A não exclui lançamento do B");
  assert.equal((await action(ownerApi, "createAdjustmentAction", { managerId: F, kind: "DEBIT", amount: "1,00", description: "x", entryDate: TODAY })).result?.ok, false);
  assert.equal(await one(`select count(*) from account_manager_adjustment where tenant_id='ten_fernando'`), 1);
  assert.equal(await tenantHash("ten_fernando"), fernandoBefore, "tenant B intacto");
  assert.equal((await action(ownerApi, "deleteAdjustmentAction", { adjustmentId: pendingA })).result?.ok, true);
});

test("L6. painel da gerente: vê só os próprios fechamentos com os lançamentos e o valor recebido", async () => {
  const hash = await one(`select password from account where user_id='u_roberio' and provider_id='credential'`);
  await admin(`insert into "user"(id,name,email,role,tenant_id,active,must_change_password) values ('u_l_a','Gerente Lançamentos','gerente.lancamentos@teste.local','ACCOUNT_MANAGER','ten_roberio',true,false);
    insert into account(id,account_id,provider_id,user_id,password) values ('acc_u_l_a','u_l_a','credential','u_l_a','${hash}');
    update account_manager set user_id='u_l_a' where id='${A}'`);
  const managerPage = await signIn("gerente.lancamentos@teste.local");
  await managerPage.goto(`${BASE}/gerente?tela=comissao`);
  await managerPage.getByText("Comissões já recebidas").waitFor();
  const text = await managerPage.locator("body").innerText().then((t) => t.replace(/\u00a0/g, " "));
  for (const piece of ["Adiantamento", "Bônus", "R$ 1.900,00", "R$ 2.000,00"]) assert.ok(text.includes(piece), `painel mostra ${piece}`);
  for (const piece of ["Vale", "Prêmio", "Segredo do tenant B"]) assert.ok(!text.includes(piece), `painel não mostra ${piece}`);
  if (SHOTS) await managerPage.screenshot({ path: `${SHOTS}/painel-gerente.png`, fullPage: true });
  // A gerente só lê: não cria nem exclui lançamento.
  const managerApi = await apiLogin("gerente.lancamentos@teste.local");
  assert.notEqual((await action(managerApi, "createAdjustmentAction", { managerId: A, kind: "CREDIT", amount: "1.000,00", description: "Auto bônus", entryDate: TODAY })).result?.ok, true);
  assert.equal(await one(`select count(*) from account_manager_adjustment where description='Auto bônus'`), 0);
});

test("L7. celular sem rolagem lateral, MASTER registra em nome do cliente SaaS, e nada financeiro fora do módulo mudou", async () => {
  const phone = await signIn("roberio@teste.local", { width: 390, height: 844 });
  await phone.goto(`${BASE}/gerentes`);
  const region = phone.getByRole("region", { name: "Gerente Gerente Lançamentos" });
  await region.getByRole("button", { name: "Lançamentos" }).click();
  await region.getByText("Lançamentos do fechamento").waitFor();
  await region.getByRole("button", { name: "Pagar comissão" }).click();
  await region.getByText("Relatório dos fechamentos").waitFor();
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "sem rolagem horizontal no celular");
  if (SHOTS) await region.screenshot({ path: `${SHOTS}/relatorio-fechamento-celular.png` });
  const master = await apiLogin("thais@teste.local");
  const byMaster = await action(master, "adminCreateAdjustmentAction", { tenantId: "ten_roberio", managerId: A, kind: "CREDIT", amount: "12,34", description: "Bônus pelo MASTER", entryDate: TODAY }, "/admin/clientes/ten_roberio");
  assert.equal(byMaster.result?.ok, true, JSON.stringify(byMaster.result));
  assert.equal(await one(`select count(*) from account_manager_adjustment where tenant_id='ten_roberio' and description='Bônus pelo MASTER' and payout_id is null`), 1);
  assert.equal(await one(`select count(*) from admin_audit_log where entity='account_manager_adjustment' and tenant_id='ten_roberio'`) >= 5, true, "lançamentos auditados");
  // Clientes, operações, pagamentos, capital e gerentes do tenant A: iguais (só o user_id da gerente A mudou no L6).
  await admin(`update account_manager set user_id=null where id='${A}'`);
  assert.equal(await tenantHash("ten_roberio"), ownerBefore, "nada financeiro fora do módulo mudou");
  assert.equal(await tenantHash("ten_fernando"), fernandoBefore);
});
