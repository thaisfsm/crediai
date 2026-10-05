"use server";

import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withPlatformContext, type TenantTransaction } from "@/lib/auth/guards";
import { generateTemporaryPassword, hashPassword } from "@/lib/admin/passwords";
import { accounts, plans, sessions, subscriptions, tenants, users, wallets } from "@/lib/db/schema";
import { normalizePhone } from "@/lib/finance/format";

// Todas as ações exigem SUPER_ADMIN na sessão e no banco (withPlatformContext). Nenhum papel vem do navegador:
// toda conta criada aqui é TENANT_USER, e contas SUPER_ADMIN nunca são alteradas por estas ações.

export type AdminActionResult = { ok: true; message: string } | { ok: false; error: string };
export type PasswordActionResult = { ok: true; message: string; email: string; temporaryPassword: string; tenantId: string } | { ok: false; error: string };

const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
const text = (data: FormData, key: string, max: number) => String(data.get(key) ?? "").trim().slice(0, max);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY = 24 * 60 * 60 * 1000;

function readContact(data: FormData): { ok: true; name: string; email: string; phone: string | null; planId: string; tenantName: string } | { ok: false; error: string } {
  const name = text(data, "name", 120);
  const email = text(data, "email", 254).toLowerCase();
  const phone = normalizePhone(text(data, "phone", 30));
  const planId = text(data, "planId", 80);
  const tenantName = text(data, "tenantName", 120);
  if (name.length < 2) return { ok: false, error: "Informe o nome do cliente SaaS." };
  if (!EMAIL.test(email)) return { ok: false, error: "Informe um e-mail válido." };
  if (!phone.ok) return { ok: false, error: phone.error };
  if (!planId) return { ok: false, error: "Escolha o plano." };
  return { ok: true, name, email, phone: phone.value, planId, tenantName: tenantName || `${name} · CrediAI` };
}

async function activePlan(tx: TenantTransaction, planId: string) {
  const [plan] = await tx.select({ id: plans.id }).from(plans).where(and(eq(plans.id, planId), eq(plans.active, true)));
  return plan ?? null;
}

