// Teste de isolamento multi-tenant e de permissões, de ponta a ponta (HTTP + banco).
//
// SÓ roda contra um ambiente LOCAL e DESCARTÁVEL: `next start` em localhost e um PostgreSQL de teste com os dados
// fictícios de tests/e2e/README.md. Recusa qualquer endereço que não seja localhost. Nunca rodar em produção.
//
//   E2E_DATABASE_URL=postgres://dono:senha@127.0.0.1:5432/crediai node tests/e2e/isolation.e2e.mjs
//
// O servidor deve usar um papel de banco com BYPASSRLS (como a produção), para provar que o isolamento não depende
// só do RLS: cada ação precisa filtrar pelo tenant da sessão.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import postgres from "postgres";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Teste destrutivo: só roda em localhost.");
const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl || !/@(localhost|127\.0\.0\.1)[:/]/.test(databaseUrl)) throw new Error("E2E_DATABASE_URL precisa apontar para um banco local.");
const PASSWORD = process.env.E2E_PASSWORD ?? "Senha-Teste-Local-123";
const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
const admin = async (query) => sql.begin(async (tx) => { await tx`select set_config('app.crediai_role', 'SUPER_ADMIN', true)`; return tx.unsafe(query); });
const one = async (query) => Object.values((await admin(query))[0] ?? {})[0];

