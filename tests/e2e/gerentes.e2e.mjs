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
// Ação com argumentos simples (texto), não FormData.
async function actionArgs(cookie, name, args, path = "/") {
  const response = await fetch(`${BASE}${path}`, { method: "POST", redirect: "manual", headers: { cookie, "next-action": actionId(name), accept: "text/x-component", origin: BASE, "content-type": "text/plain;charset=UTF-8" }, body: JSON.stringify(args) });
  const result = (await response.text()).match(/^1:(\{.*\})$/m)?.[1];
  return { status: response.status, result: result ? JSON.parse(result) : null };
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
  assert.match((await manager.getByLabel("Comissão a receber, abrir minha comissão").locator(".metric-value").innerText()).replace(/\s/g, ""), /R\$20,00/);
  assert.match((await manager.locator(".metric-featured").innerText()).replace(/\s+/g, " "), /Caixa disponível/);
  let text = await flat();
  assert.match(text, /Prevista R\$ 17,50/);
  assert.match(text, /Capital emprestado/);
  assert.ok(!/Capital disponível|Contas a pagar|Investidores|Financeiro|Configurações|Nova operação/.test(text), "nada do caixa nem de cadastros do dono");
  // Menu: só as telas dela.
  const menu = (await manager.locator(".side-nav").innerText()).replace(/\s+/g, " ");
  for (const item of ["Visão geral", "Clientes", "Operações", "Cobranças", "Comissão"]) assert.ok(menu.includes(item), `menu tem ${item}`);
  for (const item of ["Pagamentos", "Capital", "Financeiro", "Contas a pagar", "Investidores", "Gerentes", "Relatórios", "Renegociação"]) assert.ok(!menu.includes(item), `menu não tem ${item}`);
  if (SHOTS) await manager.screenshot({ path: `${SHOTS}/gerente-visao-geral-padrao.png`, fullPage: true });
  // Clientes: só os dela, sem cadastro nem edição.
  await manager.locator(".side-nav").getByText("Clientes", { exact: true }).click();
  await manager.getByRole("region", { name: "Lista de clientes" }).waitFor();
  text = await flat();
  for (const name of ["Ana Indicada", "Beto Indicado", "Carla Indicada"]) assert.ok(text.includes(name), `${name} aparece`);
  assert.ok(!text.includes("Dora Sem Gerente"), "cliente sem gerente (ou de outro gerente) não aparece");
  assert.equal(await manager.getByRole("button", { name: /Editar|Excluir/ }).count(), 0, "sem botões de edição");
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
  assert.equal(await manager.getByRole("region", { name: /Nova operação/ }).count(), 1, "só o formulário de pedido para aprovação");
  assert.ok(!(await manager.getByRole("region", { name: /Nova operação/ }).innerText()).includes("Cadastrar operação"));
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
  // Sem seletor de cor: o visual é o mesmo do dono.
  assert.equal(await manager.locator(".theme-switch").count(), 0, "sem seletor de cor");
  if (SHOTS) { await manager.goto(`${BASE}/gerente`); await manager.locator(".metric-featured").waitFor(); await manager.screenshot({ path: `${SHOTS}/gerente-visao-geral.png`, fullPage: true }); }
  const before = await tenantHash("ten_roberio");
  await manager.reload();
  assert.equal(await tenantHash("ten_roberio"), before, "abrir o painel não grava nada nos dados");
});

test("G3b. sem clientes ainda: aviso amigável e o painel completo", async () => {
  const linked = await admin(`select id, account_manager_id, account_manager_bps from client where account_manager_id is not null`);
  await admin(`update client set account_manager_id = null, account_manager_bps = null where account_manager_id is not null`);
  try {
    await manager.goto(`${BASE}/gerente`);
    await manager.locator(".manager-banner").waitFor();
    const text = (await manager.locator("body").innerText()).replace(/\s+/g, " ");
    assert.match(text, /Você ainda não tem clientes indicados/);
    assert.match(text, /Evolução da carteira/, "mesmo painel do dono, mesmo vazio");
    if (SHOTS) await manager.screenshot({ path: `${SHOTS}/gerente-sem-clientes.png`, fullPage: true });
  } finally {
    for (const row of linked) await admin(`update client set account_manager_id='${row.account_manager_id}', account_manager_bps=${row.account_manager_bps ?? "null"} where id='${row.id}'`);
  }
});

function cpfFrom(base) {
  const digits = base.split("").map(Number);
  for (const size of [9, 10]) {
    const sum = digits.slice(0, size).reduce((total, digit, index) => total + digit * (size + 1 - index), 0);
    digits.push(((sum * 10) % 11) % 10);
  }
  return digits.join("");
}
const CLIENT_FIELDS = {
  name: "Maria Cadastrada Pela Gerente", document: cpfFrom("123456780"), phone: "11988880001", whatsapp: "11988880001",
  residentialCep: "01310100", residentialStreet: "Avenida Paulista", residentialNumber: "1000", residentialDistrict: "Bela Vista", residentialCity: "São Paulo", residentialState: "SP",
  reference1Name: "Ref Um", reference1Phone: "11977770001", reference1Relationship: "Irmã", reference2Name: "Ref Dois", reference2Phone: "11977770002", reference2Relationship: "Vizinho",
};
test("G11. a gerente cadastra cliente: campos obrigatórios, ligado a ela, sem banco, CPF único", async () => {
  await manager.goto(`${BASE}/gerente?tela=clientes`);
  await manager.getByRole("heading", { name: "Cadastrar cliente indicado por você" }).waitFor();
  const countOf = async (name) => Number(await one(`select count(*) from client where tenant_id='ten_roberio' and name='${name}'`));
  // Sem os obrigatórios o navegador nem envia.
  await manager.locator('input[name="name"]').fill(CLIENT_FIELDS.name);
  await manager.getByRole("button", { name: "Cadastrar cliente" }).click();
  await sleep(1500);
  assert.equal(await countOf(CLIENT_FIELDS.name), 0, "sem os campos obrigatórios nada é gravado");
  assert.ok(await manager.locator('input[name="document"]').evaluate((input) => input.required), "CPF é obrigatório na tela");
  assert.ok(!(await manager.locator("form.form-grid").innerText()).includes("Dados bancários"), "gerente não vê dados bancários");
  // Servidor também recusa (formulário forjado sem os obrigatórios).
  const cookie = await apiLogin(EMAIL, NEW_PASSWORD);
  const incomplete = await action(cookie, "registerClientAction", { name: "Forjada Incompleta" }, "/gerente");
  assert.equal(incomplete.result?.ok, false);
  assert.match(String(incomplete.result?.error), /campos obrigatórios/);
  assert.equal(await countOf("Forjada Incompleta"), 0);
  // Preenche tudo e cadastra pela tela.
  await manager.locator('input[name="residentialCep"]').fill("01310-100");
  for (const [name, value] of Object.entries(CLIENT_FIELDS)) {
    if (name === "residentialCep") continue;
    const control = manager.locator(`[name="${name}"]`);
    if ((await control.evaluate((element) => element.tagName)) === "SELECT") await control.selectOption(value);
    else await control.fill(value);
  }
  if (SHOTS) await manager.screenshot({ path: `${SHOTS}/gerente-cadastro-cliente.png`, fullPage: true });
  await manager.getByRole("button", { name: "Cadastrar cliente" }).click();
  await poll(`select count(*) from client where tenant_id='ten_roberio' and name='${CLIENT_FIELDS.name}'`, 1);
  const gabrielle = await one(`select id from account_manager where name='Gabrielle Teste'`);
  assert.equal(await one(`select account_manager_id from client where name='${CLIENT_FIELDS.name}'`), gabrielle, "nasce ligado à gerente");
  assert.equal(await one(`select account_manager_bps is null from client where name='${CLIENT_FIELDS.name}'`), true, "usa a comissão padrão até o dono definir a do cliente");
  assert.equal(await one(`select count(*) from admin_audit_log where action='CLIENT_REGISTERED_BY_MANAGER' and tenant_id='ten_roberio'`) >= 1, true, "auditado");
  await manager.getByText(CLIENT_FIELDS.name).first().waitFor();
  // CPF repetido é recusado.
  const repeated = await action(cookie, "registerClientAction", { ...CLIENT_FIELDS, name: "Outra Pessoa" }, "/gerente");
  assert.equal(repeated.result?.ok, false);
  assert.match(String(repeated.result?.error), /Já existe um cliente com o CPF/);
  // Formulário forjado com banco e marcação interna: o servidor ignora.
  const forged = await action(cookie, "registerClientAction", { ...CLIENT_FIELDS, name: "Com Banco Forjado", document: cpfFrom("987654320"), bankName: "Banco X", bankAccount: "123", onlineCasinoBettor: "on" }, "/gerente");
  assert.equal(forged.result?.ok, true, JSON.stringify(forged));
  assert.equal(await one(`select bank_name is null and not online_casino_bettor from client where name='Com Banco Forjado'`), true);
  await admin(`delete from client where name in ('${CLIENT_FIELDS.name}','Com Banco Forjado') and tenant_id='ten_roberio'`);
});