async function emailTaken(tx: TenantTransaction, email: string, exceptUserId?: string) {
  const rows = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`);
  return rows.some((row) => row.id !== exceptUserId);
}

// Conta do cliente SaaS dono do tenant. Recusa o tenant de qualquer SUPER_ADMIN: a conta da administração
// não é suspensa, bloqueada, editada nem tem a senha redefinida por aqui.
async function saasAccount(tx: TenantTransaction, tenantId: string) {
  const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, tenantId)).for("update");
  if (!tenant) return { ok: false as const, error: "Cliente SaaS não encontrado." };
  const tenantUsers = await tx.select({ id: users.id, role: users.role, email: users.email }).from(users).where(eq(users.tenantId, tenantId)).orderBy(users.createdAt);
  if (tenantUsers.some((user) => user.role !== "TENANT_USER")) return { ok: false as const, error: "Este ambiente pertence à administração da plataforma e não pode ser alterado por aqui." };
  const user = tenantUsers[0];
  if (!user) return { ok: false as const, error: "Este cliente SaaS não tem usuário de acesso." };
  return { ok: true as const, tenant, user };
}

const isUniqueViolation = (error: unknown) => typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "23505";

export async function createSaasClientAction(data: FormData): Promise<PasswordActionResult> {
  const contact = readContact(data);
  if (!contact.ok) return contact;
  const status = text(data, "status", 20) === "TRIALING" ? "TRIALING" : "ACTIVE";
  const trialDays = Number(text(data, "trialDays", 3) || "14");
  if (status === "TRIALING" && (!Number.isInteger(trialDays) || trialDays < 1 || trialDays > 90)) return { ok: false, error: "O período de teste deve ter de 1 a 90 dias." };

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  try {
    const result = await withPlatformContext(async (tx) => {
      if (!(await activePlan(tx, contact.planId))) return { ok: false as const, error: "Plano não encontrado ou inativo." };
      if (await emailTaken(tx, contact.email)) return { ok: false as const, error: "Já existe uma conta com este e-mail." };
      const tenantId = id("ten");
      const userId = randomUUID();
      // Tudo na mesma transação: ou nasce o ambiente completo (tenant, assinatura, carteira, usuário e senha), ou nada.
      await tx.insert(tenants).values({ id: tenantId, name: contact.tenantName, slug: `workspace-${randomUUID().replaceAll("-", "")}`, planId: contact.planId, status, contactPhone: contact.phone });
      await tx.insert(subscriptions).values({ id: id("sub"), tenantId, planId: contact.planId, status, expiresAt: status === "TRIALING" ? new Date(Date.now() + trialDays * DAY) : null });
      // Carteira vazia: o próprio cliente informa o capital inicial no primeiro acesso, como já acontece no dashboard.
      await tx.insert(wallets).values({ id: id("wal"), tenantId, initialCapitalCents: 0 });
      await tx.insert(users).values({ id: userId, name: contact.name, email: contact.email, emailVerified: false, role: "TENANT_USER", tenantId, active: true, mustChangePassword: true });
      await tx.insert(accounts).values({ id: randomUUID(), accountId: userId, providerId: "credential", userId, password: passwordHash });
      return { ok: true as const, tenantId };
    });
    if (!result.ok) return result;
    revalidatePath("/admin");
    return { ok: true, message: "Cliente SaaS criado.", email: contact.email, temporaryPassword, tenantId: result.tenantId };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, error: "Já existe uma conta com este e-mail." };
    throw error;
  }
}

export async function updateSaasClientAction(data: FormData): Promise<AdminActionResult> {
  const contact = readContact(data);
  if (!contact.ok) return contact;
  const tenantId = text(data, "tenantId", 80);
  try {
    const result = await withPlatformContext(async (tx) => {
      const target = await saasAccount(tx, tenantId);
      if (!target.ok) return target;
      if (!(await activePlan(tx, contact.planId))) return { ok: false as const, error: "Plano não encontrado ou inativo." };
      if (await emailTaken(tx, contact.email, target.user.id)) return { ok: false as const, error: "Já existe outra conta com este e-mail." };
      await tx.update(tenants).set({ name: contact.tenantName, contactPhone: contact.phone, planId: contact.planId, updatedAt: sql`now()` }).where(eq(tenants.id, tenantId));
      // O plano da assinatura vigente acompanha o plano do tenant.
      const [subscription] = await tx.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.tenantId, tenantId)).orderBy(desc(subscriptions.createdAt)).limit(1);
      if (subscription) await tx.update(subscriptions).set({ planId: contact.planId, updatedAt: sql`now()` }).where(eq(subscriptions.id, subscription.id));
      await tx.update(users).set({ name: contact.name, email: contact.email, updatedAt: sql`now()` }).where(and(eq(users.id, target.user.id), eq(users.role, "TENANT_USER")));
      return { ok: true as const };
    });
    if (!result.ok) return result;
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, error: "Já existe outra conta com este e-mail." };
    throw error;
  }
  revalidatePath("/admin");
  return { ok: true, message: "Dados do cliente SaaS atualizados." };
}

// Ativar: tenant ACTIVE e assinatura vigente ACTIVE sem vencimento. Suspender: tenant SUSPENDED e sessões encerradas.
// Os dados financeiros do tenant não são tocados em nenhum dos dois casos.
export async function setSaasClientStatusAction(data: FormData): Promise<AdminActionResult> {
  const tenantId = text(data, "tenantId", 80);
  const action = text(data, "action", 20);
  if (action !== "activate" && action !== "suspend") return { ok: false, error: "Ação inválida." };
  const result = await withPlatformContext(async (tx) => {
    const target = await saasAccount(tx, tenantId);
    if (!target.ok) return target;
    if (action === "suspend") {
      await tx.update(tenants).set({ status: "SUSPENDED", updatedAt: sql`now()` }).where(eq(tenants.id, tenantId));
      await tx.delete(sessions).where(eq(sessions.userId, target.user.id));
      return { ok: true as const, message: "Cliente SaaS suspenso. O acesso foi encerrado." };
    }
    await tx.update(tenants).set({ status: "ACTIVE", updatedAt: sql`now()` }).where(eq(tenants.id, tenantId));
    const [subscription] = await tx.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.tenantId, tenantId)).orderBy(desc(subscriptions.createdAt)).limit(1);
    if (subscription) await tx.update(subscriptions).set({ status: "ACTIVE", expiresAt: null, planId: target.tenant.planId, updatedAt: sql`now()` }).where(eq(subscriptions.id, subscription.id));
    else await tx.insert(subscriptions).values({ id: id("sub"), tenantId, planId: target.tenant.planId, status: "ACTIVE", expiresAt: null });
    return { ok: true as const, message: "Cliente SaaS ativado." };
  });
  if (!result.ok) return result;
  revalidatePath("/admin");
  return result;
}

// Bloquear ou liberar o login do usuário do cliente SaaS, sem mudar o status do tenant.
export async function setSaasClientAccessAction(data: FormData): Promise<AdminActionResult> {
  const tenantId = text(data, "tenantId", 80);
  const action = text(data, "action", 20);
  if (action !== "block" && action !== "unblock") return { ok: false, error: "Ação inválida." };
  const result = await withPlatformContext(async (tx) => {
    const target = await saasAccount(tx, tenantId);
    if (!target.ok) return target;
    await tx.update(users).set({ active: action === "unblock", updatedAt: sql`now()` }).where(and(eq(users.id, target.user.id), eq(users.role, "TENANT_USER")));
    if (action === "block") await tx.delete(sessions).where(eq(sessions.userId, target.user.id));
    return { ok: true as const, message: action === "block" ? "Acesso bloqueado e sessões encerradas." : "Acesso liberado." };
  });
  if (!result.ok) return result;
  revalidatePath("/admin");
  return result;
}

// Nova senha provisória: substitui o hash (a senha antiga nunca é lida nem mostrada), exige troca no próximo
// acesso e encerra as sessões abertas.
export async function resetSaasClientPasswordAction(data: FormData): Promise<PasswordActionResult> {
  const tenantId = text(data, "tenantId", 80);
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const result = await withPlatformContext(async (tx) => {
    const target = await saasAccount(tx, tenantId);
    if (!target.ok) return target;
    const [credential] = await tx.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.userId, target.user.id), eq(accounts.providerId, "credential")));
    if (credential) await tx.update(accounts).set({ password: passwordHash, updatedAt: sql`now()` }).where(eq(accounts.id, credential.id));
    else await tx.insert(accounts).values({ id: randomUUID(), accountId: target.user.id, providerId: "credential", userId: target.user.id, password: passwordHash });
    await tx.update(users).set({ mustChangePassword: true, updatedAt: sql`now()` }).where(and(eq(users.id, target.user.id), eq(users.role, "TENANT_USER")));
    await tx.delete(sessions).where(eq(sessions.userId, target.user.id));
    return { ok: true as const, email: target.user.email };
  });
  if (!result.ok) return result;
  revalidatePath("/admin");
  return { ok: true, message: "Senha redefinida. O cliente precisa trocá-la no próximo acesso.", email: result.email, temporaryPassword, tenantId };
}
