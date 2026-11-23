// Valor de cada parcela editado na prévia (pedido de 23/11/2026): 4 × R$ 922,00 com a 4ª negociada por R$ 411,00.
// Cadastro pelo servidor e pela tela, valores gravados no cronograma, total/juros/lucro pela soma, pagamentos, capital
// uma única vez, banco recusando valores incoerentes, correção sem recalcular os valores e operações antigas intactas.
// SÓ em ambiente LOCAL e DESCARTÁVEL (ver tests/e2e/README.md). Usa ten_roberio (A); ten_fernando (B) não pode mudar.
import { test, after } from "node:test";
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
const available = async (tenantId) => Number(await one(`select w.initial_capital_cents
  + coalesce((select sum(case when m.kind in ('CONTRIBUTION','OTHER_INCOME') then m.amount_cents else -m.amount_cents end) from capital_movement m where m.tenant_id = w.tenant_id and m.cycle_number = w.cycle_number), 0)
  - coalesce((select sum(o.principal_cents) from loan_operation o where o.tenant_id = w.tenant_id and o.cycle_number = w.cycle_number and o.status <> 'CANCELED'), 0)
  + coalesce((select sum(p.amount_cents) from payment p join loan_operation o on o.id = p.operation_id where p.tenant_id = w.tenant_id and o.cycle_number = w.cycle_number), 0)
  from wallet w where w.tenant_id = '${tenantId}'`));
const existingHash = () => one(`select md5(string_agg(x, '|' order by x)) from (
  select 'o'||row(o.*)::text x from loan_operation o where o.tenant_id <> 'ten_roberio'
  union all select 'p'||row(p.*)::text from payment p where p.tenant_id <> 'ten_roberio' union all select 'r'||row(r.*)::text from loan_renewal r) t`);
const AMOUNTS = [92200, 92200, 92200, 41100];
const base = { clientId: "c_e2e_pvc", modality: "INSTALLMENT", loanAmount: "1.844,00", installment: "922,00", term: "4" };

let robério, fernando, before, availableBefore, opId;
test("preparação: carteira A com capital e cliente", async () => {
  await admin(`update wallet set initial_capital_cents = 2000000 where tenant_id = 'ten_roberio'`);
  await admin(`insert into client(id, tenant_id, name) values ('c_e2e_pvc', 'ten_roberio', 'Cliente Parcelas Combinadas')`);
  before = await existingHash();
  robério = await login("roberio@teste.local");
  fernando = await login("fernando@teste.local");
  availableBefore = await available("ten_roberio");
});

test("PV1. cadastra 4 parcelas com a 4ª por R$ 411: valores gravados, total = soma, juros = soma − principal, capital sai uma vez", async () => {
  const result = await action(robério, "createOperationAction", { ...base, loanDate: "2026-08-21", firstDueDate: "2026-09-18", customInstallmentAmounts: JSON.stringify(AMOUNTS) });
  assert.equal(result.ok, true, JSON.stringify(result));
  const [op] = await admin(`select * from loan_operation where client_id = 'c_e2e_pvc'`);
  opId = op.id;
  assert.deepEqual(op.installment_amounts, AMOUNTS);
  assert.deepEqual([Number(op.principal_cents), Number(op.total_cents), Number(op.interest_cents), op.installment_count, Number(op.installment_cents)], [184400, 317700, 133300, 4, 92200]);
  assert.equal(await available("ten_roberio"), availableBefore - 184400);
});

test("PV2. pagamentos seguem os valores gravados; a 4ª cobra R$ 411 e quita; capital recebe cada pagamento uma vez; lucro = R$ 1.333", async () => {
  for (const [amount, paidAt] of [["922,00", "2026-09-18"], ["922,00", "2026-10-18"], ["922,00", "2026-11-18"]]) {
    const paid = await action(robério, "registerPaymentAction", { operationId: opId, amount, paidAt });
    assert.equal(paid.ok, true, JSON.stringify(paid));
  }
  // Acima do saldo (R$ 411) é recusado sem gravar.
  assert.equal((await action(robério, "registerPaymentAction", { operationId: opId, amount: "411,01", paidAt: "2026-11-20" })).ok, false);
  const last = await action(robério, "registerPaymentAction", { operationId: opId, amount: "411,00", paidAt: "2026-11-20" });
  assert.match(last.message, /Operação quitada/);
  assert.equal(await one(`select status from loan_operation where id = '${opId}'`), "PAID");
  assert.equal(Number(await one(`select count(*) from payment where operation_id = '${opId}'`)), 4);
  assert.equal(await available("ten_roberio"), availableBefore - 184400 + 317700);
  // Os valores gravados não foram recalculados nem sobrescritos pelos pagamentos.
  assert.deepEqual(await one(`select installment_amounts from loan_operation where id = '${opId}'`), AMOUNTS);
});

