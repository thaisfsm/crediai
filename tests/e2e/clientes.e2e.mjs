// Clientes de ponta a ponta (HTTP + banco + navegador): busca no servidor (nome sem acentos, CPF e telefone formatados ou
// não), CPF e CNPJ com dígitos verificadores, CPF repetido na mesma carteira, dados bancários e Pix, isolamento entre
// tenants e a tela no desktop e no celular.
// SÓ em ambiente LOCAL e DESCARTÁVEL (ver tests/e2e/README.md). Usa os dados fictícios ten_roberio (A) e ten_fernando (B).
//   E2E_DATABASE_URL=… PLAYWRIGHT_MODULE=/caminho/playwright/index.mjs node --test tests/e2e/clientes.e2e.mjs
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
const parse = async (response) => { const result = (await response.text()).match(/^1:(\{.*\})$/m)?.[1]; return result ? JSON.parse(result) : null; };
async function action(cookie, name, fields) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(`_1_${key}`, value);
  form.append("0", '["$K1"]');
  return parse(await fetch(`${BASE}/`, { method: "POST", headers: { cookie, "next-action": actionId(name), accept: "text/x-component", origin: BASE }, body: form }));
}
// Ação com argumento simples (texto), como a busca.
const search = async (cookie, query) => parse(await fetch(`${BASE}/`, { method: "POST", headers: { cookie, "next-action": actionId("searchClientsAction"), accept: "text/x-component", origin: BASE, "content-type": "text/plain;charset=UTF-8" }, body: JSON.stringify([query]) }));
const names = (result) => result.results.map((client) => client.name);
const clientOf = (tenant, name) => admin(`select * from client where tenant_id = '${tenant}' and name = '${name.replace(/'/g, "''")}'`).then((rows) => rows[0]);
const create = (cookie, fields) => action(cookie, "createClientAction", fields);
// Tudo que já existia (operações, pagamentos, carteiras, movimentos, renovações, investidores) não pode mudar.
const existingHash = () => one(`select md5(string_agg(x, '|' order by x)) from (
  select 'o'||row(o.*)::text x from loan_operation o union all select 'p'||row(p.*)::text from payment p union all select 'r'||row(r.*)::text from loan_renewal r
  union all select 'w'||row(w.*)::text from wallet w union all select 'm'||row(m.*)::text from capital_movement m
  union all select 'i'||row(i.*)::text from investment i union all select 'v'||row(v.*)::text from investor v
  union all select 'c'||concat_ws(',', c.id, c.tenant_id, c.name, c.document, c.phone, c.archived_at) from client c where c.id like 'c\\_%' and c.id not like 'cli\\_%' and c.id not like 'c\\_e2e%') t`);

let robério, fernando, before;
const CPF_A = "529.982.247-25", CPF_B = "123.456.789-09";

test("preparação: login dos dois tenants", async () => {
  before = await existingHash();
  robério = await login("roberio@teste.local");
  fernando = await login("fernando@teste.local");
});

test("CE1. CPF inválido é recusado no servidor; válido é gravado só com dígitos", async () => {
  for (const document of ["529.982.247-24", "111.111.111-11", "000.000.000-00", "12345678900", "5299822"]) {
    const result = await create(robério, { name: "Cliente CPF Inválido", document });
    assert.equal(result.ok, false, document);
  }
  assert.equal(await one(`select count(*)::int from client where name = 'Cliente CPF Inválido'`), 0);
  const ok = await create(robério, { name: "João da Conceição Silva", document: CPF_A, phone: "(11) 98765-4321", whatsapp: "(21) 99876-5432" });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal((await clientOf("ten_roberio", "João da Conceição Silva")).document, "52998224725");
});

