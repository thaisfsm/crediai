import "server-only";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { withManagerContext, withPlatformContext, withTenantContext } from "@/lib/auth/guards";
import { accountManagerPayouts, accountManagers, clients, installmentDeferrals, loanOperations, loanRenewals, payments, users } from "@/lib/db/schema";
import { todayIso } from "@/lib/finance/format";
import { buildPortfolio, type DeferralRecord, type OperationView, type RenewalRecord } from "@/lib/finance/portfolio";
import { toDeferralRecord, toOperationRecord, toPaymentRecord, toRenewalRecord } from "@/lib/finance/summaries";
import { clientSituation, commissionOf, effectiveBps, managerCommission, type ClientSituation } from "./commission";

// Todas as operações (todos os ciclos) dos clientes indicados por um gerente, já calculadas como no extrato. Cada consulta filtra
// tenant_id e os clientes do gerente: o isolamento não depende do papel de banco (a produção ignora RLS).
async function loadManagerOperations(tx: Parameters<Parameters<typeof withTenantContext>[0]>[0], tenantId: string, managerId: string) {
  const clientRows = await tx.select({ id: clients.id, name: clients.name, archivedAt: clients.archivedAt, bps: clients.accountManagerBps }).from(clients)
    .where(and(eq(clients.tenantId, tenantId), eq(clients.accountManagerId, managerId))).orderBy(asc(clients.name));
  const clientIds = clientRows.map((client) => client.id);
  if (clientIds.length === 0) return { clientRows, operations: [] as OperationView[] };
  const operationRows = await tx.select({ operation: loanOperations, clientName: clients.name }).from(loanOperations)
    .innerJoin(clients, and(eq(clients.id, loanOperations.clientId), eq(clients.tenantId, loanOperations.tenantId)))
    .where(and(eq(loanOperations.tenantId, tenantId), inArray(loanOperations.clientId, clientIds)))
    .orderBy(desc(loanOperations.loanDate), desc(loanOperations.createdAt));
  const operationIds = operationRows.map((row) => row.operation.id);
  const paymentRows = operationIds.length === 0 ? [] : await tx.select({ payment: payments, clientName: clients.name }).from(payments)
    .innerJoin(loanOperations, and(eq(loanOperations.id, payments.operationId), eq(loanOperations.tenantId, payments.tenantId)))
    .innerJoin(clients, and(eq(clients.id, loanOperations.clientId), eq(clients.tenantId, loanOperations.tenantId)))
    .where(and(eq(payments.tenantId, tenantId), inArray(payments.operationId, operationIds))).orderBy(desc(payments.paidAt), desc(payments.createdAt));
  const renewalRows = operationIds.length === 0 ? [] : await tx.select({ renewal: loanRenewals }).from(loanRenewals)
    .where(and(eq(loanRenewals.tenantId, tenantId), inArray(loanRenewals.operationId, operationIds))).orderBy(asc(loanRenewals.periodNumber));
  const deferralRows = operationIds.length === 0 ? [] : await tx.select({ deferral: installmentDeferrals }).from(installmentDeferrals)
    .where(and(eq(installmentDeferrals.tenantId, tenantId), inArray(installmentDeferrals.operationId, operationIds))).orderBy(asc(installmentDeferrals.createdAt));
  const renewalsByOperation = new Map<string, RenewalRecord[]>();
  for (const { renewal } of renewalRows) renewalsByOperation.set(renewal.operationId, [...(renewalsByOperation.get(renewal.operationId) ?? []), toRenewalRecord(renewal)]);
  const deferralsByOperation = new Map<string, DeferralRecord[]>();
  for (const { deferral } of deferralRows) deferralsByOperation.set(deferral.operationId, [...(deferralsByOperation.get(deferral.operationId) ?? []), toDeferralRecord(deferral)]);
  const { operations } = buildPortfolio({
    hasWallet: true, initialCapitalCents: 0, today: todayIso(),
    operations: operationRows.map(({ operation, clientName }) => ({ ...toOperationRecord(operation, clientName, renewalsByOperation.get(operation.id) ?? [], deferralsByOperation.get(operation.id) ?? []), cycleNumber: operation.cycleNumber })),
    payments: paymentRows.map(({ payment, clientName }) => toPaymentRecord(payment, clientName)),
  });
  return { clientRows, operations };
}

export type ManagerOperationRow = {
  id: string; code: string; loanDate: string; status: OperationView["status"]; state: OperationView["state"];
  principalCents: number; totalCents: number; paidCents: number; balanceCents: number; interestPaidCents: number;
  nextDueDate: string | null; daysUntilDue: number; installment: string | null; modality: string;
};
export type ManagerClientCard = {
  id: string; name: string; situation: ClientSituation; operations: ManagerOperationRow[];
  openCount: number; overdueCount: number; paidCount: number; balanceCents: number; principalOpenCents: number;
  interestReceivedCents: number; commissionBps: number; commissionCents: number; nextDueDate: string | null; worstDaysLate: number;
};

function clientCards(clientRows: { id: string; name: string; bps: number | null }[], operations: OperationView[], managerBps: number): ManagerClientCard[] {
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
      interestReceivedCents, commissionBps: bps, commissionCents: commissionOf(interestReceivedCents, bps),
      nextDueDate: dues[0] ?? null,
      worstDaysLate: Math.max(0, ...open.filter((operation) => operation.state === "OVERDUE").map((operation) => -operation.daysUntilDue)),
      operations: own.map((operation) => ({
        id: operation.id, code: operation.code, loanDate: operation.loanDate, status: operation.status, state: operation.state,
        principalCents: operation.principalCents, totalCents: operation.totalCents, paidCents: operation.paidCents, balanceCents: operation.balanceCents, interestPaidCents: operation.interestPaidCents,
        nextDueDate: operation.status === "OPEN" ? operation.nextOpenDueDate ?? operation.nextDueDate : null, daysUntilDue: operation.daysUntilDue,
        installment: operation.status === "OPEN" && operation.nextInstallment ? `Parcela ${operation.nextInstallment.number}/${operation.installmentTotal}` : null, modality: operation.modality,
      })),
    };
  });
}