test("PV3. o banco recusa valores incoerentes (soma ≠ total, quantidade errada, zero, texto, fora do parcelado)", async () => {
  const insert = (id, amounts, extra = {}) => {
    const v = { total: 317700, interest: 133300, modality: "INSTALLMENT", count: 4, ...extra };
    return admin(`insert into loan_operation(id,tenant_id,client_id,principal_cents,interest_rate_bps,interest_cents,total_cents,loan_date,due_date,calculation_rule,modality,frequency,installment_count,installment_cents,first_due_date,installment_amounts)
      values ('${id}','ten_roberio','c_e2e_pvc',184400,0,${v.interest},${v.total},'2026-11-21','2027-04-18','X','${v.modality}','MONTHLY',${v.count},92200,'2027-01-18','${JSON.stringify(amounts)}')`);
  };
  await assert.rejects(insert("op_bad_sum", [92200, 92200, 92200, 41000]));
  await assert.rejects(insert("op_bad_len", [92200, 92200, 133300]));
  await assert.rejects(insert("op_bad_zero", [92200, 92200, 133300, 0]));
  await assert.rejects(insert("op_bad_text", ["92200", 92200, 92200, 41100]));
  await assert.rejects(insert("op_bad_frac", [92200.5, 92200, 92200, 41099.5]));
  await assert.rejects(admin(`insert into loan_operation(id,tenant_id,client_id,principal_cents,interest_rate_bps,interest_cents,total_cents,loan_date,due_date,calculation_rule,modality,frequency,installment_amounts) values ('op_bad_single','ten_roberio','c_e2e_pvc',100000,3000,30000,130000,'2026-11-21','2026-12-21','X','SINGLE','MONTHLY','[130000]')`));
  // Sem valores combinados, a regra antiga continua: total abaixo de parcela × prazo é recusado.
  await assert.rejects(admin(`insert into loan_operation(id,tenant_id,client_id,principal_cents,interest_rate_bps,interest_cents,total_cents,loan_date,due_date,calculation_rule,modality,frequency,installment_count,installment_cents,first_due_date) values ('op_bad_old','ten_roberio','c_e2e_pvc',184400,0,133300,317700,'2026-11-21','2027-04-18','X','INSTALLMENT','MONTHLY',4,92200,'2027-01-18')`));
  // Válido: soma = total.
  await insert("op_ok_db", AMOUNTS);
  await admin(`delete from loan_operation where id = 'op_ok_db'`);
});

test("PV4. servidor recusa valores inválidos sem gravar e o tenant B não usa o cliente do A", async () => {
  const count = async () => Number(await one(`select count(*) from loan_operation where client_id = 'c_e2e_pvc'`));
  const n = await count();
  for (const custom of [[92200, 92200, 92200, 0], [92200, 92200, 92200], [10000, 10000, 10000, 10000], "lixo"]) {
    const result = await action(robério, "createOperationAction", { ...base, loanDate: "2026-11-21", firstDueDate: "2027-01-18", customInstallmentAmounts: typeof custom === "string" ? custom : JSON.stringify(custom) });
    assert.equal(result.ok, false, JSON.stringify(custom));
  }
  assert.equal((await action(fernando, "createOperationAction", { ...base, loanDate: "2026-11-21", firstDueDate: "2027-01-18", customInstallmentAmounts: JSON.stringify(AMOUNTS) })).ok, false);
  assert.equal(await count(), n);
});

