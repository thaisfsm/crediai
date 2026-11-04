// Modalidades explícitas de pagamento, de ponta a ponta (HTTP + banco + navegador). Substitui juros-renovacao.e2e.mjs
// (PR #136), que cobria só "Só os juros e renovar" com os rótulos e mensagens antigos; os casos dele continuam aqui.
//   * "Só os juros e renovar" (principal primeiro e juros primeiro): 100% juros, principal intacto, renova, modalidade gravada;
//   * sem duplicidade (mesmo período duas vezes, envios simultâneos); recusas sem gravar nada;
//   * contrato atrasado (principal primeiro): juros dos períodos seguintes continuam, composição na prévia;
//   * manual pela ordem do contrato, amortização, saldo total e liquidação antecipada; edição sem reclassificar;
//   * gatilho do banco trava modalidade/ordem; pagamentos anteriores à 0054 ficam sem modalidade;
//   * prévia na tela igual ao gravado; histórico e indicadores; o tenant B não mexe no A.
// Só em ambiente LOCAL e DESCARTÁVEL, com os dados fictícios ten_roberio (A) e ten_fernando (B).
//   E2E_DATABASE_URL=… PLAYWRIGHT_MODULE=/caminho/playwright/index.mjs node --test tests/e2e/modalidades-pagamento.e2e.mjs
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

let robério, fernando, opA, opB, opC, opD, othersBefore;
const createSingle = async (clientId, loanDate = day(-20), dueDate = day(10)) => {
  // R$ 5.000 a 2% ao mês: juros do período R$ 100 (o exemplo do pedido).
  const created = await action(robério, "createOperationAction", { clientId, modality: "SINGLE", frequency: "MONTHLY", principal: "5.000,00", rate: "2", loanDate, dueDate });
  assert.equal(created?.ok, true, JSON.stringify(created));
  return one(`select id from loan_operation where client_id = '${clientId}'`);
};
const pay = (operationId, fields) => action(robério, "registerPaymentAction", { operationId, paidAt: TODAY, ...fields });
const op = (id) => admin(`select status, due_date::text due, payment_order from loan_operation where id = '${id}'`).then((rows) => rows[0]);

test("preparação: contratos de R$ 5.000 a 2% — A, B e D novos (principal primeiro, D atrasado há 3 meses) e C antigo (juros primeiro)", async () => {
  // Os seeds já existentes não ganham modalidade com a migration 0054 (null = regra de antes).
  assert.equal(await one(`select count(*)::int from payment where payment_mode is not null or allocation_order is not null`), 0);
  await admin(`update wallet set initial_capital_cents = 4000000, created_at = now() - interval '200 days', cycle_started_at = now() - interval '200 days' where tenant_id = 'ten_roberio'`);
  await admin(`insert into client(id, tenant_id, name) values ('c_e2e_mp_a', 'ten_roberio', 'Modalidade A'), ('c_e2e_mp_b', 'ten_roberio', 'Modalidade B'), ('c_e2e_mp_c', 'ten_roberio', 'Modalidade C Antigo'), ('c_e2e_mp_d', 'ten_roberio', 'Modalidade D Atrasado')`);
  robério = await login("roberio@teste.local");
  fernando = await login("fernando@teste.local");
  opA = await createSingle("c_e2e_mp_a");
  opB = await createSingle("c_e2e_mp_b");
  opC = await createSingle("c_e2e_mp_c");
  opD = await createSingle("c_e2e_mp_d", day(-100), day(-70));
  // Contrato antigo simulado: o mesmo estado dos 37 contratos de juros primeiro em produção.
  await admin(`update loan_operation set payment_order = 'INTEREST_FIRST' where id = '${opC}'`);
  assert.equal(await one(`select count(*)::int from loan_operation where id in ('${opA}','${opB}','${opD}') and payment_order = 'PRINCIPAL_FIRST' and interest_cents = 10000`), 3);
  othersBefore = await otherTenants();
});

