// Formulário público da proposta com o cadastro completo de Clientes (migração 0060), de ponta a ponta: servidor + banco + telas.
// SÓ em ambiente LOCAL e DESCARTÁVEL (ver tests/e2e/README.md): cria propostas e clientes fictícios nos tenants de teste.
//   E2E_DATABASE_URL=… PLAYWRIGHT_MODULE=… node --test tests/e2e/formulario-publico.e2e.mjs
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
const PASSWORD = process.env.E2E_PASSWORD ?? "Senha-Teste-Local-123";
const PHONE = { width: 390, height: 844 };

let lastLogin = 0;
async function throttle() { const wait = 11_000 - (Date.now() - lastLogin); if (wait > 0) await sleep(wait); lastLogin = Date.now(); }
async function signIn(email, viewport = { width: 1600, height: 1000 }) {
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
const parse = async (response) => { const result = (await response.text()).match(/^1:(\{.*\})$/m)?.[1]; return { status: response.status, result: result ? JSON.parse(result) : null }; };
// Ação com argumentos de texto.
const actionArgs = async (cookie, name, args, path = "/") => parse(await fetch(`${BASE}${path}`, { method: "POST", redirect: "manual", headers: { cookie, "next-action": actionId(name), accept: "text/x-component", origin: BASE, "content-type": "text/plain;charset=UTF-8" }, body: JSON.stringify(args) }));
// Ação com argumentos de texto seguidos de um FormData (o último argumento).
async function actionForm(cookie, name, args, fields, path) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(`_${args.length + 1}_${key}`, value);
  form.append("0", JSON.stringify([...args, `$K${args.length + 1}`]));
  return parse(await fetch(`${BASE}${path}`, { method: "POST", redirect: "manual", headers: { cookie, "next-action": actionId(name), accept: "text/x-component", origin: BASE }, body: form }));
}
const pdf = (name) => ({ name, mimeType: "application/pdf", buffer: Buffer.from(`%PDF-1.4\n% ${name}\n%%EOF`) });
const DOCS = ["Documento de identidade (RG ou CNH)", "Comprovante de residência", "Extrato bancário (últimos 3 meses)", "Holerite (último)"];
const noHorizontalScroll = async (page) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, "sem rolagem horizontal");
const clientHash = (tenant) => one(`select md5(coalesce(string_agg(row(c.*)::text, '|' order by id), '')) from client c where tenant_id = '${tenant}'`);

// CPFs fictícios válidos.
const CPF_NEW = "11144477735";      // cliente novo: o envio cria o cadastro
const CPF_EXISTING = "39053344705"; // já é cliente da carteira A: o envio atualiza, sem duplicar
const CPF_OTHER = "52998224725";

async function ownerProposal(cookie, fields) {
  const response = await actionForm(cookie, "createCreditProposalAction", [], { applicantName: fields.name, cpf: fields.cpf, requested: "5.000,00", termMonths: "10", rate: "", installment: "", email: fields.email ?? "", phone: fields.phone ?? "" }, "/");
  assert.equal(response.result?.ok, true, JSON.stringify(response.result));
  return one(`select id from credit_proposal where tenant_id='ten_roberio' and cpf='${fields.cpf}' order by created_at desc limit 1`);
}

