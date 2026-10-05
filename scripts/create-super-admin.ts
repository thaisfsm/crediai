import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
}
const [{ auth }, { db }, { accounts, users }, { sql }, { randomUUID }] = await Promise.all([
  import("../src/lib/auth"), import("../src/lib/db"), import("../src/lib/db/schema"), import("drizzle-orm"), import("node:crypto"),
]);

const name = process.env.ADMIN_NAME?.trim();
const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD;
if (!name || !email || !password || password.length < 12) {
  throw new Error("Defina ADMIN_NAME, ADMIN_EMAIL e ADMIN_PASSWORD (mínimo 12 caracteres) em .env.local.");
}

const existing = await db.query.users.findFirst({ where: (table, operators) => operators.eq(table.email, email) });
if (existing) throw new Error("Já existe uma conta com este e-mail; o bootstrap não altera usuários existentes.");

// O cadastro público está desativado; a conta é criada direto no banco, com o mesmo hash de senha do Better Auth.
const passwordHash = await (await auth.$context).password.hash(password);
const userId = randomUUID();
await db.transaction(async (tx) => {
  // Declara o procedimento administrativo exigido pelo gatilho user_role_guard (migração 0009).
  await tx.execute(sql`select set_config('app.crediai_role_grant', 'promote', true)`);
  await tx.insert(users).values({ id: userId, name, email, emailVerified: false, role: "SUPER_ADMIN", tenantId: null, active: true });
  await tx.insert(accounts).values({ id: randomUUID(), accountId: userId, providerId: "credential", userId, password: passwordHash });
});
console.info(`SUPER_ADMIN criado para ${email}. A senha não foi exibida.`);