test("ME1. recusas sem gravar: valor diferente dos juros, sem período esperado, modalidade inválida, liquidação pelo pagamento, amortização acima do principal, saldo total errado, tenant B", async () => {
  const hash = await dataHash();
  const cases = [
    [{ amount: "90,00", paymentMode: "INTEREST_ONLY_RENEWAL", expectedPeriod: "1" }, /exatamente os juros pendentes/],
    [{ amount: "200,00", paymentMode: "INTEREST_ONLY_RENEWAL", expectedPeriod: "1" }, /exatamente os juros pendentes/],
    [{ amount: "100,00", paymentMode: "INTEREST_ONLY_RENEWAL" }, /Atualize a tela/],
    [{ amount: "100,00", paymentMode: "JUROS" }, /Modalidade de pagamento inválida/],
    [{ amount: "5.100,00", paymentMode: "EARLY_SETTLEMENT" }, /formulário próprio/],
    [{ amount: "5.000,01", paymentMode: "PRINCIPAL_AMORTIZATION" }, /principal em aberto/],
    [{ amount: "5.000,00", paymentMode: "FULL_SETTLEMENT" }, /saldo total nesta data é R\$\s?5\.100,00/],
    [{ amount: "100,00", paymentMode: "MANUAL", newDueDate: day(60) }, /Novo vencimento só vale/],
  ];
  for (const [fields, error] of cases) {
    const result = await pay(opA, fields);
    assert.equal(result?.ok, false, JSON.stringify(fields)); assert.match(result.error, error);
  }
  assert.equal((await action(fernando, "registerPaymentAction", { operationId: opA, amount: "100,00", paidAt: TODAY, paymentMode: "INTEREST_ONLY_RENEWAL", expectedPeriod: "1" }))?.ok, false, "outro tenant");
  assert.equal(await dataHash(), hash, "nada gravado");
});

test("ME2. principal primeiro: quatro 'Só os juros e renovar' de R$ 100 → 4 renovações, juros +400, principal intacto, modalidade gravada, capital +400 uma vez", async () => {
  const capitalBefore = await available();
  const due0 = (await op(opA)).due;
  for (let index = 0; index < 4; index += 1) {
    const result = await pay(opA, { amount: "100,00", paymentMode: "INTEREST_ONLY_RENEWAL", expectedPeriod: String(index + 1) });
    assert.equal(result?.ok, true, JSON.stringify(result));
    assert.match(result.message, /Juros \/ Renovação: R\$\s?100,00 recebidos como juros\. Principal mantido em R\$\s?5\.000,00/);
  }
  assert.equal(await one(`select count(*)::int from payment where operation_id = '${opA}' and payment_mode = 'INTEREST_ONLY_RENEWAL' and allocation_order = 'PRINCIPAL_FIRST'`), 4);
  assert.deepEqual((await admin(`select period_number, principal_base_cents::int b, interest_cents::int j from loan_renewal where operation_id = '${opA}' order by period_number`)).map((row) => [row.period_number, row.b, row.j]),
    [[2, 500000, 10000], [3, 500000, 10000], [4, 500000, 10000], [5, 500000, 10000]]);
  assert.ok((await op(opA)).due > due0, "vencimento renovado");
  assert.equal((await op(opA)).status, "OPEN");
  assert.equal(await available(), capitalBefore + 40000, "o recebido entra uma vez");
});

test("ME3. sem duplicidade: o mesmo período enviado de novo é recusado; dois envios simultâneos gravam uma renovação só", async () => {
  const again = await pay(opA, { amount: "100,00", paymentMode: "INTEREST_ONLY_RENEWAL", expectedPeriod: "4" });
  assert.equal(again?.ok, false); assert.match(again.error, /já foi renovado/);
  const results = await Promise.all([1, 2, 3].map(() => pay(opA, { amount: "100,00", paymentMode: "INTEREST_ONLY_RENEWAL", expectedPeriod: "5" })));
  assert.equal(results.filter((result) => result?.ok).length, 1, JSON.stringify(results));
  assert.equal(await one(`select count(*)::int from loan_renewal where operation_id = '${opA}'`), 5);
  assert.equal(await one(`select count(*)::int from payment where operation_id = '${opA}'`), 5);
});

test("ME4. contrato antigo (juros primeiro): 'Só os juros' explícito renova; tela antiga sem modalidade continua renovando pelo valor; manual divide juros primeiro", async () => {
  const explicit = await pay(opC, { amount: "100,00", paymentMode: "INTEREST_ONLY_RENEWAL", expectedPeriod: "1" });
  assert.equal(explicit?.ok, true, JSON.stringify(explicit));
  const legacy = await pay(opC, { amount: "100,00" });
  assert.equal(legacy?.ok, true, JSON.stringify(legacy));
  assert.equal(await one(`select count(*)::int from loan_renewal where operation_id = '${opC}'`), 2);
  assert.equal(await one(`select count(*)::int from payment where operation_id = '${opC}' and payment_mode = 'INTEREST_ONLY_RENEWAL' and allocation_order = 'INTEREST_FIRST'`), 2);
  const manual = await pay(opC, { amount: "600,00", paymentMode: "MANUAL" });
  assert.equal(manual?.ok, true); assert.match(manual.message, /juros R\$\s?100,00, principal R\$\s?500,00/);
});

