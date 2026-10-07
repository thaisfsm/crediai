import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AUDIT_ACTIONS, changedFields, cleanSnapshot, clientIp } from "../src/lib/admin/audit-rules.ts";
import { lastAccessOf, relativeAccessLabel } from "../src/lib/admin/last-access.ts";

test("AU1. auditoria nunca grava senha, hash ou token", () => {
  const snapshot = cleanSnapshot({ name: "Ana", password: "x", passwordHash: "h", temporaryPassword: "t", token: "k", sessionToken: "s", active: true, extra: { nested: 1 }, at: new Date("2026-10-06T12:00:00Z") });
  assert.deepEqual(snapshot, { name: "Ana", active: true, at: "2026-10-06T12:00:00.000Z" });
});

test("AU2. diferença entre antes e depois lista só os campos que mudaram", () => {
  assert.deepEqual(changedFields({ status: "TRIALING", planId: "p1", contractedPriceCents: null }, { status: "ACTIVE", planId: "p1", contractedPriceCents: 15000 }), ["contractedPriceCents", "status"]);
  assert.deepEqual(changedFields(null, { a: 1 }), ["a"]);
  assert.deepEqual(changedFields({ a: 1 }, { a: 1 }), []);
});

test("AU3. IP do cliente: primeiro endereço do x-forwarded-for, senão x-real-ip", () => {
  assert.equal(clientIp("191.188.235.74, 10.0.0.1", null), "191.188.235.74");
  assert.equal(clientIp(null, "177.198.102.27"), "177.198.102.27");
  assert.equal(clientIp("", null), null);
});

test("AU4. todas as ações administrativas pedidas têm evento de auditoria gravado no código", () => {
  const source = readFileSync("src/app/admin/actions.ts", "utf8") + readFileSync("src/app/admin/planos/actions.ts", "utf8") + readFileSync("scripts/create-super-admin.ts", "utf8");
  for (const action of Object.keys(AUDIT_ACTIONS)) assert.ok(source.includes(`"${action}"`), `${action} sem registro`);
  // Toda ação exportada que altera dados chama recordAdminAudit (nenhuma ação administrativa sem auditoria).
  const admin = readFileSync("src/app/admin/actions.ts", "utf8");
  const exported = [...admin.matchAll(/export async function (\w+)/g)].map((match) => match[1]);
  for (const name of exported) {
    const body = admin.slice(admin.indexOf(`export async function ${name}`)).split(/\nexport async function /)[0];
    assert.ok(body.includes("recordAdminAudit("), `${name} não grava auditoria`);
  }
});

test("AU5. a migration 0014 torna a auditoria somente de inserção (sem UPDATE/DELETE/TRUNCATE, nem para o dono do banco)", () => {
  const migration = readFileSync("drizzle/0014_admin_audit_log.sql", "utf8");
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON "admin_audit_log"/);
  assert.match(migration, /BEFORE TRUNCATE ON "admin_audit_log"/);
  assert.doesNotMatch(migration, /FOR (UPDATE|DELETE)/);
  // Só cria coisas novas: nenhuma tabela existente é alterada.
  assert.doesNotMatch(migration, /ALTER TABLE "(?!admin_audit_log")|DROP |UPDATE "|DELETE FROM|INSERT INTO/);
});

test("LA1. último acesso: o mais recente entre o último login e a última atividade da sessão", () => {
  // Caso do Fernando: login em 02/10, sessão renovada (usada) em 05/10 → último acesso 05/10.
  assert.equal(lastAccessOf("2026-10-02T13:00:00Z", "2026-10-05T18:30:00Z"), "2026-10-05T18:30:00.000Z");
  assert.equal(lastAccessOf(new Date("2026-10-06T10:00:00Z"), "2026-10-05T18:30:00Z"), "2026-10-06T10:00:00.000Z");
  // Depois do "Sair" a sessão some, mas o último login continua valendo.
  assert.equal(lastAccessOf("2026-10-02T13:00:00Z", null), "2026-10-02T13:00:00.000Z");
  assert.equal(lastAccessOf(null, null), null);
});

test("LA2. texto do último acesso por dia de calendário em Brasília", () => {
  const now = new Date("2026-10-06T15:00:00Z"); // 12:00 em Brasília
  assert.equal(relativeAccessLabel(null, now), "Nunca acessou");
  assert.equal(relativeAccessLabel("2026-10-06T13:05:00Z", now), "Hoje às 10:05");
  // 23:30 de ontem em Brasília (02:30 UTC de hoje) é "Ontem", não "Hoje".
  assert.equal(relativeAccessLabel("2026-10-06T02:30:00Z", now), "Ontem às 23:30");
  assert.equal(relativeAccessLabel("2026-10-02T13:00:00Z", now), "Há 4 dias (02/10/2026)");
  assert.equal(relativeAccessLabel("2026-08-01T13:00:00Z", now), "01/08/2026");
});

test("LA3. todas as telas usam a mesma regra (nenhuma lê last_login_at sozinho para mostrar o último acesso)", () => {
  const queries = readFileSync("src/lib/admin/queries.ts", "utf8");
  assert.equal((queries.match(/lastAccessOf\(/g) ?? []).length, 3, "Clientes SaaS/detalhe, usuários do detalhe e Registros");
  for (const file of ["src/app/admin/page.tsx", "src/app/admin/clientes/[id]/page.tsx", "src/app/admin/registros/page.tsx"]) {
    const page = readFileSync(file, "utf8");
    assert.doesNotMatch(page, /lastLoginAt/, file);
    assert.match(page, /relativeAccess\(/, file);
  }
});