// Painel do gerente logado: SÓ os clientes dele, sem CPF, telefone, endereço ou banco (só nome e situação das operações).
export async function loadManagerPanel() {
  const data = await withManagerContext(async (tx, { tenantId, manager, session }) => {
    const { clientRows, operations } = await loadManagerOperations(tx, tenantId, manager.id);
    const payoutRows = await tx.select({ id: accountManagerPayouts.id, amountCents: accountManagerPayouts.amountCents, paidOn: accountManagerPayouts.paidOn, notes: accountManagerPayouts.notes })
      .from(accountManagerPayouts).where(and(eq(accountManagerPayouts.tenantId, tenantId), eq(accountManagerPayouts.managerId, manager.id))).orderBy(desc(accountManagerPayouts.paidOn), desc(accountManagerPayouts.createdAt));
    return { manager, userName: session.user.name, clientRows, operations, payoutRows };
  });
  const paidOutCents = data.payoutRows.reduce((total, payout) => total + payout.amountCents, 0);
  const summary = managerCommission(data.clientRows.map((client) => ({ bps: effectiveBps(client.bps, data.manager.commissionBps), operations: data.operations.filter((operation) => operation.clientId === client.id) })), paidOutCents);
  const cards = clientCards(data.clientRows, data.operations, data.manager.commissionBps);
  const live = data.operations.filter((operation) => operation.status !== "CANCELED");
  return {
    managerName: data.manager.name, userName: data.userName, today: todayIso(), summary,
    counts: {
      clients: cards.length, overdue: cards.filter((card) => card.situation === "OVERDUE").length, onTime: cards.filter((card) => card.situation === "ON_TIME").length,
      paid: cards.filter((card) => card.situation === "PAID").length, none: cards.filter((card) => card.situation === "NO_OPERATIONS").length,
      openOperations: live.filter((operation) => operation.status === "OPEN").length, paidOperations: live.filter((operation) => operation.status === "PAID").length,
    },
    principalOpenCents: live.filter((operation) => operation.status === "OPEN").reduce((total, operation) => total + operation.principalRemainingCents, 0),
    clients: cards,
    payouts: data.payoutRows,
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
      id: accountManagers.id, name: accountManagers.name, email: accountManagers.email, userId: accountManagers.userId, commissionBps: accountManagers.commissionBps, active: accountManagers.active,
      loginActive: users.active, mustChangePassword: users.mustChangePassword, lastLoginAt: users.lastLoginAt,
    }).from(accountManagers)
      .leftJoin(users, and(eq(users.id, accountManagers.userId), eq(users.tenantId, tenantId)))
      .where(eq(accountManagers.tenantId, tenantId)).orderBy(asc(accountManagers.name));
    const payoutRows = await tx.select({ id: accountManagerPayouts.id, managerId: accountManagerPayouts.managerId, amountCents: accountManagerPayouts.amountCents, paidOn: accountManagerPayouts.paidOn, notes: accountManagerPayouts.notes })
      .from(accountManagerPayouts).where(eq(accountManagerPayouts.tenantId, tenantId)).orderBy(desc(accountManagerPayouts.paidOn), desc(accountManagerPayouts.createdAt));
    const unassigned = await tx.select({ id: clients.id, name: clients.name }).from(clients)
      .where(and(eq(clients.tenantId, tenantId), isNull(clients.accountManagerId), isNull(clients.archivedAt))).orderBy(asc(clients.name));
    const perManager = [];
    for (const manager of managerRows) perManager.push({ manager, ...(await loadManagerOperations(tx, tenantId, manager.id)) });
    return { perManager, payoutRows, unassigned };
  })();
  return {
    today: todayIso(),
    unassigned: data.unassigned,
    managers: data.perManager.map(({ manager, clientRows, operations }) => {
      const payouts = data.payoutRows.filter((payout) => payout.managerId === manager.id);
      const paidOutCents = payouts.reduce((total, payout) => total + payout.amountCents, 0);
      const summary = managerCommission(clientRows.map((client) => ({ bps: effectiveBps(client.bps, manager.commissionBps), operations: operations.filter((operation) => operation.clientId === client.id) })), paidOutCents);
      const cards = clientCards(clientRows, operations, manager.commissionBps);
      return {
        id: manager.id, name: manager.name, email: manager.email, active: manager.active, commissionBps: manager.commissionBps,
        hasLogin: Boolean(manager.userId), loginActive: manager.loginActive ?? false, mustChangePassword: manager.mustChangePassword ?? false, lastLoginAt: manager.lastLoginAt?.toISOString() ?? null,
        summary, payouts,
        clients: cards.map((card) => ({ id: card.id, name: card.name, situation: card.situation, commissionBps: card.commissionBps, customBps: clientRows.find((client) => client.id === card.id)?.bps ?? null, interestReceivedCents: card.interestReceivedCents, commissionCents: card.commissionCents })),
      };
    }),
  };
}
export type ManagersPage = Awaited<ReturnType<typeof loadManagersData>>;
