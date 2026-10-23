// Ordem das Cobranças no navegador (Playwright/Chromium), de ponta a ponta: servidor + banco + tela.
// SÓ em ambiente LOCAL e DESCARTÁVEL (ver tests/e2e/README.md): cria operações fictícias no tenant de teste A e registra
// pagamentos fictícios nelas. Nunca rodar em produção.
//   E2E_DATABASE_URL=… PLAYWRIGHT_MODULE=/caminho/playwright/index.mjs node --test tests/e2e/cobrancas.e2e.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Teste destrutivo: só roda em localhost.");
const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl || !/@(localhost|127\.0\.0\.1)[:/]/.test(databaseUrl)) throw new Error("E2E_DATABASE_URL precisa apontar para um banco local.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
const admin = async (query) => sql.begin(async (tx) => { await tx`select set_config('app.crediai_role', 'SUPER_ADMIN', true)`; return tx.unsafe(query); });
const one = async (query) => Object.values((await admin(query))[0] ?? {})[0];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
after(async () => { await browser.close(); await sql.end(); });

// "Hoje" do app (fuso de São Paulo) e datas relativas a ele.
const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const day = (offset) => { const date = new Date(`${TODAY}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + offset); return date.toISOString().slice(0, 10); };

// Dados financeiros de cada tenant (para provar que olhar a tela não muda nada e que o tenant B fica intacto).
const tenantHash = (tenant) => one(`select md5(string_agg(x, '|' order by x)) from (
  select 'c'||row(c.*)::text x from client c where tenant_id = '${tenant}' union all select 'o'||row(o.*)::text from loan_operation o where tenant_id = '${tenant}'
  union all select 'p'||row(p.*)::text from payment p where tenant_id = '${tenant}' union all select 'w'||row(w.*)::text from wallet w where tenant_id = '${tenant}'
  union all select 'm'||row(m.*)::text from capital_movement m where tenant_id = '${tenant}' union all select 'r'||row(r.*)::text from loan_renewal r where tenant_id = '${tenant}') t`);

let lastLogin = 0;
async function signIn(email) {
  const wait = 11_000 - (Date.now() - lastLogin);
  if (wait > 0) await sleep(wait);
  lastLogin = Date.now();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(process.env.E2E_PASSWORD ?? "Senha-Teste-Local-123");
  await page.getByRole("button", { name: /Entrar/ }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20_000 });
  return page;
}
const TABS = ["Em aberto", "Em atraso", "Hoje", "Amanhã", "Próximas"];
const charges = (page) => page.locator("main .table-panel");
// Clientes da tabela, na ordem exibida, e o rótulo de cada aba com o contador.
const rows = async (page) => charges(page).locator("table.data-table > tbody > tr > td:nth-child(1) > strong").allInnerTexts();
async function openTab(page, name) {
  await charges(page).getByRole("tab", { name: new RegExp(`^${name} \\(`) }).click();
  await page.waitForTimeout(150);
  return rows(page);
}
// Coluna Vencimento (dd/mm/aaaa do próximo vencimento em aberto), como ISO, para conferir a ordem crescente.
const dueColumn = async (page) => (await charges(page).locator("table.data-table > tbody > tr > td:nth-child(7)").allInnerTexts())
  .map((text) => { const [, d, m, y] = text.match(/(\d{2})\/(\d{2})\/(\d{4})/); return `${y}-${m}-${d}`; });
const assertAscending = (dates, label) => dates.forEach((date, index) => index && assert.ok(dates[index - 1] <= date, `${label}: ${dates[index - 1]} antes de ${date}`));
const counts = async (page) => Object.fromEntries((await charges(page).getByRole("tab").allInnerTexts()).map((label) => { const [, name, count] = label.match(/^(.+) \((\d+)\)$/); return [name, Number(count)]; }));
async function readAll(page) {
  const result = { counts: await counts(page) };
  for (const name of TABS) result[name] = await openTab(page, name);
  await openTab(page, "Em aberto");
  return result;
}
const openCharges = async (page) => { await page.goto(`${BASE}/?tela=cobrancas`); await charges(page).getByRole("tab").first().waitFor(); };

// Tenant A (Robério): carteira fictícia com todas as situações, criada com datas relativas a hoje.
const OPS = [
  // id, cliente, vencimento/1ª parcela, modalidade
  ["op_e2e_far", "Fábio Longe", day(40), "SINGLE"],
  ["op_e2e_next", "Nina Próxima", day(5), "SINGLE"],
  ["op_e2e_tom", "Tiago Amanhã", day(1), "SINGLE"],
  ["op_e2e_today_b", "Bruno Hoje", TODAY, "SINGLE"],
  ["op_e2e_today_a", "Ana Hoje", TODAY, "SINGLE"],
  ["op_e2e_late", "Bia Atrasada", day(-3), "SINGLE"],
  ["op_e2e_partial", "Paula Parcial", day(-10), "INSTALLMENT"],
  ["op_e2e_inst", "Igor Parcelado", day(-30), "INSTALLMENT"],
  ["op_e2e_old", "Zélia Antiga", day(-40), "SINGLE"],
  ["op_e2e_paid", "Quitério Quitado", day(-5), "PAID"],
];
const EXPECTED = ["Zélia Antiga", "Igor Parcelado", "Paula Parcial", "Bia Atrasada", "Ana Hoje", "Bruno Hoje", "Tiago Amanhã", "Nina Próxima", "Fábio Longe"];

let robério, fernando, fernandoBefore, thaisBefore;
test("preparação: operações fictícias do tenant A em todas as situações", async () => {
  fernandoBefore = await tenantHash("ten_fernando");
  thaisBefore = await tenantHash("ten_thais");
  const clients = OPS.map(([id, name]) => `('c_${id}', 'ten_roberio', '${name}')`).join(",");
  const ops = OPS.map(([id, , due, kind]) => kind === "INSTALLMENT"
    ? `('${id}','ten_roberio','c_${id}',270000,1111,30000,300000,'${day(-60)}','${due}','FIXED_MONTHLY_INSTALLMENTS_V1','OPEN',null,'INSTALLMENT',3,100000,'${due}')`
    : `('${id}','ten_roberio','c_${id}',100000,1000,10000,110000,'${day(-60)}','${due}','RATE_PER_OPERATION_SINGLE_PAYMENT_V1','${kind === "PAID" ? "PAID" : "OPEN"}',${kind === "PAID" ? `'${day(-5)}'` : "null"},'SINGLE',null,null,'${due}')`).join(",");
  await admin(`insert into client(id, tenant_id, name) values ${clients}`);
  await admin(`insert into loan_operation(id,tenant_id,client_id,principal_cents,interest_rate_bps,interest_cents,total_cents,loan_date,due_date,calculation_rule,status,settled_at,modality,installment_count,installment_cents,first_due_date) values ${ops}`);
  // Parcela de R$ 1.000 com R$ 400 pagos (parcial) e a operação quitada.
  await admin(`insert into payment(id,tenant_id,operation_id,amount_cents,paid_at) values ('pay_e2e_partial','ten_roberio','op_e2e_partial',40000,'${day(-9)}'), ('pay_e2e_paid','ten_roberio','op_e2e_paid',110000,'${day(-5)}')`);
  robério = await signIn("roberio@teste.local");
  fernando = await signIn("fernando@teste.local");
});

test("K1. Em aberto: vencidas (a mais antiga primeiro), depois hoje, depois as futuras; quitada fora", async () => {
  const before = await tenantHash("ten_roberio");
  await openCharges(robério);
  assert.deepEqual(await rows(robério), EXPECTED);
  // Parcelado usa a 1ª parcela pendente (não a futura) e a parcial continua na data original.
  assert.ok(!(await rows(robério)).includes("Quitério Quitado"));
  // Coluna "A cobrar no vencimento": parcela em aberto (parcial já descontado) ou total a quitar na data.
  const toCollect = Object.fromEntries(await charges(robério).locator("table.data-table > tbody > tr").evaluateAll((trs) => trs.map((tr) => [tr.querySelector("td:nth-child(1) > strong").textContent, tr.querySelector("td:nth-child(6)").innerText.replace(/\s+/g, " ").trim()])));
  assert.match(toCollect["Paula Parcial"], /R\$\s?600,00 saldo da parcela 1\/3/, "parcela de 1.000 com 400 pagos mostra o saldo de 600");
  assert.match(toCollect["Igor Parcelado"], /R\$\s?1\.000,00 parcela 1\/3/);
  assert.match(toCollect["Ana Hoje"], /R\$\s?1\.100,00 total a quitar/, "pagamento único mostra o total a quitar");
  // Abrir a tela e trocar de aba não grava nada.
  await readAll(robério);
  assert.equal(await tenantHash("ten_roberio"), before);
});

test("K2. cinco abas: filtros, ordem e contadores corretos, sem duplicata", async () => {
  await openCharges(robério);
  const all = await readAll(robério);
  assert.deepEqual(all["Em atraso"], ["Zélia Antiga", "Igor Parcelado", "Paula Parcial", "Bia Atrasada"]);
  assert.deepEqual(all.Hoje, ["Ana Hoje", "Bruno Hoje"]);
  assert.deepEqual(all.Amanhã, ["Tiago Amanhã"]);
  assert.deepEqual(all.Próximas, ["Tiago Amanhã", "Nina Próxima"]);
  assert.deepEqual(all["Em aberto"], EXPECTED);
  for (const name of TABS) {
    assert.equal(all.counts[name], all[name].length, `contador de ${name}`);
    assert.equal(new Set(all[name]).size, all[name].length, `${name} sem duplicata`);
  }
  for (const name of TABS) { await openTab(robério, name); assertAscending(await dueColumn(robério), name); }
  await openTab(robério, "Em aberto");
  // Recarregar não muda a ordem.
  await openCharges(robério);
  assert.deepEqual(await readAll(robério), all);
});


// Painel "Contas a receber" do Dashboard: cada card como texto (rótulo, valor, legenda).
const receivablesPanel = (page) => page.getByRole("region", { name: "Contas a receber" });
const kpi = async (page, label) => (await receivablesPanel(page).locator(".payables-kpi", { hasText: label }).innerText()).split("\n").map((part) => part.trim()).filter(Boolean);
const money = (text) => Number(text.replace(/[^\d,]/g, "").replace(",", "."));
async function openDashboard(page) { await page.goto(`${BASE}/`); await receivablesPanel(page).waitFor(); }

test("K2c. ficha do cliente: tabela de operações tem a mesma coluna A cobrar no vencimento das Operações e das Cobranças", async () => {
  await robério.goto(`${BASE}/?tela=clientes`);
  await robério.getByRole("searchbox", { name: /Buscar cliente/ }).fill("Paula Parcial");
  await robério.getByRole("table", { name: "Resultado da busca" }).getByRole("button", { name: "Abrir" }).click();
  const table = robério.locator('section[aria-label="Operações de Paula Parcial"]');
  await table.locator("tbody tr").first().waitFor();
  assert.ok((await table.locator("thead th").allTextContents()).includes("A cobrar no vencimento"), "coluna A cobrar no vencimento");
  const row = (await table.locator("tbody tr").first().innerText()).replace(/\s+/g, " ");
  assert.match(row, /R\$\s?600,00 saldo da parcela 1\/3/, "parcela de 1.000 com 400 pagos mostra o saldo de 600 também na ficha");
  if (process.env.E2E_SCREENSHOTS) { await table.scrollIntoViewIfNeeded(); await table.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/ficha-operacoes-a-cobrar.png` }); }
  await robério.getByRole("button", { name: /Voltar|Clientes/ }).first().click().catch(() => {});
});