test("CE2. CPF repetido na mesma carteira é recusado (com ou sem máscara), inclusive de cliente arquivado", async () => {
  const again = await create(robério, { name: "Outro João", document: "52998224725" });
  assert.equal(again.ok, false);
  assert.match(again.error, /Já existe um cliente com o CPF 529\.982\.247-25 nesta carteira: João da Conceição Silva/);
  await admin(`insert into client(id, tenant_id, name, document, archived_at) values ('c_e2e_arch', 'ten_roberio', 'Arquivado Teste', '12345678909', now())`);
  const archived = await create(robério, { name: "Volta do Arquivado", document: CPF_B });
  assert.equal(archived.ok, false);
  assert.match(archived.error, /Arquivado Teste \(arquivado\)/);
  // Outra carteira não é afetada: o tenant B pode ter o mesmo CPF.
  const other = await create(fernando, { name: "João Conceição da Carteira B", document: CPF_A, phone: "11987654321" });
  assert.equal(other.ok, true, JSON.stringify(other));
});

test("CE3. dois cadastros simultâneos com o mesmo CPF: só um é gravado", async () => {
  const results = await Promise.all([1, 2, 3].map((index) => create(robério, { name: `Simultâneo ${index}`, document: "111.444.777-35" })));
  assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
  assert.equal(await one(`select count(*)::int from client where tenant_id = 'ten_roberio' and document = '11144477735'`), 1);
});

test("CE4. edição: CPF inválido ou de outro cliente é recusado; valor antigo sem alteração continua aceito", async () => {
  const joao = await clientOf("ten_roberio", "João da Conceição Silva");
  await create(robério, { name: "Maria Edição" });
  const maria = await clientOf("ten_roberio", "Maria Edição");
  assert.equal((await action(robério, "updateClientAction", { clientId: maria.id, name: "Maria Edição", document: "529.982.247-24" })).ok, false);
  const duplicate = await action(robério, "updateClientAction", { clientId: maria.id, name: "Maria Edição", document: CPF_A });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error, /João da Conceição Silva/);
  // O próprio cliente mantém o próprio CPF.
  assert.equal((await action(robério, "updateClientAction", { clientId: joao.id, name: joao.name, document: CPF_A, phone: "11987654321", whatsapp: "21998765432" })).ok, true);
  // Cadastro antigo com CPF fora do padrão: reenviado sem alteração continua aceito; alterado precisa ser válido.
  await admin(`insert into client(id, tenant_id, name, document) values ('c_e2e_legacy', 'ten_roberio', 'Legado Teste', '99988877700')`);
  assert.equal((await action(robério, "updateClientAction", { clientId: "c_e2e_legacy", name: "Legado Teste Editado", document: "99988877700" })).ok, true);
  assert.equal((await action(robério, "updateClientAction", { clientId: "c_e2e_legacy", name: "Legado Teste Editado", document: "99988877701" })).ok, false);
  assert.equal((await clientOf("ten_roberio", "Legado Teste Editado")).document, "99988877700");
});

