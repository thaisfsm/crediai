"use server";

import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { recordAdminAudit } from "@/lib/admin/audit";
import { generateTemporaryPassword, hashPassword } from "@/lib/admin/passwords";
import { withTenantContext, type TenantTransaction } from "@/lib/auth/guards";
import { accountManagerPayouts, accountManagers, accounts, clients, sessions, tenants, users } from "@/lib/db/schema";
import { formatMoney, parseMoneyToCents, parseRateToBps, todayIso } from "@/lib/finance/format";
import type { ActionResult } from "../actions";

// Gerentes de contas: só o dono da carteira (TENANT_USER) cadastra, vincula clientes, define a comissão (livre por cliente), paga e cria o
// acesso de leitura. Tudo em withTenantContext: o tenant vem da sessão e cada consulta filtra tenant_id. O gerente (ACCOUNT_MANAGER) nunca
// chega aqui: requireTenantUser o manda para /gerente.

const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
const text = (data: FormData, key: string, max: number) => String(data.get(key) ?? "").trim().slice(0, max);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const bpsLabel = (bps: number) => `${(bps / 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;

export type AccessResult = { ok: true; message: string; email: string; temporaryPassword: string } | { ok: false; error: string };

function readPercent(raw: string): { ok: true; bps: number } | { ok: false; error: string } {
  const bps = parseRateToBps(raw);
  if (bps === null || !Number.isInteger(bps) || bps < 0 || bps > 10000) return { ok: false, error: "Informe a comissão em porcentagem, de 0% a 100% (por exemplo 10 ou 7,5)." };
  return { ok: true, bps };
}

async function tenantName(tx: TenantTransaction, tenantId: string) {
  const [row] = await tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId));
  return row?.name ?? null;
}
async function ownManager(tx: TenantTransaction, tenantId: string, managerId: string) {
  const [manager] = await tx.select().from(accountManagers).where(and(eq(accountManagers.id, managerId), eq(accountManagers.tenantId, tenantId)));
  return manager ?? null;
}
const refresh = () => revalidatePath("/gerentes");

export async function createManagerAction(data: FormData): Promise<ActionResult> {
  const name = text(data, "name", 120);
  const email = text(data, "email", 160).toLowerCase();
  const percent = readPercent(text(data, "commission", 10));
  if (name.length < 2) return { ok: false, error: "Informe o nome do gerente." };
  if (email && !EMAIL.test(email)) return { ok: false, error: "E-mail inválido." };
  if (!percent.ok) return percent;
  const result = await withTenantContext(async (tx, { tenantId, session }): Promise<ActionResult> => {
    const managerId = id("mgr");
    await tx.insert(accountManagers).values({ id: managerId, tenantId, name, email: email || null, commissionBps: percent.bps });
    await recordAdminAudit(tx, session, {
      action: "MANAGER_CREATED", entity: "account_manager", entityId: managerId, tenantId, tenantName: await tenantName(tx, tenantId),
      description: `Gerente de contas ${name} cadastrado (comissão padrão ${bpsLabel(percent.bps)}).`, after: { name, email: email || null, commissionBps: percent.bps },
    });
    return { ok: true, message: `Gerente ${name} cadastrado.` };
  });
  if (result.ok) refresh();
  return result;
}

// Nome, e-mail, comissão padrão (só vale para clientes sem percentual próprio) e ativo/inativo. Desativar também bloqueia o acesso.
export async function updateManagerAction(data: FormData): Promise<ActionResult> {
  const managerId = text(data, "managerId", 80);
  const name = text(data, "name", 120);
  const percent = readPercent(text(data, "commission", 10));
  const active = text(data, "active", 1) !== "0";
  if (name.length < 2) return { ok: false, error: "Informe o nome do gerente." };
  if (!percent.ok) return percent;
  const result = await withTenantContext(async (tx, { tenantId, session }): Promise<ActionResult> => {
    const manager = await ownManager(tx, tenantId, managerId);
    if (!manager) return { ok: false, error: "Gerente não encontrado nesta carteira." };
    await tx.update(accountManagers).set({ name, commissionBps: percent.bps, active, updatedAt: sql`now()` }).where(and(eq(accountManagers.id, manager.id), eq(accountManagers.tenantId, tenantId)));
    if (manager.userId && manager.active !== active) {
      await tx.update(users).set({ active, updatedAt: sql`now()` }).where(and(eq(users.id, manager.userId), eq(users.tenantId, tenantId), eq(users.role, "ACCOUNT_MANAGER")));
      if (!active) await tx.delete(sessions).where(eq(sessions.userId, manager.userId));
    }
    await recordAdminAudit(tx, session, {
      action: "MANAGER_UPDATED", entity: "account_manager", entityId: manager.id, tenantId, tenantName: await tenantName(tx, tenantId),
      description: `Gerente ${name} alterado (comissão padrão ${bpsLabel(percent.bps)}, ${active ? "ativo" : "inativo"}).`,
      before: { name: manager.name, commissionBps: manager.commissionBps, active: manager.active }, after: { name, commissionBps: percent.bps, active },
    });
    return { ok: true, message: "Gerente atualizado." };
  });
  if (result.ok) refresh();
  return result;
}

// Vincula (ou muda o percentual de) um cliente do próprio tenant a um gerente ativo. Percentual vazio = padrão do gerente.
export async function linkClientAction(data: FormData): Promise<ActionResult> {
  const managerId = text(data, "managerId", 80);
  const clientId = text(data, "clientId", 80);
  const rawCommission = text(data, "commission", 10);
  const percent = rawCommission ? readPercent(rawCommission) : null;
  if (percent && !percent.ok) return percent;
  const result = await withTenantContext(async (tx, { tenantId, session }): Promise<ActionResult> => {
    const manager = await ownManager(tx, tenantId, managerId);
    if (!manager || !manager.active) return { ok: false, error: "Gerente não encontrado ou inativo." };
    const [client] = await tx.select({ id: clients.id, name: clients.name, managerId: clients.accountManagerId, bps: clients.accountManagerBps }).from(clients)
      .where(and(eq(clients.id, clientId), eq(clients.tenantId, tenantId), isNull(clients.archivedAt))).for("update");
    if (!client) return { ok: false, error: "Cliente não encontrado nesta carteira." };
    if (client.managerId && client.managerId !== manager.id) return { ok: false, error: `${client.name} já está ligado a outro gerente. Desvincule antes.` };
    const bps = percent && percent.ok ? percent.bps : null;
    await tx.update(clients).set({ accountManagerId: manager.id, accountManagerBps: bps, updatedAt: sql`now()` }).where(and(eq(clients.id, client.id), eq(clients.tenantId, tenantId)));
    await recordAdminAudit(tx, session, {
      action: "MANAGER_CLIENT_LINKED", entity: "account_manager", entityId: manager.id, tenantId, tenantName: await tenantName(tx, tenantId),
      description: `Cliente ${client.name} indicado por ${manager.name} (comissão ${bpsLabel(bps ?? manager.commissionBps)}${bps === null ? ", padrão do gerente" : ""}).`,
      before: { clientId: client.id, commissionBps: client.bps }, after: { clientId: client.id, commissionBps: bps },
    });
    return { ok: true, message: `${client.name} ligado a ${manager.name}.` };
  });
  if (result.ok) refresh();
  return result;
}

export async function unlinkClientAction(data: FormData): Promise<ActionResult> {
  const clientId = text(data, "clientId", 80);
  const result = await withTenantContext(async (tx, { tenantId, session }): Promise<ActionResult> => {
    const [client] = await tx.select({ id: clients.id, name: clients.name, managerId: clients.accountManagerId, bps: clients.accountManagerBps }).from(clients)
      .where(and(eq(clients.id, clientId), eq(clients.tenantId, tenantId))).for("update");
    if (!client || !client.managerId) return { ok: false, error: "Este cliente não está ligado a nenhum gerente." };
    await tx.update(clients).set({ accountManagerId: null, accountManagerBps: null, updatedAt: sql`now()` }).where(and(eq(clients.id, client.id), eq(clients.tenantId, tenantId)));
    await recordAdminAudit(tx, session, {
      action: "MANAGER_CLIENT_UNLINKED", entity: "account_manager", entityId: client.managerId, tenantId, tenantName: await tenantName(tx, tenantId),
      description: `Cliente ${client.name} desvinculado do gerente (a comissão já gerada fica no histórico de pagamentos, não some).`, before: { clientId: client.id, commissionBps: client.bps },
    });
    return { ok: true, message: `${client.name} desvinculado.` };
  });
  if (result.ok) refresh();
  return result;
}

// Comissão efetivamente paga ao gerente (só registra; reduz o saldo a receber dele).
export async function registerManagerPayoutAction(data: FormData): Promise<ActionResult> {
  const managerId = text(data, "managerId", 80);
  const cents = parseMoneyToCents(text(data, "amount", 20));
  const paidOn = text(data, "paidOn", 10) || todayIso();
  const notes = text(data, "notes", 300) || null;
  if (cents === null || cents <= 0) return { ok: false, error: "Informe o valor pago, maior que zero." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn) || new Date(`${paidOn}T00:00:00Z`).toISOString().slice(0, 10) !== paidOn) return { ok: false, error: "Data de pagamento inválida." };
  if (paidOn > todayIso()) return { ok: false, error: "A data do pagamento não pode ser futura." };
  const result = await withTenantContext(async (tx, { tenantId, session }): Promise<ActionResult> => {
    const manager = await ownManager(tx, tenantId, managerId);
    if (!manager) return { ok: false, error: "Gerente não encontrado nesta carteira." };
    const payoutId = id("mgp");
    await tx.insert(accountManagerPayouts).values({ id: payoutId, tenantId, managerId: manager.id, amountCents: cents, paidOn, notes, createdByUserId: session.user.id });
    await recordAdminAudit(tx, session, {
      action: "MANAGER_COMMISSION_PAID", entity: "account_manager_payout", entityId: payoutId, tenantId, tenantName: await tenantName(tx, tenantId),
      description: `Comissão de ${formatMoney(cents)} paga a ${manager.name} em ${paidOn}.`, after: { managerId: manager.id, amountCents: cents, paidOn },
    });
    return { ok: true, message: `Pagamento de ${formatMoney(cents)} registrado para ${manager.name}.` };
  });
  if (result.ok) refresh();
  return result;
}

// Cria o login de leitura do gerente (papel ACCOUNT_MANAGER, no tenant do dono) com senha provisória mostrada uma única vez.
export async function createManagerAccessAction(data: FormData): Promise<AccessResult> {
  const managerId = text(data, "managerId", 80);
  const email = text(data, "email", 160).toLowerCase();
  if (!EMAIL.test(email)) return { ok: false, error: "Informe o e-mail de acesso do gerente." };
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  try {
    const result = await withTenantContext(async (tx, { tenantId, session }) => {
      const manager = await ownManager(tx, tenantId, managerId);
      if (!manager || !manager.active) return { ok: false as const, error: "Gerente não encontrado ou inativo." };
      if (manager.userId) return { ok: false as const, error: "Este gerente já tem acesso. Use “Nova senha”." };
      const [taken] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
      if (taken) return { ok: false as const, error: "Já existe uma conta com este e-mail." };
      const userId = randomUUID();
      await tx.insert(users).values({ id: userId, name: manager.name, email, emailVerified: false, role: "ACCOUNT_MANAGER", tenantId, active: true, mustChangePassword: true });
      await tx.insert(accounts).values({ id: randomUUID(), accountId: userId, providerId: "credential", userId, password: passwordHash });
      await tx.update(accountManagers).set({ userId, email, updatedAt: sql`now()` }).where(and(eq(accountManagers.id, manager.id), eq(accountManagers.tenantId, tenantId)));
      await recordAdminAudit(tx, session, {
        action: "MANAGER_ACCESS_CREATED", entity: "account_manager", entityId: manager.id, tenantId, tenantName: await tenantName(tx, tenantId),
        description: `Acesso de leitura criado para ${manager.name} (${email}); senha provisória, troca obrigatória no primeiro acesso.`, after: { userId, email, role: "ACCOUNT_MANAGER" },
      });
      return { ok: true as const };
    });
    if (!result.ok) return result;
    refresh();
    return { ok: true, message: "Acesso criado.", email, temporaryPassword };
  } catch (error) {
    const cause = (error as { cause?: { code?: string } })?.cause ?? (error as { code?: string });
    if (cause?.code === "23505") return { ok: false, error: "Já existe uma conta com este e-mail." };
    throw error;
  }
}

export async function resetManagerPasswordAction(data: FormData): Promise<AccessResult> {
  const managerId = text(data, "managerId", 80);
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const result = await withTenantContext(async (tx, { tenantId, session }) => {
    const manager = await ownManager(tx, tenantId, managerId);
    if (!manager?.userId) return { ok: false as const, error: "Este gerente ainda não tem acesso." };
    const [user] = await tx.select({ id: users.id, email: users.email }).from(users).where(and(eq(users.id, manager.userId), eq(users.tenantId, tenantId), eq(users.role, "ACCOUNT_MANAGER")));
    if (!user) return { ok: false as const, error: "Acesso do gerente não encontrado." };
    const [credential] = await tx.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.userId, user.id), eq(accounts.providerId, "credential")));
    if (credential) await tx.update(accounts).set({ password: passwordHash, updatedAt: sql`now()` }).where(eq(accounts.id, credential.id));
    else await tx.insert(accounts).values({ id: randomUUID(), accountId: user.id, providerId: "credential", userId: user.id, password: passwordHash });
    await tx.update(users).set({ mustChangePassword: true, updatedAt: sql`now()` }).where(eq(users.id, user.id));
    const closed = await tx.delete(sessions).where(eq(sessions.userId, user.id)).returning({ id: sessions.id });
    await recordAdminAudit(tx, session, {
      action: "MANAGER_PASSWORD_RESET", entity: "account_manager", entityId: manager.id, tenantId, tenantName: await tenantName(tx, tenantId),
      description: `Senha provisória gerada para ${user.email}; troca obrigatória no próximo acesso.`, after: { mustChangePassword: true, sessionsClosed: closed.length },
    });
    return { ok: true as const, email: user.email };
  });
  if (!result.ok) return result;
  refresh();
  return { ok: true, message: "Nova senha provisória gerada.", email: result.email, temporaryPassword };
}