test("G12. a gerente envia operação para aprovação; o dono aprova (ativa) ou reprova; nada entra no capital antes", async () => {
  const hadWallet = Number(await one(`select count(*) from wallet where tenant_id='ten_roberio'`)) > 0;
  if (hadWallet) await admin(`update wallet set initial_capital_cents = initial_capital_cents + 50000000 where tenant_id='ten_roberio'`);
  else await admin(`insert into wallet(id, tenant_id, initial_capital_cents) values ('wal_g12','ten_roberio',50000000)`);
  await admin(`update account_manager set cash_limit_cents = 2000000000 where name='Gabrielle Teste'`);
  const before = await tenantHash("ten_roberio");
  const opsBefore = Number(await one(`select count(*) from loan_operation where tenant_id='ten_roberio'`));
  const ddMmYyyy = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
  await manager.goto(`${BASE}/gerente?tela=operacoes`);
  await manager.getByRole("region", { name: "Nova operação" }).waitFor();
  assert.ok((await manager.getByRole("region", { name: "Nova operação" }).innerText()).includes("para aprovação"));
  assert.ok(!(await manager.getByRole("region", { name: "Nova operação" }).innerText()).includes("Capital disponível"), "gerente não vê o capital do dono");
  const form = manager.getByRole("region", { name: "Nova operação" });
  await form.locator('select[name="clientId"]').selectOption({ label: "Ana Indicada" });
  await form.locator('input[name="principal"]').fill("2.000,00");
  await form.locator('input[name="rate"]').fill("10");
  await form.getByLabel("Vencimento", { exact: true }).fill(ddMmYyyy(day(30)));
  if (SHOTS) await manager.screenshot({ path: `${SHOTS}/gerente-pedido-operacao.png`, fullPage: true });
  await manager.getByRole("button", { name: "Enviar para aprovação" }).click();
  await poll(`select count(*) from operation_request where tenant_id='ten_roberio' and status='PENDING'`, 1);
  assert.equal(await one(`select count(*) from loan_operation where tenant_id='ten_roberio'`), opsBefore, "nenhuma operação nasce antes da aprovação");
  assert.equal(await tenantHash("ten_roberio"), before, "capital, operações e pagamentos não mudaram");
  await manager.getByText("Aguardando aprovação").first().waitFor();
  assert.equal(await one(`select count(*) from admin_audit_log where action='OPERATION_REQUESTED_BY_MANAGER' and tenant_id='ten_roberio'`) >= 1, true, "pedido auditado");
  // Servidor: cliente de outro gerente/sem gerente e campos fora do formulário.
  const cookie = await apiLogin(EMAIL, NEW_PASSWORD);
  const terms = { modality: "SINGLE", frequency: "MONTHLY", principal: "500,00", rate: "10", loanDate: day(0), dueDate: day(30) };
  const foreign = await action(cookie, "submitOperationRequestAction", { clientId: "c_g_dora", ...terms }, "/gerente");
  assert.equal(foreign.result?.ok, false);
  assert.match(String(foreign.result?.error), /entre os seus clientes/);
  const invalid = await action(cookie, "submitOperationRequestAction", { clientId: "c_g_ana", ...terms, principal: "" }, "/gerente");
  assert.equal(invalid.result?.ok, false);
  assert.equal(await one(`select count(*) from operation_request where tenant_id='ten_roberio'`), 1);
  // Ela não aprova nem reprova o próprio pedido.
  const requestId = await one(`select id from operation_request where status='PENDING'`);
  for (const [name, fields] of [["approveOperationRequestAction", [requestId]], ["rejectOperationRequestAction", [requestId, "x"]]]) {
    const response = await actionArgs(cookie, name, fields, "/gerente").catch(() => ({ status: 500 }));
    assert.ok(response.status >= 300 || response.result?.ok !== true, `${name} recusada para a gerente`);
  }
  assert.equal(await one(`select status from operation_request where id='${requestId}'`), "PENDING");
  // Dono: vê o pedido e aprova pela tela.
  await owner.goto(`${BASE}/?tela=aprovacoes`);
  await owner.getByRole("region", { name: "Pedidos de operação" }).waitFor();
  await owner.getByText("Enviado por Gabrielle Teste").first().waitFor();
  if (SHOTS) await owner.screenshot({ path: `${SHOTS}/dono-aprova-operacao.png`, fullPage: true });
  await owner.getByRole("button", { name: "Aprovar" }).first().click();
  await poll(`select status from operation_request where id='${requestId}'`, "APPROVED");
  assert.equal(await one(`select count(*) from loan_operation where tenant_id='ten_roberio'`), opsBefore + 1);
  assert.equal(await one(`select o.status||'/'||o.principal_cents||'/'||o.client_id from loan_operation o join operation_request r on r.operation_id = o.id where r.id='${requestId}'`), "OPEN/200000/c_g_ana");
  assert.equal(await one(`select count(*) from admin_audit_log where action='OPERATION_REQUEST_APPROVED' and tenant_id='ten_roberio'`) >= 1, true);
  // Decidido não muda: aprovar de novo não cria outra operação.
  const ownerCookie = await apiLogin("roberio@teste.local");
  const again = await actionArgs(ownerCookie, "approveOperationRequestAction", [requestId]);
  assert.equal(again.result?.ok, false);
  assert.match(String(again.result?.error), /já foi decidido/);
  assert.equal(await one(`select count(*) from loan_operation where tenant_id='ten_roberio'`), opsBefore + 1);
  // Aprovada = Pix a fazer: aparece no menu, na visão geral e em Contas a pagar; "Pix feito" baixa o compromisso e não mexe no capital.
  await owner.goto(`${BASE}/`);
  await owner.getByRole("region", { name: "Aprovações" }).waitFor();
  assert.match(await owner.getByRole("region", { name: "Aprovações" }).innerText(), /Pix a fazer hoje[\s\S]*1 operação aprovada/);
  assert.ok(await owner.getByRole("link", { name: /Aprovações/ }).count() >= 1, "item Aprovações no menu lateral");
  if (SHOTS) await owner.screenshot({ path: `${SHOTS}/dono-visao-geral-aprovacoes.png`, fullPage: false });
  await owner.goto(`${BASE}/contas-a-pagar`);
  const pixRegion = owner.getByRole("region", { name: "Pix de operações aprovadas" });
  await pixRegion.waitFor();
  assert.match(await pixRegion.innerText(), /Ana Indicada/);
  if (SHOTS) await owner.screenshot({ path: `${SHOTS}/dono-contas-a-pagar-pix.png`, fullPage: false });
  const capitalBeforePix = await tenantHash("ten_roberio");
  await pixRegion.getByRole("button", { name: "Pix feito" }).click();
  await poll(`select pix_paid_on is not null from operation_request where id='${requestId}'`, "true");
  assert.equal(await tenantHash("ten_roberio"), capitalBeforePix, "confirmar o Pix não mexe em capital, operações nem pagamentos");
  assert.equal(await one(`select count(*) from admin_audit_log where action='OPERATION_PIX_CONFIRMED' and tenant_id='ten_roberio'`) >= 1, true);
  const pixAgain = await actionArgs(ownerCookie, "confirmOperationPixAction", [requestId]);
  assert.equal(pixAgain.result?.ok, false);
  assert.equal(await one(`select count(*) from operation_request where status='APPROVED' and pix_paid_on is null`), 0);
  const managerPix = await actionArgs(cookie, "confirmOperationPixAction", [requestId], "/gerente");
  assert.ok(managerPix.status >= 300 || managerPix.result?.ok !== true, "a gerente não confirma Pix");
  // Segundo pedido: reprovado com motivo, que a gerente vê.
  const second = await action(cookie, "submitOperationRequestAction", { clientId: "c_g_beto", ...terms }, "/gerente");
  assert.equal(second.result?.ok, true, JSON.stringify(second));
  await owner.goto(`${BASE}/?tela=aprovacoes`);
  await owner.getByRole("button", { name: "Reprovar" }).first().click();
  await owner.getByLabel("Motivo da reprovação").fill("Cliente com atraso, ajustar o prazo");
  await owner.getByRole("button", { name: "Confirmar reprovação" }).click();
  await poll(`select status from operation_request where client_id='c_g_beto'`, "REJECTED");
  assert.equal(await one(`select count(*) from loan_operation where tenant_id='ten_roberio'`), opsBefore + 1, "reprovado não cria operação");
  await manager.goto(`${BASE}/gerente?tela=operacoes`);
  await manager.getByText("Motivo: Cliente com atraso, ajustar o prazo").waitFor();
  // Sem capital suficiente a aprovação é recusada e o pedido continua pendente.
  const big = await action(cookie, "submitOperationRequestAction", { clientId: "c_g_ana", ...terms, principal: "9.000.000,00" }, "/gerente");
  assert.equal(big.result?.ok, true, JSON.stringify(big));
  const bigId = await one(`select id from operation_request where status='PENDING'`);
  const refused = await actionArgs(ownerCookie, "approveOperationRequestAction", [bigId]);
  assert.equal(refused.result?.ok, false);
  assert.match(String(refused.result?.error), /Capital disponível insuficiente/);
  assert.equal(await one(`select status from operation_request where id='${bigId}'`), "PENDING");
  // Limpeza: volta o tenant ao estado original.
  const createdOperation = await one(`select operation_id from operation_request where id='${requestId}'`);
  await admin(`delete from operation_request where tenant_id='ten_roberio'`);
  await admin(`delete from loan_operation where id='${createdOperation}'`);
  await admin(`update account_manager set cash_limit_cents = 0 where name='Gabrielle Teste'`);
  if (hadWallet) await admin(`update wallet set initial_capital_cents = initial_capital_cents - 50000000 where tenant_id='ten_roberio'`);
  else await admin(`delete from wallet where id='wal_g12'`);
});