test("PV5. correção sem mudar prazo e parcela mantém os valores combinados (sem recalcular); mudando a parcela, voltam a ser iguais", async () => {
  const created = await action(robério, "createOperationAction", { ...base, loanDate: "2026-11-21", firstDueDate: "2027-01-18", customInstallmentAmounts: JSON.stringify(AMOUNTS) });
  assert.equal(created.ok, true);
  const id = await one(`select id from loan_operation where client_id = 'c_e2e_pvc' and status = 'OPEN'`);
  const edit = async (fields) => {
    const preview = await action(robério, "previewOperationEditAction", { operationId: id, ...base, loanDate: "2026-11-21", firstDueDate: "2027-01-18", ...fields });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    const saved = await action(robério, "updateOperationAction", { operationId: id, ...base, loanDate: "2026-11-20", firstDueDate: "2027-01-18", reason: "Teste de correção", confirmed: "1", version: preview.version, ...fields });
    assert.equal(saved.ok, true, JSON.stringify(saved));
  };
  await edit({});
  const [kept] = await admin(`select installment_amounts, total_cents, interest_cents, loan_date::text as loan_date from loan_operation where id = '${id}'`);
  assert.deepEqual([kept.installment_amounts, Number(kept.total_cents), Number(kept.interest_cents), kept.loan_date], [AMOUNTS, 317700, 133300, "2026-11-20"]);
  await edit({ installment: "900,00" });
  const [reset] = await admin(`select installment_amounts, total_cents from loan_operation where id = '${id}'`);
  assert.deepEqual([reset.installment_amounts, Number(reset.total_cents)], [null, 360000]);
  await admin(`update loan_operation set status = 'CANCELED' where id = '${id}'`);
});

test("PV6. tela: editar só a 4ª parcela na prévia atualiza total, juros e taxa; cadastra com os valores (desktop e celular)", async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  for (const [label, viewport] of [["desktop", { width: 1440, height: 900 }], ["celular", { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport });
    const [name, value] = robério.split("; ").find((cookie) => cookie.includes("session_token")).split(/=(.*)/s);
    await context.addCookies([{ name, value, domain: new URL(BASE).hostname, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage();
    await page.goto(`${BASE}/?tela=operacoes`);
    const form = page.getByRole("region", { name: "Nova operação" });
    await form.getByRole("radio", { name: "Parcelado" }).click();
    await form.getByLabel("Cliente").selectOption("c_e2e_pvc");
    await form.getByLabel("Valor emprestado (R$)").fill("1.844,00");
    await form.getByLabel("Valor de cada parcela (R$)").fill("922,00");
    await form.getByLabel("Prazo total (meses)").fill("4");
    await form.getByLabel("Data do empréstimo").fill("21/11/2026");
    await form.getByLabel("Primeiro vencimento").fill("18/01/2027");
    await form.getByLabel("Primeiro vencimento").press("Tab");
    const preview = form.getByLabel("Prévia dos vencimentos");
    await preview.waitFor();
    await form.getByText("R$ 3.688,00").first().waitFor();
    // Muda só a 4ª: 922,00 → 411,00.
    await preview.getByLabel("Valor da parcela 4").fill("411,00");
    await preview.getByLabel("Valor da parcela 4").press("Tab");
    assert.deepEqual(await preview.locator("input.schedule-amount").evaluateAll((inputs) => inputs.map((input) => input.value)), ["922,00", "922,00", "922,00", "411,00"]);
    await form.getByText("R$ 3.177,00").first().waitFor();
    await form.getByText("R$ 1.333,00").first().waitFor();
    await preview.getByText("valor ajustado (padrão: R$ 922,00)").waitFor();
    if (SHOTS) await form.screenshot({ path: `${SHOTS}/parcelas-valores-combinados-${label}.png` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `sem rolagem horizontal (${label})`);
    if (label === "desktop") {
      await form.getByRole("button", { name: "Cadastrar operação" }).click();
      await page.getByText(/Operação cadastrada|cadastrada/).first().waitFor();
      const [op] = await admin(`select installment_amounts, total_cents from loan_operation where client_id = 'c_e2e_pvc' and loan_date = '2026-11-21' and status = 'OPEN'`);
      assert.deepEqual([op.installment_amounts, Number(op.total_cents)], [AMOUNTS, 317700]);
    }
    await context.close();
  }
});

test("PV7. operações, pagamentos e renovações já existentes (tenant B e demais) não mudaram", async () => {
  assert.equal(await existingHash(), before);
});
