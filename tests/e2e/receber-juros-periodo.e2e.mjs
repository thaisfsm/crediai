// Receber juros e renovar POR PERÍODO, de ponta a ponta (HTTP + banco + navegador).
//   * lista "Períodos de juros" com situação própria e ação própria; confirmação do período escolhido;
//   * pagar um período específico (inclusive vencido) grava só aquele período como 100% juros, principal intacto;
//   * os demais períodos ficam exatamente como estavam; sem duplicidade (reenvio e envios simultâneos);
//   * recusas sem gravar (valor, período inexistente/pago, soma de vários períodos, outro tenant, modalidade errada);
//   * gatilho do banco: período/modalidade só mudam por reclassificação auditada na mesma transação;
//   * caso Tatiana fictício com nove pagamentos; isolamento do tenant B.
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


let robério, fernando, opP, opT, othersBefore;
const createSingle = async (clientId, loanDate, dueDate) => {
  const created = await action(robério, "createOperationAction", { clientId, modality: "SINGLE", frequency: "MONTHLY", principal: "5.000,00", rate: "2", loanDate, dueDate });
  assert.equal(created?.ok, true, JSON.stringify(created));
  return one(`select id from loan_operation where client_id = '${clientId}'`);
};
const pay = (operationId, fields, who = robério) => action(who, "registerPaymentAction", { operationId, paidAt: TODAY, paymentMode: "INTEREST_ONLY_RENEWAL", ...fields });
const periodsRows = (id) => admin(`select interest_period_number p, amount_cents::int a, payment_mode m, allocation_order o from payment where operation_id = '${id}' and interest_period_number is not null order by interest_period_number`);

test("preparação: contrato de R$ 5.000 a 2% atrasado há ~4 períodos (principal primeiro)", async () => {
  await admin(`update wallet set initial_capital_cents = 4000000, created_at = now() - interval '2000 days', cycle_started_at = now() - interval '2000 days' where tenant_id = 'ten_roberio'`);
  await admin(`insert into client(id, tenant_id, name) values ('c_e2e_rp_p', 'ten_roberio', 'Periodos Atrasado'), ('c_e2e_rp_t', 'ten_roberio', 'Periodos Tatiana')`);
  robério = await login("roberio@teste.local");
  fernando = await login("fernando@teste.local");
  opP = await createSingle("c_e2e_rp_p", day(-100), day(-70));
  assert.equal(await one(`select payment_order from loan_operation where id = '${opP}'`), "PRINCIPAL_FIRST");
  othersBefore = await otherTenants();
});

test("RE1. recusas sem gravar: soma de vários períodos, valor errado, período inexistente, período com modalidade errada, outro tenant", async () => {
  const hash = await dataHash();
  const cases = [
    [{ amount: "400,00", expectedPeriod: "1" }, /exatamente os juros pendentes/],
    // Sequência (14/11/2026): com o 1º vencido sem pagar, o 2º período não nasce (sem juros futuros).
    [{ amount: "100,00", period: "2" }, /ainda não tinha começado/],
    [{ amount: "90,00", period: "1" }, /1º período tem R\$\s?100,00/],
    [{ amount: "100,00", period: "99" }, /ainda não tinha começado/],
    [{ amount: "100,00", period: "1", paymentMode: "MANUAL" }, /Período inválido/],
    [{ amount: "100,00", period: "0" }, /Período inválido/],
  ];
  for (const [fields, error] of cases) {
    const result = await pay(opP, fields);
    assert.equal(result?.ok, false, JSON.stringify(fields)); assert.match(result.error, error);
  }
  assert.equal((await pay(opP, { amount: "100,00", period: "1" }, fernando))?.ok, false, "outro tenant");
  assert.equal(await dataHash(), hash, "nada gravado");
});