test("G13. caixa da gerente: o dono define, ela vê o disponível e não envia pedido acima dele; pagamentos devolvem o caixa", async () => {
  const hadWallet = Number(await one(`select count(*) from wallet where tenant_id='ten_roberio'`)) > 0;
  if (hadWallet) await admin(`update wallet set initial_capital_cents = initial_capital_cents + 50000000 where tenant_id='ten_roberio'`);
  else await admin(`insert into wallet(id, tenant_id, initial_capital_cents) values ('wal_g13','ten_roberio',50000000)`);
  const cookie = await apiLogin(EMAIL, NEW_PASSWORD);
  const ownerCookie = await apiLogin("roberio@teste.local");
  const managerId = await one(`select id from account_manager where name='Gabrielle Teste'`);
  const terms = { modality: "SINGLE", frequency: "MONTHLY", rate: "10", loanDate: day(0), dueDate: day(30) };
  const submit = (clientId, principal) => action(cookie, "submitOperationRequestAction", { clientId, principal, ...terms }, "/gerente");
  // Sem caixa combinado (padrão 0) nenhum pedido chega.
  const none = await submit("c_g_ana", "100,00");
  assert.equal(none.result?.ok, false);
  assert.match(String(none.result?.error), /Caixa insuficiente/);
  assert.equal(await one(`select count(*) from operation_request`), 0);
  // O dono define o caixa (R$ 3.000); a gerente já tem R$ 2.000 em aberto nos clientes dela: sobram R$ 1.000.
  const saved = await action(ownerCookie, "updateManagerAction", { managerId, name: "Gabrielle Teste", commission: "", cashLimit: "3.000,00", active: "1" }, "/gerentes");
  assert.equal(saved.result?.ok, true, JSON.stringify(saved));
  assert.equal(await one(`select cash_limit_cents from account_manager where id='${managerId}'`), 300000);
  assert.equal(await one(`select count(*) from admin_audit_log where action='MANAGER_UPDATED' and description like '%caixa R$%3.000,00%'`) >= 1, true, "caixa auditado");
  await manager.goto(`${BASE}/gerente`);
  await manager.getByLabel(/Caixa disponível, abrir operações/).waitFor();
  assert.match(await manager.getByLabel(/Caixa disponível, abrir operações/).innerText(), /R\$\s*1\.000,00/);
  assert.match(await manager.getByLabel(/Caixa disponível, abrir operações/).innerText(), /Caixa combinado R\$\s*3\.000,00/);
  if (SHOTS) await manager.screenshot({ path: `${SHOTS}/gerente-caixa.png`, fullPage: false });
  // Acima do caixa: recusado; dentro: aceito e o disponível cai (pedido reservado).
  const above = await submit("c_g_ana", "1.500,00");
  assert.equal(above.result?.ok, false);
  assert.match(String(above.result?.error), /Caixa insuficiente/);
  const within = await submit("c_g_ana", "1.000,00");
  assert.equal(within.result?.ok, true, JSON.stringify(within));
  const more = await submit("c_g_beto", "100,00");
  assert.equal(more.result?.ok, false, "o pedido pendente reserva o caixa");
  // A tela avisa e trava o envio quando o valor passa do caixa.
  await manager.goto(`${BASE}/gerente?tela=operacoes`);
  const form = manager.getByRole("region", { name: "Nova operação" });
  await form.locator('input[name="principal"]').fill("50,00");
  await form.locator('input[name="principal"]').blur();
  assert.equal(await form.getByRole("button", { name: "Enviar para aprovação" }).isDisabled(), true, "caixa zerado trava o envio");
  assert.match(await form.innerText(), /maior que o seu caixa disponível/);
  // O dono reduz o caixa abaixo do que está em uso: aprovar estoura o caixa e é recusado; o pedido continua pendente.
  const requestId = await one(`select id from operation_request where status='PENDING'`);
  await action(ownerCookie, "updateManagerAction", { managerId, name: "Gabrielle Teste", commission: "", cashLimit: "2.500,00", active: "1" }, "/gerentes");
  const refused = await actionArgs(ownerCookie, "approveOperationRequestAction", [requestId]);
  assert.equal(refused.result?.ok, false);
  assert.match(String(refused.result?.error), /Estoura o caixa da gerente/);
  assert.equal(await one(`select status from operation_request where id='${requestId}'`), "PENDING");
  // Caixa volta a R$ 3.000: aprova; o principal passa de "pedido" para "em aberto" e o disponível fica zerado.
  await action(ownerCookie, "updateManagerAction", { managerId, name: "Gabrielle Teste", commission: "", cashLimit: "3.000,00", active: "1" }, "/gerentes");
  const approved = await actionArgs(ownerCookie, "approveOperationRequestAction", [requestId]);
  assert.equal(approved.result?.ok, true, JSON.stringify(approved));
  const none2 = await submit("c_g_beto", "10,00");
  assert.equal(none2.result?.ok, false);
  // Cliente paga R$ 200 (juros R$ 100 primeiro e R$ 100 de principal): R$ 100 voltam ao caixa.
  await admin(`insert into payment(id,tenant_id,operation_id,amount_cents,paid_at) values ('pay_g13','ten_roberio','op_g_ana_open',20000,'${day(0)}')`);
  const back = await submit("c_g_beto", "100,00");
  assert.equal(back.result?.ok, true, JSON.stringify(back));
  const over = await submit("c_g_beto", "0,01");
  assert.equal(over.result?.ok, false);
  // O dono vê o caixa de cada gerente.
  await owner.goto(`${BASE}/gerentes`);
  const region = owner.getByRole("region", { name: "Gerente Gabrielle Teste" });
  await region.waitFor();
  assert.match(await region.innerText(), /Caixa combinado\s*R\$\s*3\.000,00/);
  assert.match(await region.innerText(), /Caixa disponível\s*R\$\s*0,00/);
  if (SHOTS) await owner.screenshot({ path: `${SHOTS}/dono-caixa-gerente.png`, fullPage: true });
  // Limpeza.
  const createdOperation = await one(`select operation_id from operation_request where id='${requestId}'`);
  await admin(`delete from operation_request where tenant_id='ten_roberio'`);
  await admin(`delete from payment where id='pay_g13'`);
  await admin(`delete from loan_operation where id='${createdOperation}'`);
  await admin(`update account_manager set cash_limit_cents = 0 where id='${managerId}'`);
  if (hadWallet) await admin(`update wallet set initial_capital_cents = initial_capital_cents - 50000000 where tenant_id='ten_roberio'`);
  else await admin(`delete from wallet where id='wal_g13'`);
});

