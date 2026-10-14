// Auditoria administrativa, último acesso e Registros, de ponta a ponta (HTTP + banco).
// SÓ em ambiente LOCAL e DESCARTÁVEL (ver tests/e2e/README.md). Cria um cliente SaaS fictício e age sobre ele.
//   E2E_DATABASE_URL=postgres://dono:senha@127.0.0.1:5432/crediai node --test tests/e2e/admin-audit.e2e.mjs
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
const actionId = (name) => Object.entries(manifest).find(([, value]) => value.exportedName === name)[0];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;| /g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
const IP = "203.0.113.45";

let lastLogin = 0;
async function login(email) {
  const wait = 11_000 - (Date.now() - lastLogin);
  if (wait > 0) await sleep(wait);
  lastLogin = Date.now();
  const response = await fetch(`${BASE}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, "x-forwarded-for": IP }, body: JSON.stringify({ email, password: process.env.E2E_PASSWORD ?? "Senha-Teste-Local-123" }) });
  assert.equal(response.status, 200);
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}
async function action(cookie, name, fields) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(`_1_${key}`, value);
  form.append("0", '["$K1"]');
  const response = await fetch(`${BASE}/admin`, { method: "POST", headers: { cookie, "next-action": actionId(name), accept: "text/x-component", origin: BASE, "x-forwarded-for": `${IP}, 10.0.0.1`, "user-agent": "CrediAI-E2E/1.0" }, body: form });
  const result = (await response.text()).match(/^1:(\{.*\})$/m)?.[1];
  return result ? JSON.parse(result) : null;
}
const html = async (cookie, path) => text(await (await fetch(`${BASE}${path}`, { headers: { cookie } })).text());

let thais, tenantId;
const events = async () => admin(`select action, actor_email, tenant_id, entity, entity_id, description, before, after, ip_address, user_agent from admin_audit_log where tenant_id = '${tenantId}' order by created_at, id`);

test("A1. cada ação administrativa grava quem, quando, cliente SaaS, antes/depois, IP e navegador", async () => {
  thais = await login("thais@teste.local");
  const created = await action(thais, "createSaasClientAction", { name: "Cliente Auditoria", email: "auditoria@teste.local", phone: "", planId: "plan_starter_v1", status: "TRIALING", trialDays: "14", tenantName: "" });
  assert.equal(created?.ok, true, JSON.stringify(created));
  tenantId = created.tenantId;
  assert.ok(!JSON.stringify(created).includes("Senha") || created.temporaryPassword);
  const steps = [
    ["updateSaasClientAction", { tenantId, name: "Cliente Auditoria", email: "auditoria@teste.local", phone: "11987654321", tenantName: "Auditoria · CrediAI" }],
    ["activateSubscriptionAction", { tenantId, planId: "plan_starter_v1", condition: "STANDARD", contractedPrice: "150,00", activatedAt: "2026-10-06", dueDate: "2026-11-06", graceDays: "5" }],
    ["updateCommercialTermsAction", { tenantId, planId: "plan_starter_v1", condition: "CUSTOM", contractedPrice: "120,00", dueDate: "2026-11-06", graceDays: "7" }],
    ["registerSubscriptionPaymentAction", { tenantId, paidAt: "2026-10-06", dueDate: "2026-11-06" }],
    ["setSaasClientStatusAction", { tenantId, action: "suspend" }],
    ["setSaasClientStatusAction", { tenantId, action: "reactivate" }],
    ["setSaasClientAccessAction", { tenantId, action: "block" }],
    ["setSaasClientAccessAction", { tenantId, action: "unblock" }],
    ["resetSaasClientPasswordAction", { tenantId }],
  ];
  for (const [name, fields] of steps) assert.equal((await action(thais, name, fields))?.ok, true, name);
  const rows = await events();
  assert.deepEqual(rows.map((row) => row.action), [
    "SAAS_CLIENT_CREATED", "USER_CREATED", "SAAS_CLIENT_UPDATED", "SUBSCRIPTION_ACTIVATED", "CONTRACTED_PRICE_CHANGED", "COMMERCIAL_TERMS_CHANGED",
    "SUBSCRIPTION_PAYMENT_REGISTERED", "SAAS_CLIENT_SUSPENDED", "SAAS_CLIENT_REACTIVATED", "USER_BLOCKED", "USER_UNBLOCKED", "PASSWORD_RESET",
  ]);
  for (const row of rows) {
    assert.equal(row.actor_email, "thais@teste.local");
    assert.equal(row.ip_address, IP);
    assert.equal(row.user_agent, "CrediAI-E2E/1.0");
    assert.ok(!/senha-|password|hash/i.test(JSON.stringify([row.before, row.after])), `${row.action} sem segredos`);
  }
  const activated = rows.find((row) => row.action === "SUBSCRIPTION_ACTIVATED");
  assert.equal(activated.before.status, "TRIALING");
  assert.equal(activated.after.status, "ACTIVE");
  assert.equal(activated.after.contractedPriceCents, 15000);
  const price = rows.find((row) => row.action === "CONTRACTED_PRICE_CHANGED");
  assert.equal(price.before.contractedPriceCents, 15000);
  assert.equal(price.after.contractedPriceCents, 12000);
  assert.equal(rows.find((row) => row.action === "SAAS_CLIENT_SUSPENDED").after.status, "SUSPENDED");
  // Plano do catálogo: alteração também auditada (sem cliente SaaS).
  const plan = await one("select row_to_json(p) from plan p where id = 'plan_starter_v1'");
  assert.equal((await action(thais, "updatePlanAction", { planId: plan.id, name: plan.name, description: plan.description, price: "150,00", active: "on" }))?.ok, true);
  assert.equal(await one("select action from admin_audit_log where entity = 'plan' order by created_at desc limit 1"), "PLAN_UPDATED");
});

test("A2. ação recusada não grava auditoria", async () => {
  const before = Number(await one("select count(*) from admin_audit_log"));
  const refused = await action(thais, "activateSubscriptionAction", { tenantId, planId: "plan_starter_v1", condition: "COURTESY", activatedAt: "2026-10-06", graceDays: "5" });
  assert.equal(refused?.ok, false);
  assert.equal(Number(await one("select count(*) from admin_audit_log")), before);
});

test("A3. tela Auditoria: lista, busca, filtro por ação e por cliente SaaS, ordem e detalhes de antes/depois", async () => {
  const all = await html(thais, "/admin/registros?aba=auditoria");
  assert.match(all, /Auditoria/);
  assert.match(all, /Assinatura ativada/);
  assert.match(all, /Thaís Fernanda/);
  assert.match(all, new RegExp(`IP ${IP.replaceAll(".", "\\.")}`));
  assert.ok(!/Editar|Excluir|Apagar/.test(all.split("Auditoria administrativa")[1] ?? ""), "sem botões de editar ou apagar");
  const filtered = await html(thais, "/admin/registros?aba=auditoria&acao=PASSWORD_RESET");
  assert.match(filtered, /1 registro/);
  assert.match(filtered, /Senha provisória gerada para auditoria@teste\.local/);
  const search = await html(thais, "/admin/registros?aba=auditoria&q=120%2C00");
  assert.match(search, /Valor contratado alterado de R\$ ?150,00\/mês para R\$ ?120,00/);
  assert.doesNotMatch(search, /Acesso bloqueado para/);
  const byTenant = await html(thais, `/admin/registros?aba=auditoria&tenant=${tenantId}&ordem=antigas`);
  assert.ok(byTenant.indexOf("Cliente SaaS Auditoria") < byTenant.indexOf("Senha provisória gerada"), "mais antigas primeiro");
  const none = await html(thais, "/admin/registros?aba=auditoria&de=2030-01-01");
  assert.match(none, /Nenhum registro com estes filtros/);
});

test("A4. último acesso igual em Clientes SaaS, detalhe do cliente e Registros (regra única)", async () => {
  // Sessão antiga do Fernando renovada em 05/10 depois do último login de 02/10: o acesso real é 05/10.
  await admin(`update "user" set last_login_at = '2026-10-02 13:00:00+00' where id = 'u_fernando'`);
  await admin(`delete from session where user_id = 'u_fernando' and id <> 'ses_fern_old'`);
  const expected = await one(`select greatest(u.last_login_at, (select max(greatest(s.created_at, s.updated_at)) from session s where s.user_id = u.id)) from "user" u where id = 'u_fernando'`);
  assert.equal(new Date(expected).toISOString(), "2026-10-05T18:30:00.000Z");
  const time = "15:30"; // 18:30 UTC em Brasília
  const label = new RegExp(`(Ontem às ${time}|Há \\d+ dias \\(05/10/2026\\))`);
  const list = await html(thais, "/admin?q=Fernando");
  const detail = await html(thais, "/admin/clientes/ten_fernando");
  const records = await html(thais, "/admin/registros?aba=usuarios");
  const pick = (page, pattern) => page.match(pattern)?.[0];
  const fromList = pick(list, /Último acesso (Ontem às \d\d:\d\d|Há \d+ dias \(\d\d\/\d\d\/\d{4}\)|Hoje às \d\d:\d\d)/)?.replace("Último acesso ", "");
  assert.match(fromList ?? "", label);
  assert.ok(detail.includes(`Último acesso ${fromList}`) && detail.includes(`último acesso ${fromList}`), "detalhe: cabeçalho e lista de usuários");
  assert.ok(records.includes(fromList), "Registros → Usuários");
});

test("A5. Registros: conta MASTER não aparece como cliente em teste; vencimento original separado do atual", async () => {
  const tenants = await html(thais, "/admin/registros?aba=tenants");
  const start = tenants.indexOf("MASTER thais@teste.local");
  const masterRow = tenants.slice(start, tenants.indexOf("·", start));
  assert.match(masterRow, /Conta da plataforma/);
  assert.match(masterRow, /Não se aplica/);
  assert.doesNotMatch(masterRow, /14\/10\/2026/);
  const operations = await html(thais, "/admin/registros?aba=operacoes");
  assert.match(operations, /Vencimento original/);
  assert.match(operations, /Vencimento atual/);
  // Renovado Teste: combinado para 20/08, renovado duas vezes → vence agora em 20/10.
  assert.match(operations, /Renovado Teste .*?20\/08\/2026 20\/10\/2026/);
  assert.match(operations, /Parcelado .*?Última parcela/);
  const saas = await html(thais, "/admin");
  assert.match(saas, /Ambiente sem usuário de acesso/);
});

test("encerramento", async () => { await sql.end(); });