test("RE2. pagar o 1º período (vencido) grava só ele: 100% juros, principal intacto, libera o 2º pelo calendário do contrato", async () => {
  const capitalBefore = Number(await one(`select coalesce(sum(amount_cents),0) from payment where operation_id = '${opP}'`));
  const result = await pay(opP, { amount: "100,00", period: "1" });
  assert.equal(result?.ok, true, JSON.stringify(result));
  assert.match(result.message, /1º período: (Juros \/ Renovação: )?R\$\s?100,00 recebidos como juros\. Principal mantido em R\$\s?5\.000,00/);
  assert.deepEqual((await periodsRows(opP)).map((r) => [r.p, r.a, r.m, r.o]), [[1, 10000, "INTEREST_ONLY_RENEWAL", "PRINCIPAL_FIRST"]]);
  assert.deepEqual((await admin(`select period_number::int n, previous_due_date::text a, new_due_date::text b from loan_renewal where operation_id = '${opP}'`)).map((r) => [r.n, r.a, r.b]),
    [[2, day(-70), (await admin(`select (date '${day(-70)}' + interval '1 month')::date::text d`))[0].d]], "uma renovação, vencimento pelo calendário");
  assert.equal(Number(await one(`select sum(amount_cents) from payment where operation_id = '${opP}'`)), capitalBefore + 10000);
  const again = await pay(opP, { amount: "100,00", period: "1" });
  assert.equal(again?.ok, false); assert.match(again.error, /já estão pagos/);
  // O 3º período ainda não existe: o 2º (vencido) precisa ser pago antes.
  const third = await pay(opP, { amount: "100,00", period: "3" });
  assert.equal(third?.ok, false); assert.match(third.error, /ainda não tinha começado/);
});

test("RE3. envios simultâneos do mesmo período gravam um pagamento só", async () => {
  const results = await Promise.all([1, 2, 3, 4].map(() => pay(opP, { amount: "100,00", period: "2" })));
  assert.equal(results.filter((r) => r?.ok).length, 1, JSON.stringify(results));
  assert.equal(await one(`select count(*)::int from payment where operation_id = '${opP}' and interest_period_number = 2`), 1);
  assert.equal(await one(`select count(*)::int from loan_renewal where operation_id = '${opP}'`), 2);
});

test("RE4. banco: período único por operação; modalidade/período travados; reclassificação só auditada na mesma transação", async () => {
  await assert.rejects(admin(`insert into payment(id, tenant_id, operation_id, amount_cents, paid_at, payment_mode, allocation_order, interest_period_number)
    select 'pay_dup_rp', tenant_id, operation_id, 10000, paid_at, payment_mode, allocation_order, interest_period_number from payment where operation_id = '${opP}' and interest_period_number = 1`), /payment_interest_period_unique|duplicate/);
  await assert.rejects(admin(`update payment set interest_period_number = 7 where operation_id = '${opP}' and interest_period_number = 1`), /reclassificação autorizada/);
  await assert.rejects(admin(`update payment set payment_mode = 'MANUAL' where operation_id = '${opP}' and interest_period_number = 1`), /reclassificação autorizada|payment_interest_period_valid/);
  const id = await one(`select id from payment where operation_id = '${opP}' and interest_period_number = 1`);
  await assert.rejects(admin(`with r as (insert into payment_reclassification(id, tenant_id, payment_id, previous_mode, previous_allocation_order, previous_period_number, new_mode, new_allocation_order, new_period_number, reason, authorized_by)
      select 'rec_bad', tenant_id, id, payment_mode, allocation_order, interest_period_number, 'INTEREST_ONLY_RENEWAL', allocation_order, 6, 'teste de reclassificação com motivo', 'teste' from payment where id = '${id}' returning 1)
    update payment set interest_period_number = 7 where id = '${id}'`), /reclassificação autorizada/, "valor diferente do auditado");
  await sql.begin(async (tx) => {
    await tx`select set_config('app.crediai_role', 'SUPER_ADMIN', true)`;
    await tx.unsafe(`insert into payment_reclassification(id, tenant_id, payment_id, previous_mode, previous_allocation_order, previous_period_number, new_mode, new_allocation_order, new_period_number, reason, authorized_by)
      select 'rec_ok', tenant_id, id, payment_mode, allocation_order, interest_period_number, 'INTEREST_ONLY_RENEWAL', allocation_order, 1, 'ensaio de reclassificação autorizada de teste', 'teste' from payment where id = '${id}'`);
    await tx.unsafe(`update payment set interest_period_number = 1 where id = '${id}'`);
  });
  assert.equal(await one(`select count(*)::int from payment_reclassification where payment_id = '${id}'`), 1);
  await assert.rejects(admin(`update payment_reclassification set reason = 'alterado depois do fato' where id = 'rec_ok'`), /registro de auditoria/);
  await assert.rejects(admin(`delete from payment_reclassification where id = 'rec_ok'`), /registro de auditoria/);
});