test("K2b. Dashboard: Contas a receber mostra atraso, hoje, próximos 7 dias e total, iguais às Cobranças", async () => {
  const before = await tenantHash("ten_roberio");
  await openCharges(robério);
  const cobrancas = await readAll(robério);
  await openDashboard(robério);
  const late = await kpi(robério, "Em atraso");
  assert.equal(late[2].match(/^(\d+) operaç/)?.[1], String(cobrancas["Em atraso"].length), "mesma contagem de operações em atraso");
  assert.ok(money(late[1]) > 0, "valor em atraso");
  const total = await kpi(robério, "Total a receber");
  const card = await robério.getByRole("link", { name: /Total a receber, ver saldos em aberto/ }).innerText();
  assert.equal(money(total[1]), money(card.match(/R\$\s?[\d.]+,\d{2}/)[0]), "mesmo total do card Total a receber");
  // Quem vence hoje aparece na lista com o valor do saldo (R$ 1.100,00); as atrasadas com a mais antiga primeiro.
  const today = receivablesPanel(robério).getByRole("region", { name: "Vencem hoje (a receber)" });
  for (const name of ["Ana Hoje", "Bruno Hoje"]) assert.ok((await today.innerText()).includes(name), `${name} vence hoje`);
  assert.ok((await today.innerText()).includes("1.100,00"));
  const overdue = receivablesPanel(robério).getByRole("region", { name: "Em atraso" });
  const names = await overdue.locator(".payables-row .charge-person strong").allInnerTexts();
  assert.equal(names[0], "Zélia Antiga", "a mais antiga primeiro");
  assert.ok(!(await receivablesPanel(robério).innerText()).includes("Quitério Quitado"), "quitada fora");
  // O card leva à tela Cobranças já no filtro certo.
  await receivablesPanel(robério).locator(".payables-kpi", { hasText: "Em atraso" }).click();
  await charges(robério).getByRole("tab", { selected: true, name: /^Em atraso/ }).waitFor();
  assert.equal(await tenantHash("ten_roberio"), before, "só leitura");
});