test("ME5. manual no principal primeiro abate o principal; amortização só principal; saldo total quita (contrato B)", async () => {
  const manual = await pay(opB, { amount: "100,00", paymentMode: "MANUAL" });
  assert.equal(manual?.ok, true); assert.match(manual.message, /juros R\$\s?0,00, principal R\$\s?100,00/);
  const amort = await pay(opB, { amount: "900,00", paymentMode: "PRINCIPAL_AMORTIZATION" });
  assert.equal(amort?.ok, true); assert.match(amort.message, /juros R\$\s?0,00, principal R\$\s?900,00/);
  assert.equal(await one(`select count(*)::int from loan_renewal where operation_id = '${opB}'`), 0);
  const full = await pay(opB, { amount: "4.100,00", paymentMode: "FULL_SETTLEMENT" });
  assert.equal(full?.ok, true, JSON.stringify(full)); assert.match(full.message, /quitada/);
  assert.equal((await op(opB)).status, "PAID");
  assert.deepEqual((await admin(`select payment_mode m from payment where operation_id = '${opB}' order by created_at`)).map((row) => row.m), ["MANUAL", "PRINCIPAL_AMORTIZATION", "FULL_SETTLEMENT"]);
});

test("ME6. edição sem reclassificar: valor do 'Só os juros' travado (data e observação podem), modalidade/ordem travadas no banco", async () => {
  const [first] = await admin(`select id, paid_at::text d from payment where operation_id = '${opA}' order by created_at limit 1`);
  const refused = await action(robério, "editPaymentAction", { paymentId: first.id, amount: "150,00", paidAt: first.d, notes: "" });
  assert.equal(refused?.ok, false); assert.match(refused.error, /não pode ser alterado/);
  const noted = await action(robério, "editPaymentAction", { paymentId: first.id, amount: "100,00", paidAt: first.d, notes: "conferido" });
  assert.equal(noted?.ok, true, JSON.stringify(noted));
  assert.equal(await one(`select payment_mode from payment where id = '${first.id}'`), "INTEREST_ONLY_RENEWAL");
  await assert.rejects(admin(`update payment set payment_mode = 'MANUAL' where id = '${first.id}'`), /não podem ser alteradas/);
  await assert.rejects(admin(`update payment set allocation_order = 'INTEREST_FIRST' where id = '${first.id}'`), /não podem ser alteradas/);
  await assert.rejects(admin(`update payment set payment_mode = 'JUROS' where id = '${first.id}'`), /payment_mode_valid|não podem/);
  assert.equal((await action(fernando, "editPaymentAction", { paymentId: first.id, amount: "100,00", paidAt: first.d, notes: "x" }))?.ok, false, "outro tenant");
});

const panelOf = async (page, client) => {
  await page.goto(`${BASE}/?tela=cobrancas`);
  await page.locator("main .table-panel table.data-table > tbody > tr", { hasText: client }).getByRole("button", { name: "Registrar pagamento" }).click();
  const panel = page.getByRole("dialog", { name: `Pagamentos de ${client}` });
  await panel.waitFor();
  return panel;
};
const summary = async (panel) => Object.fromEntries(await panel.locator(".payment-summary div").evaluateAll((items) => items.map((item) => [item.querySelector("dt")?.textContent?.trim(), item.querySelector("dd")?.textContent?.replace(/\s/g, " ").trim()])));
const previewOf = async (panel) => Object.fromEntries(await panel.locator(".payment-plan-preview div").evaluateAll((items) => items.map((item) => [item.querySelector("span")?.textContent?.trim(), item.querySelector("strong")?.textContent?.replace(/\s/g, " ").trim()])));