test("CE5. empresa (CNPJ conferido, pode repetir) e dados bancários com Pix", async () => {
  assert.equal((await create(robério, { name: "Empresa Inválida", businessCnpj: "11.222.333/0001-80" })).ok, false);
  const full = await create(robério, {
    name: "Carla Bancária", document: "111.444.777-35".replace("35", "35"), businessCompanyName: "Padaria Pão Bom", businessCnpj: "11.222.333/0001-81",
    bankHolderName: "Carla Bancária", bankHolderDocument: "390.533.447-05", bankName: "341 Itaú", bankBranch: "1234", bankAccount: "56789-0", bankAccountType: "SAVINGS",
    pixKeyType: "PHONE", pixKey: "+55 (11) 91234-5678",
  });
  // O CPF 111.444.777-35 já é do cliente simultâneo: a ficha completa usa outro.
  assert.equal(full.ok, false);
  const ok = await create(robério, {
    name: "Carla Bancária", document: "390.533.447-05", businessCompanyName: "Padaria Pão Bom", businessCnpj: "11.222.333/0001-81",
    bankHolderName: "Carla Bancária", bankHolderDocument: "390.533.447-05", bankName: "341 Itaú", bankBranch: "1234", bankAccount: "56789-0", bankAccountType: "SAVINGS",
    pixKeyType: "PHONE", pixKey: "+55 (11) 91234-5678",
  });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const carla = await clientOf("ten_roberio", "Carla Bancária");
  assert.deepEqual([carla.business_company_name, carla.business_cnpj, carla.bank_holder_document, carla.bank_branch, carla.bank_account, carla.bank_account_type, carla.pix_key_type, carla.pix_key],
    ["Padaria Pão Bom", "11222333000181", "39053344705", "1234", "56789-0", "SAVINGS", "PHONE", "11912345678"]);
  // Outro cliente da mesma empresa: o CNPJ pode repetir.
  assert.equal((await create(robério, { name: "Colega da Padaria", businessCnpj: "11222333000181" })).ok, true);
  for (const bad of [{ pixKeyType: "CPF", pixKey: "529.982.247-24" }, { pixKeyType: "EMAIL", pixKey: "sem-arroba" }, { pixKeyType: "RANDOM", pixKey: "abc" }, { pixKey: "sem-tipo@x.com" }, { bankHolderDocument: "11.222.333/0001-80" }, { bankAccountType: "XPTO" }]) {
    assert.equal((await create(robério, { name: "Pix Inválido", ...bad })).ok, false, JSON.stringify(bad));
  }
  assert.equal(await one(`select count(*)::int from client where name = 'Pix Inválido'`), 0);
  // O banco recusa tipo de conta ou chave Pix fora da regra mesmo sem passar pelo app.
  await assert.rejects(admin(`update client set pix_key = 'x', pix_key_type = null where id = '${carla.id}'`));
  await assert.rejects(admin(`update client set bank_account_type = 'XPTO' where id = '${carla.id}'`));
});

test("CE5b. data de admissão na empresa: opcional, data real e não futura; edição e remoção", async () => {
  const future = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  for (const bad of ["2021-02-30", "31/12/2020", "abc", future, "1800-01-01"]) {
    assert.equal((await create(robério, { name: "Admissão Inválida", businessAdmissionDate: bad })).ok, false, bad);
  }
  assert.equal(await one(`select count(*)::int from client where name = 'Admissão Inválida'`), 0);
  const ok = await create(robério, { name: "Admissão Teste", businessCompanyName: "Padaria Pão Bom", businessAdmissionDate: "2021-03-15" });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const client = await clientOf("ten_roberio", "Admissão Teste");
  assert.equal(await one(`select to_char(business_admission_date, 'YYYY-MM-DD') from client where id = '${client.id}'`), "2021-03-15");
  // Sem data: cadastro continua válido. Edição troca a data e vazio remove.
  assert.equal((await create(robério, { name: "Sem Admissão" })).ok, true);
  assert.equal((await action(robério, "updateClientAction", { clientId: client.id, name: "Admissão Teste", businessAdmissionDate: "2022-01-10" })).ok, true);
  assert.equal(await one(`select to_char(business_admission_date, 'YYYY-MM-DD') from client where id = '${client.id}'`), "2022-01-10");
  assert.equal((await action(robério, "updateClientAction", { clientId: client.id, name: "Admissão Teste", businessAdmissionDate: "" })).ok, true);
  assert.equal(await one(`select business_admission_date is null from client where id = '${client.id}'`), true);
});

test("CE6. busca no servidor: nome sem acentos e em partes, CPF e telefone com ou sem máscara", async () => {
  for (const query of ["joao", "JOÃO", "conceicao silva", "silva  joão", "Conceição"]) assert.deepEqual(names(await search(robério, query)), ["João da Conceição Silva"], query);
  for (const query of ["529.982.247-25", "52998224725", "982247", "(11) 98765-4321", "11987654321", "98765", "(21) 99876"]) assert.deepEqual(names(await search(robério, query)), ["João da Conceição Silva"], query);
  // A empresa não entra na busca (só nome, CPF e telefone).
  assert.deepEqual(names(await search(robério, "pão bom")), []);
  assert.deepEqual((await search(robério, "98")).results, []);
  assert.deepEqual((await search(robério, "  ")).results, []);
  // Curingas do LIKE são tratados como texto.
  assert.deepEqual((await search(robério, "%a%")).results, []);
  // Arquivados aparecem marcados, depois dos ativos.
  const archived = await search(robério, "arquivado");
  assert.deepEqual(archived.results.map((client) => [client.name, client.archived]), [["Arquivado Teste", true]]);
});