async function pay(page, client, shortcut) {
  await charges(page).locator("table.data-table > tbody > tr", { hasText: client }).getByRole("button", { name: "Registrar pagamento" }).click();
  const panel = page.getByRole("dialog", { name: `Pagamentos de ${client}` });
  await panel.getByRole("button", { name: shortcut }).click();
  await panel.locator("form").getByRole("button", { name: "Registrar pagamento" }).click();
  // A quitada sai da lista (e o painel junto, com a linha); a renovada continua com o painel aberto.
  await Promise.race([panel.getByText(/registrado/).first().waitFor({ timeout: 15_000 }), panel.waitFor({ state: "detached", timeout: 15_000 })]);
  // Espera a atualização da lista: se a linha saiu, o painel some sozinho; senão, fecha.
  const gone = await panel.waitFor({ state: "detached", timeout: 3_000 }).then(() => true, () => false);
  if (!gone) await panel.getByRole("button", { name: "Fechar" }).click({ timeout: 5_000 }).catch(() => panel.waitFor({ state: "detached", timeout: 5_000 }));
  await panel.waitFor({ state: "detached", timeout: 5_000 });
}

test("K3. depois de registrar pagamentos a lista se reordena sozinha (quitada sai; renovada vai para o novo vencimento)", async () => {
  await openCharges(robério);
  // Quitação da mais antiga: sai das cobranças em aberto.
  await pay(robério, "Zélia Antiga", /^Saldo total/);
  await robério.waitForFunction(() => !document.querySelector("main .table-panel")?.textContent?.includes("Zélia Antiga"), null, { timeout: 15_000 });
  // Só os juros da atrasada: renova para o mês seguinte (motor) e passa para depois das próximas, antes da de 40 dias.
  await pay(robério, "Bia Atrasada", /^Só os juros e renovar/);
  const expected = ["Igor Parcelado", "Paula Parcial", "Ana Hoje", "Bruno Hoje", "Tiago Amanhã", "Nina Próxima", "Bia Atrasada", "Fábio Longe"];
  await robério.waitForFunction((first) => document.querySelector("main .table-panel tbody tr td:nth-child(1) > strong")?.textContent === first, expected[0], { timeout: 15_000 });
  assert.deepEqual(await rows(robério), expected);
  const all = await readAll(robério);
  assert.deepEqual(all["Em atraso"], ["Igor Parcelado", "Paula Parcial"]);
  assert.equal(all.counts["Em aberto"], 8);
  assert.equal(all.counts["Em atraso"], 2);
  const renewed = await one(`select new_due_date::text from loan_renewal where operation_id = 'op_e2e_late'`);
  assert.ok(renewed > day(5) && renewed < day(40), `renovada para ${renewed}`);
  assert.equal(await one(`select status from loan_operation where id = 'op_e2e_old'`), "PAID");
});

