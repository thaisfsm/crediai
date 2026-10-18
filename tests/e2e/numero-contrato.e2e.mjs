// Número do contrato gerado pelo sistema (ANO.MÊS.DIA-0001): contador único por carteira, sem repetir nem em criações
// simultâneas, preservado na edição, independente entre carteiras. SÓ em ambiente LOCAL e DESCARTÁVEL (ver tests/e2e/README.md).
//   E2E_DATABASE_URL=postgres://dono:senha@127.0.0.1:5432/crediai node --test tests/e2e/numero-contrato.e2e.mjs
// (rodar com o servidor usando um papel COM BYPASSRLS e, de novo, sem ele)
import { after, test } from "node:test";
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
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;| /g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const daysAgo = (days) => { const date = new Date(`${TODAY}T00:00:00Z`); date.setUTCDate(date.getUTCDate() - days); return date.toISOString().slice(0, 10); };
const money = (cents) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100).replace(/\s/g, " ");
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
async function action(cookie, name, fields, path = "/contas-a-pagar") {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(`_1_${key}`, value);
  form.append("0", '["$K1"]');
  const response = await fetch(`${BASE}${path}`, { method: "POST", redirect: "manual", headers: { cookie, "next-action": actionId(name), accept: "text/x-component", origin: BASE }, body: form });
  const result = (await response.text()).match(/^1:(\{.*\})$/m)?.[1];
  return result ? JSON.parse(result) : null;
}
const investorAction = (cookie, name, fields) => action(cookie, name, fields, "/investidores");
const page = async (cookie, path) => {
  const response = await fetch(`${BASE}${path}`, { redirect: "manual", headers: cookie ? { cookie } : {} });
  return { status: response.status, location: response.headers.get("location"), html: response.status === 200 ? text(await response.text()) : "" };
};
let counter = 0;
const requestId = () => `e2e-cp-${Date.now()}-${++counter}-abcdef`;


let robério, fernando;
const ids = {};
const numbers = (tenantId) => admin(`select contract_number n from investment where tenant_id = '${tenantId}' and contract_number is not null order by created_at, id`).then((rows) => rows.map((row) => row.n));
const contract = (extra) => ({ amount: "10.000,00", rate: "5", ratePeriod: "MONTHLY", startDate: "2026-07-15", ...extra });

test("NC3. cada contrato novo recebe ANO.MÊS.DIA-0001, 0002… com a data de início; carteira B começa em 0001", async () => {
  robério = await login("roberio@teste.local");
  fernando = await login("fernando@teste.local");
  const investor = await investorAction(robério, "createInvestorAction", { personType: "PF", name: "Nara Numero", document: "411.797.058-58", bankName: "001 Banco do Brasil", bankAccount: "99887-6", pixKeyType: "CPF", pixKey: "411.797.058-58" });
  assert.equal(investor?.ok, true, JSON.stringify(investor));
  ids.investor = investor.id;
  const first = await investorAction(robério, "createInvestmentAction", contract({ investorId: ids.investor }));
  assert.equal(first?.ok, true, JSON.stringify(first));
  ids.first = first.id;
  const second = await investorAction(robério, "createInvestmentAction", contract({ investorId: ids.investor, startDate: "2026-09-03" }));
  assert.equal(second?.ok, true, JSON.stringify(second));
  assert.deepEqual(await numbers("ten_roberio"), ["2026.07.15-0001", "2026.09.03-0002"]);
  const other = await investorAction(fernando, "createInvestorAction", { personType: "PF", name: "Nuno Numero", document: "390.533.447-05", bankName: "001 Banco do Brasil", bankAccount: "99887-6", pixKeyType: "CPF", pixKey: "390.533.447-05" });
  assert.equal(other?.ok, true, JSON.stringify(other));
  const otherInvestment = await investorAction(fernando, "createInvestmentAction", contract({ investorId: other.id }));
  assert.equal(otherInvestment?.ok, true, JSON.stringify(otherInvestment));
  assert.deepEqual(await numbers("ten_fernando"), ["2026.07.15-0001"]);
});

test("NC4. cinco criações simultâneas: números todos diferentes e em sequência", async () => {
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => investorAction(robério, "createInvestmentAction", contract({ investorId: ids.investor, startDate: "2026-10-01" }))));
  for (const result of results) assert.equal(result?.ok, true, JSON.stringify(result));
  const all = await numbers("ten_roberio");
  assert.equal(new Set(all).size, 7);
  assert.deepEqual(all.map((n) => Number(n.slice(-4))).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
});

test("NC5. editar o contrato não muda o número; a tela mostra o número e não tem campo para digitar", async () => {
  const before = await one(`select contract_number from investment where id = '${ids.first}'`);
  const updated = await investorAction(robério, "updateInvestmentAction", contract({ investmentId: ids.first, amount: "10.000,00", rate: "6", contractNumber: "QUALQUER-1" }));
  assert.equal(updated?.ok, true, JSON.stringify(updated));
  assert.equal(await one(`select contract_number from investment where id = '${ids.first}'`), before);
  const view = await page(robério, `/investidores/${ids.investor}`);
  assert.equal(view.status, 200);
  assert.ok(view.html.includes(before), "número aparece na lista de investimentos");
});

