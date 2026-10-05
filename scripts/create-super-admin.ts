import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
}
const [{ auth }, { db }, { subscriptions, tenants, users }, { eq, sql }] = await Promise.all([
  import("../src/lib/auth"), import("../src/lib/db"), import("../src/lib/db/schema"), import("drizzle-orm"),
]);

const name = process.env.ADMIN_NAME?.trim();
const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD;
if (!name || !email || !password || password.length < 12) {
  throw new Error("Defina ADMIN_NAME, ADMIN_EMAIL e ADMIN_PASSWORD (mínimo 12 caracteres) em .env.local.");
}

const existing = await db.query.users.findFirst({ where: (table, operators) => operators.eq(table.email, email) });
if (existing) throw new Error("Já existe uma conta com este e-mail; o bootstrap não altera usuários existentes.");

const created = await auth.api.signUpEmail({ body: { name, email, password } });
if (!created.user) throw new Error("O provedor de autenticação não retornou o usuário criado.");

const tenantId = created.user.tenantId;
await db.transaction(async (tx) => {
  // Declara o procedimento administrativo exigido pelo gatilho user_role_guard (migração 0009).
  await tx.execute(sql`select set_config('app.crediai_role_grant', 'promote', true)`);
  await tx.update(users).set({ role: "SUPER_ADMIN", tenantId: null, active: true }).where(eq(users.id, created.user.id));
  if (tenantId) {
    await tx.execute(sql`select set_config('app.tenant_id', '', true), set_config('app.crediai_role', 'SUPER_ADMIN', true)`);
    await tx.delete(subscriptions).where(eq(subscriptions.tenantId, tenantId));
    await tx.delete(tenants).where(eq(tenants.id, tenantId));
  }
});
console.info(`SUPER_ADMIN criado para ${email}. A senha não foi exibida.`);
