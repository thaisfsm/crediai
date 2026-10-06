"use server";

import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withPlatformContext, type TenantTransaction } from "@/lib/auth/guards";
import { recordAdminAudit } from "@/lib/admin/audit";
import { generateTemporaryPassword, hashPassword } from "@/lib/admin/passwords";
import { accounts, plans, sessions, subscriptionCharges, subscriptions, tenants, users, wallets } from "@/lib/db/schema";
import { normalizePhone, parseMoneyToCents, todayIso } from "@/lib/finance/format";
import { planPriceLabel } from "@/lib/admin/plan-price";
import { CONDITION_LABEL, DEFAULT_GRACE_DAYS, nextDueAfterPayment, validateTerms, type CommercialCondition, type CommercialTerms } from "@/lib/billing/rules";

// Todas as ações exigem SUPER_ADMIN na sessão e no banco (withPlatformContext). Nenhum papel vem do navegador:
// toda conta criada aqui é TENANT_USER, e contas SUPER_ADMIN nunca são alteradas por estas ações.
// Toda alteração grava um evento de auditoria (recordAdminAudit) na mesma transação: sem registro, nada muda.

export type AdminActionResult = { ok: true; message: string } | { ok: false; error: string };
export type PasswordActionResult = { ok: true; message: string; email: string; temporaryPassword: string; tenantId: string } | { ok: false; error: string };

const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
const text = (data: FormData, key: string, max: number) => String(data.get(key) ?? "").trim().slice(0, max);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY = 24 * 60 * 60 * 1000;

function readContact(data: FormData, needsPlan = true): { ok: true; name: string; email: string; phone: string | null; planId: string; tenantName: string } | { ok: false; error: string } {
  const name = text(data, "name", 120);
  const email = text(data, "email", 254).toLowerCase();
  const phone = normalizePhone(text(data, "phone", 30));
  const planId = text(data, "planId", 80);
  const tenantName = text(data, "tenantName", 120);
  if (name.length < 2) return { ok: false, error: "Informe o nome do cliente SaaS." };
  if (!EMAIL.test(email)) return { ok: false, error: "Informe um e-mail válido." };
  if (!phone.ok) return { ok: false, error: phone.error };
  if (needsPlan && !planId) return { ok: false, error: "Escolha o plano." };
  return { ok: true, name, email, phone: phone.value, planId, tenantName: tenantName || `${name} · CrediAI` };
}

async function activePlan(tx: TenantTransaction, planId: string) {
  const [plan] = await tx.select({ id: plans.id, name: plans.name, priceInCents: plans.priceInCents }).from(plans).where(and(eq(plans.id, planId), eq(plans.active, true)));
  return plan ?? null;
}

// Condição comercial digitada pelo SUPER_ADMIN (ativação ou alteração). O valor contratado é guardado na assinatura
// e não acompanha mudanças futuras no preço padrão do plano.
function readTerms(data: FormData, standardCents: number, fixed?: { activatedAt: string }): { ok: true; terms: CommercialTerms } | { ok: false; error: string } {
  const condition = text(data, "condition", 20) as CommercialCondition;
  if (!(condition in CONDITION_LABEL)) return { ok: false, error: "Escolha a condição comercial." };
  const contractedCents = condition === "COURTESY" ? 0 : parseMoneyToCents(text(data, "contractedPrice", 20));
  if (contractedCents === null) return { ok: false, error: "Informe o valor contratado." };
  const graceDays = Number(text(data, "graceDays", 3) || String(DEFAULT_GRACE_DAYS));
  const terms: CommercialTerms = {
    condition, contractedCents, standardCents, graceDays,
    activatedAt: fixed?.activatedAt ?? text(data, "activatedAt", 10),
    firstDueDate: condition === "COURTESY" ? null : text(data, "dueDate", 10) || null,
  };
  const error = validateTerms(terms);
  return error ? { ok: false, error } : { ok: true, terms };
}

function subscriptionTermsValues(terms: CommercialTerms) {
  return {
    contractedPriceCents: terms.contractedCents, commercialCondition: terms.condition, activatedAt: terms.activatedAt,
    firstDueDate: terms.firstDueDate, nextDueDate: terms.firstDueDate, billingCycle: "MONTHLY" as const, graceDays: terms.graceDays,
  };
}