test("ME7. tela: prévia completa = gravado; atrasado mostra composição dos períodos; histórico 'Juros / Renovação'; botão desabilitado quando não pode", async () => {
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

    // Contrato A: 5 renovações gravadas, histórico e indicadores.
    let panel = await panelOf(page, "Modalidade A");
    const history = panel.locator(".payment-history li");
    if (tag === "desktop") {
      assert.equal(await history.count(), 5);
      for (const label of await history.locator(".status-chip").allInnerTexts()) assert.equal(label.trim(), "Juros / Renovação");
      for (const line of await history.locator("small:not(.payment-revision)").allInnerTexts()) assert.match(line, /^Juros R\$\s?100,00 · Principal R\$\s?0,00/);
      const numbers = await summary(panel);
      assert.equal(numbers["Juros recebidos"], "R$ 500,00");
      assert.equal(numbers["Principal recebido"], "R$ 0,00");
      assert.equal(numbers["Principal restante"], "R$ 5.000,00");
      assert.equal(numbers["Saldo"], "R$ 5.100,00");
    }
    if (SHOTS) await panel.screenshot({ path: `${SHOTS}/1-historico-juros-renovacao-${tag}.png` });

    // Prévia do "Só os juros e renovar" com todos os campos pedidos; o gravado bate com a prévia.
    await panel.getByRole("button", { name: /^Só os juros e renovar/ }).click();
    await panel.getByText(/^Juros \/ Renovação\./).waitFor();
    const preview = await previewOf(panel);
    assert.equal(preview["Para juros"], "R$ 100,00");
    assert.equal(preview["Para principal"], "R$ 0,00");
    assert.equal(preview["Principal antes"], "R$ 5.000,00");
    assert.equal(preview["Principal depois"], "R$ 5.000,00");
    assert.equal(preview["Juros pendentes depois"], "R$ 100,00");
    assert.equal(preview["Juros do próximo período"], "R$ 100,00");
    assert.equal(preview["Situação após"], "Renovação / Ativa");
    if (SHOTS) { await panel.locator(".payment-plan-preview").scrollIntoViewIfNeeded(); await page.screenshot({ path: `${SHOTS}/2-previa-so-juros-${tag}.png` }); }
    await panel.locator("form").getByRole("button", { name: "Registrar pagamento" }).click();
    await panel.getByText(/Juros \/ Renovação: R\$\s?100,00 recebidos como juros/).waitFor({ timeout: 15_000 });
    const due = (await op(opA)).due;
    assert.equal(preview["Próximo vencimento"], `${due.slice(8, 10)}/${due.slice(5, 7)}/${due.slice(0, 4)}`, "vencimento gravado = prévia");
    await page.waitForTimeout(800);
    await panel.getByRole("button", { name: "Fechar" }).click();

    // Contrato D (principal primeiro, atrasado): composição dos juros pendentes período a período.
    panel = await panelOf(page, "Modalidade D Atrasado");
    const pendingD = await panel.getByRole("button", { name: /^Só os juros e renovar/ }).innerText();
    await panel.getByRole("button", { name: /^Só os juros e renovar/ }).click();
    const composition = await panel.getByText(/Juros pendentes por período:/).locator("..").innerText();
    assert.match(composition, /1º \(venc\. .*\) R\$\s?100,00 · 2º/);
    const previewD = await previewOf(panel);
    assert.equal(previewD["Para principal"], "R$ 0,00");
    assert.equal(previewD["Principal depois"], "R$ 5.000,00");
    assert.equal(previewD["Juros pendentes depois"].replace(/\s/g, " "), "R$ 100,00");
    if (SHOTS) { await panel.locator(".payment-plan-preview").scrollIntoViewIfNeeded(); await page.screenshot({ path: `${SHOTS}/3-atrasado-composicao-${tag}.png` }); }
    if (tag === "celular") {
      const amount = pendingD.match(/R\$\s?([\d.,]+)/)[1];
      assert.equal(previewD["Para juros"].replace(/\s/g, " "), `R$ ${amount}`);
      await panel.locator("form").getByRole("button", { name: "Registrar pagamento" }).click();
      await panel.getByText(/recebidos como juros\. Principal mantido em R\$\s?5\.000,00/).waitFor({ timeout: 15_000 });
      assert.equal(await one(`select count(*)::int from payment where operation_id = '${opD}' and payment_mode = 'INTEREST_ONLY_RENEWAL'`), 1);
      await page.waitForTimeout(800);
    }
    await panel.getByRole("button", { name: "Fechar" }).click();

    // Contrato C (antigo) com os juros do período já pagos: "Só os juros e renovar" aparece desabilitado só quando não pode.
    panel = await panelOf(page, "Modalidade C Antigo");
    const renewButton = panel.getByRole("button", { name: /^Só os juros e renovar/ });
    assert.equal(await renewButton.isDisabled(), (await summary(panel))["Juros restantes"] === "R$ 0,00");
    await panel.getByRole("button", { name: "Pagamento manual" }).click();
    await panel.getByLabel("Valor recebido (R$)").fill("250,00");
    const manualPreview = await previewOf(panel);
    assert.ok(manualPreview["Para juros"] && manualPreview["Para principal"]);
    if (SHOTS) { await panel.locator(".payment-plan-preview").scrollIntoViewIfNeeded(); await page.screenshot({ path: `${SHOTS}/4-manual-juros-primeiro-${tag}.png` }); }
    await panel.getByRole("button", { name: "Fechar" }).click();
    await context.close();
  }
  assert.equal(await one(`select count(*)::int from loan_renewal where operation_id = '${opD}'`), 1);
});