test("FP1. dono gera o link da proposta: dados já vêm preenchidos, CPF protege o acesso e o cadastro completo vai para Clientes", async () => {
  const owner = await apiLogin("roberio@teste.local");
  const proposalId = await ownerProposal(owner, { name: "Marina Fictícia Souza", cpf: CPF_NEW, email: "marina@ficticio.local", phone: "(11) 98888-7777" });
  // Outra carteira não gera link nem vê a proposta; a gerente/usuário de B recebe "não encontrada".
  const other = await apiLogin("fernando@teste.local");
  assert.equal((await actionArgs(other, "manageProposalFillLinkAction", [proposalId, "create"])).result?.ok, false, "tenant B não gera link de proposta do A");
  assert.equal(await one(`select fill_token is null from credit_proposal where id='${proposalId}'`), true);
  assert.equal((await actionArgs(owner, "manageProposalFillLinkAction", [proposalId, "create"])).result?.ok, true);
  const token = await one(`select fill_token from credit_proposal where id='${proposalId}'`);
  assert.equal(token.length >= 32, true, "link com segredo longo");
  assert.equal(await one(`select count(*) from admin_audit_log where action='CREDIT_PROPOSAL_FILL_LINK_CHANGED' and entity_id='${proposalId}'`), 1, "geração auditada");

  // Link inválido e link sem CPF confirmado não mostram nada da proposta.
  const anonymous = await (await fetch(`${BASE}/completar/${token}`)).text();
  assert.equal(anonymous.includes("Marina") || anonymous.includes("111.444") || anonymous.includes("marina@"), false, "sem CPF confirmado a página não mostra dados");
  const context = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto(`${BASE}/completar/link-que-nao-existe-1234567`);
  await page.getByRole("heading", { name: "Link indisponível" }).waitFor();
  await page.goto(`${BASE}/completar/${token}`);
  await page.getByRole("heading", { name: "Complete sua proposta" }).waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/celular-1-confirmar-cpf.png`, fullPage: true });
  // CPF errado: recusado e contado; 5 erros travam o link (mesmo com o CPF certo depois).
  for (let attempt = 1; attempt <= 5; attempt++) {
    await page.getByLabel("Seu CPF").fill(CPF_OTHER);
    await page.getByRole("button", { name: "Continuar" }).click();
    await page.getByText("O CPF não confere com o da proposta.").waitFor();
    for (let i = 0; i < 40 && String(await one(`select case when fill_locked_until is not null then 5 else fill_failed_attempts end from credit_proposal where id='${proposalId}'`)) !== String(attempt); i++) await sleep(150);
    await page.getByRole("button", { name: "Continuar" }).and(page.locator(":enabled")).waitFor();
  }
  assert.equal(await one(`select fill_locked_until > now() from credit_proposal where id='${proposalId}'`), true, "5 erros travam");
  await page.getByLabel("Seu CPF").fill(CPF_NEW);
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByText(/Muitas tentativas/).waitFor();
  await admin(`update credit_proposal set fill_locked_until=null where id='${proposalId}'`);
  await page.getByLabel("Seu CPF").fill(CPF_NEW);
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByRole("heading", { name: /Etapa 1 de 8: Proposta/ }).waitFor();
  assert.notEqual(await one(`select fill_session_hash from credit_proposal where id='${proposalId}'`), null);
  const cookie = (await context.cookies()).find((item) => item.name === "crediai_completar");
  assert.equal(cookie.httpOnly && cookie.path === "/completar", true, "sessão só no caminho do link, fora do alcance de scripts");
  assert.equal(String(await one(`select fill_session_hash from credit_proposal where id='${proposalId}'`)).includes(cookie.value.split(".")[1]), false, "banco guarda só o hash da sessão");

  // Etapa 1: nome e telefone da proposta já preenchidos, CPF só leitura, valor e prazo combinados com o dono.
  assert.equal(await page.getByLabel(/Nome completo/).inputValue(), "Marina Fictícia Souza");
  assert.equal(await page.getByLabel(/Telefone com DDD/).inputValue(), "(11) 98888-7777");
  assert.equal(await page.getByLabel("CPF").inputValue(), "111.444.777-35");
  assert.equal(await page.getByLabel("CPF").getAttribute("readonly"), "");
  await page.getByText(/Crédito combinado/).waitFor();
  await noHorizontalScroll(page);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/celular-2-etapa-proposta.png`, fullPage: true });
  await page.getByRole("button", { name: /Salvar e continuar/ }).click();
  await page.getByText(/Informe a sua renda mensal|Preencha este campo|Fill out this field/).first().waitFor({ timeout: 3000 }).catch(() => undefined);
  await page.getByLabel(/Renda mensal/).fill("4.200,00");
  await page.getByRole("button", { name: /Salvar e continuar/ }).click();
  await page.getByRole("heading", { name: /Etapa 2 de 8/ }).waitFor();
  assert.equal(await one(`select monthly_income_cents from credit_proposal where id='${proposalId}'`), 420000);

  // Etapa 2: e-mail da proposta já preenchido; data de nascimento futura é recusada pelo servidor (mesma regra de Clientes).
  assert.equal(await page.getByLabel("E-mail").inputValue(), "marina@ficticio.local");
  const bad = await actionForm(`crediai_completar=${cookie.value}`, "saveFillStepAction", [token, "personal"], { birthDate: "2099-01-01" }, `/completar/${token}`);
  assert.equal(bad.result?.ok, false, "data futura recusada");
  await page.getByLabel(/Data de nascimento/).fill("15/08/1988");
  await page.getByLabel("Instagram").fill("@marina.ficticia");
  await page.getByLabel("TikTok").fill("@marinatiktok");
  await page.getByLabel("Facebook").fill("facebook.com/marina.ficticia");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/celular-3-dados-pessoais.png`, fullPage: true });
  await page.getByRole("button", { name: /Salvar e continuar/ }).click();
  await page.getByRole("heading", { name: /Etapa 3 de 8/ }).waitFor();
  // Salvar e continuar depois: fechar e voltar pelo mesmo link mantém o que já foi salvo e abre na próxima etapa.
  await page.goto(`${BASE}/completar/${token}`);
  await page.getByRole("heading", { name: /Etapa 3 de 8: Endereço residencial/ }).waitFor();
  assert.equal(await one(`select client_data->>'birthDate' || '/' || (client_data->>'instagram') from credit_proposal where id='${proposalId}'`), "1988-08-15/@marina.ficticia");
  // Etapa 3: endereço residencial (obrigatório).
  await page.getByLabel("CEP").fill("01310100");
  await page.getByLabel("Logradouro").fill("Avenida Paulista");
  await page.getByLabel("Número").fill("1500");
  await page.getByLabel("Complemento").fill("Apto 12");
  await page.getByLabel("Bairro").fill("Bela Vista");
  await page.getByLabel("Cidade").fill("São Paulo");
  await page.getByLabel("Estado").selectOption("SP");
  await noHorizontalScroll(page);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/celular-4-endereco.png`, fullPage: true });
  await page.getByRole("button", { name: /Salvar e continuar/ }).click();
  await page.getByRole("heading", { name: /Etapa 4 de 8/ }).waitFor();
  // Etapa 4: empresa com CNPJ conferido e endereço comercial.
  await page.getByLabel("CNPJ da empresa").fill("11222333000181");
  await page.getByLabel("Nome da empresa").fill("Empresa Fictícia Ltda");
  await page.getByLabel(/Data de admissão/).fill("01/03/2020");
  await page.getByLabel("Cidade").fill("Campinas");
  await page.getByRole("button", { name: /Salvar e continuar/ }).click();
  await page.getByRole("heading", { name: /Etapa 5 de 8/ }).waitFor();
  // Etapa 5: banco e Pix (a chave é conferida pelo tipo).
  await page.getByLabel("Titular da conta").fill("Marina Fictícia Souza");
  await page.getByLabel("Banco").fill("341 Itaú");
  await page.getByLabel("Agência").fill("1234");
  await page.getByLabel("Conta", { exact: true }).fill("56789-0");
  await page.getByLabel("Tipo da chave Pix").selectOption("EMAIL");
  await page.getByLabel("Chave Pix", { exact: true }).fill("MARINA@FICTICIO.LOCAL");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/celular-5-banco-pix.png`, fullPage: true });
  await page.getByRole("button", { name: /Salvar e continuar/ }).click();
  await page.getByRole("heading", { name: /Etapa 6 de 8/ }).waitFor();
  // Etapa 6: referências e avalista (CPF do avalista inválido é recusado no servidor).
  const badGuarantor = await actionForm(`crediai_completar=${cookie.value}`, "saveFillStepAction", [token, "references"], { guarantorDocument: "12345678900" }, `/completar/${token}`);
  assert.equal(badGuarantor.result?.ok, false, "CPF do avalista inválido recusado");
  await page.getByLabel("Nome").first().fill("Carlos Referência");
  await page.getByLabel("Telefone").first().fill("11977776666");
  await page.getByLabel("Grau de parentesco").first().fill("Irmão");
  await page.getByLabel("Nome do avalista").fill("Paulo Avalista Fictício");
  await page.getByLabel("CPF do avalista").fill(CPF_OTHER);
  await page.getByRole("button", { name: /Salvar e continuar/ }).click();
  await page.getByRole("heading", { name: /Etapa 7 de 8: Documentos/ }).waitFor();
  // Enviar sem os 4 documentos é recusado (servidor), e a tela não deixa.
  const early = await actionArgs(`crediai_completar=${cookie.value}`, "submitFillAction", [token], `/completar/${token}`);
  assert.match(String(early.result?.error), /documentos obrigatórios/);
  for (const [index, label] of DOCS.entries()) {
    await page.getByLabel(label).setInputFiles(pdf(`doc${index}.pdf`));
    await page.getByText(`${label}: recebido.`).waitFor();
  }
  assert.equal(await one(`select count(*) from credit_proposal_document where proposal_id='${proposalId}'`), 4);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/celular-6-documentos.png`, fullPage: true });
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByRole("heading", { name: /Etapa 8 de 8/ }).waitFor();
  await noHorizontalScroll(page);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/celular-7-revisar-enviar.png`, fullPage: true });

  // Envio: cria o cliente em Clientes com todos os campos, liga à proposta e audita; a proposta continua na fase em que estava.
  const before = await one(`select count(*) from client where tenant_id='ten_roberio'`);
  const otherBefore = await clientHash("ten_fernando");
  await page.getByRole("button", { name: "Enviar proposta" }).click();
  await page.getByText(/Cadastro enviado em/).waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/celular-8-enviado.png`, fullPage: true });
  assert.equal(await one(`select count(*) from client where tenant_id='ten_roberio'`), before + 1);
  const [client] = await admin(`select * from client where tenant_id='ten_roberio' and document='${CPF_NEW}'`);
  assert.equal(client.name, "Marina Fictícia Souza");
  assert.equal(client.phone, "11988887777");
  assert.equal(client.email, "marina@ficticio.local");
  assert.equal(String(client.birth_date instanceof Date ? client.birth_date.toISOString().slice(0, 10) : client.birth_date), "1988-08-15");
  assert.equal(client.instagram + "|" + client.tiktok, "@marina.ficticia|@marinatiktok");
  assert.equal([client.residential_cep, client.residential_street, client.residential_number, client.residential_complement, client.residential_state].join("|"), "01310100|Avenida Paulista|1500|Apto 12|SP");
  assert.equal([client.business_cnpj, client.business_company_name, client.business_city].join("|"), "11222333000181|Empresa Fictícia Ltda|Campinas");
  assert.equal([client.bank_name, client.bank_branch, client.pix_key_type, client.pix_key].join("|"), "341 Itaú|1234|EMAIL|marina@ficticio.local");
  assert.equal([client.reference1_name, client.reference1_phone, client.guarantor_name, client.guarantor_document].join("|"), `Carlos Referência|11977776666|Paulo Avalista Fictício|${CPF_OTHER}`);
  assert.equal(client.notes, null, "campos internos não vêm do formulário público");
  assert.equal(client.online_casino_bettor, false);
  assert.equal(await one(`select client_id from credit_proposal where id='${proposalId}'`), client.id, "proposta ligada ao cliente");
  assert.equal(await one(`select status||'/'||phase from credit_proposal where id='${proposalId}'`), "OPEN/RECEIVED");
  assert.equal(await one(`select count(*) from admin_audit_log where action='CREDIT_PROPOSAL_CLIENT_DATA_SUBMITTED' and entity_id='${proposalId}'`), 1);
  assert.equal(String(await one(`select after::text from admin_audit_log where action='CREDIT_PROPOSAL_CLIENT_DATA_SUBMITTED' and entity_id='${proposalId}'`)).includes("Paulista"), false, "auditoria sem dados pessoais");
  assert.equal(await clientHash("ten_fernando"), otherBefore, "outra carteira intacta");
  // Depois do envio, nada mais é gravado por este link (nem reenvio).
  const again = await actionArgs(`crediai_completar=${cookie.value}`, "submitFillAction", [token], `/completar/${token}`);
  assert.equal(again.result?.ok, false);
  assert.equal((await actionForm(`crediai_completar=${cookie.value}`, "saveFillStepAction", [token, "home"], { residentialCity: "Outra" }, `/completar/${token}`)).result?.ok, false);
  assert.equal(await one(`select count(*) from client where tenant_id='ten_roberio' and document='${CPF_NEW}'`), 1);

  // Usuário interno: a Esteira mostra o cadastro enviado e o cliente aparece em Clientes com os dados.
  const ownerPage = await signIn("roberio@teste.local");
  await ownerPage.goto(`${BASE}/?tela=esteira-de-credito`);
  const received = ownerPage.getByRole("region", { name: "Proposta recebida" });
  await received.getByText(/Cadastro completo enviado pelo cliente em/).waitFor();
  if (SHOTS) await ownerPage.screenshot({ path: `${SHOTS}/dono-esteira-cadastro-enviado.png` });
  await ownerPage.goto(`${BASE}/?tela=clientes`);
  await ownerPage.getByText("Marina Fictícia Souza").first().waitFor();
  await ownerPage.context().close();

  // Gerar outro link: o antigo para de abrir, a sessão antiga cai e o cadastro volta a ser editável.
  assert.equal((await actionArgs(owner, "manageProposalFillLinkAction", [proposalId, "create"])).result?.ok, true);
  await page.goto(`${BASE}/completar/${token}`);
  await page.getByRole("heading", { name: "Link indisponível" }).waitFor();
  const newToken = await one(`select fill_token from credit_proposal where id='${proposalId}'`);
  assert.notEqual(newToken, token);
  assert.equal((await actionForm(`crediai_completar=${newToken}.${cookie.value.split(".")[1]}`, "saveFillStepAction", [newToken, "home"], { residentialCity: "X" }, `/completar/${newToken}`)).result?.ok, false, "sessão do link antigo não vale no novo");
  assert.equal((await actionArgs(owner, "manageProposalFillLinkAction", [proposalId, "disable"])).result?.ok, true);
  assert.equal(await one(`select fill_token is null from credit_proposal where id='${proposalId}'`), true);
  await context.close();
  await admin(`delete from credit_proposal where tenant_id='ten_roberio'`);
  await admin(`delete from client where tenant_id='ten_roberio' and document='${CPF_NEW}'`);
});