const termsSummary = (planName: string, terms: CommercialTerms) =>
  `${planName} · ${terms.condition === "COURTESY" ? "Cortesia (R$ 0,00/mês)" : planPriceLabel(terms.contractedCents)}`;

async function emailTaken(tx: TenantTransaction, email: string, exceptUserId?: string) {
  const rows = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`);
  return rows.some((row) => row.id !== exceptUserId);
}

// Conta do cliente SaaS dono do tenant. Recusa o tenant de qualquer SUPER_ADMIN: a conta da administração
// não é suspensa, bloqueada, editada nem tem a senha redefinida por aqui.
async function saasAccount(tx: TenantTransaction, tenantId: string) {
  const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, tenantId)).for("update");
  if (!tenant) return { ok: false as const, error: "Cliente SaaS não encontrado." };
  const tenantUsers = await tx.select({ id: users.id, role: users.role, email: users.email, name: users.name, active: users.active, mustChangePassword: users.mustChangePassword }).from(users).where(eq(users.tenantId, tenantId)).orderBy(users.createdAt);
  if (tenantUsers.some((user) => user.role !== "TENANT_USER")) return { ok: false as const, error: "Este ambiente pertence à administração da plataforma e não pode ser alterado por aqui." };
  const user = tenantUsers[0];
  if (!user) return { ok: false as const, error: "Este cliente SaaS não tem usuário de acesso." };
  return { ok: true as const, tenant, user };
}

const TENANT_STATUS_LABEL: Record<string, string> = { TRIALING: "em teste", ACTIVE: "ativo", SUSPENDED: "suspenso", CLOSED: "encerrado" };
type TenantRow = typeof tenants.$inferSelect;
type SubscriptionRow = typeof subscriptions.$inferSelect;
const tenantSnapshot = (tenant: Pick<TenantRow, "name" | "status" | "planId" | "contactPhone">) => ({ tenantName: tenant.name, status: tenant.status, planId: tenant.planId, contactPhone: tenant.contactPhone });
const subscriptionSnapshot = (subscription: SubscriptionRow | null) => subscription && {
  status: subscription.status, planId: subscription.planId, expiresAt: subscription.expiresAt, contractedPriceCents: subscription.contractedPriceCents,
  commercialCondition: subscription.commercialCondition, activatedAt: subscription.activatedAt, firstDueDate: subscription.firstDueDate,
  nextDueDate: subscription.nextDueDate, graceDays: subscription.graceDays,
};
const userSnapshot = (user: { name: string; email: string; active: boolean; mustChangePassword: boolean }) => ({ name: user.name, email: user.email, active: user.active, mustChangePassword: user.mustChangePassword });

const isUniqueViolation = (error: unknown) => typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "23505";

export async function createSaasClientAction(data: FormData): Promise<PasswordActionResult> {
  const contact = readContact(data);
  if (!contact.ok) return contact;
  const status = text(data, "status", 20) === "ACTIVE" ? "ACTIVE" : "TRIALING";
  const trialDays = Number(text(data, "trialDays", 3) || "14");
  if (status === "TRIALING" && (!Number.isInteger(trialDays) || trialDays < 1 || trialDays > 90)) return { ok: false, error: "O período de teste deve ter de 1 a 90 dias." };

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  try {
    const result = await withPlatformContext(async (tx, { session }) => {
      const plan = await activePlan(tx, contact.planId);
      if (!plan) return { ok: false as const, error: "Plano não encontrado ou inativo." };
      // Cliente criado já como Ativo precisa da condição comercial completa, como na ativação.
      const read = status === "ACTIVE" ? readTerms(data, plan.priceInCents) : null;
      if (read && !read.ok) return read;
      if (await emailTaken(tx, contact.email)) return { ok: false as const, error: "Já existe uma conta com este e-mail." };
      const tenantId = id("ten");
      const userId = randomUUID();
      // Tudo na mesma transação: ou nasce o ambiente completo (tenant, assinatura, carteira, usuário e senha), ou nada.
      await tx.insert(tenants).values({ id: tenantId, name: contact.tenantName, slug: `workspace-${randomUUID().replaceAll("-", "")}`, planId: contact.planId, status, contactPhone: contact.phone });
      await tx.insert(subscriptions).values({ id: id("sub"), tenantId, planId: contact.planId, status, expiresAt: status === "TRIALING" ? new Date(Date.now() + trialDays * DAY) : null, ...(read?.ok ? subscriptionTermsValues(read.terms) : {}) });
      // Carteira vazia: o próprio cliente informa o capital inicial no primeiro acesso, como já acontece no dashboard.
      await tx.insert(wallets).values({ id: id("wal"), tenantId, initialCapitalCents: 0 });
      await tx.insert(users).values({ id: userId, name: contact.name, email: contact.email, emailVerified: false, role: "TENANT_USER", tenantId, active: true, mustChangePassword: true });
      await tx.insert(accounts).values({ id: randomUUID(), accountId: userId, providerId: "credential", userId, password: passwordHash });
      const [subscription] = await tx.select().from(subscriptions).where(eq(subscriptions.tenantId, tenantId));
      await recordAdminAudit(tx, session, {
        action: "SAAS_CLIENT_CREATED", entity: "tenant", entityId: tenantId, tenantId, tenantName: contact.tenantName,
        description: `Cliente SaaS ${contact.tenantName} criado ${read?.ok ? `já ativo (${termsSummary(plan.name, read.terms)})` : `em teste por ${trialDays} dias no plano ${plan.name}`}.`,
        after: { ...tenantSnapshot({ name: contact.tenantName, status, planId: plan.id, contactPhone: contact.phone }), ...subscriptionSnapshot(subscription ?? null), planName: plan.name },
      });
      await recordAdminAudit(tx, session, {
        action: "USER_CREATED", entity: "user", entityId: userId, tenantId, tenantName: contact.tenantName,
        description: `Usuário ${contact.email} criado (TENANT_USER, senha provisória, troca obrigatória no primeiro acesso).`,
        after: { ...userSnapshot({ name: contact.name, email: contact.email, active: true, mustChangePassword: true }), role: "TENANT_USER" },
      });
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
  const contact = readContact(data, false);
  if (!contact.ok) return contact;
  const tenantId = text(data, "tenantId", 80);
  try {
    const result = await withPlatformContext(async (tx, { session }) => {
      const target = await saasAccount(tx, tenantId);
      if (!target.ok) return target;
      if (await emailTaken(tx, contact.email, target.user.id)) return { ok: false as const, error: "Já existe outra conta com este e-mail." };
      // Plano e valor não mudam por aqui: são a condição comercial, alterada só em "Ativar assinatura" ou
      // "Alterar condição comercial".
      await tx.update(tenants).set({ name: contact.tenantName, contactPhone: contact.phone, updatedAt: sql`now()` }).where(eq(tenants.id, tenantId));
      await tx.update(users).set({ name: contact.name, email: contact.email, updatedAt: sql`now()` }).where(and(eq(users.id, target.user.id), eq(users.role, "TENANT_USER")));
      const before = { tenantName: target.tenant.name, contactPhone: target.tenant.contactPhone, name: target.user.name, email: target.user.email };
      const after = { tenantName: contact.tenantName, contactPhone: contact.phone, name: contact.name, email: contact.email };
      await recordAdminAudit(tx, session, { action: "SAAS_CLIENT_UPDATED", entity: "tenant", entityId: tenantId, tenantId, tenantName: contact.tenantName, before, after });
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

async function currentSubscription(tx: TenantTransaction, tenantId: string) {
  const [subscription] = await tx.select().from(subscriptions).where(eq(subscriptions.tenantId, tenantId)).orderBy(desc(subscriptions.createdAt)).limit(1).for("update");
  return subscription ?? null;
}

// Ativar assinatura: o SUPER_ADMIN escolhe plano, valor contratado, condição, data de ativação, primeiro vencimento
// e tolerância. Tenant e assinatura vigente passam a ACTIVE (sem fim de teste); a assinatura guarda o valor contratado.
// Carteira, clientes finais, operações e pagamentos do tenant não são tocados.
export async function activateSubscriptionAction(data: FormData): Promise<AdminActionResult> {
  const tenantId = text(data, "tenantId", 80);
  const result = await withPlatformContext(async (tx, { session }) => {
    const target = await saasAccount(tx, tenantId);
    if (!target.ok) return target;
    if (target.tenant.status === "ACTIVE") return { ok: false as const, error: "Este cliente SaaS já está ativo. Use Alterar condição comercial." };
    const plan = await activePlan(tx, text(data, "planId", 80));
    if (!plan) return { ok: false as const, error: "Plano não encontrado ou inativo." };
    const read = readTerms(data, plan.priceInCents);
    if (!read.ok) return read;
    const values = { status: "ACTIVE" as const, expiresAt: null, planId: plan.id, ...subscriptionTermsValues(read.terms), updatedAt: sql`now()` };
    await tx.update(tenants).set({ status: "ACTIVE", planId: plan.id, updatedAt: sql`now()` }).where(eq(tenants.id, tenantId));
    const subscription = await currentSubscription(tx, tenantId);
    const subscriptionId = subscription?.id ?? id("sub");
    if (subscription) await tx.update(subscriptions).set(values).where(eq(subscriptions.id, subscription.id));
    else await tx.insert(subscriptions).values({ id: subscriptionId, tenantId, ...values });
    const [updated] = await tx.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId));
    await recordAdminAudit(tx, session, {
      action: "SUBSCRIPTION_ACTIVATED", entity: "subscription", entityId: subscriptionId, tenantId, tenantName: target.tenant.name,
      description: `Assinatura ativada: ${termsSummary(plan.name, read.terms)} (antes: ${TENANT_STATUS_LABEL[target.tenant.status] ?? target.tenant.status}).`,
      before: { tenantStatus: target.tenant.status, ...subscriptionSnapshot(subscription) }, after: { tenantStatus: "ACTIVE", ...subscriptionSnapshot(updated ?? null) },
    });
    return { ok: true as const, message: `Assinatura ativada: ${termsSummary(plan.name, read.terms)}.` };
  });
  if (!result.ok) return result;
  revalidatePath("/admin");
  return result;
}

// Alterar condição comercial de uma assinatura já ativada: plano, valor contratado, condição, próximo vencimento e
// tolerância. Não muda o status, a data de ativação nem o preço padrão do plano, e não afeta nenhum outro cliente.
export async function updateCommercialTermsAction(data: FormData): Promise<AdminActionResult> {
  const tenantId = text(data, "tenantId", 80);
  const result = await withPlatformContext(async (tx, { session }) => {
    const target = await saasAccount(tx, tenantId);
    if (!target.ok) return target;
    const subscription = await currentSubscription(tx, tenantId);
    if (!subscription?.activatedAt) return { ok: false as const, error: "Este cliente SaaS ainda não tem assinatura ativada. Use Ativar assinatura." };
    const plan = await activePlan(tx, text(data, "planId", 80));
    // Um plano desativado continua valendo para quem já o tem; só não pode ser escolhido de novo.
    const chosen = plan ?? (text(data, "planId", 80) === subscription.planId
      ? (await tx.select({ id: plans.id, name: plans.name, priceInCents: plans.priceInCents }).from(plans).where(eq(plans.id, subscription.planId)))[0] ?? null
      : null);
    if (!chosen) return { ok: false as const, error: "Plano não encontrado ou inativo." };
    const read = readTerms(data, chosen.priceInCents, { activatedAt: subscription.activatedAt });
    if (!read.ok) return read;
    const { terms } = read;
    await tx.update(subscriptions).set({
      planId: chosen.id, contractedPriceCents: terms.contractedCents, commercialCondition: terms.condition, graceDays: terms.graceDays,
      nextDueDate: terms.firstDueDate, firstDueDate: subscription.firstDueDate ?? terms.firstDueDate, updatedAt: sql`now()`,
    }).where(eq(subscriptions.id, subscription.id));
    await tx.update(tenants).set({ planId: chosen.id, updatedAt: sql`now()` }).where(eq(tenants.id, tenantId));
    const [updated] = await tx.select().from(subscriptions).where(eq(subscriptions.id, subscription.id));
    const before = subscriptionSnapshot(subscription), after = subscriptionSnapshot(updated ?? null);
    // Um evento por tipo de mudança, para que a busca por "plano alterado" ou "valor contratado alterado" encontre cada uma.
    const event = { entity: "subscription", entityId: subscription.id, tenantId, tenantName: target.tenant.name, before, after };
    const summary = termsSummary(chosen.name, terms);
    if (subscription.planId !== chosen.id) await recordAdminAudit(tx, session, { ...event, action: "PLAN_CHANGED", description: `Plano alterado para ${chosen.name}. ${summary}.` });
    if (subscription.contractedPriceCents !== terms.contractedCents) await recordAdminAudit(tx, session, { ...event, action: "CONTRACTED_PRICE_CHANGED", description: `Valor contratado alterado de ${planPriceLabel(subscription.contractedPriceCents ?? 0)} para ${planPriceLabel(terms.contractedCents)}.` });
    await recordAdminAudit(tx, session, { ...event, action: "COMMERCIAL_TERMS_CHANGED", description: `Condição comercial: ${summary}.` });
    return { ok: true as const, message: `Condição comercial atualizada: ${summary}.` };
  });
  if (!result.ok) return result;
  revalidatePath("/admin");
  return result;
}

// Registrar mensalidade paga (manual, até existir um provedor de cobrança): grava a mensalidade do vencimento atual
// como paga, pelo valor contratado, e avança o próximo vencimento em um mês, no dia do primeiro vencimento.
export async function registerSubscriptionPaymentAction(data: FormData): Promise<AdminActionResult> {
  const tenantId = text(data, "tenantId", 80);
  const paidAt = text(data, "paidAt", 10);
  const today = todayIso();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidAt) || paidAt > today) return { ok: false, error: "Informe a data do pagamento (até hoje)." };
  const result = await withPlatformContext(async (tx, { session }) => {
    const target = await saasAccount(tx, tenantId);
    if (!target.ok) return target;
    const subscription = await currentSubscription(tx, tenantId);
    if (!subscription?.activatedAt || subscription.status !== "ACTIVE") return { ok: false as const, error: "Este cliente SaaS não tem assinatura ativa." };
    if (subscription.commercialCondition === "COURTESY" || !subscription.nextDueDate || !subscription.firstDueDate) return { ok: false as const, error: "Esta assinatura não tem cobrança (cortesia)." };
    const dueDate = subscription.nextDueDate;
    if (text(data, "dueDate", 10) !== dueDate) return { ok: false as const, error: "O vencimento mudou desde que a tela foi aberta. Recarregue a página." };
    const nextDueDate = nextDueAfterPayment(dueDate, subscription.firstDueDate);
    const chargeId = id("chg");
    await tx.insert(subscriptionCharges).values({ id: chargeId, tenantId, subscriptionId: subscription.id, dueDate, amountCents: subscription.contractedPriceCents ?? 0, status: "PAID", paidAt, provider: "MANUAL" });
    await tx.update(subscriptions).set({ nextDueDate, updatedAt: sql`now()` }).where(eq(subscriptions.id, subscription.id));
    await recordAdminAudit(tx, session, {
      action: "SUBSCRIPTION_PAYMENT_REGISTERED", entity: "subscription_charge", entityId: chargeId, tenantId, tenantName: target.tenant.name,
      description: `Mensalidade de ${dueDate.split("-").reverse().join("/")} registrada como paga em ${paidAt.split("-").reverse().join("/")} (${planPriceLabel(subscription.contractedPriceCents ?? 0)}).`,
      before: { nextDueDate: dueDate }, after: { dueDate, paidAt, amountCents: subscription.contractedPriceCents ?? 0, nextDueDate },
    });
    return { ok: true as const, message: `Mensalidade de ${dueDate.split("-").reverse().join("/")} registrada. Próximo vencimento: ${nextDueDate.split("-").reverse().join("/")}.` };
  });
  if (!result.ok) return result;
  revalidatePath("/admin");
  return result;
}

// Suspender: tenant SUSPENDED e sessões encerradas. Reativar: volta a ACTIVE mantendo a condição comercial já definida
// (quem nunca foi ativado passa por Ativar assinatura). Os dados financeiros do tenant não são tocados.
export async function setSaasClientStatusAction(data: FormData): Promise<AdminActionResult> {
  const tenantId = text(data, "tenantId", 80);
  const action = text(data, "action", 20);
  if (action !== "reactivate" && action !== "suspend") return { ok: false, error: "Ação inválida." };
  const result = await withPlatformContext(async (tx, { session }) => {
    const target = await saasAccount(tx, tenantId);
    if (!target.ok) return target;
    const event = { entity: "tenant", entityId: tenantId, tenantId, tenantName: target.tenant.name };
    if (action === "suspend") {
      await tx.update(tenants).set({ status: "SUSPENDED", updatedAt: sql`now()` }).where(eq(tenants.id, tenantId));
      const closed = await tx.delete(sessions).where(eq(sessions.userId, target.user.id)).returning({ id: sessions.id });
      await recordAdminAudit(tx, session, { ...event, action: "SAAS_CLIENT_SUSPENDED", before: { status: target.tenant.status }, after: { status: "SUSPENDED", sessionsClosed: closed.length } });
      return { ok: true as const, message: "Cliente SaaS suspenso. O acesso foi encerrado." };
    }
    const subscription = await currentSubscription(tx, tenantId);
    if (!subscription?.activatedAt) return { ok: false as const, error: "Este cliente SaaS nunca foi ativado. Use Ativar assinatura." };
    await tx.update(tenants).set({ status: "ACTIVE", updatedAt: sql`now()` }).where(eq(tenants.id, tenantId));
    if (subscription.status !== "ACTIVE" || subscription.expiresAt) await tx.update(subscriptions).set({ status: "ACTIVE", expiresAt: null, updatedAt: sql`now()` }).where(eq(subscriptions.id, subscription.id));
    await recordAdminAudit(tx, session, {
      ...event, action: "SAAS_CLIENT_REACTIVATED",
      before: { status: target.tenant.status, subscriptionStatus: subscription.status, expiresAt: subscription.expiresAt }, after: { status: "ACTIVE", subscriptionStatus: "ACTIVE", expiresAt: null },
    });
    return { ok: true as const, message: "Cliente SaaS reativado com a condição comercial que já tinha." };
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
  const result = await withPlatformContext(async (tx, { session }) => {
    const target = await saasAccount(tx, tenantId);
    if (!target.ok) return target;
    await tx.update(users).set({ active: action === "unblock", updatedAt: sql`now()` }).where(and(eq(users.id, target.user.id), eq(users.role, "TENANT_USER")));
    const closed = action === "block" ? await tx.delete(sessions).where(eq(sessions.userId, target.user.id)).returning({ id: sessions.id }) : [];
    await recordAdminAudit(tx, session, {
      action: action === "block" ? "USER_BLOCKED" : "USER_UNBLOCKED", entity: "user", entityId: target.user.id, tenantId, tenantName: target.tenant.name,
      description: `${action === "block" ? "Acesso bloqueado" : "Acesso liberado"} para ${target.user.email}.`,
      before: { active: target.user.active }, after: { active: action === "unblock", ...(action === "block" ? { sessionsClosed: closed.length } : {}) },
    });
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
  const result = await withPlatformContext(async (tx, { session }) => {
    const target = await saasAccount(tx, tenantId);
    if (!target.ok) return target;
    const [credential] = await tx.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.userId, target.user.id), eq(accounts.providerId, "credential")));
    if (credential) await tx.update(accounts).set({ password: passwordHash, updatedAt: sql`now()` }).where(eq(accounts.id, credential.id));
    else await tx.insert(accounts).values({ id: randomUUID(), accountId: target.user.id, providerId: "credential", userId: target.user.id, password: passwordHash });
    await tx.update(users).set({ mustChangePassword: true, updatedAt: sql`now()` }).where(and(eq(users.id, target.user.id), eq(users.role, "TENANT_USER")));
    const closed = await tx.delete(sessions).where(eq(sessions.userId, target.user.id)).returning({ id: sessions.id });
    // A senha provisória e o hash nunca entram na auditoria.
    await recordAdminAudit(tx, session, {
      action: "PASSWORD_RESET", entity: "user", entityId: target.user.id, tenantId, tenantName: target.tenant.name,
      description: `Senha provisória gerada para ${target.user.email}; troca obrigatória no próximo acesso.`,
      before: { mustChangePassword: target.user.mustChangePassword }, after: { mustChangePassword: true, sessionsClosed: closed.length },
    });
    return { ok: true as const, email: target.user.email };
  });
  if (!result.ok) return result;
  revalidatePath("/admin");
  return { ok: true, message: "Senha redefinida. O cliente precisa trocá-la no próximo acesso.", email: result.email, temporaryPassword, tenantId };
}