test("G14. política de crédito: o dono salva os limites, campo vazio = sem limite, valores inválidos são recusados e a gerente não alcança", async () => {
  const ownerCookie = await apiLogin("roberio@teste.local");
  const save = (fields) => action(ownerCookie, "saveCreditPolicyAction", fields, "/");
  const good = await save({ maxExposurePerCpf: "50.000,00", maxTermMonths: "24", maxContract: "20.000,00", minRate: "7,5" });
  assert.equal(good.result?.ok, true, JSON.stringify(good));
  const row = await admin(`select max_exposure_per_cpf_cents e, max_term_months t, max_contract_cents c, min_rate_bps r from credit_policy where tenant_id='ten_roberio'`);
  assert.deepEqual([Number(row[0].e), row[0].t, Number(row[0].c), row[0].r], [5000000, 24, 2000000, 750]);
  // Taxa de juros padrão (sugerida na oferta e no simulador): 30% = 3000 bps; não pode ficar abaixo da mínima.
  assert.equal((await save({ minRate: "7,5", defaultRate: "30" })).result?.ok, true);
  assert.equal(Number(await one(`select default_rate_bps from credit_policy where tenant_id='ten_roberio'`)), 3000);
  assert.equal((await save({ minRate: "7,5", defaultRate: "5" })).result?.ok, false, "padrão abaixo da mínima");
  assert.equal((await save({ defaultRate: "abc" })).result?.ok, false);
  assert.equal(Number(await one(`select default_rate_bps from credit_policy where tenant_id='ten_roberio'`)), 3000, "recusa não altera");
  assert.equal((await save({ maxExposurePerCpf: "50.000,00", maxTermMonths: "24", maxContract: "20.000,00", minRate: "7,5" })).result?.ok, true);
  assert.equal(await one(`select default_rate_bps from credit_policy where tenant_id='ten_roberio'`), null, "vazio = sem taxa padrão");
  assert.equal(await one(`select count(*) from admin_audit_log where action='CREDIT_POLICY_UPDATED'`) >= 1, true, "auditado");
  for (const bad of [{ maxTermMonths: "0" }, { maxTermMonths: "abc" }, { maxContract: "-5" }, { maxExposurePerCpf: "xx" }, { minRate: "abc" }]) {
    const res = await save(bad);
    assert.equal(res.result?.ok, false, JSON.stringify(bad));
  }
  const cleared = await save({});
  assert.equal(cleared.result?.ok, true);
  assert.equal(await one(`select count(*) from credit_policy where tenant_id='ten_roberio' and max_term_months is null and max_contract_cents is null and max_exposure_per_cpf_cents is null and min_rate_bps is null`), 1);
  assert.equal(await one(`select count(*) from credit_policy where tenant_id='ten_roberio'`), 1, "uma política por carteira");
  await save({ maxExposurePerCpf: "50.000,00", maxTermMonths: "24", maxContract: "20.000,00", minRate: "7,5" });
  const ownerPage = await signIn("roberio@teste.local");
  await ownerPage.goto(`${BASE}/?tela=politica-de-credito`);
  await ownerPage.getByRole("heading", { name: "Política de crédito" }).first().waitFor();
  assert.equal(await ownerPage.locator('input[name="maxTermMonths"]').inputValue(), "24");
  assert.equal(await ownerPage.locator('input[name="minRate"]').inputValue(), "7,5");
  if (SHOTS) await ownerPage.screenshot({ path: `${SHOTS}/dono-politica-de-credito.png` });
  await admin(`delete from credit_policy where tenant_id='ten_roberio'`);
});

