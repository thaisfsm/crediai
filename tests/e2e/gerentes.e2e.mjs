// Gerente de contas (acesso só de leitura + comissão livre por cliente), de ponta a ponta: servidor + banco + telas.
// SÓ em ambiente LOCAL e DESCARTÁVEL (ver tests/e2e/README.md): cria clientes, operações e pagamentos fictícios no tenant de teste A.
//   E2E_DATABASE_URL=… PLAYWRIGHT_MODULE=… node --test tests/e2e/gerentes.e2e.mjs
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
const one = async (query) => { const value = Object.values((await admin(query))[0] ?? {})[0]; return typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value; };
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
const NEW_PASSWORD = "Gabrielle-Senha-Nova-2026";
const EMAIL = "gabrielle.gerente@teste.local";
const tenantHash = (tenant) => one(`select md5(string_agg(x, '|' order by x)) from (
  select 'c'||row(c.*)::text x from client c where tenant_id = '${tenant}' and id not like 'c\\_g\\_%' union all select 'o'||row(o.*)::text from loan_operation o where tenant_id = '${tenant}'
  union all select 'p'||row(p.*)::text from payment p where tenant_id = '${tenant}' union all select 'w'||row(w.*)::text from wallet w where tenant_id = '${tenant}'
  union all select 'm'||row(m.*)::text from capital_movement m where tenant_id = '${tenant}') t`);