test("K3b. Dashboard atualiza depois das baixas: quitada e renovada saem do atraso e o recebido hoje soma os pagamentos", async () => {
  const received = Number(await one(`select coalesce(sum(amount_cents),0) from payment where tenant_id = 'ten_roberio' and paid_at = '${TODAY}'`));
  assert.ok(received > 0, "houve pagamentos hoje");
  await openDashboard(robério);
  const late = await kpi(robério, "Em atraso");
  assert.equal(late[2].match(/^(\d+) operaç/)?.[1], "2", "só Igor e Paula continuam em atraso");
  const text = await receivablesPanel(robério).innerText();
  assert.ok(!text.includes("Zélia Antiga") && !text.includes("Bia Atrasada"), "quitada e renovada saíram do atraso");
  const today = await kpi(robério, "Recebido hoje");
  assert.equal(money(today[1]), received / 100, "recebido hoje = soma dos pagamentos de hoje no banco");
});

test("K3c. Operações: filtro por cliente mostra só as operações do cliente (sem acento) e volta ao limpar", async () => {
  await robério.goto(`${BASE}/?tela=operacoes`);
  const list = robério.getByRole("region", { name: "Lista de operações" });
  const filter = list.getByRole("searchbox", { name: "Filtrar operações por cliente" });
  await filter.waitFor();
  const total = await list.locator("tbody tr").count();
  assert.ok(total > 1, "há várias operações");
  await filter.fill("nina proxima");
  await robério.waitForFunction(() => document.querySelectorAll('section[aria-label="Lista de operações"] tbody tr').length === 1);
  assert.match(await list.locator("tbody tr").first().innerText(), /Nina Próxima/);
  await filter.fill("cliente que nao existe");
  await list.getByText("Nenhuma operação encontrada para esse cliente.").first().waitFor();
  await list.getByRole("button", { name: "Limpar filtro" }).click();
  assert.equal(await list.locator("tbody tr").count(), total, "limpar volta a lista inteira");
  const SHOTS = process.env.E2E_SCREENSHOTS;
  if (SHOTS) { await filter.fill("bia"); await robério.waitForTimeout(300); await robério.screenshot({ path: `${SHOTS}/operacoes-filtro-cliente.png` }); }
});