test("G15. esteira de crédito: cadastra proposta, avança e volta de fase, reprova com motivo, valida campos e a gerente não alcança", async () => {
  const ownerCookie = await apiLogin("roberio@teste.local");
  const create = (fields) => action(ownerCookie, "createCreditProposalAction", fields, "/");
  const base = { applicantName: "Maria Fictícia da Silva", cpf: "529.982.247-25", requested: "5.000,00", termMonths: "12", email: "maria@ficticio.local", phone: "(11) 98765-4321" };
  for (const bad of [{ applicantName: "Al" }, { cpf: "111.111.111-11" }, { requested: "0" }, { termMonths: "0" }, { termMonths: "400" }, { email: "sem-arroba" }, { phone: "123" }, { installment: "abc" }, { installment: "0,00" }, { installment: "100,00" }]) {
    assert.equal((await create({ ...base, ...bad })).result?.ok, false, JSON.stringify(bad));
  }
  assert.equal(await one(`select count(*) from credit_proposal`), 0);
  // Parcela negociada (opcional): R$ 520 x 12 = R$ 6.240 para R$ 5.000 pedidos.
  const ok = await create({ ...base, installment: "520,00" });
  assert.equal(ok.result?.ok, true, JSON.stringify(ok));
  const proposalId = await one(`select id from credit_proposal where tenant_id='ten_roberio'`);
  assert.equal(Number(await one(`select negotiated_installment_cents from credit_proposal where id='${proposalId}'`)), 52000);
  assert.equal(await one(`select phase from credit_proposal where id='${proposalId}'`), "RECEIVED");
  const move = (direction) => actionArgs(ownerCookie, "moveCreditProposalAction", [proposalId, direction]);
  assert.equal((await move("back")).result?.ok, false, "não volta da primeira fase");
  for (const phase of ["IDENTITY", "DOCUMENTS", "CAPACITY", "ENGINE", "APPROVAL", "ACCEPTANCE"]) {
    // A fase de identidade só libera o avanço com a conferência completa.
    if (phase === "DOCUMENTS") assert.equal((await actionArgs(ownerCookie, "saveProposalReviewAction", [proposalId, { documentChecked: true, holderChecked: true, noFraudSigns: true }, ""])).result?.ok, true);
    if (phase === "ENGINE") assert.equal((await actionArgs(ownerCookie, "saveProposalReviewAction", [proposalId, { regularIncome: true, noOverdraft: true, noSuspiciousActivity: true, capacityConfirmed: true }, ""])).result?.ok, true);
    if (phase === "CAPACITY") assert.equal((await actionArgs(ownerCookie, "saveProposalReviewAction", [proposalId, { bankStatementChecked: true, payslipChecked: true, incomeMatches: true }, ""])).result?.ok, true);
    // Aprovação e oferta: sem oferta salva não passa para o aceite.
    if (phase === "ACCEPTANCE") {
      assert.equal((await move("next")).result?.ok, false, "sem oferta não avança");
      assert.equal((await actionArgs(ownerCookie, "saveProposalOfferAction", [proposalId, "100,00", "3", "7,5"])).result?.ok, true);
    }
    assert.equal((await move("next")).result?.ok, true);
    assert.equal(await one(`select phase from credit_proposal where id='${proposalId}'`), phase);
  }
  assert.equal((await move("next")).result?.ok, false, "não avança da última fase");
  assert.equal((await move("back")).result?.ok, true);
  assert.equal(await one(`select phase from credit_proposal where id='${proposalId}'`), "APPROVAL");
  assert.equal((await move("sideways")).result?.ok, false);
  const ownerPage = await signIn("roberio@teste.local", PASSWORD, { width: 1600, height: 900 });
  await ownerPage.goto(`${BASE}/?tela=esteira-de-credito`);
  await ownerPage.getByRole("region", { name: "Aprovação e oferta" }).getByText("Maria Fictícia da Silva").waitFor();
  assert.match(await ownerPage.getByRole("region", { name: "Aprovação e oferta" }).innerText(), /Parcela negociada R\$\s*520,00/);
  assert.equal(await ownerPage.locator(".pipeline-column").count(), 7, "7 fases");
  if (SHOTS) await ownerPage.screenshot({ path: `${SHOTS}/dono-esteira-de-credito.png` });
  assert.equal((await actionArgs(ownerCookie, "rejectCreditProposalAction", [proposalId, "  "])).result?.ok, false, "motivo obrigatório");
  assert.equal((await actionArgs(ownerCookie, "rejectCreditProposalAction", [proposalId, "Renda insuficiente"])).result?.ok, true);
  assert.equal(await one(`select status from credit_proposal where id='${proposalId}'`), "REJECTED");
  assert.equal((await move("next")).result?.ok, false, "reprovada não anda");
  assert.equal(await one(`select count(*) from admin_audit_log where action in ('CREDIT_PROPOSAL_REGISTERED','CREDIT_PROPOSAL_MOVED','CREDIT_PROPOSAL_REJECTED')`) >= 9, true, "tudo auditado");
  await admin(`delete from credit_proposal where tenant_id='ten_roberio'`);
});

