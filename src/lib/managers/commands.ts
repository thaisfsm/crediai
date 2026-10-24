import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { recordAdminAudit, type AuditActor } from "@/lib/admin/audit";
import type { TenantTransaction } from "@/lib/auth/guards";
import { accountManagerPayouts, accountManagers, accounts, clients, sessions, tenants, users } from "@/lib/db/schema";
import { formatMoney, parseMoneyToCents, parseRateToBps, todayIso } from "@/lib/finance/format";

// Regras de gravação dos gerentes de contas, usadas pelo dono da carteira (/gerentes, withTenantContext) e pelo MASTER
// (/admin/clientes/[id]/gerentes, withPlatformContext). Cada função recebe o tenant EXPLÍCITO e filtra tenant_id em toda consulta;
// quem chama decide de onde vem o tenant (sessão do dono ou tenant escolhido pelo MASTER). Tudo na transação de quem chama.

export type CommandResult = { ok: true; message: string } | { ok: false; error: string };
export type AccessCommandResult = { ok: true; message: string; email: string; temporaryPassword: string } | { ok: false; error: string };

const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
export const text = (data: FormData, key: string, max: number) => String(data.get(key) ?? "").trim().slice(0, max);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const bpsLabel = (bps: number) => `${(bps / 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;

// Comissão em porcentagem (0% a 100%). Vazia só vale onde o campo é opcional.
export function readPercent(raw: string, { required }: { required: boolean }): { ok: true; bps: number | null } | { ok: false; error: string } {
  if (!raw.trim()) return required ? { ok: false, error: "Informe a comissão deste cliente em porcentagem (por exemplo 10 ou 7,5)." } : { ok: true, bps: null };
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

// A comissão padrão é opcional (o percentual é definido por cliente, na hora de vincular); em branco fica 0%.
// Caixa disponibilizado à gerente (R$): em branco vale 0 (ela só envia pedidos depois que o dono definir).
function readCash(raw: string): { ok: true; cents: number } | { ok: false; error: string } {
  if (!raw.trim()) return { ok: true, cents: 0 };
  const cents = parseMoneyToCents(raw);
  if (cents === null || cents < 0 || cents > 100_000_000_000) return { ok: false, error: "Informe o caixa em reais, por exemplo 20.000,00." };
  return { ok: true, cents };
}

export async function createManager(tx: TenantTransaction, tenantId: string, actor: AuditActor, data: FormData): Promise<CommandResult> {
  const name = text(data, "name", 120);
  const email = text(data, "email", 160).toLowerCase();
  const percent = readPercent(text(data, "commission", 10), { required: false });
  const cash = readCash(text(data, "cashLimit", 20));
  if (name.length < 2) return { ok: false, error: "Informe o nome do gerente." };
  if (email && !EMAIL.test(email)) return { ok: false, error: "E-mail inválido." };
  if (!percent.ok) return percent;
  if (!cash.ok) return cash;
  const bps = percent.bps ?? 0;
  const managerId = id("mgr");
  await tx.insert(accountManagers).values({ id: managerId, tenantId, name, email: email || null, commissionBps: bps, cashLimitCents: cash.cents });
  await recordAdminAudit(tx, actor, {
    action: "MANAGER_CREATED", entity: "account_manager", entityId: managerId, tenantId, tenantName: await tenantName(tx, tenantId),
    description: `Gerente de contas ${name} cadastrado${bps ? ` (comissão padrão ${bpsLabel(bps)})` : " (comissão definida por cliente)"}.`, after: { name, email: email || null, commissionBps: bps, cashLimitCents: cash.cents },
  });
  return { ok: true, message: `Gerente ${name} cadastrado.` };
}

// Nome, comissão padrão (só vale para clientes sem percentual próprio) e ativo/inativo. Desativar também bloqueia o acesso.
export async function updateManager(tx: TenantTransaction, tenantId: string, actor: AuditActor, data: FormData): Promise<CommandResult> {
  const managerId = text(data, "managerId", 80);
  const name = text(data, "name", 120);
  const percent = readPercent(text(data, "commission", 10), { required: false });
  const active = text(data, "active", 1) !== "0";
  const cash = readCash(text(data, "cashLimit", 20));
  if (name.length < 2) return { ok: false, error: "Informe o nome do gerente." };
  if (!percent.ok) return percent;
  if (!cash.ok) return cash;
  const bps = percent.bps ?? 0;
  const manager = await ownManager(tx, tenantId, managerId);
  if (!manager) return { ok: false, error: "Gerente não encontrado nesta carteira." };
  await tx.update(accountManagers).set({ name, commissionBps: bps, cashLimitCents: cash.cents, active, updatedAt: sql`now()` }).where(and(eq(accountManagers.id, manager.id), eq(accountManagers.tenantId, tenantId)));
  if (manager.userId && manager.active !== active) {
    await tx.update(users).set({ active, updatedAt: sql`now()` }).where(and(eq(users.id, manager.userId), eq(users.tenantId, tenantId), eq(users.role, "ACCOUNT_MANAGER")));
    if (!active) await tx.delete(sessions).where(eq(sessions.userId, manager.userId));
  }
  await recordAdminAudit(tx, actor, {
    action: "MANAGER_UPDATED", entity: "account_manager", entityId: manager.id, tenantId, tenantName: await tenantName(tx, tenantId),
    description: `Gerente ${name} alterado (${bps ? `comissão padrão ${bpsLabel(bps)}, ` : ""}caixa ${formatMoney(cash.cents)}, ${active ? "ativo" : "inativo"}).`,
    before: { name: manager.name, commissionBps: manager.commissionBps, cashLimitCents: manager.cashLimitCents, active: manager.active }, after: { name, commissionBps: bps, cashLimitCents: cash.cents, active },
  });
  return { ok: true, message: "Gerente atualizado." };
}

// Vincula (ou muda o percentual de) um cliente do tenant a um gerente ativo. O percentual do cliente é obrigatório: é o dono quem define na hora.
export async function linkClient(tx: TenantTransaction, tenantId: string, actor: AuditActor, data: FormData): Promise<CommandResult> {
  const managerId = text(data, "managerId", 80);
  const clientId = text(data, "clientId", 80);
  const percent = readPercent(text(data, "commission", 10), { required: true });
  if (!percent.ok) return percent;
  const bps = percent.bps as number;
  const manager = await ownManager(tx, tenantId, managerId);
  if (!manager || !manager.active) return { ok: false, error: "Gerente não encontrado ou inativo." };
  const [client] = await tx.select({ id: clients.id, name: clients.name, managerId: clients.accountManagerId, bps: clients.accountManagerBps }).from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.tenantId, tenantId), isNull(clients.archivedAt))).for("update");
  if (!client) return { ok: false, error: "Cliente não encontrado nesta carteira." };
  if (client.managerId && client.managerId !== manager.id) return { ok: false, error: `${client.name} já está ligado a outro gerente. Desvincule antes.` };
  await tx.update(clients).set({ accountManagerId: manager.id, accountManagerBps: bps, updatedAt: sql`now()` }).where(and(eq(clients.id, client.id), eq(clients.tenantId, tenantId)));
  await recordAdminAudit(tx, actor, {
    action: "MANAGER_CLIENT_LINKED", entity: "account_manager", entityId: manager.id, tenantId, tenantName: await tenantName(tx, tenantId),
    description: `Cliente ${client.name} indicado por ${manager.name} (comissão ${bpsLabel(bps)}).`,
    before: { clientId: client.id, commissionBps: client.bps }, after: { clientId: client.id, commissionBps: bps },
  });
  return { ok: true, message: `${client.name} ligado a ${manager.name} com ${bpsLabel(bps)} de comissão.` };
}

export async function unlinkClient(tx: TenantTransaction, tenantId: string, actor: AuditActor, data: FormData): Promise<CommandResult> {
  const clientId = text(data, "clientId", 80);
  const [client] = await tx.select({ id: clients.id, name: clients.name, managerId: clients.accountManagerId, bps: clients.accountManagerBps }).from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.tenantId, tenantId))).for("update");
  if (!client || !client.managerId) return { ok: false, error: "Este cliente não está ligado a nenhum gerente." };
  await tx.update(clients).set({ accountManagerId: null, accountManagerBps: null, updatedAt: sql`now()` }).where(and(eq(clients.id, client.id), eq(clients.tenantId, tenantId)));
  await recordAdminAudit(tx, actor, {
    action: "MANAGER_CLIENT_UNLINKED", entity: "account_manager", entityId: client.managerId, tenantId, tenantName: await tenantName(tx, tenantId),
    description: `Cliente ${client.name} desvinculado do gerente (a comissão já paga fica no histórico, não some).`, before: { clientId: client.id, commissionBps: client.bps },
  });
  return { ok: true, message: `${client.name} desvinculado.` };
}

// Comissão efetivamente paga ao gerente (só registra; reduz o saldo a receber dele).
export async function registerPayout(tx: TenantTransaction, tenantId: string, actor: AuditActor, data: FormData): Promise<CommandResult> {
  const managerId = text(data, "managerId", 80);
  const cents = parseMoneyToCents(text(data, "amount", 20));
  const paidOn = text(data, "paidOn", 10) || todayIso();
  const notes = text(data, "notes", 300) || null;
  if (cents === null || cents <= 0) return { ok: false, error: "Informe o valor pago, maior que zero." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn) || new Date(`${paidOn}T00:00:00Z`).toISOString().slice(0, 10) !== paidOn) return { ok: false, error: "Data de pagamento inválida." };
  if (paidOn > todayIso()) return { ok: false, error: "A data do pagamento não pode ser futura." };
  const manager = await ownManager(tx, tenantId, managerId);
  if (!manager) return { ok: false, error: "Gerente não encontrado nesta carteira." };
  const payoutId = id("mgp");
  await tx.insert(accountManagerPayouts).values({ id: payoutId, tenantId, managerId: manager.id, amountCents: cents, paidOn, notes, createdByUserId: actor.user.id });
  await recordAdminAudit(tx, actor, {
    action: "MANAGER_COMMISSION_PAID", entity: "account_manager_payout", entityId: payoutId, tenantId, tenantName: await tenantName(tx, tenantId),
    description: `Comissão de ${formatMoney(cents)} paga a ${manager.name} em ${paidOn}.`, after: { managerId: manager.id, amountCents: cents, paidOn },
  });
  return { ok: true, message: `Pagamento de ${formatMoney(cents)} registrado para ${manager.name}.` };
}

// Login de leitura do gerente (papel ACCOUNT_MANAGER, no tenant), com senha provisória (o hash vem pronto de quem chama).
export async function createManagerAccess(tx: TenantTransaction, tenantId: string, actor: AuditActor, data: FormData, passwordHash: string, temporaryPassword: string): Promise<AccessCommandResult> {
  const managerId = text(data, "managerId", 80);
  const email = text(data, "email", 160).toLowerCase();
  if (!EMAIL.test(email)) return { ok: false, error: "Informe o e-mail de acesso do gerente." };
  const manager = await ownManager(tx, tenantId, managerId);
  if (!manager || !manager.active) return { ok: false, error: "Gerente não encontrado ou inativo." };
  if (manager.userId) return { ok: false, error: "Este gerente já tem acesso. Use “Nova senha”." };
  const [taken] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (taken) return { ok: false, error: "Já existe uma conta com este e-mail." };
  const userId = randomUUID();
  await tx.insert(users).values({ id: userId, name: manager.name, email, emailVerified: false, role: "ACCOUNT_MANAGER", tenantId, active: true, mustChangePassword: true });
  await tx.insert(accounts).values({ id: randomUUID(), accountId: userId, providerId: "credential", userId, password: passwordHash });
  await tx.update(accountManagers).set({ userId, email, updatedAt: sql`now()` }).where(and(eq(accountManagers.id, manager.id), eq(accountManagers.tenantId, tenantId)));
  await recordAdminAudit(tx, actor, {
    action: "MANAGER_ACCESS_CREATED", entity: "account_manager", entityId: manager.id, tenantId, tenantName: await tenantName(tx, tenantId),
    description: `Acesso de leitura criado para ${manager.name} (${email}); senha provisória, troca obrigatória no primeiro acesso.`, after: { userId, email, role: "ACCOUNT_MANAGER" },
  });
  return { ok: true, message: "Acesso criado.", email, temporaryPassword };
}

export async function resetManagerPassword(tx: TenantTransaction, tenantId: string, actor: AuditActor, data: FormData, passwordHash: string, temporaryPassword: string): Promise<AccessCommandResult> {
  const managerId = text(data, "managerId", 80);
  const manager = await ownManager(tx, tenantId, managerId);
  if (!manager?.userId) return { ok: false, error: "Este gerente ainda não tem acesso." };
  const [user] = await tx.select({ id: users.id, email: users.email }).from(users).where(and(eq(users.id, manager.userId), eq(users.tenantId, tenantId), eq(users.role, "ACCOUNT_MANAGER")));
  if (!user) return { ok: false, error: "Acesso do gerente não encontrado." };
  const [credential] = await tx.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.userId, user.id), eq(accounts.providerId, "credential")));
  if (credential) await tx.update(accounts).set({ password: passwordHash, updatedAt: sql`now()` }).where(eq(accounts.id, credential.id));
  else await tx.insert(accounts).values({ id: randomUUID(), accountId: user.id, providerId: "credential", userId: user.id, password: passwordHash });
  await tx.update(users).set({ mustChangePassword: true, updatedAt: sql`now()` }).where(eq(users.id, user.id));
  const closed = await tx.delete(sessions).where(eq(sessions.userId, user.id)).returning({ id: sessions.id });
  await recordAdminAudit(tx, actor, {
    action: "MANAGER_PASSWORD_RESET", entity: "account_manager", entityId: manager.id, tenantId, tenantName: await tenantName(tx, tenantId),
    description: `Senha provisória gerada para ${user.email}; troca obrigatória no próximo acesso.`, after: { mustChangePassword: true, sessionsClosed: closed.length },
  });
  return { ok: true, message: "Nova senha provisória gerada.", email: user.email, temporaryPassword };
}

// Exclusão definitiva: só de gerente sem comissão paga (o histórico de pagamentos não se apaga). Desvincula os clientes (os clientes
// em si não mudam) e apaga o login de leitura, se houver. Com pagamentos registrados, o gerente só pode ser desativado.
export async function deleteManager(tx: TenantTransaction, tenantId: string, actor: AuditActor, data: FormData): Promise<CommandResult> {
  const managerId = text(data, "managerId", 80);
  const manager = await ownManager(tx, tenantId, managerId);
  if (!manager) return { ok: false, error: "Gerente não encontrado nesta carteira." };
  const [paid] = await tx.select({ id: accountManagerPayouts.id }).from(accountManagerPayouts)
    .where(and(eq(accountManagerPayouts.tenantId, tenantId), eq(accountManagerPayouts.managerId, manager.id))).limit(1);
  if (paid) return { ok: false, error: `${manager.name} já recebeu comissão registrada e não pode ser excluído (o histórico financeiro fica). Desative o gerente.` };
  const unlinked = await tx.update(clients).set({ accountManagerId: null, accountManagerBps: null, updatedAt: sql`now()` })
    .where(and(eq(clients.tenantId, tenantId), eq(clients.accountManagerId, manager.id))).returning({ id: clients.id });
  await tx.delete(accountManagers).where(and(eq(accountManagers.id, manager.id), eq(accountManagers.tenantId, tenantId)));
  if (manager.userId) await tx.delete(users).where(and(eq(users.id, manager.userId), eq(users.tenantId, tenantId), eq(users.role, "ACCOUNT_MANAGER")));
  await recordAdminAudit(tx, actor, {
    action: "MANAGER_DELETED", entity: "account_manager", entityId: manager.id, tenantId, tenantName: await tenantName(tx, tenantId),
    description: `Gerente ${manager.name} excluído (${unlinked.length} cliente(s) desvinculado(s)${manager.userId ? ", acesso de leitura removido" : ""}).`,
    before: { name: manager.name, email: manager.email, commissionBps: manager.commissionBps, hadAccess: Boolean(manager.userId) }, after: { clientsUnlinked: unlinked.length },
  });
  return { ok: true, message: `Gerente ${manager.name} excluído.` };
}
