// Auditoria geral (14/10/2026): cabeçalhos de segurança e login de conta bloqueada.
// SÓ em ambiente LOCAL e DESCARTÁVEL (ver tests/e2e/README.md). Usa os usuários fictícios roberio@ e fernando@teste.local.
//   E2E_DATABASE_URL=… node --test tests/e2e/seguranca-auditoria.e2e.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Teste destrutivo: só roda em localhost.");
const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl || !/@(localhost|127\.0\.0\.1)[:/]/.test(databaseUrl)) throw new Error("E2E_DATABASE_URL precisa apontar para um banco local.");
const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
const admin = async (query) => sql.begin(async (tx) => { await tx`select set_config('app.crediai_role', 'SUPER_ADMIN', true)`; return tx.unsafe(query); });
const one = async (query) => Object.values((await admin(query))[0] ?? {})[0];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
after(async () => { await sql.end(); });

let lastLogin = 0;
async function signIn(email) {
  const wait = 11_000 - (Date.now() - lastLogin);
  if (wait > 0) await sleep(wait);
  lastLogin = Date.now();
  return fetch(`${BASE}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email, password: process.env.E2E_PASSWORD ?? "Senha-Teste-Local-123" }) });
}

test("SEG1. toda resposta traz os cabeçalhos contra abrir o CrediAI dentro de outro site", async () => {
  for (const path of ["/login", "/", "/investidores"]) {
    const response = await fetch(`${BASE}${path}`, { redirect: "manual" });
    assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN", path);
    assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'self'/, path);
    assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin", path);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", path);
  }
});

test("SEG2. conta bloqueada não entra: sem sessão nova e sem mudar o último acesso", async () => {
  await admin(`update "user" set active = false where email = 'roberio@teste.local'`);
  const before = await one(`select concat(count(s.*), '|', u.last_login_at) from "user" u left join session s on s.user_id = u.id where u.email = 'roberio@teste.local' group by u.last_login_at`);
  const response = await signIn("roberio@teste.local");
  assert.notEqual(response.status, 200);
  assert.match(await response.text(), /desativada/);
  assert.equal(response.headers.getSetCookie().some((cookie) => cookie.startsWith("better-auth.session_token=") && !/Max-Age=0/.test(cookie)), false);
  assert.equal(await one(`select concat(count(s.*), '|', u.last_login_at) from "user" u left join session s on s.user_id = u.id where u.email = 'roberio@teste.local' group by u.last_login_at`), before);
  await admin(`update "user" set active = true where email = 'roberio@teste.local'`);
});

test("SEG3. conta ativa, inclusive com senha provisória, continua entrando (a troca de senha depende disso)", async () => {
  assert.equal((await signIn("roberio@teste.local")).status, 200);
  await admin(`update "user" set must_change_password = true where email = 'fernando@teste.local'`);
  const temporary = await signIn("fernando@teste.local");
  assert.equal(temporary.status, 200);
  const cookie = temporary.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const home = await fetch(`${BASE}/`, { headers: { cookie }, redirect: "manual" });
  assert.match(home.headers.get("location") ?? "", /\/definir-senha/);
  await admin(`update "user" set must_change_password = false where email = 'fernando@teste.local'`);
});