const manifest = JSON.parse(readFileSync(".next/server/server-reference-manifest.json", "utf8")).node;
const actionId = (name) => Object.entries(manifest).find(([, value]) => value.exportedName === name)?.[0] ?? assert.fail(`ação ${name} não encontrada no build`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let lastLogin = 0;
async function login(email) {
  // O Better Auth limita tentativas de login por IP: espaça os logins.
  const wait = 11_000 - (Date.now() - lastLogin);
  if (wait > 0) await sleep(wait);
  lastLogin = Date.now();
  const response = await fetch(`${BASE}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email, password: PASSWORD }) });
  assert.equal(response.status, 200, `login de ${email}`);
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}

// Server action chamada como o navegador chama (FormData como único argumento), mas com os valores que quisermos:
// é assim que um usuário mal-intencionado tentaria usar ids de outro tenant.
async function action(cookie, name, fields, files = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(`_1_${key}`, value);
  for (const [key, [content, type, fileName]] of Object.entries(files)) form.append(`_1_${key}`, new Blob([content], { type }), fileName);
  form.append("0", '["$K1"]');
  const response = await fetch(`${BASE}/`, { method: "POST", redirect: "manual", headers: { cookie, "next-action": actionId(name), accept: "text/x-component", origin: BASE }, body: form });
  const text = await response.text();
  const result = text.match(/^1:(\{.*\})$/m)?.[1];
  return { status: response.status, redirect: response.headers.get("x-action-redirect"), result: result ? JSON.parse(result) : null };
}
const page = async (cookie, path) => {
  const response = await fetch(`${BASE}${path}`, { redirect: "manual", headers: { cookie } });
  return { status: response.status, location: response.headers.get("location"), html: response.status === 200 ? await response.text() : "" };
};

// Dados do tenant B (Fernando) e o que o tenant A (Robério) não pode tocar.
const tenantBHash = () => one(`select md5(string_agg(x, '|' order by x)) from (
  select 'c'||row(c.*)::text x from client c where tenant_id = 'ten_fernando' union all select 'o'||row(o.*)::text from loan_operation o where tenant_id = 'ten_fernando'
  union all select 'p'||row(p.*)::text from payment p where tenant_id = 'ten_fernando' union all select 'w'||row(w.*)::text from wallet w where tenant_id = 'ten_fernando'
  union all select 'm'||row(m.*)::text from capital_movement m where tenant_id = 'ten_fernando' union all select 'd'||d.id from client_document d where tenant_id = 'ten_fernando'
  union all select 'r'||row(r.*)::text from loan_renewal r where tenant_id = 'ten_fernando') t`);
const platformHash = () => one(`select md5(string_agg(x, '|' order by x)) from (
  select 't'||row(t.*)::text x from tenant t union all select 's'||row(s.*)::text from subscription s union all select 'pl'||row(p.*)::text from plan p
  union all select 'u'||concat_ws(',', u.id, u.name, u.email, u.role, u.tenant_id, u.active, u.must_change_password) from "user" u
  union all select 'a'||row(a.*)::text from account a union all select 'ch'||row(c.*)::text from subscription_charge c) t`);
const B_NAMES = ["Alexandre Teste", "Willian Teste", "Amany Teste", "Cinco Mil Teste"];

let robério, fernando, thais;
test("preparação: dados fictícios de dois tenants e um SUPER_ADMIN", async () => {
  // Documento e aporte do tenant B, para tentar apagar/estornar a partir do tenant A.
  await admin(`insert into client_document(id, tenant_id, client_id, label, file_name, content_type, size_bytes, content) values ('doc_b', 'ten_fernando', 'c_alex', 'RG', 'rg.pdf', 'application/pdf', 5, '%PDF-'::bytea) on conflict do nothing`);
  await admin(`insert into capital_movement(id, tenant_id, kind, amount_cents, occurred_at) values ('cap_b', 'ten_fernando', 'CONTRIBUTION', 1000, '2026-10-01') on conflict do nothing`);
  robério = await login("roberio@teste.local");
  fernando = await login("fernando@teste.local");
  thais = await login("thais@teste.local");
});

test("I1. tenant A não lê clientes, operações, pagamentos, carteira, dashboard nem relatórios do tenant B", async () => {
  for (const tela of ["", "?tela=clientes", "?tela=operacoes", "?tela=pagamentos", "?tela=capital", "?tela=cobrancas", "?tela=relatorios", "?tela=configuracoes"]) {
    const { status, html } = await page(robério, `/${tela}`);
    assert.equal(status, 200, tela);
    assert.ok(html.includes("Cliente do Robério"), `tela ${tela || "dashboard"} mostra os dados do próprio tenant`);
    for (const name of B_NAMES) assert.ok(!html.includes(name), `tela ${tela || "dashboard"} vazou ${name}`);
  }
  // E o tenant B não vê o tenant A.
  const { html } = await page(fernando, "/?tela=clientes");
  assert.ok(html.includes("Alexandre Teste") && !html.includes("Cliente do Robério"));
  // Download de documento de outro tenant: 404.
  assert.equal((await fetch(`${BASE}/documentos/doc_b`, { headers: { cookie: robério } })).status, 404);
});

test("I2. tenant A não altera nada do tenant B usando ids do B nas ações", async () => {
  const before = await tenantBHash();
  const attempts = [
    ["registerPaymentAction", { operationId: "op_will", amount: "100,00", paidAt: "2026-10-05", notes: "" }],
    ["editPaymentAction", { paymentId: "pay_will1", amount: "1,00", paidAt: "2026-04-10", notes: "" }],
    ["cancelOperationAction", { operationId: "op_alex" }],
    ["updateClientAction", { clientId: "c_alex", name: "Invadido" }],
    ["deleteClientAction", { clientId: "c_alex" }],
    ["createOperationAction", { clientId: "c_alex", modality: "SINGLE", frequency: "MONTHLY", principal: "10,00", rate: "10", loanDate: "2026-10-05", dueDate: "2026-11-05" }],
    ["deleteClientDocumentAction", { documentId: "doc_b" }],
    ["reverseContributionAction", { movementId: "cap_b" }],
  ];
  for (const [name, fields] of attempts) {
    const response = await action(robério, name, fields);
    assert.equal(response.result?.ok, false, `${name} deveria recusar`);
    assert.match(response.result.error, /não encontrad|inválid/i, name);
  }
  const upload = await action(robério, "uploadClientDocumentAction", { clientId: "c_alex", label: "RG" }, { file: ["%PDF-1.4 teste", "application/pdf", "rg.pdf"] });
  assert.equal(upload.result?.ok, false);
  assert.equal(await tenantBHash(), before, "nenhum dado do tenant B mudou");
});

test("I3. TENANT_USER não entra na administração nem usa nenhuma ação administrativa", async () => {
  for (const path of ["/admin", "/admin/registros", "/admin/registros?aba=auditoria", "/admin/planos", "/admin/clientes/novo", "/admin/clientes/ten_fernando"]) {
    const { status, location } = await page(robério, path);
    assert.ok([307, 308, 303].includes(status) && location === "/", `${path} → ${status} ${location}`);
  }
  const before = await platformHash();
  const auditBefore = Number(await one("select count(*) from admin_audit_log"));
  const attempts = [
    ["activateSubscriptionAction", { tenantId: "ten_roberio", planId: "plan_starter_v1", condition: "COURTESY", activatedAt: "2026-10-06", graceDays: "5" }],
    ["updateCommercialTermsAction", { tenantId: "ten_roberio", planId: "plan_starter_v1", condition: "CUSTOM", contractedPrice: "1,00", dueDate: "2026-11-06", graceDays: "5" }],
    ["registerSubscriptionPaymentAction", { tenantId: "ten_roberio", paidAt: "2026-10-06", dueDate: "2026-10-06" }],
    ["setSaasClientStatusAction", { tenantId: "ten_fernando", action: "suspend" }],
    ["setSaasClientAccessAction", { tenantId: "ten_fernando", action: "block" }],
    ["resetSaasClientPasswordAction", { tenantId: "ten_fernando" }],
    ["updateSaasClientAction", { tenantId: "ten_roberio", name: "Robério", email: "roberio@teste.local", phone: "", tenantName: "Invadido" }],
    ["createSaasClientAction", { name: "Intruso", email: "intruso@teste.local", phone: "", planId: "plan_starter_v1", status: "ACTIVE", condition: "COURTESY", activatedAt: "2026-10-06" }],
    ["createPlanAction", { name: "Plano grátis", price: "0", active: "on" }],
    ["updatePlanAction", { planId: "plan_starter_v1", name: "Starter", price: "0,01", active: "on" }],
  ];
  for (const [name, fields] of attempts) {
    const response = await action(robério, name, fields);
    // requireSuperAdmin redireciona para "/" sem executar nada.
    assert.ok(response.result === null && (response.redirect?.startsWith("/;") || response.redirect === "/" || response.status === 303), `${name}: ${response.status} ${response.redirect} ${JSON.stringify(response.result)}`);
  }
  assert.equal(await platformHash(), before, "tenants, assinaturas, planos, usuários e mensalidades intactos");
  assert.equal(Number(await one("select count(*) from admin_audit_log")), auditBefore);
});

test("I4. TENANT_USER não vira SUPER_ADMIN, não troca de tenant e não cria conta pelo Better Auth", async () => {
  const updated = await fetch(`${BASE}/api/auth/update-user`, { method: "POST", headers: { cookie: robério, "content-type": "application/json", origin: BASE }, body: JSON.stringify({ name: "Robério Santos", role: "SUPER_ADMIN", tenantId: "ten_fernando", active: true, mustChangePassword: false }) });
  assert.ok(updated.status >= 400 || updated.status === 200);
  assert.equal(await one("select role::text || '|' || tenant_id from \"user\" where id = 'u_roberio'"), "TENANT_USER|ten_roberio");
  const signUp = await fetch(`${BASE}/api/auth/sign-up/email`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ name: "Novo", email: "novo-admin@teste.local", password: "Senha-Teste-Local-123", role: "SUPER_ADMIN" }) });
  assert.ok(signUp.status >= 400, `cadastro público recusado (${signUp.status})`);
  assert.equal(Number(await one("select count(*) from \"user\" where email = 'novo-admin@teste.local'")), 0);
  // E o banco recusa promover qualquer conta a SUPER_ADMIN fora do procedimento administrativo (gatilho da 0009).
  await assert.rejects(admin(`update "user" set role = 'SUPER_ADMIN' where id = 'u_roberio'`), /SUPER_ADMIN só pode ser concedido/);
  // Sem acesso à administração continua valendo depois da tentativa.
  assert.equal((await page(robério, "/admin")).location, "/");
});

test("I5. SUPER_ADMIN acessa a administração; na própria carteira vê só o próprio tenant", async () => {
  for (const path of ["/admin", "/admin/registros", "/admin/registros?aba=auditoria", "/admin/planos", "/admin/clientes/ten_fernando"]) {
    assert.equal((await page(thais, path)).status, 200, path);
  }
  const { html } = await page(thais, "/?tela=clientes");
  assert.ok(html.includes("Cliente da Thaís"));
  for (const name of [...B_NAMES, "Cliente do Robério"]) assert.ok(!html.includes(name), `carteira do MASTER vazou ${name}`);
});

test("encerramento", async () => { await sql.end(); });