let lastLogin = 0;
async function throttle() { const wait = 11_000 - (Date.now() - lastLogin); if (wait > 0) await sleep(wait); lastLogin = Date.now(); }
async function signIn(email, password = PASSWORD, viewport = { width: 1440, height: 900 }) {
  await throttle();
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(password);
  await page.getByRole("button", { name: /Entrar/ }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20_000 });
  return page;
}
async function apiLogin(email, password = PASSWORD) {
  await throttle();
  const response = await fetch(`${BASE}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email, password }) });
  assert.equal(response.status, 200, `login de ${email}`);
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}
async function action(cookie, name, fields, path = "/gerentes") {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(`_1_${key}`, value);
  form.append("0", '["$K1"]');
  const response = await fetch(`${BASE}${path}`, { method: "POST", redirect: "manual", headers: { cookie, "next-action": actionId(name), accept: "text/x-component", origin: BASE }, body: form });
  const result = (await response.text()).match(/^1:(\{.*\})$/m)?.[1];
  return { status: response.status, result: result ? JSON.parse(result) : null, location: response.headers.get("location") };
}
const get = (cookie, path) => fetch(`${BASE}${path}`, { redirect: "manual", headers: { cookie } });
const poll = async (query, expected) => { for (let i = 0; i < 60; i++) { if (String(await one(query)) === String(expected)) return; await sleep(250); } assert.equal(String(await one(query)), String(expected)); };

let owner, manager, ownerBefore, fernandoBefore, tempPassword, managerCookie;

test("preparação: clientes e operações fictícias do tenant A (indicados e um cliente sem gerente)", async () => {
  fernandoBefore = await tenantHash("ten_fernando");
  await admin(`insert into client(id, tenant_id, name, document, phone) values
    ('c_g_ana','ten_roberio','Ana Indicada','11144477735','11999990001'), ('c_g_beto','ten_roberio','Beto Indicado','52998224725','11999990002'),
    ('c_g_carla','ten_roberio','Carla Indicada','39053344705','11999990003'), ('c_g_dora','ten_roberio','Dora Sem Gerente','12345678909','11999990004')`);
  const single = (id, client, status, loan, due, settled) => `('${id}','ten_roberio','${client}',100000,1000,10000,110000,'${loan}','${due}','RATE_PER_OPERATION_SINGLE_PAYMENT_V1','${status}',${settled ? `'${settled}'` : "null"},'SINGLE',null,null,'${due}')`;
  await admin(`insert into loan_operation(id,tenant_id,client_id,principal_cents,interest_rate_bps,interest_cents,total_cents,loan_date,due_date,calculation_rule,status,settled_at,modality,installment_count,installment_cents,first_due_date) values
    ${[single("op_g_ana_paid", "c_g_ana", "PAID", day(-50), day(-20), day(-20)), single("op_g_ana_open", "c_g_ana", "OPEN", day(-10), day(20)), single("op_g_beto_open", "c_g_beto", "OPEN", day(-40), day(-5)),
      single("op_g_carla_paid", "c_g_carla", "PAID", day(-45), day(-15), day(-15)), single("op_g_dora_open", "c_g_dora", "OPEN", day(-5), day(25))].join(",")}`);
  await admin(`insert into payment(id,tenant_id,operation_id,amount_cents,paid_at) values ('pay_g_ana','ten_roberio','op_g_ana_paid',110000,'${day(-20)}'), ('pay_g_carla','ten_roberio','op_g_carla_paid',110000,'${day(-15)}')`);
  ownerBefore = await tenantHash("ten_roberio");
  owner = await signIn("roberio@teste.local");
});

test("G1. dono cadastra o gerente, vincula clientes (comissão livre por cliente), paga comissão e cria o acesso", async () => {
  await owner.goto(`${BASE}/gerentes`);
  await owner.getByLabel("Nome", { exact: true }).first().fill("Gabrielle Teste");
  assert.equal(await owner.getByLabel("Comissão padrão (%)").count(), 0, "o cadastro do gerente não pede percentual: ele é digitado por cliente");
  await owner.getByRole("button", { name: "Cadastrar gerente" }).click();
  await poll(`select count(*) from account_manager where tenant_id='ten_roberio' and name='Gabrielle Teste' and commission_bps=0`, 1);
  const managerId = await one(`select id from account_manager where tenant_id='ten_roberio' and name='Gabrielle Teste'`);
  const region = owner.getByRole("region", { name: "Gerente Gabrielle Teste" });
  await region.waitFor();
  const link = async (label, commission) => {
    await region.getByLabel("Cliente indicado").selectOption({ label });
    if (commission) await region.getByLabel("Comissão deste cliente (%)").fill(commission);
    await region.getByRole("button", { name: "Vincular cliente" }).click();
    await poll(`select count(*) from client where tenant_id='ten_roberio' and name='${label}' and account_manager_id='${managerId}'`, 1);
    await owner.waitForTimeout(400);
  };
  // O percentual é obrigatório no vínculo: sem ele o servidor recusa e nada é gravado.
  const noPercent = await action(await apiLogin("roberio@teste.local"), "linkClientAction", { managerId, clientId: "c_g_ana", commission: "" });
  assert.equal(noPercent.result?.ok, false);
  assert.equal(await one(`select account_manager_id from client where id='c_g_ana'`), null);
  await link("Ana Indicada", "10");
  await link("Beto Indicado", "7,5");
  await link("Carla Indicada", "20");
  assert.equal(await one(`select account_manager_bps from client where id='c_g_carla'`), 2000, "Carla com 20% próprios");
  assert.equal(await one(`select account_manager_bps from client where id='c_g_ana'`), 1000);
  assert.equal(await one(`select account_manager_bps from client where id='c_g_beto'`), 750);
  assert.equal(await one(`select account_manager_id from client where id='c_g_dora'`), null, "Dora continua sem gerente");
  // Pagamento de comissão de R$ 10,00 registrado pelo dono.
  await region.getByRole("button", { name: "Pagar comissão" }).click();
  await region.getByLabel("Valor pago (R$)").fill("10,00");
  await region.getByRole("button", { name: "Registrar pagamento da comissão" }).click();
  await poll(`select coalesce(sum(amount_cents),0) from account_manager_payout where tenant_id='ten_roberio'`, 1000);
  // Acesso de leitura com senha provisória mostrada uma vez.
  await owner.reload();
  const region2 = owner.getByRole("region", { name: "Gerente Gabrielle Teste" });
  await region2.getByLabel("E-mail de acesso do gerente").fill(EMAIL);
  await region2.getByRole("button", { name: "Criar acesso de leitura" }).click();
  const note = region2.locator(".capital-note", { hasText: "Senha provisória" });
  await note.waitFor();
  tempPassword = (await note.locator("b").nth(1).innerText()).trim();
  assert.match(tempPassword, /^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/);
  assert.equal(await one(`select role::text from "user" where email='${EMAIL}'`), "ACCOUNT_MANAGER");
  assert.equal(await one(`select tenant_id from "user" where email='${EMAIL}'`), "ten_roberio");
  assert.equal(await one(`select must_change_password from "user" where email='${EMAIL}'`), true);
  assert.equal(await one(`select count(*) from account_manager where user_id = (select id from "user" where email='${EMAIL}')`), 1);
  // O hash nunca vai para a auditoria e a senha provisória não aparece nos registros.
  assert.equal(await one(`select count(*) from admin_audit_log where action like 'MANAGER_%' and tenant_id='ten_roberio'`) >= 6, true);
  assert.equal(await one(`select count(*) from admin_audit_log where after::text like '%${tempPassword}%' or description like '%${tempPassword}%'`), 0);
  if (SHOTS) { await owner.reload(); await owner.getByRole("region", { name: "Gerente Gabrielle Teste" }).screenshot({ path: `${SHOTS}/gerentes-tela-do-dono.png` }); }
});

test("G2. senha provisória: o gerente só passa pela troca de senha e depois entra no painel", async () => {
  const cookie = await apiLogin(EMAIL, tempPassword);
  const redirected = await get(cookie, "/gerente");
  assert.match(redirected.headers.get("location") ?? "", /\/definir-senha/, "com senha provisória, só a troca de senha");
  const changed = await action(cookie, "changeTemporaryPasswordAction", { currentPassword: tempPassword, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD }, "/definir-senha");
  assert.equal(changed.result?.ok ?? changed.result?.json?.ok, true);
  assert.equal(await one(`select must_change_password from "user" where email='${EMAIL}'`), false);
  manager = await signIn(EMAIL, NEW_PASSWORD);
  await manager.waitForURL((url) => url.pathname === "/gerente", { timeout: 15_000 });
});

test("G3. painel: mesmas telas do dono, só os clientes dele, números certos, sem edição, sem banco, com as duas cores", async () => {
  // Dados bancários e observação do cliente existem no cadastro do dono, mas não podem chegar à gerente.
  await admin(`update client set bank_name='Banco Secreto', pix_key_type='EMAIL', pix_key='chave-pix-secreta@teste.local', notes='observação interna do dono', online_casino_bettor=true where id='c_g_ana'`);
  await manager.goto(`${BASE}/gerente`);
  await manager.locator(".metric-featured .metric-value").waitFor();
  const flat = async () => (await manager.locator("body").innerText()).replace(/\s+/g, " ");
  // Ganho: Ana 10% de R$ 100,00 + Carla 20% de R$ 100,00 = R$ 30,00; paga R$ 10,00; a receber R$ 20,00; prevista (Ana 10% + Beto 7,5%) R$ 17,50.
  assert.match((await manager.locator(".metric-featured .metric-value").innerText()).replace(/\s/g, ""), /R\$20,00/);
  let text = await flat();
  assert.match(text, /Já recebida R\$ 10,00/);
  assert.match(text, /Clientes indicados/);
  assert.ok(!/Capital disponível|Contas a pagar|Investidores|Financeiro|Configurações|Nova operação/.test(text), "nada do caixa nem de cadastros do dono");
  // Menu: só as telas dela.
  const menu = (await manager.locator(".side-nav").innerText()).replace(/\s+/g, " ");
  for (const item of ["Visão geral", "Clientes", "Operações", "Pagamentos", "Cobranças", "Comissão"]) assert.ok(menu.includes(item), `menu tem ${item}`);
  for (const item of ["Capital", "Financeiro", "Contas a pagar", "Investidores", "Gerentes", "Relatórios", "Renegociação"]) assert.ok(!menu.includes(item), `menu não tem ${item}`);
  if (SHOTS) await manager.screenshot({ path: `${SHOTS}/gerente-visao-geral-padrao.png`, fullPage: true });
  // Clientes: só os dela, sem cadastro nem edição.
  await manager.locator(".side-nav").getByText("Clientes", { exact: true }).click();
  await manager.getByRole("region", { name: "Lista de clientes" }).waitFor();
  text = await flat();
  for (const name of ["Ana Indicada", "Beto Indicado", "Carla Indicada"]) assert.ok(text.includes(name), `${name} aparece`);
  assert.ok(!text.includes("Dora Sem Gerente"), "cliente sem gerente (ou de outro gerente) não aparece");
  assert.equal(await manager.getByRole("button", { name: /Editar|Excluir|Cadastrar cliente/ }).count(), 0, "sem botões de edição");
  assert.equal(await manager.getByRole("region", { name: "Novo cliente" }).count(), 0);
  await manager.getByPlaceholder("Buscar por nome ou CPF").fill("carla");
  assert.equal(await manager.locator("tbody tr").count(), 1);
  await manager.getByPlaceholder("Buscar por nome ou CPF").fill("");
  // Ficha do cliente: contato visível (como o dono vê), mas nada de banco, observações nem documentos.
  await manager.getByRole("button", { name: "Ver" }).first().click();
  await manager.getByText("Resumo do cliente").waitFor();
  const detail = await flat();
  assert.ok(detail.includes("CPF"), "cadastro com CPF, como o dono vê");
  assert.ok(!/Banco Secreto|chave-pix-secreta|observação interna|Apostadora|Dados bancários/.test(detail), "sem dados bancários, observações nem sinalização interna");
  assert.equal(await manager.getByText("Documentos", { exact: false }).count() > 0 && (await manager.getByRole("button", { name: /Enviar|Anexar|Excluir/ }).count()) > 0, false, "sem envio de documentos");
  const html = await manager.content();
  for (const secret of ["12345678909", "Dora", "Banco Secreto", "chave-pix-secreta"]) assert.ok(!html.includes(secret), `${secret} não está na página`);
  // Operações: só leitura, com detalhes do histórico (sem registrar pagamento nem editar).
  await manager.locator(".side-nav").getByText("Operações", { exact: true }).click();
  await manager.getByRole("region", { name: "Lista de operações" }).waitFor();
  assert.equal(await manager.getByRole("region", { name: /Nova operação/ }).count(), 0);
  assert.equal(await manager.getByRole("button", { name: /Registrar pagamento|Editar|Excluir/ }).count(), 0, "sem botões de gravação");
  await manager.getByRole("button", { name: "Detalhes" }).first().click();
  await manager.getByRole("button", { name: /Registrar pagamento|Quitar|Renegociar/ }).count().then((count) => assert.equal(count, 0, "detalhe sem ações de gravação"));
  await manager.keyboard.press("Escape");
  await manager.goto(`${BASE}/gerente?tela=comissao`);
  text = await flat();
  assert.match(text, /A receber agora R\$ 20,00/);
  assert.match(text, /Prevista \(juros ainda a pagar\) R\$ 17,50/);
  assert.match(text, /Comissão gerada até hoje R\$ 30,00/);
  // Telas do dono por endereço direto não abrem para ela.
  await manager.goto(`${BASE}/gerente?tela=capital`);
  assert.ok(!/Capital disponível/.test(await flat()), "?tela=capital não mostra o capital");
  // Cores: padrão e roxo, guardada num cookie (nada no banco).
  const before = await tenantHash("ten_roberio");
  assert.equal(await manager.locator(".app-shell").getAttribute("data-theme"), "padrao");
  await manager.getByRole("button", { name: "Roxo" }).first().click();
  await manager.waitForFunction(() => document.querySelector(".app-shell")?.getAttribute("data-theme") === "roxo");
  await sleep(700);
  if (SHOTS) { await manager.goto(`${BASE}/gerente`); await manager.locator(".metric-featured").waitFor(); await manager.screenshot({ path: `${SHOTS}/gerente-visao-geral-roxo.png`, fullPage: true }); }
  await manager.reload();
  assert.equal(await manager.locator(".app-shell").getAttribute("data-theme"), "roxo", "a escolha da cor continua depois de recarregar");
  assert.equal(await tenantHash("ten_roberio"), before, "escolher a cor não grava nada nos dados");
});

test("G3b. sem clientes ainda: tela de boas-vindas bonita no lugar dos zeros", async () => {
  const linked = await admin(`select id, account_manager_id, account_manager_bps from client where account_manager_id is not null`);
  await admin(`update client set account_manager_id = null, account_manager_bps = null where account_manager_id is not null`);
  try {
    await manager.goto(`${BASE}/gerente`);
    await manager.locator(".manager-welcome").waitFor();
    const text = (await manager.locator("body").innerText()).replace(/\s+/g, " ");
    assert.match(text, /Sua vitrine de comissões está pronta/);
    assert.ok(!/Evolução da carteira/.test(text), "sem gráficos vazios");
    if (SHOTS) await manager.screenshot({ path: `${SHOTS}/gerente-sem-clientes.png`, fullPage: true });
  } finally {
    for (const row of linked) await admin(`update client set account_manager_id='${row.account_manager_id}', account_manager_bps=${row.account_manager_bps ?? "null"} where id='${row.id}'`);
  }
});

test("G4. celular: painel sem rolagem lateral", async () => {
  const phone = await signIn(EMAIL, NEW_PASSWORD, { width: 390, height: 844 });
  await phone.goto(`${BASE}/gerente`);
  await phone.locator(".metric-featured").waitFor();
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, "sem rolagem lateral");
  if (SHOTS) await phone.screenshot({ path: `${SHOTS}/gerente-celular.png`, fullPage: true });
  await phone.context().close();
});

test("G5. só leitura: o gerente não alcança nenhuma tela nem ação da carteira", async () => {
  managerCookie = await apiLogin(EMAIL, NEW_PASSWORD);
  for (const path of ["/", "/?tela=clientes", "/?tela=operacoes", "/financeiro", "/contas-a-pagar", "/investidores", "/gerentes", "/admin", "/admin/registros"]) {
    let where = path, status = 200;
    for (let hop = 0; hop < 4 && status >= 300 && status < 400 || hop === 0; hop++) {
      const response = await get(managerCookie, where);
      status = response.status;
      const next = response.headers.get("location");
      if (!(status >= 300 && status < 400) || !next) break;
      where = new URL(next, BASE).pathname + new URL(next, BASE).search;
    }
    assert.equal(where, "/gerente", `${path} leva o gerente ao painel (terminou em ${where}, status ${status})`);
  }
  const before = await tenantHash("ten_roberio");
  const counts = async () => `${await one(`select count(*) from client where tenant_id='ten_roberio'`)}/${await one(`select count(*) from account_manager`)}/${await one(`select count(*) from account_manager_payout`)}/${await one(`select count(*) from loan_operation`)}/${await one(`select count(*) from payment`)}`;
  const countsBefore = await counts();
  const forged = [
    ["createClientAction", { name: "Forjado" }, "/"], ["createManagerAction", { name: "Forjada", commission: "50" }, "/gerentes"],
    ["registerManagerPayoutAction", { managerId: await one(`select id from account_manager where name='Gabrielle Teste'`), amount: "999,00", paidOn: TODAY }, "/gerentes"],
    ["linkClientAction", { managerId: await one(`select id from account_manager where name='Gabrielle Teste'`), clientId: "c_g_dora" }, "/gerentes"],
    ["unlinkClientAction", { clientId: "c_g_ana" }, "/gerentes"], ["deleteManagerAction", { managerId: await one(`select id from account_manager where name='Gabrielle Teste'`) }, "/gerentes"],
    ["deleteClientAction", { clientId: "c_g_ana" }, "/"], ["registerPaymentAction", { operationId: "op_g_ana_open", amount: "100,00", paidOn: TODAY }, "/"],
    ["updateClientAction", { clientId: "c_g_ana", name: "Renomeada" }, "/"], ["cancelOperationAction", { operationId: "op_g_ana_open" }, "/"],
    ["uploadClientDocumentAction", { clientId: "c_g_ana" }, "/"], ["createManagerAccessAction", { managerId: await one(`select id from account_manager where name='Gabrielle Teste'`), email: "outro@teste.local" }, "/gerentes"],
  ];
  for (const [name, fields, path] of forged) {
    const response = await action(managerCookie, name, fields, path);
    assert.ok(response.status >= 300 || response.result?.ok !== true, `${name} recusada para o gerente`);
  }
  assert.equal(await counts(), countsBefore, "nada foi criado nem alterado");
  assert.equal(await tenantHash("ten_roberio"), before);
  assert.equal(await one(`select account_manager_id from client where id='c_g_dora'`), null);
  assert.equal(await one(`select count(*) from "user" where email='outro@teste.local'`), 0);
});

test("G6. isolamento: outro tenant não vê nem mexe, e o painel não enxerga clientes de outro gerente", async () => {
  const fernandoCookie = await apiLogin("fernando@teste.local");
  const page = await (await get(fernandoCookie, "/gerentes")).text();
  assert.ok(!page.includes("Gabrielle Teste") && !page.includes("Ana Indicada"), "tenant B não vê o gerente do A");
  const managerId = await one(`select id from account_manager where name='Gabrielle Teste'`);
  const link = await action(fernandoCookie, "linkClientAction", { managerId, clientId: "c_g_dora" });
  assert.equal(link.result?.ok, false, "tenant B não vincula cliente ao gerente do A");
  const pay = await action(fernandoCookie, "registerManagerPayoutAction", { managerId, amount: "5,00", paidOn: TODAY });
  assert.equal(pay.result?.ok, false);
  assert.equal(await one(`select count(*) from account_manager_payout`), 1);
  assert.equal(await tenantHash("ten_fernando"), fernandoBefore, "tenant B intacto");
  // Segundo gerente do mesmo tenant: o painel da primeira nunca mostra os clientes dele.
  const own = await action(await apiLogin("roberio@teste.local"), "createManagerAction", { name: "Outro Gerente", commission: "5" });
  assert.equal(own.result?.ok, true);
  const otherId = await one(`select id from account_manager where name='Outro Gerente'`);
  await admin(`update client set account_manager_id='${otherId}' where id='c_g_dora'`);
  await manager.reload();
  assert.ok(!(await manager.locator("body").innerText()).includes("Dora Sem Gerente"), "cliente de outro gerente do mesmo tenant não aparece");
});

test("G7. regras do banco: comissão paga não se edita nem se apaga; percentual só com gerente; limites", async () => {
  await assert.rejects(admin(`update account_manager_payout set amount_cents = 1`), /não podem ser alterados/);
  await assert.rejects(admin(`delete from account_manager_payout`), /não podem ser alterados/);
  await assert.rejects(admin(`update client set account_manager_id = null, account_manager_bps = 500 where id = 'c_g_dora'`), /client_account_manager_bps_valid/);
  await assert.rejects(admin(`update client set account_manager_bps = 10001 where id = 'c_g_ana'`), /client_account_manager_bps_valid/);
  await assert.rejects(admin(`update account_manager set commission_bps = 10001`), /account_manager_commission_range/);
});

test("G8. desativar o gerente bloqueia o acesso na hora e nada financeiro mudou", async () => {
  const ownerCookie = await apiLogin("roberio@teste.local");
  const managerId = await one(`select id from account_manager where name='Gabrielle Teste'`);
  const off = await action(ownerCookie, "updateManagerAction", { managerId, name: "Gabrielle Teste", commission: "10", active: "0" });
  assert.equal(off.result?.ok, true);
  assert.equal(await one(`select active from "user" where email='${EMAIL}'`), false);
  assert.equal(await one(`select count(*) from session where user_id = (select id from "user" where email='${EMAIL}')`), 0, "sessões encerradas");
  await manager.goto(`${BASE}/gerente`);
  assert.match(new URL(manager.url()).pathname, /login|account-disabled/, "sem sessão ou conta desativada");
  assert.equal(await tenantHash("ten_roberio"), ownerBefore, "operações, pagamentos e capital do tenant não mudaram");
});

test("G9. MASTER vê e cria gerentes de qualquer cliente SaaS, e o gerente não vira \"dono\" do ambiente", async () => {
  const master = await signIn("thais@teste.local");
  // Vê o gerente que o dono cadastrou (com percentuais e pagamentos).
  await master.goto(`${BASE}/admin/clientes/ten_roberio`);
  const seen = master.locator("#gerentes");
  await seen.getByRole("region", { name: "Gerente Gabrielle Teste" }).waitFor();
  assert.match(await seen.innerText(), /Ana Indicada/);
  assert.match(await seen.innerText(), /7,5%/);
  assert.match(await master.locator("body").innerText(), /Gerente de contas \(só leitura\)/, "o gerente aparece rotulado em Gerenciar acesso");
  if (SHOTS) await seen.screenshot({ path: `${SHOTS}/master-ve-gerentes.png` });
  // Cria, em nome do Fernando (tenant B), um gerente + vínculo + acesso, tudo pela tela.
  await admin(`insert into client(id, tenant_id, name, document, phone) values ('c_g_fer','ten_fernando','Cliente Fictício do Fernando','15350946056','11999990009')`);
  await master.goto(`${BASE}/admin/clientes/ten_fernando`);
  const box = master.locator("#gerentes");
  await box.getByLabel("Nome", { exact: true }).first().fill("Gerente Do Master");
  await box.getByRole("button", { name: "Cadastrar gerente" }).click();
  await poll(`select count(*) from account_manager where tenant_id='ten_fernando' and name='Gerente Do Master'`, 1);
  const region = box.getByRole("region", { name: "Gerente Gerente Do Master" });
  await region.waitFor();
  await region.getByLabel("Cliente indicado").selectOption({ label: "Cliente Fictício do Fernando" });
  await region.getByLabel("Comissão deste cliente (%)").fill("12,5");
  await region.getByRole("button", { name: "Vincular cliente" }).click();
  await poll(`select account_manager_bps from client where id='c_g_fer'`, 1250);
  await master.waitForTimeout(500);
  await region.getByLabel("E-mail de acesso do gerente").fill("gerente.master@teste.local");
  await region.getByRole("button", { name: "Criar acesso de leitura" }).click();
  await region.locator(".capital-note", { hasText: "Senha provisória" }).waitFor();
  assert.equal(await one(`select tenant_id from "user" where email='gerente.master@teste.local'`), "ten_fernando");
  assert.equal(await one(`select role::text from "user" where email='gerente.master@teste.local'`), "ACCOUNT_MANAGER");
  assert.equal(await one(`select actor_email from admin_audit_log where action='MANAGER_ACCESS_CREATED' and tenant_id='ten_fernando'`), "thais@teste.local", "auditoria: o MASTER é o autor");
  // O gerente não é a "conta principal" do ambiente: a lista de clientes SaaS continua mostrando o Fernando.
  const list = await (await get(await apiLogin("thais@teste.local"), "/admin")).text();
  assert.ok(list.includes("fernando@teste.local"), "o dono do ambiente continua sendo o Fernando");
  // Bloquear/desbloquear o cliente SaaS (Robério, que tem gerente) continua funcionando e só afeta o dono.
  const thais = await apiLogin("thais@teste.local");
  const block = await action(thais, "setSaasClientAccessAction", { tenantId: "ten_roberio", action: "block" }, "/admin");
  assert.equal(block.result?.ok, true, "ambiente com gerente continua gerenciável pelo MASTER");
  assert.equal(await one(`select active from "user" where email='roberio@teste.local'`), false);
  assert.equal(await one(`select active from "user" where email='${EMAIL}'`), false, "o gerente já estava desativado (G8) e continua assim");
  const unblock = await action(thais, "setSaasClientAccessAction", { tenantId: "ten_roberio", action: "unblock" }, "/admin");
  assert.equal(unblock.result?.ok, true);
  assert.equal(await one(`select active from "user" where email='roberio@teste.local'`), true);
  // Quem não é MASTER não alcança as ações do MASTER, e o ambiente do próprio MASTER é recusado.
  const before = await one(`select count(*) from account_manager`);
  const forged = await action(await apiLogin("roberio@teste.local"), "adminCreateManagerAction", { tenantId: "ten_roberio", name: "Forjado" }, "/admin");
  assert.notEqual(forged.result?.ok, true);
  const masterTenant = await one(`select tenant_id from "user" where email='thais@teste.local'`);
  const own = await action(thais, "adminCreateManagerAction", { tenantId: masterTenant, name: "No Ambiente Master" }, "/admin");
  assert.equal(own.result?.ok, false);
  const missing = await action(thais, "adminCreateManagerAction", { tenantId: "ten_inexistente", name: "Fantasma" }, "/admin");
  assert.equal(missing.result?.ok, false);
  assert.equal(await one(`select count(*) from account_manager`), before);
  assert.equal(await one(`select count(*) from loan_operation where tenant_id='ten_fernando' and id like 'op\\_g\\_%'`), 0);
});

test("G10. excluir gerente: sem comissão paga apaga (e desvincula clientes e remove o login); com comissão paga recusa", async () => {
  const ownerCookie = await apiLogin("roberio@teste.local");
  // Gabrielle já recebeu comissão (R$ 10,00): não pode ser excluída, nada muda.
  const gabrielle = await one(`select id from account_manager where name='Gabrielle Teste'`);
  const refused = await action(ownerCookie, "deleteManagerAction", { managerId: gabrielle });
  assert.equal(refused.result?.ok, false);
  assert.match(refused.result?.error ?? "", /não pode ser excluído/);
  assert.equal(await one(`select count(*) from account_manager where id='${gabrielle}'`), 1);
  assert.equal(await one(`select count(*) from client where account_manager_id='${gabrielle}'`), 3);
  // "Outro Gerente" (sem pagamentos, com o cliente Dora) pela tela do dono.
  const beforeOps = await tenantHash("ten_roberio");
  owner = await signIn("roberio@teste.local"); // o bloqueio/desbloqueio do MASTER (G9) encerrou a sessão anterior
  await owner.goto(`${BASE}/gerentes`);
  const region = owner.getByRole("region", { name: "Gerente Outro Gerente" });
  await region.getByRole("button", { name: "Excluir", exact: true }).click();
  await region.getByRole("button", { name: "Sim, excluir" }).click();
  await poll(`select count(*) from account_manager where name='Outro Gerente'`, 0);
  assert.equal(await one(`select account_manager_id from client where id='c_g_dora'`), null, "Dora voltou a ficar sem gerente");
  assert.equal(await one(`select count(*) from client where id='c_g_dora'`), 1, "o cliente continua existindo");
  assert.equal(await tenantHash("ten_roberio"), beforeOps, "operações, pagamentos e capital intactos");
  assert.equal(await one(`select count(*) from admin_audit_log where action='MANAGER_DELETED' and tenant_id='ten_roberio'`), 1);
  // O MASTER exclui o gerente que criou para o Fernando (com login e cliente vinculado).
  const thais = await apiLogin("thais@teste.local");
  const masterManager = await one(`select id from account_manager where name='Gerente Do Master'`);
  const deleted = await action(thais, "adminDeleteManagerAction", { tenantId: "ten_fernando", managerId: masterManager }, "/admin");
  assert.equal(deleted.result?.ok, true);
  assert.equal(await one(`select count(*) from "user" where email='gerente.master@teste.local'`), 0, "login removido");
  assert.equal(await one(`select account_manager_id from client where id='c_g_fer'`), null);
  // Outro tenant não exclui gerente alheio.
  const foreign = await action(await apiLogin("fernando@teste.local"), "deleteManagerAction", { managerId: gabrielle });
  assert.equal(foreign.result?.ok, false);
  assert.equal(await one(`select count(*) from account_manager where id='${gabrielle}'`), 1);
});