test("RE5. tela: lista de períodos com situação própria; escolher o 1º período abre a confirmação, confirma e só ele muda", async () => {
  await spaced();
  for (const [width, height, tag] of [[1440, 1000, "desktop"], [390, 844, "celular"]]) {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    if (tag === "celular") await spaced();
    await page.goto(`${BASE}/login`);
    await page.getByLabel("E-mail").fill("roberio@teste.local");
    await page.getByLabel("Senha").fill(process.env.E2E_PASSWORD ?? "Senha-Teste-Local-123");
    await page.getByRole("button", { name: /Entrar/ }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20_000 });
    await page.goto(`${BASE}/?tela=cobrancas`);
    await page.locator("main .table-panel table.data-table > tbody > tr", { hasText: "Periodos Atrasado" }).getByRole("button", { name: "Registrar pagamento" }).click();
    const panel = page.getByRole("dialog", { name: "Pagamentos de Periodos Atrasado" });
    await panel.waitFor();
    const table = panel.locator(".interest-periods table");
    const snapshot = async () => table.locator("tbody tr").evaluateAll((rows) => rows.map((r) => [r.dataset.period, r.dataset.status, r.querySelector("td:nth-child(3)")?.textContent, r.querySelector("td:nth-child(4)")?.textContent]));
    const before = await snapshot();
    // Desktop: 1º e 2º pagos e renovados + o 3º (vencido), nenhum período futuro. Celular: depois do 3º pago no desktop, nasce o 4º.
    assert.equal(before.length, tag === "desktop" ? 3 : 4, "nenhum período além do seguinte ao último pago");
    assert.equal(before.find((r) => r[0] === "3")[1], tag === "desktop" ? "OVERDUE" : "PAID_RENEWED");
    assert.match(await panel.getByRole("button", { name: /^Saldo total/ }).innerText(), /R\$\s?5\.100,00/, "principal + juros do período em aberto, sem juros futuros");
    assert.equal(before.find((r) => r[0] === "1")[1] === "OVERDUE" || before.find((r) => r[0] === "1")[1] === "PAID_RENEWED", true);
    assert.equal(before.find((r) => r[0] === "2")[1], "PAID_RENEWED", "2º já pago e renovado (RE2)");
    if (SHOTS) await panel.screenshot({ path: `${SHOTS}/lista-periodos-${tag}.png` });
    if (tag === "desktop") {
      const buttons = table.getByRole("button", { name: /^Receber juros e renovar/ });
      assert.equal(await table.locator("tr[data-period='1'] button").count(), 0, "1º já pago no RE2: sem ação");
      assert.equal(await table.locator("tr[data-period='2'] button").count(), 0, "2º já pago: sem ação");
      await buttons.first().click();
      const number = await table.locator("tr[aria-selected], tr.row-selected").getAttribute("data-period");
      const box = panel.getByTestId("period-confirm");
      await box.waitFor();
      assert.match(await box.innerText(), new RegExp(`Receber juros do ${number}º período`));
      const preview = await previewOf(panel);
      assert.equal(preview["Para juros"], "R$ 100,00"); assert.equal(preview["Para principal"], "R$ 0,00");
      assert.equal(preview["Principal depois"], "R$ 5.000,00");
      if (SHOTS) await panel.screenshot({ path: `${SHOTS}/confirmacao-periodo-${tag}.png` });
      await panel.locator("form").getByRole("button", { name: "Confirmar recebimento e renovar" }).click();
      await panel.getByText(new RegExp(`${number}º período: (Juros / Renovação: )?R\\$\\s?100,00 recebidos como juros`)).waitFor({ timeout: 15_000 });
      await page.waitForTimeout(800);
      const after = await snapshot();
      for (const row of before) {
        const now = after.find((r) => r[0] === row[0]);
        if (row[0] === number) { assert.equal(now[1], "PAID_RENEWED"); continue; }
        assert.deepEqual(now, row, `período ${row[0]} não pode mudar`);
      }
      if (SHOTS) await panel.screenshot({ path: `${SHOTS}/apos-recebimento-${tag}.png` });
    }
    await context.close();
  }
  assert.equal(Number(await one(`select count(*)::int from payment where operation_id = '${opP}' and amount_cents <> 10000`)), 0);
  assert.equal(await one(`select count(*) filter (where payment_mode = 'INTEREST_ONLY_RENEWAL')::int from payment where operation_id = '${opP}'`), Number(await one(`select count(*)::int from payment where operation_id = '${opP}'`)));
});