test("CE6b. busca por e-mail: com @, parte do e-mail sem acento e só na própria carteira", async () => {
  await admin(`update client set email = 'joao.silva@exemplo.com' where tenant_id = 'ten_roberio' and name = 'João da Conceição Silva'`);
  for (const query of ["joao.silva@exemplo.com", "@exemplo", "SILVA@", "silva@exemplo.com", "joao.silva", "exemplo"]) assert.deepEqual(names(await search(robério, query)), ["João da Conceição Silva"], query);
  assert.deepEqual((await search(robério, "@")).results, []);
  assert.deepEqual((await search(robério, "@naoexiste")).results, []);
  assert.deepEqual((await search(fernando, "joao.silva@exemplo.com")).results, [], "outra carteira não encontra");
  assert.equal((await search(robério, "@exemplo")).results[0].email, "joao.silva@exemplo.com");
});

test("CE7. isolamento: a busca de um tenant nunca devolve clientes do outro", async () => {
  assert.deepEqual(names(await search(fernando, "joao")), ["João Conceição da Carteira B"]);
  assert.deepEqual(names(await search(fernando, "52998224725")), ["João Conceição da Carteira B"]);
  for (const query of ["alexandre", "willian", "renovado", "Cliente da Thaís"]) assert.deepEqual((await search(robério, query)).results, [], query);
  assert.deepEqual(names(await search(fernando, "alexandre")), ["Alexandre Teste"]);
  assert.deepEqual((await search(fernando, "Carla")).results, []);
  // Sem sessão não há busca.
  const anonymous = await fetch(`${BASE}/`, { method: "POST", headers: { "next-action": actionId("searchClientsAction"), accept: "text/x-component", origin: BASE, "content-type": "text/plain;charset=UTF-8" }, body: JSON.stringify(["joao"]) });
  assert.ok(!(await anonymous.text()).includes("João da Conceição"));
  // O tenant A não edita cliente do B nem com o id forjado.
  const fernandoJoao = await clientOf("ten_fernando", "João Conceição da Carteira B");
  assert.equal((await action(robério, "updateClientAction", { clientId: fernandoJoao.id, name: "Invadido", document: "" })).ok, false);
  assert.equal((await clientOf("ten_fernando", "João Conceição da Carteira B")).document, "52998224725");
});