test("FP2. CPF que já é cliente: atualiza o cadastro existente sem duplicar; dois envios ao mesmo tempo gravam um só; links não se cruzam", async () => {
  const owner = await apiLogin("roberio@teste.local");
  await admin(`insert into client(id,tenant_id,name,document,phone,notes,residential_city) values ('c_fp_exist','ten_roberio','Nome Interno Existente','${CPF_EXISTING}','11911112222','observação interna','Santos')`);
  await admin(`insert into client(id,tenant_id,name,document) values ('c_fp_other_tenant','ten_fernando','Mesmo CPF em outra carteira','${CPF_EXISTING}')`);
  const otherBefore = await clientHash("ten_fernando");
  const proposalA = await ownerProposal(owner, { name: "Renata Fictícia", cpf: CPF_EXISTING, phone: "11933334444" });
  const proposalB = await ownerProposal(owner, { name: "Bruno Fictício", cpf: CPF_OTHER, phone: "11955556666" });
  for (const id of [proposalA, proposalB]) assert.equal((await actionArgs(owner, "manageProposalFillLinkAction", [id, "create"])).result?.ok, true);
  const tokenA = await one(`select fill_token from credit_proposal where id='${proposalA}'`);
  const tokenB = await one(`select fill_token from credit_proposal where id='${proposalB}'`);
  // Confirma o CPF de A pela ação (sem tela) e pega a sessão.
  const confirm = await fetch(`${BASE}/completar/${tokenA}`, { method: "POST", redirect: "manual", headers: { "next-action": actionId("confirmFillCpfAction"), accept: "text/x-component", origin: BASE }, body: (() => { const form = new FormData(); form.append("_2_cpf", CPF_EXISTING); form.append("0", JSON.stringify([tokenA, "$K2"])); return form; })() });
  const cookieA = confirm.headers.getSetCookie().map((item) => item.split(";")[0]).find((item) => item.startsWith("crediai_completar="));
  assert.ok(cookieA, "sessão criada");
  // A sessão do link A não lê nem grava a proposta B (nem trocando o link na chamada).
  assert.equal((await actionForm(cookieA, "saveFillStepAction", [tokenB, "personal"], { birthDate: "1990-01-01" }, `/completar/${tokenB}`)).result?.ok, false);
  assert.equal((await actionForm(cookieA.replace(tokenA, tokenB), "saveFillStepAction", [tokenB, "personal"], { birthDate: "1990-01-01" }, `/completar/${tokenB}`)).result?.ok, false);
  assert.equal(await one(`select client_data is null from credit_proposal where id='${proposalB}'`), true);
  const pageB = await (await fetch(`${BASE}/completar/${tokenB}`, { headers: { cookie: cookieA.replace(tokenA, tokenB) } })).text();
  assert.equal(pageB.includes("Bruno") || pageB.includes("529.982"), false, "sem dados de B");
  // Sem sessão, nenhuma ação passa; etapa inexistente é recusada.
  assert.equal((await actionForm("", "saveFillStepAction", [tokenA, "personal"], { birthDate: "1990-01-01" }, `/completar/${tokenA}`)).result?.ok, false);
  assert.equal((await actionForm(cookieA, "saveFillStepAction", [tokenA, "notes"], { notes: "x" }, `/completar/${tokenA}`)).result?.ok, false);
  // Preenche A pelas ações e anexa os documentos.
  assert.equal((await actionForm(cookieA, "saveFillProposalAction", [tokenA], { name: "Renata Fictícia", phone: "11933334444", income: "3.000,00" }, `/completar/${tokenA}`)).result?.ok, true);
  assert.equal((await actionForm(cookieA, "saveFillStepAction", [tokenA, "personal"], { birthDate: "1991-05-20", email: "renata@ficticio.local" }, `/completar/${tokenA}`)).result?.ok, true);
  assert.equal((await actionForm(cookieA, "saveFillStepAction", [tokenA, "home"], { residentialCep: "11010-000", residentialStreet: "Rua XV", residentialNumber: "10", residentialDistrict: "Centro", residentialCity: "Santos", residentialState: "SP" }, `/completar/${tokenA}`)).result?.ok, true);
  for (const [index, kind] of ["ID_DOCUMENT", "PROOF_OF_ADDRESS", "BANK_STATEMENT", "PAYSLIP"].entries()) {
    const form = new FormData();
    form.append("_2_kind", kind);
    form.append("_2_file", new Blob([index === 1 ? "não é pdf" : `%PDF-1.4 doc${index}`], { type: "application/pdf" }), `doc${index}.pdf`);
    form.append("0", JSON.stringify([tokenA, "$K2"]));
    const upload = await parse(await fetch(`${BASE}/completar/${tokenA}`, { method: "POST", headers: { cookie: cookieA, "next-action": actionId("uploadFillDocumentAction"), accept: "text/x-component", origin: BASE }, body: form }));
    assert.equal(upload.result?.ok, index !== 1, `documento ${kind}`);
  }
  assert.match(String((await actionArgs(cookieA, "submitFillAction", [tokenA], `/completar/${tokenA}`)).result?.error), /documentos obrigatórios/, "arquivo que não é PDF/imagem não conta");
  const form = new FormData();
  form.append("_2_kind", "PROOF_OF_ADDRESS");
  form.append("_2_file", new Blob(["%PDF-1.4 residencia"], { type: "application/pdf" }), "residencia.pdf");
  form.append("0", JSON.stringify([tokenA, "$K2"]));
  assert.equal((await parse(await fetch(`${BASE}/completar/${tokenA}`, { method: "POST", headers: { cookie: cookieA, "next-action": actionId("uploadFillDocumentAction"), accept: "text/x-component", origin: BASE }, body: form }))).result?.ok, true);
  // Dois envios ao mesmo tempo: um passa, o outro é recusado; um cliente só.
  const results = await Promise.all([0, 1].map(() => actionArgs(cookieA, "submitFillAction", [tokenA], `/completar/${tokenA}`)));
  assert.equal(results.filter((item) => item.result?.ok).length, 1, JSON.stringify(results.map((item) => item.result)));
  assert.equal(await one(`select count(*) from client where tenant_id='ten_roberio' and document='${CPF_EXISTING}'`), 1, "sem duplicar");
  const [client] = await admin(`select * from client where id='c_fp_exist'`);
  assert.equal(client.name, "Nome Interno Existente", "nome do cadastro existente mantido");
  assert.equal(client.notes, "observação interna", "campo interno mantido");
  assert.equal([client.phone, client.email, client.residential_city, client.residential_street].join("|"), "11933334444|renata@ficticio.local|Santos|Rua XV", "atualizado com o que o cliente preencheu");
  assert.equal(await one(`select client_id from credit_proposal where id='${proposalA}'`), "c_fp_exist");
  assert.equal(await clientHash("ten_fernando"), otherBefore, "mesmo CPF em outra carteira não muda");
  assert.equal(await one(`select count(*) from admin_audit_log where action='CREDIT_PROPOSAL_CLIENT_DATA_SUBMITTED' and entity_id='${proposalA}'`), 1);
  // O aceite da oferta depois usa o mesmo cliente (sem duplicar).
  await admin(`update credit_proposal set phase='ACCEPTANCE', offer_cents=300000, offer_term_months=6, offer_rate_bps=800, offered_at=now() where id='${proposalA}'`);
  assert.equal((await actionArgs(owner, "registerOfferAcceptanceAction", [proposalA])).result?.ok, true);
  assert.equal(await one(`select count(*) from client where tenant_id='ten_roberio' and document='${CPF_EXISTING}'`), 1);
  // Proposta enviada pelo link da carteira (conta do cliente) não usa link individual.
  await admin(`update credit_proposal set source='APPLICANT' where id='${proposalB}'`);
  assert.equal((await actionArgs(owner, "manageProposalFillLinkAction", [proposalB, "create"])).result?.ok, false);
  assert.equal((await actionForm(cookieA.replace(tokenA, tokenB), "saveFillStepAction", [tokenB, "personal"], { birthDate: "1990-01-01" }, `/completar/${tokenB}`)).result?.ok, false, "link de proposta que não é do dono não abre");
  await admin(`delete from credit_proposal where tenant_id='ten_roberio'`);
  await admin(`delete from client where id in ('c_fp_exist','c_fp_other_tenant')`);
});