test("K3d. Operações: Ativas é o padrão, Quitadas e Todos separam a lista e a busca respeita a aba", async () => {
  await robério.goto(`${BASE}/?tela=operacoes`);
  const list = robério.getByRole("region", { name: "Lista de operações" });
  const tab = (name) => list.getByRole("button", { name: new RegExp(`^${name}`) });
  await tab("Ativas").waitFor();
  assert.equal(await tab("Ativas").getAttribute("aria-pressed"), "true", "Ativas é o padrão");
  const open = await list.locator("tbody tr").count();
  const open2 = Number(await one(`select count(*) from loan_operation where tenant_id = 'ten_roberio' and status = 'OPEN'`));
  const paid = Number(await one(`select count(*) from loan_operation where tenant_id = 'ten_roberio' and status = 'PAID'`));
  const all = Number(await one(`select count(*) from loan_operation where tenant_id = 'ten_roberio'`));
  assert.equal(open, open2);
  assert.ok(paid > 0, "há quitada (Zélia Antiga)");
  assert.ok(!(await list.innerText()).includes("Zélia Antiga"), "quitada fora da aba padrão");
  const filter = list.getByRole("searchbox", { name: "Filtrar operações por cliente" });
  await filter.fill("zelia");
  await list.getByText("Nenhuma operação ativa encontrada para essa busca.").first().waitFor();
  await tab("Quitadas").click();
  await robério.waitForFunction(() => document.querySelectorAll('section[aria-label="Lista de operações"] tbody tr').length === 1);
  assert.match(await list.locator("tbody tr").first().innerText(), /Zélia Antiga/);
  await filter.fill("");
  await robério.waitForFunction((n) => document.querySelectorAll('section[aria-label="Lista de operações"] tbody tr').length === n, paid);
  await tab("Todos").click();
  await robério.waitForFunction((n) => document.querySelectorAll('section[aria-label="Lista de operações"] tbody tr').length === n, all);
  const SHOTS = process.env.E2E_SCREENSHOTS;
  if (SHOTS) { await tab("Ativas").click(); await robério.waitForTimeout(300); await list.screenshot({ path: `${SHOTS}/operacoes-abas-situacao.png` }); }
});

test("K4. isolamento: cada tenant vê só as próprias cobranças, na ordem certa; o tenant B fica intacto", async () => {
  await openCharges(fernando);
  const all = await readAll(fernando);
  const robérioNames = OPS.map(([, name]) => name);
  for (const name of TABS) for (const client of all[name]) assert.ok(!robérioNames.includes(client), `${client} não é do Fernando`);
  // Ordem do Fernando igual à próxima obrigação em aberto do servidor (Willian e Cinco Mil atrasados, Amany, Renovado…).
  const html = await fernando.content();
  for (const client of robérioNames) assert.ok(!html.includes(client), `${client} não aparece para o tenant B`);
  assert.ok(all["Em aberto"].length > 0);
  for (const name of TABS) { await openTab(fernando, name); assertAscending(await dueColumn(fernando), `${name} (Fernando)`); }
  for (const name of TABS) assert.equal(all.counts[name], all[name].length, `contador de ${name} (Fernando)`);
  await openDashboard(fernando);
  const panelText = await receivablesPanel(fernando).innerText();
  for (const client of robérioNames) assert.ok(!panelText.includes(client), `${client} não aparece em Contas a receber do tenant B`);
  await openCharges(robério);
  const mine = await rows(robério);
  for (const client of ["Alexandre Teste", "Willian Teste", "Amany Teste", "Cinco Mil Teste", "Renovado Teste"]) assert.ok(!mine.includes(client));
  assert.equal(await tenantHash("ten_fernando"), fernandoBefore);
  assert.equal(await tenantHash("ten_thais"), thaisBefore);
});
