import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { recordAdminAudit, type AuditActor } from "@/lib/admin/audit";
import type { TenantTransaction } from "@/lib/auth/guards";
import { accountManagerAdjustments, accountManagerCommissionPaid, accountManagerPayoutItems, accountManagerPayouts, accountManagers, accounts, clients, loanOperations, sessions, tenants, users } from "@/lib/db/schema";
import { formatMoney, parseMoneyToCents, parseRateToBps, todayIso } from "@/lib/finance/format";
import { closingTotals, type AdjustmentKind } from "./commission";
import { allocatePayout } from "./commission-paid";
import { loadManagerCommissionSummary } from "./queries";

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
// Administração de LOGINS de gerente (criar acesso, nova senha, ativar/desativar, revogar ao excluir) é exclusiva do MASTER (SUPER_ADMIN).
// Quem chama informa se o autor é MASTER, conferido no banco (nunca pela tela); o dono operacional da carteira recebe esta recusa.
export const ACCESS_ADMIN_ONLY = "Somente o MASTER pode administrar os acessos de login dos gerentes (criar, ativar, desativar, redefinir senha ou revogar).";

export async function updateManager(tx: TenantTransaction, tenantId: string, actor: AuditActor, data: FormData, canManageAccess: boolean): Promise<CommandResult> {
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
  // Ativar/desativar o gerente liga/desliga o login dele: com acesso criado, só o MASTER muda a situação.
  if (manager.userId && manager.active !== active && !canManageAccess) return { ok: false, error: ACCESS_ADMIN_ONLY };
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

// Transfere UM contrato para um gerente (vale só para a operação, prevalece sobre o gerente do cliente). Sem managerId, o contrato
// volta a valer o gerente do cliente. Não mexe em pagamentos, capital nem nos termos do contrato.
export async function transferOperation(tx: TenantTransaction, tenantId: string, actor: AuditActor, data: FormData): Promise<CommandResult> {
  const operationId = text(data, "operationId", 80);
  const managerId = text(data, "managerId", 80);
  const [operation] = await tx.select({ id: loanOperations.id, status: loanOperations.status, clientId: loanOperations.clientId, managerId: loanOperations.accountManagerId, bps: loanOperations.accountManagerBps }).from(loanOperations)
    .where(and(eq(loanOperations.id, operationId), eq(loanOperations.tenantId, tenantId))).for("update");
  if (!operation) return { ok: false, error: "Operação não encontrada nesta carteira." };
  if (operation.status === "CANCELED" || operation.status === "RENEGOTIATED") return { ok: false, error: "Contrato cancelado ou renegociado não pode ser transferido." };
  const [client] = await tx.select({ name: clients.name }).from(clients).where(and(eq(clients.id, operation.clientId), eq(clients.tenantId, tenantId)));
  if (!managerId) {
    if (!operation.managerId) return { ok: false, error: "Este contrato não foi transferido para nenhum gerente." };
    await tx.update(loanOperations).set({ accountManagerId: null, accountManagerBps: null, updatedAt: sql`now()` }).where(and(eq(loanOperations.id, operation.id), eq(loanOperations.tenantId, tenantId)));
    await recordAdminAudit(tx, actor, {
      action: "MANAGER_OPERATION_TRANSFERRED", entity: "account_manager", entityId: operation.managerId, tenantId, tenantName: await tenantName(tx, tenantId),
      description: `Contrato de ${client?.name ?? "cliente"} devolvido ao gerente do cliente.`, before: { operationId: operation.id, managerId: operation.managerId, commissionBps: operation.bps }, after: { operationId: operation.id, managerId: null },
    });
    return { ok: true, message: "Contrato devolvido ao gerente do cliente." };
  }
  const percent = readPercent(text(data, "commission", 10), { required: true });
  if (!percent.ok) return percent;
  const bps = percent.bps as number;
  const manager = await ownManager(tx, tenantId, managerId);
  if (!manager || !manager.active) return { ok: false, error: "Gerente não encontrado ou inativo." };
  await tx.update(loanOperations).set({ accountManagerId: manager.id, accountManagerBps: bps, updatedAt: sql`now()` }).where(and(eq(loanOperations.id, operation.id), eq(loanOperations.tenantId, tenantId)));
  await recordAdminAudit(tx, actor, {
    action: "MANAGER_OPERATION_TRANSFERRED", entity: "account_manager", entityId: manager.id, tenantId, tenantName: await tenantName(tx, tenantId),
    description: `Contrato de ${client?.name ?? "cliente"} transferido para ${manager.name} (comissão ${bpsLabel(bps)}).`,
    before: { operationId: operation.id, managerId: operation.managerId, commissionBps: operation.bps }, after: { operationId: operation.id, managerId: manager.id, commissionBps: bps },
  });
  return { ok: true, message: `Contrato transferido para ${manager.name} com ${bpsLabel(bps)} de comissão.` };
}

const KIND_LABEL: Record<AdjustmentKind, string> = { DEBIT: "débito", CREDIT: "crédito" };
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
type AdjustmentInput = { kind: AdjustmentKind; description: string; amountCents: number };
function readAdjustment(kindRaw: string, descriptionRaw: string, amountRaw: string): { ok: true; value: AdjustmentInput } | { ok: false; error: string } {
  const kind = kindRaw === "DEBIT" || kindRaw === "CREDIT" ? kindRaw : null;
  if (!kind) return { ok: false, error: "Escolha o tipo do lançamento: débito ou crédito." };
  const description = descriptionRaw.trim().slice(0, 200);
  if (!description) return { ok: false, error: "Informe a descrição do lançamento (por exemplo: adiantamento, bônus)." };
  const amountCents = parseMoneyToCents(amountRaw);
  if (amountCents === null || amountCents <= 0 || amountCents > 100_000_000_000) return { ok: false, error: "Informe o valor do lançamento em reais, maior que zero." };
  return { ok: true, value: { kind, description, amountCents } };
}

// Novo lançamento (débito ou crédito) de um gerente: fica PENDENTE e entra sozinho no próximo fechamento de comissão dele.
export async function createAdjustment(tx: TenantTransaction, tenantId: string, actor: AuditActor, data: FormData): Promise<CommandResult> {
  const managerId = text(data, "managerId", 80);
  const read = readAdjustment(text(data, "kind", 10), text(data, "description", 200), text(data, "amount", 20));
  if (!read.ok) return read;
  const entryDate = text(data, "entryDate", 10) || todayIso();
  if (!validDate(entryDate)) return { ok: false, error: "Data do lançamento inválida." };
  const manager = await ownManager(tx, tenantId, managerId);
  if (!manager) return { ok: false, error: "Gerente não encontrado nesta carteira." };
  const adjustmentId = id("mga");
  await tx.insert(accountManagerAdjustments).values({ id: adjustmentId, tenantId, managerId: manager.id, ...read.value, entryDate, createdByUserId: actor.user.id });
  await recordAdminAudit(tx, actor, {
    action: "MANAGER_ADJUSTMENT_CREATED", entity: "account_manager_adjustment", entityId: adjustmentId, tenantId, tenantName: await tenantName(tx, tenantId),
    description: `Lançamento de ${KIND_LABEL[read.value.kind]} de ${formatMoney(read.value.amountCents)} para ${manager.name} (${read.value.description}), pendente para o próximo fechamento.`,
    after: { managerId: manager.id, kind: read.value.kind, amountCents: read.value.amountCents, entryDate },
  });
  return { ok: true, message: `Lançamento de ${KIND_LABEL[read.value.kind]} de ${formatMoney(read.value.amountCents)} registrado. Ele entra no próximo fechamento de ${manager.name}.` };
}

// Exclui um lançamento ainda PENDENTE (o aplicado faz parte de um fechamento e não se apaga; o banco também recusa).
export async function deleteAdjustment(tx: TenantTransaction, tenantId: string, actor: AuditActor, data: FormData): Promise<CommandResult> {
  const adjustmentId = text(data, "adjustmentId", 80);
  const [row] = await tx.select().from(accountManagerAdjustments)
    .where(and(eq(accountManagerAdjustments.id, adjustmentId), eq(accountManagerAdjustments.tenantId, tenantId))).for("update");
  if (!row) return { ok: false, error: "Lançamento não encontrado nesta carteira." };
  if (row.payoutId) return { ok: false, error: "Este lançamento já foi aplicado em um fechamento e não pode ser excluído." };
  await tx.delete(accountManagerAdjustments).where(and(eq(accountManagerAdjustments.id, row.id), eq(accountManagerAdjustments.tenantId, tenantId), isNull(accountManagerAdjustments.payoutId)));
  await recordAdminAudit(tx, actor, {
    action: "MANAGER_ADJUSTMENT_DELETED", entity: "account_manager_adjustment", entityId: row.id, tenantId, tenantName: await tenantName(tx, tenantId),
    description: `Lançamento pendente de ${KIND_LABEL[row.kind as AdjustmentKind] ?? row.kind} de ${formatMoney(row.amountCents)} excluído (${row.description}).`,
    before: { managerId: row.managerId, kind: row.kind, amountCents: row.amountCents, entryDate: row.entryDate },
  });
  return { ok: true, message: "Lançamento pendente excluído." };
}

// Fechamento da comissão do gerente: registra a comissão quitada (reduz o saldo a receber dele) e aplica, na mesma transação, TODOS os
// lançamentos pendentes dele mais os lançamentos digitados só para este fechamento. Valor final pago = comissão − débitos + créditos.
// O formulário manda os pendentes que a pessoa viu (pendingIds): se mudaram nesse meio-tempo, nada é gravado.
export async function registerPayout(tx: TenantTransaction, tenantId: string, actor: AuditActor, data: FormData): Promise<CommandResult> {
  const managerId = text(data, "managerId", 80);
  const cents = parseMoneyToCents(text(data, "amount", 20));
  const paidOn = text(data, "paidOn", 10) || todayIso();
  const notes = text(data, "notes", 300) || null;
  if (cents === null || cents <= 0) return { ok: false, error: "Informe o valor da comissão, maior que zero." };
  if (!validDate(paidOn)) return { ok: false, error: "Data de pagamento inválida." };
  if (paidOn > todayIso()) return { ok: false, error: "A data do pagamento não pode ser futura." };
  // Lançamentos só deste fechamento (linhas em branco são ignoradas).
  const kinds = data.getAll("extraKind").map(String), descriptions = data.getAll("extraDescription").map(String), amounts = data.getAll("extraAmount").map(String);
  const extras: AdjustmentInput[] = [];
  for (let index = 0; index < Math.min(Math.max(kinds.length, descriptions.length, amounts.length), 20); index += 1) {
    if (!(descriptions[index] ?? "").trim() && !(amounts[index] ?? "").trim()) continue;
    const read = readAdjustment(kinds[index] ?? "", descriptions[index] ?? "", amounts[index] ?? "");
    if (!read.ok) return { ok: false, error: `Lançamento ${index + 1} deste fechamento: ${read.error}` };
    extras.push(read.value);
  }
  const manager = await ownManager(tx, tenantId, managerId);
  if (!manager) return { ok: false, error: "Gerente não encontrado nesta carteira." };
  // Trava o gerente até o fim da transação: dois fechamentos ao mesmo tempo não passam pela conferência do saldo nem pegam os mesmos
  // lançamentos pendentes juntos.
  await tx.execute(sql`select 1 from ${accountManagers} where ${accountManagers.id} = ${manager.id} and ${accountManagers.tenantId} = ${tenantId} for update`);
  // Só se paga comissão gerada (contratos com juros recebidos) e ainda não paga: nada de pagamento sem comissão nem em dobro.
  const summary = await loadManagerCommissionSummary(tx, tenantId, manager.id, manager.commissionBps);
  if (summary.earnedCents <= 0) return { ok: false, error: "Nenhum contrato deste gerente tem comissão gerada ainda. Nada a pagar." };
  if (summary.balanceCents <= 0) return { ok: false, error: "Toda a comissão gerada deste gerente já foi paga. Nada a pagar." };
  if (cents > summary.balanceCents) return { ok: false, error: `O valor passa da comissão a pagar (${formatMoney(summary.balanceCents)}). Confira o valor.` };
  const pending = await tx.select().from(accountManagerAdjustments)
    .where(and(eq(accountManagerAdjustments.tenantId, tenantId), eq(accountManagerAdjustments.managerId, manager.id), isNull(accountManagerAdjustments.payoutId)))
    .orderBy(asc(accountManagerAdjustments.entryDate), asc(accountManagerAdjustments.createdAt)).for("update");
  if (data.has("pendingIds")) {
    const seen = new Set(text(data, "pendingIds", 4000).split(",").filter(Boolean));
    if (seen.size !== pending.length || pending.some((row) => !seen.has(row.id))) {
      return { ok: false, error: "Os lançamentos pendentes deste gerente mudaram desde que a tela foi aberta (outro fechamento ou lançamento). Atualize a página e confira de novo." };
    }
  }
  const totals = closingTotals(cents, [...pending, ...extras]);
  if (totals.finalCents < 0) {
    return { ok: false, error: `Os débitos (${formatMoney(totals.debitCents)}) passam da comissão mais os créditos (${formatMoney(cents + totals.creditCents)}). O valor final não pode ficar negativo.` };
  }
  // Composição (controle CPG): os recebimentos de juros pagos neste fechamento, dos contratos marcados na conferência (todos, se a tela
  // não mandar), do mais antigo para o mais recente; valor menor que o pendente = pagamento parcial. Nunca paga de novo o que já foi pago.
  const marked = data.has("includedOperationIds") ? new Set(text(data, "includedOperationIds", 20000).split(",").filter(Boolean))
    : data.has("includedClientIds") ? new Set(summary.receipts.filter((receipt) => text(data, "includedClientIds", 8000).split(",").includes(receipt.clientId)).map((receipt) => receipt.operationId))
    : null;
  if (marked && marked.size === 0) return { ok: false, error: "Marque pelo menos um contrato com comissão pendente." };
  const allocation = allocatePayout(cents, summary.receipts, marked);
  if (!allocation.ok) {
    return { ok: false, error: allocation.availableCents <= 0 ? "Os contratos marcados não têm comissão pendente (já foi paga). Nada a pagar."
      : `O valor passa da comissão pendente dos contratos marcados (${formatMoney(allocation.availableCents)}). Confira o valor ou marque outros contratos.` };
  }
  const payoutId = id("mgp");
  await tx.insert(accountManagerPayouts).values({ id: payoutId, tenantId, managerId: manager.id, amountCents: cents, paidOn, notes, createdByUserId: actor.user.id, debitCents: totals.debitCents, creditCents: totals.creditCents });
  await tx.insert(accountManagerCommissionPaid).values(allocation.lines.map((line) => ({
    id: id("cpg"), tenantId, managerId: manager.id, payoutId, kind: "PAID", reversesId: null, operationId: line.operationId, paymentId: line.paymentId,
    clientId: line.clientId, clientName: line.clientName.trim() || "Cliente", operationCode: line.operationCode, loanDate: line.loanDate, principalCents: line.principalCents,
    interestRateBps: line.interestRateBps, commissionBps: line.commissionBps, receiptPaidOn: line.paidOn, interestCents: line.interestCents,
    commissionDueCents: line.commissionDueCents, commissionCents: line.payCents, source: "CLOSING", reason: null, createdByUserId: actor.user.id,
  })));
  // Detalhamento por contrato (o mesmo do CPG, somado por contrato), como nas versões anteriores do relatório.
  const byOperation = new Map<string, (typeof allocation.lines)[number] & { interestSum: number; paySum: number }>();
  for (const line of allocation.lines) {
    const current = byOperation.get(line.operationId);
    byOperation.set(line.operationId, current ? { ...current, interestSum: current.interestSum + line.interestCents, paySum: current.paySum + line.payCents } : { ...line, interestSum: line.interestCents, paySum: line.payCents });
  }
  await tx.insert(accountManagerPayoutItems).values([...byOperation.values()].map((line) => ({
    id: id("mgi"), tenantId, managerId: manager.id, payoutId, operationId: line.operationId, clientId: line.clientId, clientName: line.clientName.trim() || "Cliente",
    operationCode: line.operationCode, loanDate: line.loanDate, principalCents: line.principalCents, interestRateBps: line.interestRateBps, commissionBps: line.commissionBps,
    interestReceivedCents: line.interestSum, commissionCents: line.paySum,
  })));
  if (pending.length > 0) {
    // Só os que ainda estão pendentes (payout_id nulo): um lançamento nunca é aplicado duas vezes.
    const applied = await tx.update(accountManagerAdjustments).set({ payoutId, appliedAt: sql`now()` })
      .where(and(eq(accountManagerAdjustments.tenantId, tenantId), eq(accountManagerAdjustments.managerId, manager.id), isNull(accountManagerAdjustments.payoutId), inArray(accountManagerAdjustments.id, pending.map((row) => row.id))))
      .returning({ id: accountManagerAdjustments.id });
    if (applied.length !== pending.length) throw new Error("Lançamentos pendentes mudaram durante o fechamento.");
  }
  if (extras.length > 0) {
    await tx.insert(accountManagerAdjustments).values(extras.map((extra) => ({ id: id("mga"), tenantId, managerId: manager.id, ...extra, entryDate: paidOn, payoutId, appliedAt: sql`now()`, createdByUserId: actor.user.id })));
  }
  const applied = pending.length + extras.length;
  await recordAdminAudit(tx, actor, {
    action: "MANAGER_COMMISSION_PAID", entity: "account_manager_payout", entityId: payoutId, tenantId, tenantName: await tenantName(tx, tenantId),
    description: applied === 0 ? `Comissão de ${formatMoney(cents)} paga a ${manager.name} em ${paidOn}.`
      : `Fechamento de ${manager.name} em ${paidOn}: comissão ${formatMoney(cents)} − débitos ${formatMoney(totals.debitCents)} + créditos ${formatMoney(totals.creditCents)} = ${formatMoney(totals.finalCents)} pago (${applied} lançamento(s) aplicado(s)).`,
    after: { managerId: manager.id, amountCents: cents, paidOn, debitCents: totals.debitCents, creditCents: totals.creditCents, finalCents: totals.finalCents, adjustmentsApplied: applied, contractsInReport: byOperation.size,
      composition: allocation.lines.map((line) => ({ operationCode: line.operationCode, clientName: line.clientName, paymentId: line.paymentId, receiptPaidOn: line.paidOn, interestCents: line.interestCents, commissionBps: line.commissionBps, commissionCents: line.payCents, partial: line.payCents < line.pendingCents })) },
  });
  return { ok: true, message: applied === 0 ? `Pagamento de ${formatMoney(cents)} registrado para ${manager.name}.`
    : `Fechamento registrado para ${manager.name}: comissão ${formatMoney(cents)}, ${applied} lançamento(s) aplicado(s), valor final ${formatMoney(totals.finalCents)}.` };
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
export async function deleteManager(tx: TenantTransaction, tenantId: string, actor: AuditActor, data: FormData, canManageAccess: boolean): Promise<CommandResult> {
  const managerId = text(data, "managerId", 80);
  const manager = await ownManager(tx, tenantId, managerId);
  if (!manager) return { ok: false, error: "Gerente não encontrado nesta carteira." };
  // Excluir apaga o login de leitura (revoga o acesso): com acesso criado, só o MASTER.
  if (manager.userId && !canManageAccess) return { ok: false, error: ACCESS_ADMIN_ONLY };
  const [paid] = await tx.select({ id: accountManagerPayouts.id }).from(accountManagerPayouts)
    .where(and(eq(accountManagerPayouts.tenantId, tenantId), eq(accountManagerPayouts.managerId, manager.id))).limit(1);
  if (paid) return { ok: false, error: `${manager.name} já recebeu comissão registrada e não pode ser excluído (o histórico financeiro fica). Desative o gerente.` };
  // Lançamentos ainda pendentes (sem fechamento) saem junto com o gerente.
  await tx.delete(accountManagerAdjustments).where(and(eq(accountManagerAdjustments.tenantId, tenantId), eq(accountManagerAdjustments.managerId, manager.id), isNull(accountManagerAdjustments.payoutId)));
  // Contratos transferidos para ele voltam a valer o gerente do cliente (a comissão já paga continua no histórico).
  const returned = await tx.update(loanOperations).set({ accountManagerId: null, accountManagerBps: null, updatedAt: sql`now()` })
    .where(and(eq(loanOperations.tenantId, tenantId), eq(loanOperations.accountManagerId, manager.id))).returning({ id: loanOperations.id });
  const unlinked = await tx.update(clients).set({ accountManagerId: null, accountManagerBps: null, updatedAt: sql`now()` })
    .where(and(eq(clients.tenantId, tenantId), eq(clients.accountManagerId, manager.id))).returning({ id: clients.id });
  await tx.delete(accountManagers).where(and(eq(accountManagers.id, manager.id), eq(accountManagers.tenantId, tenantId)));
  if (manager.userId) await tx.delete(users).where(and(eq(users.id, manager.userId), eq(users.tenantId, tenantId), eq(users.role, "ACCOUNT_MANAGER")));
  await recordAdminAudit(tx, actor, {
    action: "MANAGER_DELETED", entity: "account_manager", entityId: manager.id, tenantId, tenantName: await tenantName(tx, tenantId),
    description: `Gerente ${manager.name} excluído (${unlinked.length} cliente(s) desvinculado(s), ${returned.length} contrato(s) devolvido(s)${manager.userId ? ", acesso de leitura removido" : ""}).`,
    before: { name: manager.name, email: manager.email, commissionBps: manager.commissionBps, hadAccess: Boolean(manager.userId) }, after: { clientsUnlinked: unlinked.length, operationsReturned: returned.length },
  });
  return { ok: true, message: `Gerente ${manager.name} excluído.` };
}

// Estorno de comissão paga (CPG): devolve parte ou tudo do que foi pago de UM recebimento num fechamento (ex.: o gerente devolveu, ou o
// pagamento foi feito por engano). O fechamento original não muda (histórico); a linha de estorno fica ligada a ele e o recebimento volta
// a ficar pendente nesse valor, podendo ser pago de novo num próximo fechamento. Motivo obrigatório; auditado.
export async function reverseCommissionPaid(tx: TenantTransaction, tenantId: string, actor: AuditActor, data: FormData): Promise<CommandResult> {
  const rowId = text(data, "commissionPaidId", 80);
  const reason = text(data, "reason", 300);
  const typed = text(data, "amount", 20);
  if (!reason) return { ok: false, error: "Informe o motivo do estorno." };
  const [row] = await tx.select().from(accountManagerCommissionPaid).where(and(eq(accountManagerCommissionPaid.id, rowId), eq(accountManagerCommissionPaid.tenantId, tenantId)));
  if (!row || row.kind !== "PAID") return { ok: false, error: "Comissão paga não encontrada nesta carteira." };
  const manager = await ownManager(tx, tenantId, row.managerId);
  if (!manager) return { ok: false, error: "Gerente não encontrado nesta carteira." };
  await tx.execute(sql`select 1 from ${accountManagers} where ${accountManagers.id} = ${manager.id} and ${accountManagers.tenantId} = ${tenantId} for update`);
  const [reversed] = await tx.select({ total: sql<string>`coalesce(sum(${accountManagerCommissionPaid.commissionCents}), 0)` }).from(accountManagerCommissionPaid)
    .where(and(eq(accountManagerCommissionPaid.tenantId, tenantId), eq(accountManagerCommissionPaid.reversesId, row.id), eq(accountManagerCommissionPaid.kind, "REVERSAL")));
  const leftCents = row.commissionCents - Number(reversed?.total ?? 0);
  if (leftCents <= 0) return { ok: false, error: "Esta comissão já foi totalmente estornada." };
  const cents = typed ? parseMoneyToCents(typed) : leftCents;
  if (cents === null || cents <= 0) return { ok: false, error: "Informe o valor do estorno, maior que zero." };
  if (cents > leftCents) return { ok: false, error: `O estorno passa do que resta desta comissão paga (${formatMoney(leftCents)}).` };
  const reversalId = id("cpg");
  await tx.insert(accountManagerCommissionPaid).values({
    id: reversalId, tenantId, managerId: row.managerId, payoutId: row.payoutId, kind: "REVERSAL", reversesId: row.id, operationId: row.operationId, paymentId: row.paymentId,
    clientId: row.clientId, clientName: row.clientName, operationCode: row.operationCode, loanDate: row.loanDate, principalCents: row.principalCents, interestRateBps: row.interestRateBps,
    commissionBps: row.commissionBps, receiptPaidOn: row.receiptPaidOn, interestCents: row.interestCents, commissionDueCents: row.commissionDueCents, commissionCents: cents,
    source: row.source === "HISTORICAL" ? "HISTORICAL" : "CLOSING", reason, createdByUserId: actor.user.id,
  });
  await recordAdminAudit(tx, actor, {
    action: "MANAGER_COMMISSION_REVERSED", entity: "account_manager_payout", entityId: row.payoutId, tenantId, tenantName: await tenantName(tx, tenantId),
    description: `Estorno de ${formatMoney(cents)} da comissão paga a ${manager.name} (#${row.operationCode ?? "?"} · ${row.clientName}, recebimento de ${row.receiptPaidOn}). Motivo: ${reason}`,
    before: { commissionPaidId: row.id, commissionCents: row.commissionCents, alreadyReversedCents: row.commissionCents - leftCents },
    after: { reversalId, managerId: row.managerId, payoutId: row.payoutId, paymentId: row.paymentId, operationId: row.operationId, amountCents: cents, reason },
  });
  return { ok: true, message: `Estorno de ${formatMoney(cents)} registrado. Esse valor volta a ficar pendente para ${manager.name}.` };
}

// Composição histórica de um fechamento ANTIGO (anterior ao controle por contrato, sem composição registrada): a responsável confirma
// quais recebimentos foram pagos nele e quanto de cada um. Só o MASTER registra (ação da administração). O fechamento não muda (valor,
// data, lançamentos); as linhas entram como CPG de origem HISTORICAL, com o motivo, e precisam somar exatamente o valor gravado nele.
// Uma vez só por fechamento (o banco também confere). `entries` = "paymentId:centavos,paymentId:centavos".
export async function recordHistoricalComposition(tx: TenantTransaction, tenantId: string, actor: AuditActor, data: FormData): Promise<CommandResult> {
  const payoutId = text(data, "payoutId", 80);
  const reason = text(data, "reason", 300);
  if (!reason) return { ok: false, error: "Informe o motivo/confirmação da composição histórica." };
  const entries = text(data, "entries", 8000).split(",").map((item) => item.trim()).filter(Boolean).map((item) => {
    const [paymentId, cents] = item.split(":");
    return { paymentId: paymentId ?? "", cents: Number(cents) };
  });
  if (entries.length === 0 || entries.some((entry) => !entry.paymentId || !Number.isInteger(entry.cents) || entry.cents <= 0)) return { ok: false, error: "Informe os recebimentos e valores da composição." };
  if (new Set(entries.map((entry) => entry.paymentId)).size !== entries.length) return { ok: false, error: "Cada recebimento entra uma vez só na composição." };
  const [payout] = await tx.select().from(accountManagerPayouts).where(and(eq(accountManagerPayouts.id, payoutId), eq(accountManagerPayouts.tenantId, tenantId)));
  if (!payout) return { ok: false, error: "Fechamento não encontrado nesta carteira." };
  const manager = await ownManager(tx, tenantId, payout.managerId);
  if (!manager) return { ok: false, error: "Gerente não encontrado nesta carteira." };
  await tx.execute(sql`select 1 from ${accountManagers} where ${accountManagers.id} = ${manager.id} and ${accountManagers.tenantId} = ${tenantId} for update`);
  const [existing] = await tx.select({ total: sql<string>`count(*)` }).from(accountManagerCommissionPaid)
    .where(and(eq(accountManagerCommissionPaid.tenantId, tenantId), eq(accountManagerCommissionPaid.payoutId, payout.id), eq(accountManagerCommissionPaid.kind, "PAID")));
  const [items] = await tx.select({ total: sql<string>`count(*)` }).from(accountManagerPayoutItems).where(and(eq(accountManagerPayoutItems.tenantId, tenantId), eq(accountManagerPayoutItems.payoutId, payout.id)));
  if (Number(existing?.total ?? 0) > 0 || Number(items?.total ?? 0) > 0) return { ok: false, error: "Este fechamento já tem composição registrada." };
  const total = entries.reduce((sum, entry) => sum + entry.cents, 0);
  if (total !== payout.amountCents) return { ok: false, error: `A composição soma ${formatMoney(total)} e o fechamento gravado é de ${formatMoney(payout.amountCents)}.` };
  const summary = await loadManagerCommissionSummary(tx, tenantId, manager.id, manager.commissionBps);
  const lines = [];
  for (const entry of entries) {
    const receipt = summary.receipts.find((item) => item.paymentId === entry.paymentId);
    if (!receipt) return { ok: false, error: `Recebimento ${entry.paymentId} não é de um contrato deste gerente.` };
    if (receipt.paidOn > payout.paidOn) return { ok: false, error: `O recebimento de ${receipt.clientName} é posterior ao fechamento.` };
    if (entry.cents > receipt.pendingCents) return { ok: false, error: `O valor de ${receipt.clientName} passa da comissão pendente desse recebimento (${formatMoney(receipt.pendingCents)}).` };
    lines.push({ receipt, cents: entry.cents });
  }
  await tx.insert(accountManagerCommissionPaid).values(lines.map(({ receipt, cents }) => ({
    id: id("cpg"), tenantId, managerId: manager.id, payoutId: payout.id, kind: "PAID", reversesId: null, operationId: receipt.operationId, paymentId: receipt.paymentId,
    clientId: receipt.clientId, clientName: receipt.clientName.trim() || "Cliente", operationCode: receipt.operationCode, loanDate: receipt.loanDate, principalCents: receipt.principalCents,
    interestRateBps: receipt.interestRateBps, commissionBps: receipt.commissionBps, receiptPaidOn: receipt.paidOn, interestCents: receipt.interestCents,
    commissionDueCents: receipt.commissionDueCents, commissionCents: cents, source: "HISTORICAL", reason, createdByUserId: actor.user.id,
  })));
  await recordAdminAudit(tx, actor, {
    action: "MANAGER_COMMISSION_COMPOSITION_RECORDED", entity: "account_manager_payout", entityId: payout.id, tenantId, tenantName: await tenantName(tx, tenantId),
    description: `Composição histórica do fechamento de ${manager.name} em ${payout.paidOn} (${formatMoney(payout.amountCents)}) registrada: ${lines.map(({ receipt, cents }) => `#${receipt.operationCode} ${receipt.clientName} ${formatMoney(cents)}`).join("; ")}. Motivo: ${reason}`,
    before: { payoutId: payout.id, amountCents: payout.amountCents, composition: null },
    after: { payoutId: payout.id, managerId: manager.id, amountCents: payout.amountCents, reason, composition: lines.map(({ receipt, cents }) => ({ operationId: receipt.operationId, operationCode: receipt.operationCode, clientName: receipt.clientName, paymentId: receipt.paymentId, receiptPaidOn: receipt.paidOn, interestCents: receipt.interestCents, commissionBps: receipt.commissionBps, commissionCents: cents })) },
  });
  return { ok: true, message: `Composição do fechamento de ${payout.paidOn} registrada (${lines.length} recebimento(s), ${formatMoney(total)}).` };
}