test("G16. portal do cliente: link da carteira, conta própria, dados + 4 documentos, só então a proposta entra na esteira", async () => {
  const ownerCookie = await apiLogin("roberio@teste.local");
  const link = (mode) => actionArgs(ownerCookie, "manageProposalLinkAction", [mode]);
  assert.equal((await link("disable")).result?.ok, false, "sem link ativo");
  assert.equal((await link("create")).result?.ok, true);
  const token = await one(`select token from proposal_link where tenant_id='ten_roberio' and enabled`);
  const pdf = (name) => ({ name, mimeType: "application/pdf", buffer: Buffer.from(`%PDF-1.4\n% ${name}\n%%EOF`) });
  const context = await browser.newContext({ viewport: { width: 900, height: 1100 } });
  const page = await context.newPage();
  await page.goto(`${BASE}/proposta/invalido-invalido-invalido`);
  await page.getByRole("heading", { name: "Link indisponível" }).waitFor();
  await page.goto(`${BASE}/proposta/${token}`);
  await page.getByRole("heading", { name: "Crie sua conta" }).waitFor();
  await page.getByLabel("Nome completo").fill("Joana Fictícia Teste");
  await page.getByLabel("E-mail").fill("joana@ficticio.local");
  await page.getByLabel(/Senha/).fill("curta");
  await page.getByRole("button", { name: /Criar conta/ }).click();
  await page.waitForTimeout(800);
  assert.equal(await one(`select count(*) from proposal_applicant`), 0, "senha curta recusada");
  await page.getByLabel(/Senha/).fill("senha-segura-123");
  await page.getByRole("button", { name: /Criar conta/ }).click();
  await page.getByRole("heading", { name: /Olá, Joana/ }).waitFor();
  assert.equal(await one(`select count(*) from proposal_applicant where tenant_id='ten_roberio'`), 1);
  assert.notEqual(await one(`select password_hash from proposal_applicant`), "senha-segura-123", "senha não fica em texto");
  // Nada de proposta na esteira antes de completar: o rascunho nem aparece para o dono.
  await page.getByLabel("CPF").fill("52998224725");
  await page.getByLabel(/Telefone/).fill("11987654321");
  await page.getByLabel(/Renda mensal/).fill("3.500,00");
  await page.getByLabel(/Valor que você precisa/).fill("5.000,00");
  await page.getByLabel(/Prazo desejado/).fill("12");
  await page.getByRole("button", { name: /Salvar e continuar/ }).click();
  await page.getByRole("heading", { name: /Passo 2 de 3/ }).waitFor();
  assert.equal(await one(`select status from credit_proposal where source='APPLICANT'`), "DRAFT");
  assert.equal(await page.getByRole("button", { name: /Envie os 4 documentos/ }).isDisabled(), true);
  // Arquivo que não é PDF/imagem é recusado; PDFs válidos entram um a um.
  await page.getByLabel("Comprovante de residência").setInputFiles({ name: "x.txt", mimeType: "text/plain", buffer: Buffer.from("texto") });
  await page.getByText(/Envie um PDF ou uma imagem/).waitFor();
  const labels = ["Documento de identidade (RG ou CNH)", "Comprovante de residência", "Extrato bancário (últimos 3 meses)", "Holerite (último)"];
  for (const [index, label] of labels.entries()) {
    await page.getByLabel(label).setInputFiles(pdf(`doc${index}.pdf`));
    await poll(`select count(*) from credit_proposal_document`, index + 1);
    if (index < 3) assert.equal(await page.getByRole("button", { name: /Envie os 4 documentos/ }).isDisabled(), true);
  }
  await page.getByRole("button", { name: "Enviar proposta" }).waitFor();
  const board = await get(ownerCookie, "/");
  assert.equal(String(await board.text()).includes("Joana Fictícia Teste"), false, "rascunho não aparece na esteira");
  await page.getByRole("button", { name: "Enviar proposta" }).click();
  await page.getByText(/Proposta enviada/).first().waitFor();
  assert.equal(await one(`select status||'/'||phase from credit_proposal where source='APPLICANT'`), "OPEN/RECEIVED");
  // O dono vê a proposta na fase 1, com os 4 documentos baixáveis.
  const ownerPage = await signIn("roberio@teste.local", PASSWORD, { width: 1600, height: 1000 });
  await ownerPage.goto(`${BASE}/?tela=esteira-de-credito`);
  const received = ownerPage.getByRole("region", { name: "Proposta recebida" });
  await received.getByText("Joana Fictícia Teste").waitFor();
  assert.equal(await received.locator(".pipeline-docs a").count(), 4);
  assert.match(await received.innerText(), /enviada pelo cliente/);
  const docId = await one(`select id from credit_proposal_document limit 1`);
  const download = await get(ownerCookie, `/esteira/documento/${docId}`);
  assert.equal(download.status, 200);
  assert.equal((await get("", `/esteira/documento/${docId}`)).status === 200, false, "sem login não baixa");
  if (SHOTS) { await ownerPage.screenshot({ path: `${SHOTS}/dono-esteira-proposta-cliente.png` }); await page.screenshot({ path: `${SHOTS}/cliente-portal-proposta.png` }); }
  // Entrar de novo com a mesma conta; senha errada é recusada; outro link/tenant não enxerga esta conta.
  const context2 = await browser.newContext();
  const page2 = await context2.newPage();
  await page2.goto(`${BASE}/proposta/${token}`);
  await page2.getByRole("button", { name: /Já tenho conta/ }).click();
  await page2.getByLabel("E-mail").fill("joana@ficticio.local");
  await page2.getByLabel("Senha").fill("errada-errada");
  await page2.getByRole("button", { name: /Entrar/ }).click();
  await page2.getByText("E-mail ou senha incorretos.").waitFor();
  await page2.getByLabel("Senha").fill("senha-segura-123");
  await page2.getByRole("button", { name: /Entrar/ }).click();
  await page2.getByText(/Proposta enviada/).first().waitFor();
  // Fase 7: com a oferta aprovada, o cliente vê as condições no portal e aceita; a resposta vale uma vez e é auditada.
  const operationsBefore = await one(`select count(*) from loan_operation where tenant_id='ten_roberio'`);
  const portalProposal = await one(`select id from credit_proposal where source='APPLICANT'`);
  await admin(`update credit_proposal set phase='ACCEPTANCE', offer_cents=200000, offer_term_months=6, offer_rate_bps=800, offered_at=now() where id='${portalProposal}'`);
  await page2.reload();
  const offerBox = page2.getByLabel("Oferta aprovada");
  await offerBox.getByText("Parcela mensal").waitFor();
  assert.match(await offerBox.innerText(), /R\$\s*2\.000,00/);
  assert.match(await offerBox.innerText(), /6 meses/);
  assert.match(await offerBox.innerText(), /R\$\s*493,34/, "parcela = (2.000 + 6 x 8% = 2.960) / 6, arredondada para cima");
  if (SHOTS) await page2.screenshot({ path: `${SHOTS}/cliente-portal-oferta.png` });
  await page2.getByRole("button", { name: /Aceitar oferta/ }).click();
  await page2.getByText("Confirmar o aceite desta oferta?").waitFor();
  assert.equal(await one(`select accepted_at is null from credit_proposal where id='${portalProposal}'`), true, "só confirma no segundo clique");
  await page2.getByRole("button", { name: "Sim, aceitar" }).click();
  await page2.getByText(/Oferta aceita em/).waitFor();
  assert.equal(await one(`select accepted_via from credit_proposal where id='${portalProposal}'`), "APPLICANT");
  assert.equal(await one(`select count(*) from admin_audit_log where action='CREDIT_PROPOSAL_ACCEPTED'`), 1, "aceite auditado");
  // Já aceita: o dono não volta nem reprova, e nada de capital ou contrato foi criado.
  assert.match(String((await actionArgs(ownerCookie, "moveCreditProposalAction", [portalProposal, "back"])).result?.error), /já aceitou/);
  assert.match(String((await actionArgs(ownerCookie, "rejectCreditProposalAction", [portalProposal, "motivo"])).result?.error), /já aceitou/);
  assert.equal((await actionArgs(ownerCookie, "registerOfferAcceptanceAction", [portalProposal])).result?.ok, false, "proposta do portal só o cliente aceita");
  assert.equal(await one(`select count(*) from loan_operation where tenant_id='ten_roberio'`), operationsBefore, "aceitar não cria contrato");
  await ownerPage.goto(`${BASE}/?tela=esteira-de-credito`);
  await ownerPage.getByRole("region", { name: "Aceite do cliente" }).getByText(/Aceita pelo cliente em/).waitFor();
  if (SHOTS) await ownerPage.screenshot({ path: `${SHOTS}/dono-esteira-fase7.png` });
  // Gerar novo link invalida o antigo e a sessão antiga.
  assert.equal((await link("rotate")).result?.ok, true);
  await page2.goto(`${BASE}/proposta/${token}`);
  await page2.getByRole("heading", { name: "Link indisponível" }).waitFor();
  assert.equal(await one(`select count(*) from proposal_applicant a join tenant t on t.id=a.tenant_id where a.tenant_id <> 'ten_roberio'`), 0, "nada em outro tenant");
  // A gerente não alcança o gerenciamento do link.
  assert.equal((await actionArgs(await apiLogin(EMAIL, NEW_PASSWORD), "manageProposalLinkAction", ["create"])).result?.ok === true, false);
  await context.close(); await context2.close();
  await admin(`delete from credit_proposal where tenant_id='ten_roberio'`);
  await admin(`delete from proposal_applicant where tenant_id='ten_roberio'`);
  await admin(`delete from proposal_link where tenant_id='ten_roberio'`);
});