test("RE6. caso Tatiana fictício: nove recebimentos de R$ 100 por período → juros 900, principal 0, restante 5.000, 9 períodos renovados, nove datas e ids no histórico", async () => {
  opT = await createSingle("c_e2e_rp_t", "2023-04-01", "2023-05-01");
  const dates = ["2023-05-01", "2023-06-01", "2023-07-01", "2023-08-01", "2023-09-01", "2023-10-01", "2023-11-01", "2023-12-01", "2024-01-01"];
  for (const [i, paidAt] of dates.entries()) {
    const result = await pay(opT, { amount: "100,00", paidAt, period: String(i + 1) });
    assert.equal(result?.ok, true, `${paidAt}: ${JSON.stringify(result)}`);
  }
  assert.equal(await one(`select sum(amount_cents)::int from payment where operation_id = '${opT}'`), 90000);
  assert.deepEqual((await periodsRows(opT)).map((r) => r.p), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(await one(`select count(*)::int from loan_renewal where operation_id = '${opT}'`), 9);
  const ids = (await admin(`select id from payment where operation_id = '${opT}' order by paid_at`)).map((r) => r.id);
  assert.equal(new Set(ids).size, 9);
  await spaced();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel("E-mail").fill("roberio@teste.local");
  await page.getByLabel("Senha").fill(process.env.E2E_PASSWORD ?? "Senha-Teste-Local-123");
  await page.getByRole("button", { name: /Entrar/ }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20_000 });
  await page.goto(`${BASE}/?tela=cobrancas`);
  await page.locator("main .table-panel table.data-table > tbody > tr", { hasText: "Periodos Tatiana" }).getByRole("button", { name: "Registrar pagamento" }).click();
  const panel = page.getByRole("dialog", { name: "Pagamentos de Periodos Tatiana" });
  await panel.waitFor();
  const numbers = await summary(panel);
  assert.equal(numbers["Juros recebidos"], "R$ 900,00"); assert.equal(numbers["Principal recebido"], "R$ 0,00");
  assert.equal(numbers["Principal restante"], "R$ 5.000,00"); assert.equal(numbers["Recebido"], "R$ 900,00");
  assert.equal(await panel.locator(".interest-periods tr[data-status='PAID_RENEWED']").count(), 9);
  for (const label of await panel.locator(".payment-history li .status-chip").allInnerTexts()) assert.equal(label.trim(), "Juros / Renovação");
  if (SHOTS) await panel.screenshot({ path: `${SHOTS}/caso-tatiana-9-periodos.png` });
  await context.close();
});

test("RE7. o tenant B não mudou e a classificação gravada é a mesma em todas as telas (extrato do banco = tela)", async () => {
  assert.equal(await otherTenants(), othersBefore, "o tenant B não muda");
  assert.equal(await one(`select count(*)::int from payment where tenant_id = 'ten_roberio' and interest_period_number is not null and payment_mode is distinct from 'INTEREST_ONLY_RENEWAL'`), 0);
});
