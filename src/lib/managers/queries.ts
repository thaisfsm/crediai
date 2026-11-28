import "server-only";
import { and, asc, desc, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { withManagerContext, withPlatformContext, withTenantContext } from "@/lib/auth/guards";
import { accountManagerAdjustments, accountManagerCommissionPaid, accountManagerPayoutItems, accountManagerPayouts, accountManagers, clients, installmentDeferrals, loanOperations, loanRenewals, operationRequests, payments, tenants, users } from "@/lib/db/schema";
import { todayIso } from "@/lib/finance/format";
import { buildPortfolio, type DeferralRecord, type OperationView, type RenewalRecord } from "@/lib/finance/portfolio";
import { toDeferralRecord, toOperationRecord, toPaymentRecord, toRenewalRecord } from "@/lib/finance/summaries";
import { buildClosingReport, linesFromCommissionPaid, referencePeriod, unregisteredLine, type ClosingLine, type ClosingReversal, type ClosingSource } from "./closing-report";
import { contractReceipts, contractsWithStatus, receiptsWithStatus, reversibleByRow, type CommissionPaidRow, type Receipt } from "./commission-paid";
import { clientSituation, commissionOf, effectiveBps, managerCommission, type ClientSituation } from "./commission";

// Lançamentos (débito/crédito) e fechamentos com o detalhe de cada um: o relatório de comissão mostra comissão, lançamentos e valor final.
type Tx = Parameters<Parameters<typeof withTenantContext>[0]>[0];
export type AdjustmentRow = { id: string; managerId: string; kind: "DEBIT" | "CREDIT"; description: string; amountCents: number; entryDate: string; payoutId: string | null; appliedAt: string | null };
export type PayoutRow = { id: string; managerId: string; amountCents: number; paidOn: string; notes: string | null; debitCents: number; creditCents: number; finalCents: number; adjustments: AdjustmentRow[] };
async function loadPayoutsAndAdjustments(tx: Tx, tenantId: string, managerId?: string) {
  const payoutRows = await tx.select({
    id: accountManagerPayouts.id, managerId: accountManagerPayouts.managerId, amountCents: accountManagerPayouts.amountCents, paidOn: accountManagerPayouts.paidOn, notes: accountManagerPayouts.notes,
    debitCents: accountManagerPayouts.debitCents, creditCents: accountManagerPayouts.creditCents,
  }).from(accountManagerPayouts)
    .where(and(eq(accountManagerPayouts.tenantId, tenantId), managerId ? eq(accountManagerPayouts.managerId, managerId) : undefined))
    .orderBy(desc(accountManagerPayouts.paidOn), desc(accountManagerPayouts.createdAt));
  const adjustmentRows = await tx.select({
    id: accountManagerAdjustments.id, managerId: accountManagerAdjustments.managerId, kind: accountManagerAdjustments.kind, description: accountManagerAdjustments.description,
    amountCents: accountManagerAdjustments.amountCents, entryDate: accountManagerAdjustments.entryDate, payoutId: accountManagerAdjustments.payoutId, appliedAt: accountManagerAdjustments.appliedAt,
  }).from(accountManagerAdjustments)
    .where(and(eq(accountManagerAdjustments.tenantId, tenantId), managerId ? eq(accountManagerAdjustments.managerId, managerId) : undefined))
    .orderBy(desc(accountManagerAdjustments.entryDate), desc(accountManagerAdjustments.createdAt));
  const adjustments: AdjustmentRow[] = adjustmentRows.map((row) => ({ ...row, kind: row.kind === "CREDIT" ? "CREDIT" : "DEBIT", appliedAt: row.appliedAt?.toISOString() ?? null }));
  const payouts: PayoutRow[] = payoutRows.map((row) => ({ ...row, finalCents: row.amountCents - row.debitCents + row.creditCents, adjustments: adjustments.filter((item) => item.payoutId === row.id) }));
  return { payouts, adjustments };
}
const pendingTotals = (adjustments: AdjustmentRow[]) => {
  const pending = adjustments.filter((item) => !item.payoutId);
  const debitCents = pending.filter((item) => item.kind === "DEBIT").reduce((total, item) => total + item.amountCents, 0);
  const creditCents = pending.filter((item) => item.kind === "CREDIT").reduce((total, item) => total + item.amountCents, 0);
  return { count: pending.length, debitCents, creditCents, netCents: creditCents - debitCents };
};

// Todas as operações (todos os ciclos) dos clientes indicados por um gerente, já calculadas como no extrato. Cada consulta filtra
// tenant_id e os clientes do gerente: o isolamento não depende do papel de banco (a produção ignora RLS).
// `asOf` (AAAA-MM-DD): só os recebimentos até essa data (e as renovações ligadas a eles), para reconstituir a comissão de um fechamento antigo.
async function loadManagerOperations(tx: Parameters<Parameters<typeof withTenantContext>[0]>[0], tenantId: string, managerId: string, asOf?: string) {
  // Contratos de um gerente = os dos clientes dele que não foram transferidos + os transferidos para ele (loan_operation.account_manager_id).
  const linkedRows = await tx.select({ id: clients.id, name: clients.name, archivedAt: clients.archivedAt, bps: clients.accountManagerBps }).from(clients)
    .where(and(eq(clients.tenantId, tenantId), eq(clients.accountManagerId, managerId))).orderBy(asc(clients.name));
  const transferredIn = await tx.select({ id: loanOperations.id, clientId: loanOperations.clientId, bps: loanOperations.accountManagerBps }).from(loanOperations)
    .where(and(eq(loanOperations.tenantId, tenantId), eq(loanOperations.accountManagerId, managerId)));
  const overrideBps = new Map(transferredIn.map((row) => [row.id, row.bps ?? 0]));
  const extraIds = [...new Set(transferredIn.map((row) => row.clientId))].filter((clientId) => !linkedRows.some((client) => client.id === clientId));
  const extraRows = extraIds.length === 0 ? [] : await tx.select({ id: clients.id, name: clients.name, archivedAt: clients.archivedAt, bps: sql<number | null>`null` }).from(clients)
    .where(and(eq(clients.tenantId, tenantId), inArray(clients.id, extraIds)));
  const clientRows = [...linkedRows, ...extraRows].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  const clientIds = clientRows.map((client) => client.id);
  if (clientIds.length === 0) return { clientRows, operations: [] as OperationView[], overrideBps };
  const operationRows = await tx.select({ operation: loanOperations, clientName: clients.name }).from(loanOperations)
    .innerJoin(clients, and(eq(clients.id, loanOperations.clientId), eq(clients.tenantId, loanOperations.tenantId)))
    .where(and(eq(loanOperations.tenantId, tenantId), inArray(loanOperations.clientId, clientIds), or(eq(loanOperations.accountManagerId, managerId), and(isNull(loanOperations.accountManagerId), inArray(loanOperations.clientId, linkedRows.length ? linkedRows.map((client) => client.id) : ["-"])))))
    .orderBy(desc(loanOperations.loanDate), desc(loanOperations.createdAt));
  const operationIds = operationRows.map((row) => row.operation.id);
  const paymentRows = operationIds.length === 0 ? [] : await tx.select({ payment: payments, clientName: clients.name }).from(payments)
    .innerJoin(loanOperations, and(eq(loanOperations.id, payments.operationId), eq(loanOperations.tenantId, payments.tenantId)))
    .innerJoin(clients, and(eq(clients.id, loanOperations.clientId), eq(clients.tenantId, loanOperations.tenantId)))
    .where(and(eq(payments.tenantId, tenantId), inArray(payments.operationId, operationIds), asOf ? lte(payments.paidAt, asOf) : undefined)).orderBy(desc(payments.paidAt), desc(payments.createdAt));
  const keptPayments = new Set(paymentRows.map(({ payment }) => payment.id));
  const renewalRows = operationIds.length === 0 ? [] : await tx.select({ renewal: loanRenewals }).from(loanRenewals)
    .where(and(eq(loanRenewals.tenantId, tenantId), inArray(loanRenewals.operationId, operationIds))).orderBy(asc(loanRenewals.periodNumber));
  const deferralRows = operationIds.length === 0 ? [] : await tx.select({ deferral: installmentDeferrals }).from(installmentDeferrals)
    .where(and(eq(installmentDeferrals.tenantId, tenantId), inArray(installmentDeferrals.operationId, operationIds))).orderBy(asc(installmentDeferrals.createdAt));
  const renewalsByOperation = new Map<string, RenewalRecord[]>();
  for (const { renewal } of renewalRows.filter(({ renewal }) => !asOf || keptPayments.has(renewal.paymentId))) renewalsByOperation.set(renewal.operationId, [...(renewalsByOperation.get(renewal.operationId) ?? []), toRenewalRecord(renewal)]);
  const deferralsByOperation = new Map<string, DeferralRecord[]>();
  for (const { deferral } of deferralRows) deferralsByOperation.set(deferral.operationId, [...(deferralsByOperation.get(deferral.operationId) ?? []), toDeferralRecord(deferral)]);
  const { operations } = buildPortfolio({
    hasWallet: true, initialCapitalCents: 0, today: todayIso(),
    operations: operationRows.map(({ operation, clientName }) => ({ ...toOperationRecord(operation, clientName, renewalsByOperation.get(operation.id) ?? [], deferralsByOperation.get(operation.id) ?? []), cycleNumber: operation.cycleNumber })),
    payments: paymentRows.map(({ payment, clientName }) => toPaymentRecord(payment, clientName)),
  });
  return { clientRows, operations, overrideBps };
}

// Caixa da gerente: limite combinado com o dono, menos o principal que ainda não voltou das operações abertas dos clientes dela e o
// principal dos pedidos aguardando aprovação. Pagamentos dos clientes devolvem o principal ao caixa (até o limite).
export type ManagerCash = { limitCents: number; inUseCents: number; reservedCents: number; availableCents: number };
export const managerCashOf = (limitCents: number, operations: OperationView[], reservedCents: number): ManagerCash => {
  const inUseCents = operations.filter((operation) => operation.status === "OPEN").reduce((total, operation) => total + operation.principalRemainingCents, 0);
  return { limitCents, inUseCents, reservedCents, availableCents: Math.max(limitCents - inUseCents - reservedCents, 0) };
};

// Caixa de uma gerente dentro da transação; excludeRequestId deixa de fora o pedido que está sendo decidido.
export async function loadManagerCash(tx: Parameters<Parameters<typeof withTenantContext>[0]>[0], tenantId: string, managerId: string, excludeRequestId?: string): Promise<ManagerCash> {
  const [manager] = await tx.select({ cashLimitCents: accountManagers.cashLimitCents }).from(accountManagers)
    .where(and(eq(accountManagers.id, managerId), eq(accountManagers.tenantId, tenantId)));
  const { operations } = await loadManagerOperations(tx, tenantId, managerId);
  const [reserved] = await tx.select({ total: sql<string>`coalesce(sum(${operationRequests.principalCents}), 0)` }).from(operationRequests)
    .where(and(eq(operationRequests.tenantId, tenantId), eq(operationRequests.managerId, managerId), eq(operationRequests.status, "PENDING"), excludeRequestId ? ne(operationRequests.id, excludeRequestId) : undefined));
  return managerCashOf(manager?.cashLimitCents ?? 0, operations, Number(reserved?.total ?? 0));
}

// Saldo de comissão de UM gerente, com a mesma conta da tela (comissão gerada sobre os juros recebidos − já pago − estornado) e os
// recebimentos com a situação de cada um no controle CPG. Usado pelo fechamento para nunca pagar sem comissão nem pagar de novo.
export async function loadManagerCommissionSummary(tx: Parameters<Parameters<typeof withTenantContext>[0]>[0], tenantId: string, managerId: string, managerBps: number) {
  const { clientRows, operations, overrideBps } = await loadManagerOperations(tx, tenantId, managerId);
  const payouts = await tx.select({ amountCents: accountManagerPayouts.amountCents }).from(accountManagerPayouts)
    .where(and(eq(accountManagerPayouts.tenantId, tenantId), eq(accountManagerPayouts.managerId, managerId)));
  const rows = await loadCommissionPaid(tx, tenantId, managerId);
  const summary = managerCommission(commissionGroups(clientRows, operations, managerBps, overrideBps), paidOutOf(payouts, rows));
  return { ...summary, receipts: receiptsWithStatus(managerReceipts(clientRows, operations, managerBps, overrideBps), rows) };
}

export type ManagerOperationRow = {
  id: string; code: string; loanDate: string; status: OperationView["status"]; state: OperationView["state"];
  principalCents: number; totalCents: number; paidCents: number; balanceCents: number; interestPaidCents: number;
  nextDueDate: string | null; daysUntilDue: number; installment: string | null; modality: string;
  // Comissão deste contrato (percentual do contrato transferido ou do cliente) sobre os juros já recebidos dele.
  commissionBps: number; commissionCents: number;
};
export type ManagerClientCard = {
  id: string; name: string; situation: ClientSituation; operations: ManagerOperationRow[];
  openCount: number; overdueCount: number; paidCount: number; balanceCents: number; principalOpenCents: number;
  interestReceivedCents: number; commissionBps: number; commissionCents: number; nextDueDate: string | null; worstDaysLate: number;
};

// Percentual de cada contrato: o do contrato transferido, ou o do cliente (e, sem ele, o padrão do gerente).
const operationBps = (operation: OperationView, clientBps: number | null, managerBps: number, overrideBps: Map<string, number>) => overrideBps.get(operation.id) ?? effectiveBps(clientBps, managerBps);

// Grupos para a conta da comissão: um por contrato (cada contrato com o seu percentual e o seu arredondamento, igual à soma dos
// recebimentos no controle CPG). Cliente sem operação entra vazio (só para a comissão prevista ficar zero).
function commissionGroups(clientRows: { id: string; bps: number | null }[], operations: OperationView[], managerBps: number, overrideBps: Map<string, number>) {
  return clientRows.flatMap((client) => {
    const own = operations.filter((row) => row.clientId === client.id);
    return own.length === 0 ? [{ bps: effectiveBps(client.bps, managerBps), operations: [] as OperationView[] }]
      : own.map((operation) => ({ bps: operationBps(operation, client.bps, managerBps, overrideBps), operations: [operation] }));
  });
}

// Recebimentos de juros de todos os contratos do gerente (cancelados ficam de fora, como no saldo), com a comissão de cada um.
function managerReceipts(clientRows: { id: string; name: string; bps: number | null }[], operations: OperationView[], managerBps: number, overrideBps: Map<string, number>): Receipt[] {
  const byId = new Map(clientRows.map((client) => [client.id, client]));
  return operations.filter((operation) => operation.status !== "CANCELED" && byId.has(operation.clientId)).flatMap((operation) => {
    const client = byId.get(operation.clientId)!;
    return contractReceipts({
      operationId: operation.id, clientId: client.id, clientName: client.name, operationCode: operation.code, loanDate: operation.loanDate,
      principalCents: operation.principalCents, interestRateBps: Number(operation.interestRateBps), commissionBps: operationBps(operation, client.bps, managerBps, overrideBps),
      interestPaidCents: operation.interestPaidCents,
    }, operation.payments.map((payment) => ({ id: payment.id, paidAt: payment.paidAt, createdAt: payment.createdAt, interestCents: payment.interestCents })));
  });
}

// Linhas do controle CPG (comissão paga por recebimento) do tenant, de um gerente ou de todos.
async function loadCommissionPaid(tx: Tx, tenantId: string, managerId?: string): Promise<(CommissionPaidRow & { managerId: string })[]> {
  const rows = await tx.select().from(accountManagerCommissionPaid)
    .where(and(eq(accountManagerCommissionPaid.tenantId, tenantId), managerId ? eq(accountManagerCommissionPaid.managerId, managerId) : undefined))
    .orderBy(asc(accountManagerCommissionPaid.createdAt), asc(accountManagerCommissionPaid.receiptPaidOn), asc(accountManagerCommissionPaid.id));
  return rows.map((row) => ({
    id: row.id, managerId: row.managerId, payoutId: row.payoutId, kind: row.kind === "REVERSAL" ? "REVERSAL" : "PAID", reversesId: row.reversesId, paymentId: row.paymentId, operationId: row.operationId,
    clientId: row.clientId, clientName: row.clientName, operationCode: row.operationCode, loanDate: row.loanDate, principalCents: row.principalCents, interestRateBps: Number(row.interestRateBps),
    commissionBps: row.commissionBps, receiptPaidOn: row.receiptPaidOn, interestCents: row.interestCents, commissionDueCents: row.commissionDueCents, commissionCents: row.commissionCents,
    source: row.source === "HISTORICAL" ? "HISTORICAL" : "CLOSING", reason: row.reason, createdAt: row.createdAt.toISOString(),
  }));
}
const reversedCentsOf = (rows: Pick<CommissionPaidRow, "kind" | "commissionCents">[]) => rows.filter((row) => row.kind === "REVERSAL").reduce((total, row) => total + row.commissionCents, 0);
// Já pago ao gerente = comissão dos fechamentos − estornos.
const paidOutOf = (payouts: { amountCents: number }[], rows: Pick<CommissionPaidRow, "kind" | "commissionCents">[]) => payouts.reduce((total, payout) => total + payout.amountCents, 0) - reversedCentsOf(rows);

// Composição de um fechamento: CPG (recebimentos pagos nele), o detalhamento por contrato gravado (versão anterior) ou nenhuma.
type ItemRow = typeof accountManagerPayoutItems.$inferSelect;
function payoutComposition(payout: { id: string; amountCents: number }, rows: CommissionPaidRow[], items: ItemRow[]): { source: ClosingSource; lines: ClosingLine[]; historical: { recordedAt: string; reason: string } | null } {
  const paid = rows.filter((row) => row.payoutId === payout.id && row.kind === "PAID");
  if (paid.length > 0) {
    const historical = paid.find((row) => row.source === "HISTORICAL");
    return { source: "CPG", lines: linesFromCommissionPaid(rows, payout.id), historical: historical ? { recordedAt: historical.createdAt, reason: historical.reason ?? "" } : null };
  }
  const own = items.filter((item) => item.payoutId === payout.id);
  if (own.length > 0) {
    return { source: "SNAPSHOT", historical: null, lines: own.map((item) => ({
      operationId: item.operationId, clientId: item.clientId, clientName: item.clientName, operationCode: item.operationCode, loanDate: item.loanDate,
      principalCents: item.principalCents, interestRateBps: Number(item.interestRateBps), commissionBps: item.commissionBps, interestReceivedCents: item.interestReceivedCents, commissionCents: item.commissionCents,
    })) };
  }
  return { source: "UNREGISTERED", historical: null, lines: [unregisteredLine(payout.amountCents)] };
}
const reversalsOf = (rows: CommissionPaidRow[], payoutId: string): ClosingReversal[] => rows.filter((row) => row.payoutId === payoutId && row.kind === "REVERSAL")
  .map((row) => ({ clientName: row.clientName, operationCode: row.operationCode, receiptPaidOn: row.receiptPaidOn, amountCents: row.commissionCents, reason: row.reason ?? "", createdAt: row.createdAt }));

function clientCards(clientRows: { id: string; name: string; bps: number | null }[], operations: OperationView[], managerBps: number, overrideBps: Map<string, number>): ManagerClientCard[] {
  return clientRows.map((client) => {
    const bps = effectiveBps(client.bps, managerBps);
    const own = operations.filter((operation) => operation.clientId === client.id && operation.status !== "CANCELED");
    const open = own.filter((operation) => operation.status === "OPEN");
    const dues = open.map((operation) => operation.nextOpenDueDate ?? operation.nextDueDate).filter(Boolean).sort();
    const interestReceivedCents = own.reduce((total, operation) => total + operation.interestPaidCents, 0);
    return {
      id: client.id, name: client.name, situation: clientSituation(own),
      openCount: open.length, overdueCount: open.filter((operation) => operation.state === "OVERDUE").length, paidCount: own.filter((operation) => operation.status === "PAID").length,
      balanceCents: open.reduce((total, operation) => total + operation.balanceCents, 0),
      principalOpenCents: open.reduce((total, operation) => total + operation.principalRemainingCents, 0),
      interestReceivedCents, commissionBps: own.length > 0 ? operationBps(own[0], client.bps, managerBps, overrideBps) : bps,
      commissionCents: own.reduce((total, operation) => total + commissionOf(operation.interestPaidCents, operationBps(operation, client.bps, managerBps, overrideBps)), 0),
      nextDueDate: dues[0] ?? null,
      worstDaysLate: Math.max(0, ...open.filter((operation) => operation.state === "OVERDUE").map((operation) => -operation.daysUntilDue)),
      operations: own.map((operation) => ({
        id: operation.id, code: operation.code, loanDate: operation.loanDate, status: operation.status, state: operation.state,
        principalCents: operation.principalCents, totalCents: operation.totalCents, paidCents: operation.paidCents, balanceCents: operation.balanceCents, interestPaidCents: operation.interestPaidCents,
        nextDueDate: operation.status === "OPEN" ? operation.nextOpenDueDate ?? operation.nextDueDate : null, daysUntilDue: operation.daysUntilDue,
        installment: operation.status === "OPEN" && operation.nextInstallment ? `Parcela ${operation.nextInstallment.number}/${operation.installmentTotal}` : null, modality: operation.modality,
        commissionBps: operationBps(operation, client.bps, managerBps, overrideBps), commissionCents: commissionOf(operation.interestPaidCents, operationBps(operation, client.bps, managerBps, overrideBps)),
      })),
    };
  });
}

// Painel do gerente logado: SÓ os clientes dele, sem CPF, telefone, endereço ou banco (só nome e situação das operações).
export async function loadManagerPanel() {
  const data = await withManagerContext(async (tx, { tenantId, manager, session }) => {
    const { clientRows, operations, overrideBps } = await loadManagerOperations(tx, tenantId, manager.id);
    const { payouts: payoutRows, adjustments } = await loadPayoutsAndAdjustments(tx, tenantId, manager.id);
    const cash = await loadManagerCash(tx, tenantId, manager.id);
    const commissionPaid = await loadCommissionPaid(tx, tenantId, manager.id);
    return { manager, userId: session.user.id, userName: session.user.name, clientRows, operations, overrideBps, payoutRows, adjustments, cash, commissionPaid };
  });
  const paidOutCents = paidOutOf(data.payoutRows, data.commissionPaid);
  const summary = managerCommission(commissionGroups(data.clientRows, data.operations, data.manager.commissionBps, data.overrideBps), paidOutCents);
  const cards = clientCards(data.clientRows, data.operations, data.manager.commissionBps, data.overrideBps);
  const live = data.operations.filter((operation) => operation.status !== "CANCELED");
  // Controle CPG da própria gerente (só leitura): por contrato, a comissão gerada, a paga e a pendente, com os mesmos cálculos de /gerentes.
  const contracts = contractsWithStatus(receiptsWithStatus(managerReceipts(data.clientRows, data.operations, data.manager.commissionBps, data.overrideBps), data.commissionPaid));
  return {
    managerName: data.manager.name, userId: data.userId, userName: data.userName, today: todayIso(), summary, cash: data.cash,
    counts: {
      clients: cards.length, overdue: cards.filter((card) => card.situation === "OVERDUE").length, onTime: cards.filter((card) => card.situation === "ON_TIME").length,
      paid: cards.filter((card) => card.situation === "PAID").length, none: cards.filter((card) => card.situation === "NO_OPERATIONS").length,
      openOperations: live.filter((operation) => operation.status === "OPEN").length, paidOperations: live.filter((operation) => operation.status === "PAID").length,
    },
    principalOpenCents: live.filter((operation) => operation.status === "OPEN").reduce((total, operation) => total + operation.principalRemainingCents, 0),
    clients: cards,
    payouts: data.payoutRows,
    contracts: contracts.map(({ receipts: _receipts, ...contract }) => { void _receipts; return contract; }),
    pendingAdjustments: data.adjustments.filter((item) => !item.payoutId), pending: pendingTotals(data.adjustments),
  };
}
export type ManagerPanel = Awaited<ReturnType<typeof loadManagerPanel>>;

// Visão do dono da carteira (/gerentes): todos os gerentes do tenant com o resumo da comissão, os clientes ligados (com o percentual
// de cada um) e os clientes ainda sem gerente. Só leitura; nada é calculado fora do extrato das operações.
export async function loadManagersPage() {
  return withTenantContext((tx, { tenantId }) => loadManagersData(tx, tenantId));
}

// Mesma tela para o MASTER, de um cliente SaaS escolhido (withPlatformContext exige SUPER_ADMIN na sessão e no banco).
export async function loadManagersForTenant(tenantId: string) {
  return withPlatformContext((tx) => loadManagersData(tx, tenantId));
}

// Montagem da tela de gerentes de UM tenant, dentro da transação de quem chama (dono da carteira ou MASTER).
export async function loadManagersData(tx: Parameters<Parameters<typeof withTenantContext>[0]>[0], tenantId: string) {
  const data = await (async () => {
    const managerRows = await tx.select({
      id: accountManagers.id, name: accountManagers.name, email: accountManagers.email, userId: accountManagers.userId, commissionBps: accountManagers.commissionBps, cashLimitCents: accountManagers.cashLimitCents, active: accountManagers.active,
      loginActive: users.active, mustChangePassword: users.mustChangePassword, lastLoginAt: users.lastLoginAt,
    }).from(accountManagers)
      .leftJoin(users, and(eq(users.id, accountManagers.userId), eq(users.tenantId, tenantId)))
      .where(eq(accountManagers.tenantId, tenantId)).orderBy(asc(accountManagers.name));
    const { payouts: payoutRows, adjustments } = await loadPayoutsAndAdjustments(tx, tenantId);
    const commissionPaid = await loadCommissionPaid(tx, tenantId);
    const items = await tx.select().from(accountManagerPayoutItems).where(eq(accountManagerPayoutItems.tenantId, tenantId));
    const unassigned = await tx.select({ id: clients.id, name: clients.name }).from(clients)
      .where(and(eq(clients.tenantId, tenantId), isNull(clients.accountManagerId), isNull(clients.archivedAt))).orderBy(asc(clients.name));
    const reservedRows = await tx.select({ managerId: operationRequests.managerId, total: sql<string>`coalesce(sum(${operationRequests.principalCents}), 0)` }).from(operationRequests)
      .where(and(eq(operationRequests.tenantId, tenantId), eq(operationRequests.status, "PENDING"))).groupBy(operationRequests.managerId);
    const reservedBy = new Map(reservedRows.map((row) => [row.managerId, Number(row.total)]));
    const perManager = [];
    for (const manager of managerRows) perManager.push({ manager, ...(await loadManagerOperations(tx, tenantId, manager.id)) });
    return { perManager, payoutRows, adjustments, unassigned, reservedBy, commissionPaid, items };
  })();
  return {
    today: todayIso(),
    unassigned: data.unassigned,
    managers: data.perManager.map(({ manager, clientRows, operations, overrideBps }) => {
      const rows = data.commissionPaid.filter((row) => row.managerId === manager.id);
      const reversible = reversibleByRow(rows);
      // Cada fechamento com a composição dele (contratos e comissão de cada um) e os estornos ligados a ele.
      const payouts = data.payoutRows.filter((payout) => payout.managerId === manager.id).map((payout) => {
        const composition = payoutComposition(payout, rows, data.items);
        return { ...payout, source: composition.source, historical: composition.historical, lines: composition.lines, reversals: reversalsOf(rows, payout.id), reversedCents: reversedCentsOf(rows.filter((row) => row.payoutId === payout.id)) };
      });
      const paidOutCents = paidOutOf(payouts, rows);
      const receipts = receiptsWithStatus(managerReceipts(clientRows, operations, manager.commissionBps, overrideBps), rows);
      const paidOn = new Map(payouts.map((payout) => [payout.id, payout.paidOn]));
      // Histórico CPG: cada pagamento de comissão por recebimento e cada estorno, com o que ainda pode ser estornado.
      const history = rows.map((row) => ({ ...row, payoutPaidOn: paidOn.get(row.payoutId) ?? null, reversibleCents: row.kind === "PAID" ? Math.max(0, reversible.get(row.id) ?? 0) : 0 }));
      const summary = managerCommission(commissionGroups(clientRows, operations, manager.commissionBps, overrideBps), paidOutCents);
      const cards = clientCards(clientRows, operations, manager.commissionBps, overrideBps);
      const adjustments = data.adjustments.filter((item) => item.managerId === manager.id);
      return {
        id: manager.id, name: manager.name, email: manager.email, active: manager.active, commissionBps: manager.commissionBps,
        hasLogin: Boolean(manager.userId), loginActive: manager.loginActive ?? false, mustChangePassword: manager.mustChangePassword ?? false, lastLoginAt: manager.lastLoginAt?.toISOString() ?? null,
        summary, payouts, adjustments, pending: pendingTotals(adjustments), contracts: contractsWithStatus(receipts), commissionHistory: history, cash: managerCashOf(manager.cashLimitCents, operations, data.reservedBy.get(manager.id) ?? 0),
        clients: cards.map((card) => ({ id: card.id, name: card.name, situation: card.situation, commissionBps: card.commissionBps, customBps: clientRows.find((client) => client.id === card.id)?.bps ?? null, interestReceivedCents: card.interestReceivedCents, commissionCents: card.commissionCents, contracts: card.operations })),
      };
    }),
  };
}
export type ManagersPage = Awaited<ReturnType<typeof loadManagersData>>;

// ---------------------------------------------------------------------------------------------------------------------------------
// Relatório de UM fechamento, só se ele for do tenant de quem pede (o id de outra carteira devolve null). Só leitura. As linhas são as
// GRAVADAS (CPG ou detalhamento); fechamento sem composição registrada mostra só o valor, sem repartir entre contratos.
export async function loadClosingReport(tx: Tx, tenantId: string, payoutId: string, generatedAt = new Date()) {
  const [payout] = await tx.select().from(accountManagerPayouts).where(and(eq(accountManagerPayouts.id, payoutId), eq(accountManagerPayouts.tenantId, tenantId)));
  if (!payout) return null;
  const [manager] = await tx.select({ id: accountManagers.id, name: accountManagers.name }).from(accountManagers)
    .where(and(eq(accountManagers.id, payout.managerId), eq(accountManagers.tenantId, tenantId)));
  if (!manager) return null;
  const [tenant] = await tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId));
  const rows = await loadCommissionPaid(tx, tenantId, manager.id);
  const items = await tx.select().from(accountManagerPayoutItems).where(and(eq(accountManagerPayoutItems.tenantId, tenantId), eq(accountManagerPayoutItems.payoutId, payout.id)));
  const composition = payoutComposition(payout, rows, items);
  const adjustments = await tx.select({ kind: accountManagerAdjustments.kind, description: accountManagerAdjustments.description, amountCents: accountManagerAdjustments.amountCents, entryDate: accountManagerAdjustments.entryDate })
    .from(accountManagerAdjustments).where(and(eq(accountManagerAdjustments.tenantId, tenantId), eq(accountManagerAdjustments.payoutId, payout.id)))
    .orderBy(asc(accountManagerAdjustments.entryDate), asc(accountManagerAdjustments.createdAt));
  const allPayouts = (await tx.select({ id: accountManagerPayouts.id, paidOn: accountManagerPayouts.paidOn, createdAt: accountManagerPayouts.createdAt }).from(accountManagerPayouts)
    .where(and(eq(accountManagerPayouts.tenantId, tenantId), eq(accountManagerPayouts.managerId, manager.id)))).map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
  return buildClosingReport({
    tenantName: tenant?.name ?? "Carteira", managerName: manager.name,
    payout: { id: payout.id, paidOn: payout.paidOn, createdAt: payout.createdAt.toISOString(), amountCents: payout.amountCents, debitCents: payout.debitCents, creditCents: payout.creditCents, notes: payout.notes },
    period: referencePeriod(allPayouts, payout.id)!, lines: composition.lines, source: composition.source, historical: composition.historical, generatedAt,
    reversals: reversalsOf(rows, payout.id),
    adjustments: adjustments.map((item) => ({ ...item, kind: item.kind === "CREDIT" ? "CREDIT" : "DEBIT" })),
  });
}

// Todos os fechamentos de uma data no tenant (relatório consolidado, um grupo por gerente). Só leitura.
export async function loadClosingReportsByDate(tx: Tx, tenantId: string, paidOn: string, generatedAt = new Date()) {
  const rows = await tx.select({ id: accountManagerPayouts.id }).from(accountManagerPayouts)
    .innerJoin(accountManagers, and(eq(accountManagers.id, accountManagerPayouts.managerId), eq(accountManagers.tenantId, accountManagerPayouts.tenantId)))
    .where(and(eq(accountManagerPayouts.tenantId, tenantId), eq(accountManagerPayouts.paidOn, paidOn)))
    .orderBy(asc(accountManagers.name), asc(accountManagerPayouts.createdAt));
  const reports = [];
  for (const row of rows) { const report = await loadClosingReport(tx, tenantId, row.id, generatedAt); if (report) reports.push(report); }
  return reports;
}
