import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, inArray, isNull, or, sql, gt } from "drizzle-orm";
import { db } from "@/lib/db";
import { accountManagers, subscriptions, tenants, users } from "@/lib/db/schema";

// Papéis conhecidos. A fonte da verdade é sempre a coluna user.role (nunca o e-mail).
// SUPER_ADMIN (MASTER) acessa a administração global e, se tiver tenant próprio, também usa a própria carteira.
// ACCOUNT_MANAGER (gerente de contas) só abre o painel de leitura /gerente: nunca entra em withTenantContext nem em ação de gravação.
export const ROLES = ["TENANT_USER", "SUPER_ADMIN", "ACCOUNT_MANAGER"] as const;
export type Role = (typeof ROLES)[number];

export async function getSession() {
  const { auth } = await import("@/lib/auth");
  return auth.api.getSession({ headers: await headers() });
}

// Confere no banco o estado atual da conta (papel, ativa, senha provisória), para que promoção, bloqueio ou
// redefinição de senha valham já na próxima requisição, sem depender do que a sessão guardou.
export async function accountState(userId: string) {
  const [row] = await db.select({ role: users.role, active: users.active, mustChangePassword: users.mustChangePassword })
    .from(users).where(eq(users.id, userId)).limit(1);
  return row ?? null;
}

async function currentRole(userId: string): Promise<Role | null> {
  const state = await accountState(userId);
  if (!state || !state.active) return null;
  return state.role as Role;
}

// Sessão válida de conta ativa. Com senha provisória, a única tela liberada é a de troca de senha.
export async function requireActiveAccount({ allowTemporaryPassword = false } = {}) {
  const session = await getSession();
  if (!session) redirect("/login");
  const state = await accountState(session.user.id);
  if (!state || !state.active || !session.user.active) redirect("/account-disabled");
  if (state.mustChangePassword && !allowTemporaryPassword) redirect("/definir-senha");
  return { session, state };
}

// Tenant ativo (ou em teste) com assinatura válida; a carteira do MASTER não depende de período de teste ou assinatura.
async function tenantIsUsable(tenantId: string, role: Role) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.crediai_role', 'TENANT_USER', true)`);
    const tenant = await tx.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
    if (!tenant) return false;
    if (role === "SUPER_ADMIN") return tenant.status !== "CLOSED";
    if (!["TRIALING", "ACTIVE"].includes(tenant.status)) return false;
    const subscription = await tx.query.subscriptions.findFirst({
      where: and(
        eq(subscriptions.tenantId, tenantId),
        inArray(subscriptions.status, ["TRIALING", "ACTIVE"]),
        or(isNull(subscriptions.expiresAt), gt(subscriptions.expiresAt, new Date())),
      ),
    });
    return Boolean(subscription);
  });
}

// Acesso à carteira do próprio tenant: TENANT_USER e também SUPER_ADMIN que tenha tenant próprio.
// O contexto de banco é sempre o do tenant ('TENANT_USER'), mesmo para o MASTER: no dashboard comum o RLS
// restringe tudo ao próprio tenant; a visão global só existe em withPlatformContext.
export async function requireTenantUser() {
  const { session, state } = await requireActiveAccount();
  // O papel vem do banco: um rebaixamento vale na hora, mesmo com a sessão antiga.
  const role = state.role as Role;
  // Gerente de contas nunca usa a carteira: vai para o painel de leitura, e qualquer ação de gravação dela é recusada aqui.
  if (role === "ACCOUNT_MANAGER") redirect("/gerente");
  if (!ROLES.includes(role)) redirect("/account-disabled");
  if (!session.user.tenantId) redirect(role === "SUPER_ADMIN" ? "/admin" : "/account-disabled");
  const tenantId = session.user.tenantId;
  const tenantAllowed = await tenantIsUsable(tenantId, role);
  if (!tenantAllowed) redirect("/account-disabled");
  return { session, tenantId };
}

export async function requireSuperAdmin() {
  const { session } = await requireActiveAccount();
  if (session.user.role !== "SUPER_ADMIN") redirect("/");
  // Segunda checagem direto no banco: a sessão não basta para liberar a área global.
  if ((await currentRole(session.user.id)) !== "SUPER_ADMIN") redirect("/");
  return session;
}

export type TenantTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function withTenantContext<T>(operation: (tx: TenantTransaction, context: { tenantId: string; session: Awaited<ReturnType<typeof requireTenantUser>>["session"] }) => Promise<T>) {
  const { tenantId, session } = await requireTenantUser();
  return db.transaction(async (tx) => {
    // Sempre 'TENANT_USER' aqui: o papel global do MASTER não vale dentro da carteira de um tenant.
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.crediai_role', 'TENANT_USER', true)`);
    return operation(tx, { tenantId, session });
  });
}

export type PlatformSession = Awaited<ReturnType<typeof requireSuperAdmin>>;

// A sessão do SUPER_ADMIN vai junto para que as ações administrativas registrem quem agiu (auditoria).
export async function withPlatformContext<T>(operation: (tx: TenantTransaction, context: { session: PlatformSession }) => Promise<T>) {
  const session = await requireSuperAdmin();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', '', true), set_config('app.crediai_role', 'SUPER_ADMIN', true)`);
    return operation(tx, { session });
  });
}

// Painel do gerente de contas (/gerente): só conta ativa com papel ACCOUNT_MANAGER, ligada a um cadastro de gerente ativo do
// mesmo tenant. Só leitura: o contexto de banco é o do tenant e cada consulta filtra pelos clientes do gerente.
export async function requireAccountManager() {
  const { session, state } = await requireActiveAccount();
  if (state.role !== "ACCOUNT_MANAGER") redirect("/");
  const tenantId = session.user.tenantId;
  if (!tenantId) redirect("/account-disabled");
  if (!(await tenantIsUsable(tenantId, "ACCOUNT_MANAGER"))) redirect("/account-disabled");
  // A tabela de gerentes tem RLS: a consulta roda com o tenant da sessão.
  const [manager] = await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.crediai_role', 'TENANT_USER', true)`);
    return tx.select({ id: accountManagers.id, name: accountManagers.name, commissionBps: accountManagers.commissionBps })
      .from(accountManagers)
      .where(and(eq(accountManagers.userId, session.user.id), eq(accountManagers.tenantId, tenantId), eq(accountManagers.active, true))).limit(1);
  });
  if (!manager) redirect("/account-disabled");
  return { session, tenantId, manager };
}

export async function withManagerContext<T>(operation: (tx: TenantTransaction, context: { tenantId: string; manager: { id: string; name: string; commissionBps: number }; session: Awaited<ReturnType<typeof requireAccountManager>>["session"] }) => Promise<T>) {
  const { tenantId, manager, session } = await requireAccountManager();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.crediai_role', 'TENANT_USER', true)`);
    return operation(tx, { tenantId, manager, session });
  });
}
