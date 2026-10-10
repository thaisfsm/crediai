// Módulo Investidores de ponta a ponta (HTTP + banco): cadastro, edição, investimentos, documentos, contatos de
// clientes, isolamento entre tenants, visão do MASTER e auditoria.
// SÓ em ambiente LOCAL e DESCARTÁVEL (ver tests/e2e/README.md). Usa os dados fictícios ten_roberio (A), ten_fernando (B)
// e ten_thais (MASTER). O servidor deve rodar com um papel de banco com BYPASSRLS (como a produção) e, de novo, sem ele.
//   E2E_DATABASE_URL=postgres://dono:senha@127.0.0.1:5432/crediai node --test tests/e2e/investors.e2e.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;| /g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

let lastLogin = 0;
async function login(email) {
  const wait = 11_000 - (Date.now() - lastLogin);
  if (wait > 0) await sleep(wait);
  lastLogin = Date.now();
  const response = await fetch(`${BASE}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email, password: process.env.E2E_PASSWORD ?? "Senha-Teste-Local-123" }) });
  assert.equal(response.status, 200, `login de ${email}`);
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}
async function action(cookie, name, fields, files = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(`_1_${key}`, value);
  for (const [key, [content, type, fileName]] of Object.entries(files)) form.append(`_1_${key}`, new Blob([content], { type }), fileName);
  form.append("0", '["$K1"]');
  const response = await fetch(`${BASE}/investidores`, { method: "POST", headers: { cookie, "next-action": actionId(name), accept: "text/x-component", origin: BASE }, body: form });
  const result = (await response.text()).match(/^1:(\{.*\})$/m)?.[1];
  return result ? JSON.parse(result) : null;
}
const page = async (cookie, path) => {
  const response = await fetch(`${BASE}${path}`, { redirect: "manual", headers: { cookie } });
  return { status: response.status, location: response.headers.get("location"), html: response.status === 200 ? text(await response.text()) : "" };
};
// Tudo o que o módulo não pode tocar: dados financeiros, assinaturas, tenants e usuários (inclusive Fernando e Robério).
const protectedHash = () => one(`select md5(string_agg(x, '|' order by x)) from (
  select 'o'||row(o.*)::text x from loan_operation o union all select 'p'||row(p.*)::text from payment p union all select 'r'||row(r.*)::text from loan_renewal r
  union all select 'w'||row(w.*)::text from wallet w union all select 'm'||row(m.*)::text from capital_movement m union all select 's'||row(s.*)::text from subscription s
  union all select 't'||row(t.*)::text from tenant t union all select 'u'||concat_ws(',', u.id, u.name, u.email, u.role, u.tenant_id, u.active) from "user" u
  union all select 'ch'||row(c.*)::text from subscription_charge c) t`);
const PDF = "%PDF-1.4 contrato de teste";
const PDF2 = "%PDF-1.4 contrato assinado v2";

let robério, fernando, thais, hashBefore;
const ids = {};

test("preparação", async () => {
  hashBefore = await protectedHash();
  robério = await login("roberio@teste.local");
  fernando = await login("fernando@teste.local");
  thais = await login("thais@teste.local");
});

test("V1. criar investidor (TENANT_USER grava na própria carteira, mesmo forjando outra)", async () => {
  const created = await action(robério, "createInvestorAction", {
    tenantId: "ten_fernando", name: "Investidora do Robério", document: "411.797.058-58", phone: "(11) 3456-7890", whatsapp: "(11) 98765-4321",
    email: "Investidora@Teste.Local", instagram: "@investidora", facebook: "https://facebook.com/investidora", notes: "conta bancária 123-4",
  });
  assert.equal(created?.ok, true, JSON.stringify(created));
  ids.investorA = created.id;
  const [row] = await admin(`select * from investor where id = '${ids.investorA}'`);
  assert.equal(row.tenant_id, "ten_roberio", "o tenant vem da sessão, não do formulário");
  assert.equal(row.document, "41179705858");
  assert.equal(row.whatsapp, "11987654321");
  assert.equal(row.email, "investidora@teste.local");
  assert.equal(row.instagram, "@investidora");
  assert.equal(row.status, "ACTIVE");
  // Mesmo CPF na mesma carteira: recusado com mensagem clara.
  const duplicate = await action(robério, "createInvestorAction", { name: "Outro", document: "41179705858" });
  assert.equal(duplicate?.ok, false);
  assert.match(duplicate.error, /CPF\/CNPJ/);
  // Investidor do tenant B, para as tentativas de acesso cruzado.
  const other = await action(fernando, "createInvestorAction", { name: "Investidor do Fernando", document: "12.345.678/0001-90" });
  assert.equal(other?.ok, true);
  ids.investorB = other.id;
});

test("V2. editar investidor e alterar status", async () => {
  const updated = await action(robério, "updateInvestorAction", { investorId: ids.investorA, name: "Investidora do Robério Ltda", document: "41179705858", phone: "", whatsapp: "(11) 98765-4321", email: "investidora@teste.local", instagram: "instagram.com/investidora", facebook: "", notes: "conta bancária 999-9", status: "ACTIVE" });
  assert.equal(updated?.ok, true, JSON.stringify(updated));
  const [row] = await admin(`select name, phone, instagram, facebook from investor where id = '${ids.investorA}'`);
  assert.deepEqual(row, { name: "Investidora do Robério Ltda", phone: null, instagram: "instagram.com/investidora", facebook: null });
  const inactive = await action(robério, "updateInvestorAction", { investorId: ids.investorA, name: "Investidora do Robério Ltda", document: "41179705858", whatsapp: "11987654321", email: "investidora@teste.local", instagram: "instagram.com/investidora", notes: "conta bancária 999-9", status: "INACTIVE" });
  assert.equal(inactive?.ok, true);
  // Inativo não recebe investimento novo; reativado, recebe.
  const blocked = await action(robério, "createInvestmentAction", { investorId: ids.investorA, amount: "1.000,00", rate: "1", ratePeriod: "MONTHLY", startDate: "2026-10-01" });
  assert.equal(blocked?.ok, false);
  assert.equal((await action(robério, "updateInvestorAction", { investorId: ids.investorA, name: "Investidora do Robério Ltda", document: "41179705858", whatsapp: "11987654321", email: "investidora@teste.local", instagram: "instagram.com/investidora", notes: "conta bancária 999-9", status: "ACTIVE" }))?.ok, true);
});

test("V3. criar e editar investimento (só o combinado; período da taxa explícito)", async () => {
  const noPeriod = await action(robério, "createInvestmentAction", { investorId: ids.investorA, amount: "50.000,00", rate: "1,5", ratePeriod: "", startDate: "2026-10-01" });
  assert.equal(noPeriod?.ok, false, "sem período da taxa não grava");
  const created = await action(robério, "createInvestmentAction", { investorId: ids.investorA, amount: "50.000,00", rate: "1,5", ratePeriod: "MONTHLY", startDate: "2026-10-01", maturityDate: "2027-10-01", dueDay: "5", notes: "pagamento por PIX", status: "PENDING_SIGNATURE" });
  assert.equal(created?.ok, true, JSON.stringify(created));
  ids.investmentA = created.id;
  const second = await action(robério, "createInvestmentAction", { investorId: ids.investorA, amount: "10.000,00", rate: "12", ratePeriod: "YEARLY", startDate: "2026-09-01", status: "ACTIVE" });
  assert.equal(second?.ok, true);
  const [row] = await admin(`select tenant_id, amount_cents, agreed_rate_bps, rate_period, start_date::text, maturity_date::text, due_day, status, calculation_rule from investment where id = '${ids.investmentA}'`);
  assert.deepEqual(row, { tenant_id: "ten_roberio", amount_cents: "5000000", agreed_rate_bps: 150, rate_period: "MONTHLY", start_date: "2026-10-01", maturity_date: "2027-10-01", due_day: 5, status: "PENDING_SIGNATURE", calculation_rule: null });
  const edited = await action(robério, "updateInvestmentAction", { investmentId: ids.investmentA, amount: "55.000,00", rate: "1,5", ratePeriod: "MONTHLY", startDate: "2026-10-01", maturityDate: "2027-10-01", dueDay: "5", notes: "pagamento por PIX", status: "ACTIVE" });
  assert.equal(edited?.ok, true);
  assert.equal(await one(`select amount_cents from investment where id = '${ids.investmentA}'`), "5500000");
  const otherB = await action(fernando, "createInvestmentAction", { investorId: ids.investorB, amount: "7.000,00", rate: "2", ratePeriod: "CONTRACT_TERM", startDate: "2026-10-01" });
  assert.equal(otherB?.ok, true);
  ids.investmentB = otherB.id;
});

test("V4. listar e acessar detalhes: painel, lista com busca/filtros, ficha e contrato", async () => {
  const list = await page(robério, "/investidores");
  assert.equal(list.status, 200);
  for (const expected of ["Investidores", "Capital investido", "R$ 65.000,00", "Investimentos ativos", "Rendimentos previstos", "Aguardando regra", "Total a devolver", "Próximos vencimentos", "Investidora do Robério Ltda", "411.797.058-58", "investidora@teste.local", "Instagram", "Facebook"]) assert.ok(list.html.includes(expected), `lista sem "${expected}"`);
  assert.ok(!list.html.includes("Investidor do Fernando"));
  assert.ok((await page(robério, "/investidores?q=79705")).html.includes("Investidora do Robério Ltda"), "busca por CPF");
  assert.ok(!(await page(robério, "/investidores?q=zzz")).html.includes("Investidora do Robério Ltda"));
  assert.ok((await page(robério, "/investidores?status=INACTIVE")).html.includes("Nenhum investidor com esses filtros"));
  const detail = await page(robério, `/investidores/${ids.investorA}`);
  assert.equal(detail.status, 200);
  for (const expected of ["Dados e contatos", "WhatsApp", "(11) 98765-4321", "conta bancária 999-9", "Investimentos", "R$ 55.000,00", "1,5% ao mês", "R$ 10.000,00", "12% ao ano", "Pendente"]) assert.ok(detail.html.includes(expected), `ficha sem "${expected}"`);
  const contract = await page(robério, `/investidores/investimentos/${ids.investmentA}`);
  assert.equal(contract.status, 200);
  for (const expected of ["Contrato", "Valor investido", "1,5% ao mês", "01/10/2027", "Dia 5", "Rendimento e devolução", "Aguardando regra", "Documentos", "Contrato assinado ainda não enviado"]) assert.ok(contract.html.includes(expected), `contrato sem "${expected}"`);
});

test("V5. vincular documento ao investimento: enviar, visualizar, baixar e substituir (histórico mantido)", async () => {
  const uploaded = await action(robério, "uploadInvestmentDocumentAction", { investmentId: ids.investmentA, kind: "SIGNED_CONTRACT" }, { file: [PDF, "application/pdf", "contrato.pdf"] });
  assert.equal(uploaded?.ok, true, JSON.stringify(uploaded));
  ids.documentA = uploaded.id;
  const [row] = await admin(`select investment_id, tenant_id, kind, file_name, content_type, size_bytes from investment_document where id = '${ids.documentA}'`);
  assert.deepEqual(row, { investment_id: ids.investmentA, tenant_id: "ten_roberio", kind: "SIGNED_CONTRACT", file_name: "contrato.pdf", content_type: "application/pdf", size_bytes: PDF.length });
  // Segundo contrato assinado: só por substituição. Arquivo que não é PDF/imagem: recusado.
  assert.equal((await action(robério, "uploadInvestmentDocumentAction", { investmentId: ids.investmentA, kind: "SIGNED_CONTRACT" }, { file: [PDF, "application/pdf", "c2.pdf"] }))?.ok, false);
  assert.equal((await action(robério, "uploadInvestmentDocumentAction", { investmentId: ids.investmentA, kind: "OTHER" }, { file: ["MZ executável", "application/pdf", "x.pdf"] }))?.ok, false);
  const view = await fetch(`${BASE}/investidores/documentos/${ids.documentA}`, { headers: { cookie: robério } });
  assert.equal(view.status, 200);
  assert.match(view.headers.get("content-disposition"), /^inline/);
  assert.equal(view.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await view.text(), PDF);
  const download = await fetch(`${BASE}/investidores/documentos/${ids.documentA}?baixar=1`, { headers: { cookie: robério } });
  assert.match(download.headers.get("content-disposition"), /^attachment/);
  const replaced = await action(robério, "replaceInvestmentDocumentAction", { documentId: ids.documentA }, { file: [PDF2, "application/pdf", "contrato-assinado.pdf"] });
  assert.equal(replaced?.ok, true, JSON.stringify(replaced));
  ids.documentA2 = replaced.id;
  const versions = await admin(`select id, replaced_by_document_id, replaced_at is not null as replaced from investment_document where investment_id = '${ids.investmentA}' order by created_at`);
  assert.deepEqual(versions, [{ id: ids.documentA, replaced_by_document_id: ids.documentA2, replaced: true }, { id: ids.documentA2, replaced_by_document_id: null, replaced: false }]);
  assert.equal((await action(robério, "replaceInvestmentDocumentAction", { documentId: ids.documentA }, { file: [PDF2, "application/pdf", "x.pdf"] }))?.ok, false, "versão antiga não é substituída de novo");
  const contract = await page(robério, `/investidores/investimentos/${ids.investmentA}`);
  assert.ok(contract.html.includes("contrato-assinado.pdf") && contract.html.includes("Versões substituídas (1)") && !contract.html.includes("Contrato assinado ainda não enviado"));
  const bDoc = await action(fernando, "uploadInvestmentDocumentAction", { investmentId: ids.investmentB, kind: "SIGNED_CONTRACT" }, { file: [PDF, "application/pdf", "b.pdf"] });
  assert.equal(bDoc?.ok, true);
  ids.documentB = bDoc.id;
});

test("V6. editar cliente adicionando WhatsApp, e-mail, Instagram e Facebook (nada financeiro muda)", async () => {
  const response = await fetch(`${BASE}/`, { method: "POST", headers: { cookie: robério, "next-action": actionId("updateClientAction"), accept: "text/x-component", origin: BASE }, body: (() => {
    const form = new FormData();
    for (const [key, value] of Object.entries({ clientId: "c_rob", name: "Cliente do Robério", whatsapp: "(11) 91234-5678", email: "cliente@teste.local", instagram: "@cliente.rob", facebook: "facebook.com/cliente.rob" })) form.append(`_1_${key}`, value);
    form.append("0", '["$K1"]');
    return form;
  })() });
  assert.match(await response.text(), /"ok":true/);
  const [row] = await admin(`select whatsapp, email, instagram, facebook from client where id = 'c_rob'`);
  assert.deepEqual(row, { whatsapp: "11912345678", email: "cliente@teste.local", instagram: "@cliente.rob", facebook: "facebook.com/cliente.rob" });
  const clients = await page(robério, "/?tela=clientes");
  assert.ok(clients.html.includes("WhatsApp (11) 91234-5678"));
});

test("V7. TENANT_USER não acessa investidores, investimentos nem documentos de outro tenant", async () => {
  const before = await one(`select md5(string_agg(row(x.*)::text, '|' order by x.id)) from (select id, tenant_id, name, document, status, updated_at from investor union all select id, tenant_id, investor_id, amount_cents::text, status::text, updated_at from investment) x`);
  const docsBefore = await one(`select md5(string_agg(row(d.id, d.replaced_at)::text, '|' order by d.id)) from investment_document d`);
  for (const path of [`/investidores/${ids.investorB}`, `/investidores/investimentos/${ids.investmentB}`]) assert.equal((await page(robério, path)).status, 404, path);
  assert.equal((await fetch(`${BASE}/investidores/documentos/${ids.documentB}`, { headers: { cookie: robério } })).status, 404);
  assert.equal((await fetch(`${BASE}/investidores/documentos/${ids.documentA2}`, { headers: { cookie: fernando } })).status, 404);
  assert.ok(!(await page(fernando, "/investidores")).html.includes("Investidora do Robério"));
  // O filtro de carteira não vale para o usuário do tenant.
  assert.ok(!(await page(robério, "/investidores?carteira=ten_fernando")).html.includes("Investidor do Fernando"));
  const attempts = [
    ["updateInvestorAction", { investorId: ids.investorB, name: "Invadido" }],
    ["createInvestmentAction", { investorId: ids.investorB, amount: "1,00", rate: "1", ratePeriod: "MONTHLY", startDate: "2026-10-01" }],
    ["updateInvestmentAction", { investmentId: ids.investmentB, amount: "1,00", rate: "1", ratePeriod: "MONTHLY", startDate: "2026-10-01" }],
  ];
  for (const [name, fields] of attempts) {
    const result = await action(robério, name, fields);
    assert.equal(result?.ok, false, `${name} deveria recusar`);
    assert.match(result.error, /não encontrad/i, name);
  }
  assert.equal((await action(robério, "uploadInvestmentDocumentAction", { investmentId: ids.investmentB, kind: "OTHER" }, { file: [PDF, "application/pdf", "x.pdf"] }))?.ok, false);
  assert.equal((await action(robério, "replaceInvestmentDocumentAction", { documentId: ids.documentB }, { file: [PDF, "application/pdf", "x.pdf"] }))?.ok, false);
  assert.equal(await one(`select md5(string_agg(row(x.*)::text, '|' order by x.id)) from (select id, tenant_id, name, document, status, updated_at from investor union all select id, tenant_id, investor_id, amount_cents::text, status::text, updated_at from investment) x`), before);
  assert.equal(await one(`select md5(string_agg(row(d.id, d.replaced_at)::text, '|' order by d.id)) from investment_document d`), docsBefore);
  // Sem sessão: login.
  assert.equal((await page("", "/investidores")).location?.endsWith("/login"), true);
});

test("V8. MASTER vê e administra investidores, contratos e documentos de todas as carteiras", async () => {
  const list = await page(thais, "/investidores");
  assert.equal(list.status, 200);
  assert.ok(list.html.includes("Investidora do Robério Ltda") && list.html.includes("Investidor do Fernando") && list.html.includes("Carteira"));
  assert.ok((await page(thais, "/investidores?carteira=ten_fernando")).html.includes("Investidor do Fernando"));
  assert.ok(!(await page(thais, "/investidores?carteira=ten_fernando")).html.includes("Investidora do Robério Ltda"));
  assert.equal((await page(thais, `/investidores/${ids.investorB}`)).status, 200);
  assert.equal((await page(thais, `/investidores/investimentos/${ids.investmentA}`)).status, 200);
  assert.equal((await fetch(`${BASE}/investidores/documentos/${ids.documentB}`, { headers: { cookie: thais } })).status, 200);
  const created = await action(thais, "createInvestorAction", { tenantId: "ten_fernando", name: "Investidor criado pelo MASTER" });
  assert.equal(created?.ok, true);
  assert.equal(await one(`select tenant_id from investor where id = '${created.id}'`), "ten_fernando");
  const edited = await action(thais, "updateInvestmentAction", { investmentId: ids.investmentB, amount: "7.000,00", rate: "2", ratePeriod: "CONTRACT_TERM", startDate: "2026-10-01", status: "CLOSED" });
  assert.equal(edited?.ok, true);
  // O usuário do tenant B continua vendo o que o MASTER cadastrou na carteira dele.
  assert.ok((await page(fernando, "/investidores")).html.includes("Investidor criado pelo MASTER"));
});

test("V9. auditoria: cada ação grava quem, carteira, antes/depois; sem conteúdo de arquivo nem observações em texto", async () => {
  const rows = await admin(`select action, actor_email, tenant_id, tenant_name, entity, entity_id, before, after from admin_audit_log where entity in ('investor','investment','investment_document') order by created_at, id`);
  const actions = rows.map((row) => `${row.actor_email.split("@")[0]}:${row.action}`);
  for (const expected of ["roberio:INVESTOR_CREATED", "roberio:INVESTOR_UPDATED", "roberio:INVESTOR_STATUS_CHANGED", "roberio:INVESTMENT_CREATED", "roberio:INVESTMENT_UPDATED", "roberio:INVESTMENT_STATUS_CHANGED", "roberio:INVESTMENT_DOCUMENT_UPLOADED", "roberio:INVESTMENT_DOCUMENT_REPLACED", "fernando:INVESTOR_CREATED", "thais:INVESTOR_CREATED", "thais:INVESTMENT_STATUS_CHANGED"]) {
    assert.ok(actions.includes(expected), `falta ${expected}`);
  }
  for (const row of rows) {
    assert.ok(["ten_roberio", "ten_fernando"].includes(row.tenant_id));
    assert.ok(row.tenant_name);
    const json = JSON.stringify([row.before, row.after]);
    assert.ok(!/conta bancária|PDF-1\.4|password|hash|token|content"/i.test(json), `auditoria com conteúdo sensível: ${json}`);
  }
  const masterEvent = rows.find((row) => row.actor_email === "thais@teste.local" && row.action === "INVESTOR_CREATED");
  assert.equal(masterEvent.tenant_id, "ten_fernando", "evento do MASTER fica na carteira em que ele agiu");
  const replaced = rows.find((row) => row.action === "INVESTMENT_DOCUMENT_REPLACED");
  assert.equal(replaced.before.fileName, "contrato.pdf");
  assert.equal(replaced.after.fileName, "contrato-assinado.pdf");
  assert.equal(replaced.after.replacedDocumentId, ids.documentA);
  // Ações recusadas (outro tenant, inválidas) não deixam evento: nenhum evento no investidor B feito pelo Robério.
  assert.ok(!rows.some((row) => row.actor_email === "roberio@teste.local" && row.tenant_id !== "ten_roberio"));
  // A tela de Auditoria do MASTER mostra os eventos; o usuário do tenant não lê a auditoria.
  const auditPage = await page(thais, "/admin/registros?aba=auditoria");
  assert.ok(auditPage.html.includes("Investidor cadastrado") && auditPage.html.includes("Documento do investimento substituído"));
  assert.notEqual((await page(robério, "/admin/registros")).status, 200);
});

test("V10. nenhum dado financeiro, assinatura, tenant ou usuário mudou", async () => {
  assert.equal(await protectedHash(), hashBefore);
});

test("encerramento", async () => { await sql.end(); });