test("ME8. liquidação antecipada grava a modalidade; o tenant B não mudou", async () => {
  const settled = await action(robério, "settleOperationEarlyAction", { operationId: opA, amount: "5.050,00", confirm: "yes" });
  assert.equal(settled?.ok, true, JSON.stringify(settled));
  assert.equal(await one(`select payment_mode from payment p join loan_operation o on o.settlement_payment_id = p.id where o.id = '${opA}'`), "EARLY_SETTLEMENT");
  assert.equal((await op(opA)).status, "PAID");
  assert.equal(await otherTenants(), othersBefore, "o tenant B não muda");
});

test("ME9. caso Tatiana com dados fictícios: 8 'Só os juros e renovar' de R$ 100 (05 a 12/2023) → juros R$ 800, principal recebido R$ 0, principal R$ 5.000, 8 renovações, vencimento 01/01/2024", async () => {
  await admin(`insert into client(id, tenant_id, name) values ('c_e2e_mp_t', 'ten_roberio', 'Modalidade T Caso Tatiana')`);
  const opT = await createSingle("c_e2e_mp_t", "2023-04-01", "2023-05-01");
  assert.equal((await op(opT)).payment_order, "PRINCIPAL_FIRST");
  const capitalBefore = await available();
  for (let index = 0; index < 8; index += 1) {
    const paidAt = `2023-${String(5 + index).padStart(2, "0")}-01`;
    const result = await action(robério, "registerPaymentAction", { operationId: opT, amount: "100,00", paidAt, paymentMode: "INTEREST_ONLY_RENEWAL", expectedPeriod: String(index + 1) });
    assert.equal(result?.ok, true, `${paidAt}: ${JSON.stringify(result)}`);
  }
  // Classificação gravada no banco: os 8 pagamentos são "Só os juros e renovar", com 8 renovações sobre o principal de R$ 5.000.
  assert.equal(await one(`select count(*)::int from payment where operation_id = '${opT}' and payment_mode = 'INTEREST_ONLY_RENEWAL' and amount_cents = 10000`), 8);
  assert.deepEqual((await admin(`select period_number p, new_due_date::text d, principal_base_cents::int b, interest_cents::int j from loan_renewal where operation_id = '${opT}' order by period_number`)).map((row) => [row.p, row.d, row.b, row.j]),
    [2, 3, 4, 5, 6, 7, 8, 9].map((period) => [period, `${period === 9 ? "2024-01" : `2023-${String(period + 4).padStart(2, "0")}`}-01`, 500000, 10000]));
  assert.equal((await op(opT)).due, "2024-01-01", "próximo vencimento");
  assert.equal(await available(), capitalBefore + 80000, "total recebido R$ 800, uma vez");
  // Na tela: juros R$ 800, principal recebido R$ 0, principal restante R$ 5.000, 8 × "Juros / Renovação".
  await spaced();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel("E-mail").fill("roberio@teste.local");
  await page.getByLabel("Senha").fill(process.env.E2E_PASSWORD ?? "Senha-Teste-Local-123");
  await page.getByRole("button", { name: /Entrar/ }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20_000 });
  const panel = await panelOf(page, "Modalidade T Caso Tatiana");
  const history = panel.locator(".payment-history li");
  assert.equal(await history.count(), 8);
  for (const label of await history.locator(".status-chip").allInnerTexts()) assert.equal(label.trim(), "Juros / Renovação");
  const numbers = await summary(panel);
  assert.equal(numbers["Juros recebidos"], "R$ 800,00");
  assert.equal(numbers["Principal recebido"], "R$ 0,00");
  assert.equal(numbers["Principal restante"], "R$ 5.000,00");
  if (SHOTS) await panel.screenshot({ path: `${SHOTS}/5-caso-tatiana-ficticio-desktop.png` });
  await context.close();
});