test("FP3. link da carteira (conta do cliente) no celular: etapas com os campos de Clientes, salvar e continuar, cliente criado no envio", async () => {
  const owner = await apiLogin("roberio@teste.local");
  assert.equal((await actionArgs(owner, "manageProposalLinkAction", ["create"])).result?.ok, true);
  const token = await one(`select token from proposal_link where tenant_id='ten_roberio' and enabled`);
  const context = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto(`${BASE}/proposta/${token}`);
  await page.getByLabel("Nome completo").fill("Lucas Fictício Lima");
  await page.getByLabel("E-mail").fill("lucas@ficticio.local");
  await page.getByLabel(/Senha/).fill("senha-segura-123");
  await page.getByRole("button", { name: /Criar conta/ }).click();
  await page.getByRole("heading", { name: /Etapa 1 de 8: Proposta/ }).waitFor();
  // As etapas seguintes só abrem depois da proposta salva.
  assert.equal(await page.getByRole("button", { name: /^Etapa 2:/ }).isDisabled(), true);
  await page.getByLabel(/^CPF/).fill(CPF_NEW);
  await page.getByLabel(/Telefone/).fill("11944443333");
  await page.getByLabel(/Renda mensal/).fill("2.800,00");
  await page.getByLabel(/Valor que você precisa/).fill("1.500,00");
  await page.getByLabel(/Prazo desejado/).fill("6");
  await page.getByRole("button", { name: /Salvar e continuar/ }).click();
  await page.getByRole("heading", { name: /Etapa 2 de 8/ }).waitFor();
  assert.equal(await page.getByLabel("E-mail").inputValue(), "lucas@ficticio.local", "e-mail da conta já preenchido");
  await page.getByLabel(/Data de nascimento/).fill("10/10/1995");
  await page.getByRole("button", { name: /Salvar e continuar/ }).click();
  await page.getByRole("heading", { name: /Etapa 3 de 8/ }).waitFor();
  await noHorizontalScroll(page);
  // Sai e entra de novo: continua de onde parou.
  await page.getByRole("button", { name: "Sair" }).click();
  await page.getByRole("button", { name: /Já tenho conta/ }).click();
  await page.getByLabel("E-mail").fill("lucas@ficticio.local");
  await page.getByLabel("Senha").fill("senha-segura-123");
  await page.getByRole("button", { name: /Entrar/ }).click();
  await page.getByRole("heading", { name: /Etapa 3 de 8: Endereço residencial/ }).waitFor();
  await page.getByLabel("CEP").fill("20040020");
  await page.getByLabel("Logradouro").fill("Rua da Assembleia");
  await page.getByLabel("Número").fill("50");
  await page.getByLabel("Bairro").fill("Centro");
  await page.getByLabel("Cidade").fill("Rio de Janeiro");
  await page.getByLabel("Estado").selectOption("RJ");
  await page.getByRole("button", { name: /Salvar e continuar/ }).click();
  await page.getByRole("heading", { name: /Etapa 4 de 8/ }).waitFor();
  await page.getByRole("button", { name: /^Etapa 7: Documentos/ }).click();
  for (const [index, label] of DOCS.entries()) {
    await page.getByLabel(label).setInputFiles(pdf(`l${index}.pdf`));
    await page.getByText(`${label}: recebido.`).waitFor();
  }
  await page.getByRole("button", { name: "Continuar" }).click();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/celular-link-carteira-revisar.png`, fullPage: true });
  await page.getByRole("button", { name: "Enviar proposta" }).click();
  await page.getByText(/Proposta enviada/).first().waitFor();
  assert.equal(await one(`select status||'/'||phase from credit_proposal where source='APPLICANT'`), "OPEN/RECEIVED");
  const [client] = await admin(`select * from client where tenant_id='ten_roberio' and document='${CPF_NEW}'`);
  assert.equal([client.name, client.email, client.phone, client.residential_city].join("|"), "Lucas Fictício Lima|lucas@ficticio.local|11944443333|Rio de Janeiro");
  assert.equal(await one(`select client_id from credit_proposal where source='APPLICANT'`), client.id);
  await context.close();
  await admin(`delete from credit_proposal where tenant_id='ten_roberio'`);
  await admin(`delete from proposal_applicant where tenant_id='ten_roberio'`);
  await admin(`delete from proposal_link where tenant_id='ten_roberio'`);
  await admin(`delete from client where id='${client.id}'`);
});