test("CE8. tela: busca, abrir a ficha com empresa e banco, CPF inválido avisado na hora (desktop e celular)", async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  for (const [label, viewport] of [["desktop", { width: 1440, height: 900 }], ["celular", { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport });
    const [name, value] = robério.split("; ").find((cookie) => cookie.includes("session_token")).split(/=(.*)/s);
    await context.addCookies([{ name, value, domain: new URL(BASE).hostname, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage();
    await page.goto(`${BASE}/?tela=clientes`);
    const box = page.getByRole("searchbox", { name: /Buscar cliente/ });
    await box.fill("joao conceicao");
    const results = page.getByRole("table", { name: "Resultado da busca" });
    await results.getByText("João da Conceição Silva").waitFor();
    assert.equal(await results.locator("tbody tr").count(), 1);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/clientes-busca-${label}.png`, fullPage: false });
    await box.fill("390.533.447-05");
    await results.getByText("Carla Bancária").waitFor();
    // Na própria busca: Editar abre o formulário do cliente e Excluir abre a confirmação (nada é excluído aqui).
    await results.getByRole("button", { name: "Excluir" }).waitFor();
    await results.getByRole("button", { name: "Editar" }).click();
    await page.getByRole("region", { name: "Editar cliente" }).getByText("Editar Carla Bancária").waitFor();
    await results.getByRole("button", { name: "Excluir" }).click();
    await page.getByRole("alertdialog", { name: /Excluir Carla Bancária/ }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("alertdialog").waitFor({ state: "detached" });
    await results.getByRole("button", { name: "Abrir" }).click();
    await page.getByRole("heading", { name: "Carla Bancária", level: 1 }).waitFor();
    const profile = page.getByRole("region", { name: "Cadastro de Carla Bancária" });
    await profile.getByText("Padaria Pão Bom · CNPJ 11.222.333/0001-81").waitFor();
    await profile.getByText("341 Itaú · ag. 1234 · conta 56789-0 · Conta poupança").waitFor();
    await profile.getByText("Celular: (11) 91234-5678").waitFor();
    if (SHOTS) await profile.screenshot({ path: `${SHOTS}/clientes-ficha-banco-${label}.png` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `sem rolagem horizontal (${label})`);
    // Novo cliente com CPF inválido: aviso na hora e o navegador não envia.
    await page.goto(`${BASE}/?tela=clientes`);
    const form = page.getByRole("region", { name: "Novo cliente" });
    await form.getByLabel("Nome completo").fill(`Tela Inválida ${label}`);
    await form.getByLabel("CPF", { exact: true }).fill("52998224724");
    await form.getByText("CPF inválido: confira os números digitados.").waitFor();
    if (SHOTS) await form.screenshot({ path: `${SHOTS}/clientes-cpf-invalido-${label}.png` });
    await form.getByRole("button", { name: "Cadastrar cliente" }).click();
    await sleep(800);
    assert.equal(await one(`select count(*)::int from client where name = 'Tela Inválida ${label}'`), 0);
    await context.close();
  }
});

test("CE8b. cadastro novo já traz os documentos: cliente e arquivos gravados, ficha mostra os anexos, só na própria carteira", async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  browser ??= await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const [name, value] = robério.split("; ").find((cookie) => cookie.includes("session_token")).split(/=(.*)/s);
  await context.addCookies([{ name, value, domain: new URL(BASE).hostname, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage();
  await page.goto(`${BASE}/?tela=clientes`);
  const form = page.getByRole("region", { name: "Novo cliente" });
  await form.getByLabel("Nome completo").fill("Docs Cadastro Teste");
  const pdf = (text) => Buffer.from(`%PDF-1.4\n% ${text}\n%%EOF\n`);
  await form.locator('input[name="docLabel"]').nth(0).fill("RG");
  await form.locator('input[name="docFile"]').nth(0).setInputFiles({ name: "rg.pdf", mimeType: "application/pdf", buffer: pdf("rg") });
  await form.getByRole("button", { name: /Adicionar outro documento/ }).click();
  await form.locator('input[name="docLabel"]').nth(1).fill("Comprovante de residência");
  await form.locator('input[name="docFile"]').nth(1).setInputFiles({ name: "comprovante.pdf", mimeType: "application/pdf", buffer: pdf("comprovante") });
  await form.getByRole("button", { name: "Cadastrar cliente" }).click();
  await page.getByText(/Docs Cadastro Teste cadastrado\. 2 documentos anexados\./).waitFor({ timeout: 20_000 });
  const client = await clientOf("ten_roberio", "Docs Cadastro Teste");
  assert.ok(client, "cliente gravado");
  const docs = await admin(`select label, file_name, content_type, tenant_id from client_document where client_id = '${client.id}' order by label`);
  assert.deepEqual(docs.map((doc) => [doc.label, doc.file_name, doc.content_type, doc.tenant_id]), [
    ["Comprovante de residência", "comprovante.pdf", "application/pdf", "ten_roberio"], ["RG", "rg.pdf", "application/pdf", "ten_roberio"]]);
  // Sem arquivo: cadastro continua funcionando; rótulo sem nome do documento é recusado antes de gravar.
  await form.getByLabel("Nome completo").fill("Docs Sem Rotulo");
  await form.locator('input[name="docFile"]').nth(0).setInputFiles({ name: "x.pdf", mimeType: "application/pdf", buffer: pdf("x") });
  await form.getByRole("button", { name: "Cadastrar cliente" }).click();
  await page.getByText(/Informe o que é cada documento/).waitFor();
  assert.equal(await clientOf("ten_roberio", "Docs Sem Rotulo"), undefined, "nada gravado quando falta o nome do documento");
  // Edição do cliente já cadastrado: a seção Documentos aparece, lista os anexos e permite anexar mais um depois.
  await page.reload();
  await page.getByRole("searchbox", { name: /Buscar cliente/ }).fill("Docs Cadastro Teste");
  const found = page.getByRole("table", { name: "Resultado da busca" });
  await found.getByText("Docs Cadastro Teste").waitFor();
  await found.getByRole("button", { name: "Editar" }).click();
  const documents = page.getByRole("region", { name: "Documentos de Docs Cadastro Teste" });
  await documents.getByText("comprovante.pdf").waitFor();
  await documents.getByLabel("Documento", { exact: true }).fill("CPF");
  await documents.getByLabel("Arquivo", { exact: true }).setInputFiles({ name: "cpf.pdf", mimeType: "application/pdf", buffer: pdf("cpf") });
  await documents.getByRole("button", { name: "Anexar documento" }).click();
  await documents.getByText("cpf.pdf").waitFor({ timeout: 20_000 });
  assert.equal(await one(`select count(*)::int from client_document where client_id = '${client.id}'`), 3);
  // Isolamento: o tenant B não enxerga o documento do tenant A.
  const download = await fetch(`${BASE}/documentos/${(await admin(`select id from client_document where client_id = '${client.id}' limit 1`))[0].id}`, { headers: { cookie: fernando } });
  assert.equal(download.status, 404);
  await context.close();
});

test("CE8c. tela: campo Data de admissão na seção Empresa (cadastro e ficha)", async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  browser ??= await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "pt-BR" });
  const [name, value] = robério.split("; ").find((cookie) => cookie.includes("session_token")).split(/=(.*)/s);
  await context.addCookies([{ name, value, domain: new URL(BASE).hostname, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage();
  await page.goto(`${BASE}/?tela=clientes`);
  const form = page.getByRole("region", { name: "Novo cliente" });
  const company = form.getByRole("group", { name: "Empresa" });
  await company.getByLabel("Nome da empresa").fill("ASSOCIACAO DESP POLICIA MILITAR DO ESTADO DE SAO PAULO");
  await company.getByLabel("Data de admissão").fill("12/08/2019");
  await company.scrollIntoViewIfNeeded();
  if (SHOTS) await company.screenshot({ path: `${SHOTS}/clientes-empresa-admissao.png` });
  await form.getByLabel("Nome completo").fill("Admissão Tela");
  await form.getByRole("button", { name: "Cadastrar cliente" }).click();
  await page.getByText(/Admissão Tela cadastrado/).waitFor({ timeout: 20_000 });
  assert.equal(await one(`select to_char(business_admission_date, 'DD/MM/YYYY') from client where name = 'Admissão Tela'`), "12/08/2019");
  await page.getByRole("searchbox", { name: /Buscar cliente/ }).fill("Admissão Tela");
  await page.getByRole("table", { name: "Resultado da busca" }).getByRole("button", { name: "Abrir" }).click();
  await page.getByText(/admitido em 12\/08\/2019/).waitFor();
  await context.close();
});

test("CE8d. tela: modo visualização/edição do cadastro (campos bloqueados, Editar, Salvar volta à visualização, nova edição sem recarregar, Cancelar, falha)", async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  browser ??= await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "pt-BR" });
  const [name, value] = robério.split("; ").find((cookie) => cookie.includes("session_token")).split(/=(.*)/s);
  await context.addCookies([{ name, value, domain: new URL(BASE).hostname, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage();
  await page.goto(`${BASE}/?tela=clientes`);
  await page.getByRole("searchbox", { name: /Buscar cliente/ }).fill("Admissão Tela");
  await page.getByRole("table", { name: "Resultado da busca" }).getByRole("button", { name: "Editar" }).click();
  const form = page.getByRole("region", { name: "Editar cliente" });
  const notes = form.getByLabel("Observações");
  // Ao clicar em Editar o formulário já está editável, com Salvar e Cancelar.
  assert.equal(await notes.isEditable(), true);
  await form.getByRole("button", { name: "Salvar alterações" }).waitFor();
  await form.getByRole("button", { name: "Cancelar" }).waitFor();
  // Cancelar descarta o que foi digitado e volta à visualização (campos bloqueados de verdade).
  await notes.fill("rascunho descartado");
  await form.getByRole("button", { name: "Cancelar" }).click();
  await form.getByRole("button", { name: "Editar", exact: true }).waitFor();
  assert.equal(await form.getByRole("button", { name: "Salvar alterações" }).count(), 0, "sem Salvar na visualização");
  assert.equal(await notes.isDisabled(), true, "campo bloqueado");
  assert.notEqual(await notes.inputValue(), "rascunho descartado");
  assert.equal(await one(`select count(*)::int from client where name = 'Admissão Tela' and notes = 'rascunho descartado'`), 0);
  // Editar de novo, salvar: confirmação, volta à visualização com os dados novos e campos bloqueados.
  await form.getByRole("button", { name: "Editar", exact: true }).click();
  await notes.fill("primeira etapa");
  await form.getByLabel("Titular da conta").fill("Titular Teste");
  await form.getByRole("button", { name: "Salvar alterações" }).click();
  await page.getByText(/Cliente Admissão Tela atualizado/).waitFor({ timeout: 15_000 });
  await form.getByRole("button", { name: "Editar", exact: true }).waitFor();
  assert.equal(await notes.isDisabled(), true);
  assert.equal(await notes.inputValue(), "primeira etapa", "a tela mostra o que foi salvo");
  assert.equal(await page.getByText("Salvando…").count(), 0, "nenhum botão preso em Salvando…");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/clientes-visualizacao-apos-salvar.png` });
  // Sem recarregar a página: Editar reabre na hora e uma segunda edição soma à primeira.
  await page.waitForTimeout(2000);
  await form.getByRole("button", { name: "Editar", exact: true }).click();
  assert.equal(await notes.isEditable(), true);
  assert.equal(await notes.inputValue(), "primeira etapa", "carrega os dados mais recentes");
  await form.getByLabel("Agência").fill("1234");
  await form.getByRole("button", { name: "Salvar alterações" }).click();
  await form.getByRole("button", { name: "Editar", exact: true }).waitFor({ timeout: 15_000 });
  assert.equal(await one(`select notes from client where name = 'Admissão Tela'`), "primeira etapa");
  assert.equal(await one(`select bank_holder_name from client where name = 'Admissão Tela'`), "Titular Teste");
  assert.equal(await one(`select bank_branch from client where name = 'Admissão Tela'`), "1234");
  // Falha ao salvar (CPF de outro cliente): continua em edição, com o que foi digitado e o erro.
  const otherCpf = await one(`select document from client where tenant_id = 'ten_roberio' and document is not null and name <> 'Admissão Tela' limit 1`);
  assert.ok(otherCpf, "há outro cliente com CPF para provocar a falha");
  await form.getByRole("button", { name: "Editar", exact: true }).click();
  await form.getByLabel("CPF", { exact: true }).fill(otherCpf);
  await notes.fill("não deve gravar");
  await form.getByRole("button", { name: "Salvar alterações" }).click();
  await form.getByRole("alert").or(form.locator(".form-feedback-error")).first().waitFor({ timeout: 15_000 });
  await form.getByRole("button", { name: "Salvar alterações" }).waitFor();
  assert.equal(await notes.inputValue(), "não deve gravar", "preserva o que foi digitado");
  assert.equal(await one(`select notes from client where name = 'Admissão Tela'`), "primeira etapa");
  await context.close();
});

test("CE9. nada que já existia mudou (operações, pagamentos, capital, investidores, clientes antigos)", async () => {
  assert.equal(await existingHash(), before);
});