test("G17. fase 2 (identidade e antifraude): só avança com a conferência completa; registra e audita; a gerente não alcança", async () => {
  const ownerCookie = await apiLogin("roberio@teste.local");
  const created = await action(ownerCookie, "createCreditProposalAction", { applicantName: "Carla Fictícia Teste", cpf: "529.982.247-25", requested: "3.000,00", termMonths: "6" }, "/");
  assert.equal(created.result?.ok, true, JSON.stringify(created));
  const proposalId = await one(`select id from credit_proposal where tenant_id='ten_roberio'`);
  const move = (direction) => actionArgs(ownerCookie, "moveCreditProposalAction", [proposalId, direction]);
  const review = (checks, note = "") => actionArgs(ownerCookie, "saveProposalReviewAction", [proposalId, checks, note]);
  assert.equal((await review({ documentChecked: true })).result?.ok, false, "fase 1 não tem conferência");
  assert.equal((await move("next")).result?.ok, true);
  assert.equal(await one(`select phase from credit_proposal where id='${proposalId}'`), "IDENTITY");
  // Sem conferência, ou incompleta, não avança.
  assert.equal((await move("next")).result?.ok, false);
  const partial = await review({ documentChecked: true, holderChecked: true }, "extrato ilegível");
  assert.equal(partial.result?.ok, true);
  assert.equal(await one(`select completed from credit_proposal_review where proposal_id='${proposalId}'`), false);
  const blocked = await move("next");
  assert.equal(blocked.result?.ok, false);
  assert.match(String(blocked.result?.error), /Conclua a conferência/);
  assert.equal(await one(`select phase from credit_proposal where id='${proposalId}'`), "IDENTITY");
  // Itens desconhecidos são ignorados; só os itens da fase contam.
  const full = await review({ documentChecked: true, holderChecked: true, noFraudSigns: true, injected: true }, "tudo certo");
  assert.equal(full.result?.ok, true);
  assert.equal(await one(`select completed from credit_proposal_review where proposal_id='${proposalId}'`), true);
  assert.equal(await one(`select count(*) from credit_proposal_review where proposal_id='${proposalId}'`), 1, "uma conferência por fase");
  assert.equal(await one(`select (checks ? 'injected') from credit_proposal_review where proposal_id='${proposalId}'`), false);
  // A tela mostra a conferência; o botão só habilita com a conferência salva.
  const ownerPage = await signIn("roberio@teste.local", PASSWORD, { width: 1700, height: 1000 });
  await ownerPage.goto(`${BASE}/?tela=esteira-de-credito`);
  const column = ownerPage.getByRole("region", { name: "Identidade e antifraude" });
  await column.getByText("Carla Fictícia Teste").waitFor();
  assert.equal(await column.getByRole("checkbox").count(), 3);
  assert.equal(await column.getByRole("button", { name: "Avançar fase" }).isDisabled(), false);
  if (SHOTS) await ownerPage.screenshot({ path: `${SHOTS}/dono-esteira-fase2.png` });
  // Desmarcar um item e salvar de novo volta a travar.
  assert.equal((await review({ documentChecked: true, holderChecked: true, noFraudSigns: false })).result?.ok, true);
  assert.equal((await move("next")).result?.ok, false);
  assert.equal(await review({ documentChecked: true, holderChecked: true, noFraudSigns: true }).then((r) => r.result?.ok), true);
  assert.equal((await move("next")).result?.ok, true);
  assert.equal(await one(`select phase from credit_proposal where id='${proposalId}'`), "DOCUMENTS");
  // Fase 3 (documentação validada): mesma regra, com os itens de extrato e holerite.
  assert.equal((await move("next")).result?.ok, false, "sem conferência da documentação não avança");
  assert.equal((await review({ documentChecked: true, holderChecked: true, noFraudSigns: true })).result?.ok, true);
  assert.equal(await one(`select completed from credit_proposal_review where proposal_id='${proposalId}' and phase='DOCUMENTS'`), false, "itens da fase 2 não valem na fase 3");
  assert.equal((await move("next")).result?.ok, false);
  assert.equal((await review({ bankStatementChecked: true, payslipChecked: true, incomeMatches: true }, "renda confere")).result?.ok, true);
  assert.equal(await one(`select count(*) from credit_proposal_review where proposal_id='${proposalId}'`), 2, "uma conferência por fase");
  assert.equal(await one(`select completed from credit_proposal_review where proposal_id='${proposalId}' and phase='IDENTITY'`), true, "a da fase 2 continua guardada");
  assert.equal((await move("next")).result?.ok, true);
  assert.equal(await one(`select phase from credit_proposal where id='${proposalId}'`), "CAPACITY");
  // Fase 4 (capacidade de pagamento): quatro itens sobre a movimentação bancária.
  assert.equal((await move("next")).result?.ok, false, "sem análise da movimentação não avança");
  assert.equal((await review({ regularIncome: true, noOverdraft: true, noSuspiciousActivity: true })).result?.ok, true);
  assert.equal(await one(`select completed from credit_proposal_review where proposal_id='${proposalId}' and phase='CAPACITY'`), false, "faltou um item");
  assert.equal((await move("next")).result?.ok, false);
  assert.equal((await review({ regularIncome: true, noOverdraft: true, noSuspiciousActivity: true, capacityConfirmed: true }, "movimentação ok")).result?.ok, true);
  assert.equal(await one(`select count(*) from credit_proposal_review where proposal_id='${proposalId}'`), 3);
  assert.equal((await move("next")).result?.ok, true);
  assert.equal(await one(`select phase from credit_proposal where id='${proposalId}'`), "ENGINE");
  assert.equal((await review({ regularIncome: true })).result?.ok, false, "fase 5 ainda sem conferência definida");
  assert.equal(await one(`select count(*) from admin_audit_log where action='CREDIT_PROPOSAL_REVIEWED'`) >= 8, true, "conferências auditadas");
  const managerCookie2 = await apiLogin(EMAIL, NEW_PASSWORD);
  assert.equal((await actionArgs(managerCookie2, "saveProposalReviewAction", [proposalId, { documentChecked: true }, ""])).result?.ok === true, false);
  await admin(`delete from credit_proposal where tenant_id='ten_roberio'`);
});

test("G18. fase 5 (motor de crédito): confere a proposta contra a política (contrato, prazo, exposição por CPF) e só avança dentro dela", async () => {
  const ownerCookie = await apiLogin("roberio@teste.local");
  const save = (fields) => action(ownerCookie, "saveCreditPolicyAction", fields, "/");
  const created = await action(ownerCookie, "createCreditProposalAction", { applicantName: "Davi Fictício Teste", cpf: "111.444.777-35", requested: "3.000,00", termMonths: "6" }, "/");
  assert.equal(created.result?.ok, true, JSON.stringify(created));
  const proposalId = await one(`select id from credit_proposal where tenant_id='ten_roberio'`);
  await admin(`update credit_proposal set phase='ENGINE' where id='${proposalId}'`);
  const move = () => actionArgs(ownerCookie, "moveCreditProposalAction", [proposalId, "next"]);
  const phase = () => one(`select phase from credit_proposal where id='${proposalId}'`);
  // Sem política: nada a conferir, avança.
  await admin(`delete from credit_policy where tenant_id='ten_roberio'`);
  // Limite por contrato abaixo do pedido: recusa e explica.
  assert.equal((await save({ maxContract: "2.000,00" })).result?.ok, true);
  const contract = await move();
  assert.equal(contract.result?.ok, false);
  assert.match(String(contract.result?.error), /Limite por contrato/);
  assert.equal(await phase(), "ENGINE");
  // Prazo acima do limite.
  assert.equal((await save({ maxContract: "5.000,00", maxTermMonths: "4" })).result?.ok, true);
  assert.match(String((await move()).result?.error), /Prazo máximo/);
  // Exposição por CPF: um contrato em aberto do mesmo CPF (outro formato de máscara) entra na soma.
  await admin(`insert into client (id, tenant_id, name, document) values ('cli_g18', 'ten_roberio', 'Davi Fictício Teste', '111.444.777-35')`);
  await admin(`insert into loan_operation (id, tenant_id, client_id, principal_cents, interest_rate_bps, interest_cents, total_cents, loan_date, due_date, calculation_rule) values ('op_g18', 'ten_roberio', 'cli_g18', 400000, 1000, 40000, 440000, '2026-10-01', '2026-11-01', 'FIXED')`);
  assert.equal((await save({ maxContract: "5.000,00", maxTermMonths: "12", maxExposurePerCpf: "6.000,00" })).result?.ok, true);
  const exposure = await move();
  assert.equal(exposure.result?.ok, false);
  assert.match(String(exposure.result?.error), /Exposição máxima por CPF/);
  // A tela mostra as regras e trava o botão.
  const ownerPage = await signIn("roberio@teste.local", PASSWORD, { width: 1700, height: 1000 });
  await ownerPage.goto(`${BASE}/?tela=esteira-de-credito`);
  const column = ownerPage.getByRole("region", { name: "Motor de crédito" });
  await column.getByText("Davi Fictício Teste").waitFor();
  await column.getByText("Exposição máxima por CPF:").waitFor();
  assert.equal(await column.getByRole("button", { name: "Avançar fase" }).isDisabled(), true);
  if (SHOTS) await ownerPage.screenshot({ path: `${SHOTS}/dono-esteira-fase5.png` });
  // Dentro dos limites avança (o contrato em aberto é só de 4.000 + 3.000 = 7.000 → limite sobe para 8.000).
  assert.equal((await save({ maxContract: "5.000,00", maxTermMonths: "12", maxExposurePerCpf: "8.000,00" })).result?.ok, true);
  assert.equal((await move()).result?.ok, true);
  assert.equal(await phase(), "APPROVAL");
  // Fase 6: oferta aprovada. Só na fase certa, até o valor pedido, e o motor reconfere (taxa mínima, exposição).
  const offer = (approved, term, rate) => actionArgs(ownerCookie, "saveProposalOfferAction", [proposalId, approved, term, rate]);
  assert.equal((await save({ maxContract: "5.000,00", maxTermMonths: "12", maxExposurePerCpf: "8.000,00", minRate: "7,5", defaultRate: "30" })).result?.ok, true);
  await ownerPage.reload();
  const approval = ownerPage.getByRole("region", { name: "Aprovação e oferta" });
  await approval.getByLabel("Taxa de juros ao mês").waitFor();
  assert.equal(await approval.getByLabel("Taxa de juros ao mês").inputValue(), "30", "a taxa padrão já vem preenchida na oferta");
  if (SHOTS) await ownerPage.screenshot({ path: `${SHOTS}/dono-esteira-fase6.png` });
  assert.equal((await move()).result?.ok, false, "sem oferta não avança para o aceite");
  assert.match(String((await offer("3.500,00", "6", "8")).result?.error), /valor pedido/);
  assert.match(String((await offer("2.000,00", "6", "5")).result?.error), /Taxa de juros mínima/);
  assert.match(String((await offer("2.000,00", "13", "8")).result?.error), /Prazo máximo/);
  assert.equal((await offer("2.000,00", "6", "abc")).result?.ok, false);
  assert.equal(await one(`select count(*) from credit_proposal where id='${proposalId}' and offer_cents is not null`), 0, "oferta recusada não grava");
  const okOffer = await offer("2.000,00", "6", "8");
  assert.equal(okOffer.result?.ok, true, JSON.stringify(okOffer));
  const saved = (await admin(`select offer_cents c, offer_term_months t, offer_rate_bps r from credit_proposal where id='${proposalId}'`))[0];
  assert.deepEqual([Number(saved.c), saved.t, Number(saved.r)], [200000, 6, 800]);
  assert.equal(await one(`select count(*) from admin_audit_log where action='CREDIT_PROPOSAL_REVIEWED' and description like '%oferta aprovada%'`) >= 1, true, "oferta auditada");
  const managerOffer = await actionArgs(await apiLogin(EMAIL, NEW_PASSWORD), "saveProposalOfferAction", [proposalId, "1.000,00", "6", "8"]);
  assert.equal(managerOffer.result?.ok === true, false, "a gerente não alcança");
  // Uma taxa mínima maior depois da oferta também barra o avanço.
  assert.equal((await save({ maxContract: "5.000,00", maxTermMonths: "12", maxExposurePerCpf: "8.000,00", minRate: "9" })).result?.ok, true);
  assert.match(String((await move()).result?.error), /Taxa de juros mínima/);
  assert.equal((await save({ maxContract: "5.000,00", maxTermMonths: "12", maxExposurePerCpf: "8.000,00", minRate: "7,5" })).result?.ok, true);
  assert.equal((await move()).result?.ok, true);
  assert.equal(await phase(), "ACCEPTANCE");
  await admin(`delete from loan_operation where id='op_g18'`);
  await admin(`delete from client where id='cli_g18'`);
  await admin(`delete from credit_policy where tenant_id='ten_roberio'`);
  await admin(`delete from credit_proposal where tenant_id='ten_roberio'`);
});

test("G19. fase 7 (aceite do cliente): o dono registra o aceite de proposta própria; recusa reprova; só vale uma vez; gerente não alcança", async () => {
  const ownerCookie = await apiLogin("roberio@teste.local");
  const create = (name) => action(ownerCookie, "createCreditProposalAction", { applicantName: name, cpf: "529.982.247-25", requested: "3.000,00", termMonths: "6" }, "/");
  assert.equal((await create("Eva Fictícia Teste")).result?.ok, true);
  const proposalId = await one(`select id from credit_proposal where tenant_id='ten_roberio'`);
  const accept = () => actionArgs(ownerCookie, "registerOfferAcceptanceAction", [proposalId]);
  assert.equal((await accept()).result?.ok, false, "sem oferta e fora da fase de aceite não aceita");
  await admin(`update credit_proposal set phase='ACCEPTANCE' where id='${proposalId}'`);
  assert.equal((await accept()).result?.ok, false, "sem oferta salva não aceita");
  await admin(`update credit_proposal set offer_cents=100000, offer_term_months=3, offer_rate_bps=3000, offered_at=now() where id='${proposalId}'`);
  assert.equal((await accept()).result?.ok, true);
  assert.equal(await one(`select accepted_via from credit_proposal where id='${proposalId}'`), "OWNER");
  assert.equal((await accept()).result?.ok, false, "só uma vez");
  assert.equal((await actionArgs(await apiLogin(EMAIL, NEW_PASSWORD), "registerOfferAcceptanceAction", [proposalId])).result?.ok === true, false, "a gerente não alcança");
  // Regra do banco: aceite sem oferta é impossível.
  await assert.rejects(admin(`update credit_proposal set accepted_at=now(), accepted_via='OWNER', offer_cents=null, offer_term_months=null, offer_rate_bps=null, offered_at=null where id='${proposalId}'`));
  await admin(`delete from credit_proposal where tenant_id='ten_roberio'`);
  // Recusa pelo cliente (aqui via portal simulado no banco não existe: o dono reprova com motivo, e proposta recusada não aceita mais).
  assert.equal((await create("Fábio Fictício Teste")).result?.ok, true);
  const second = await one(`select id from credit_proposal where tenant_id='ten_roberio'`);
  await admin(`update credit_proposal set phase='ACCEPTANCE', offer_cents=100000, offer_term_months=3, offer_rate_bps=3000, offered_at=now() where id='${second}'`);
  assert.equal((await actionArgs(ownerCookie, "rejectCreditProposalAction", [second, "Cliente desistiu"])).result?.ok, true);
  assert.equal((await actionArgs(ownerCookie, "registerOfferAcceptanceAction", [second])).result?.ok, false, "recusada não aceita");
  await admin(`delete from credit_proposal where tenant_id='ten_roberio'`);
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
    ["uploadClientDocumentAction", { clientId: "c_g_ana" }, "/"], ["saveCreditPolicyAction", { maxContract: "1,00" }, "/"], ["createCreditProposalAction", { applicantName: "Fulano Teste", cpf: "52998224725", requested: "100,00", termMonths: "3" }, "/"], ["createOperationAction", { clientId: "c_g_ana", modality: "SINGLE", frequency: "MONTHLY", principal: "100,00", rate: "10", loanDate: TODAY, dueDate: day(30) }, "/"], ["createManagerAccessAction", { managerId: await one(`select id from account_manager where name='Gabrielle Teste'`), email: "outro@teste.local" }, "/gerentes"],
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
