import "server-only";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { TenantTransaction } from "@/lib/auth/guards";
import { capitalMovements, clients, loanOperations, loanRenewals, payments, wallets } from "@/lib/db/schema";
import { todayIso } from "./format";
import { buildPortfolio, type CapitalMovementRecord, type OperationRecord, type PaymentRecord, type PaymentRevisionRecord, type RenewalRecord } from "./portfolio";

// Conversão das linhas do banco para os registros de buildPortfolio. Usada pelo dashboard do tenant e pela
// administração da plataforma, para que os indicadores dos dois lados saiam exatamente do mesmo cálculo.
type MovementRow = typeof capitalMovements.$inferSelect;
type OperationRow = typeof loanOperations.$inferSelect;
type PaymentRow = typeof payments.$inferSelect;
type RenewalRow = typeof loanRenewals.$inferSelect;

export function toMovementRecord(movement: MovementRow): CapitalMovementRecord {
  return {
    id: movement.id, kind: movement.kind, amountCents: movement.amountCents, occurredAt: movement.occurredAt, notes: movement.notes, reversedMovementId: movement.reversedMovementId, createdAt: movement.createdAt.toISOString(),
  };
}

export function toRenewalRecord(renewal: RenewalRow): RenewalRecord {
  return {
    id: renewal.id, paymentId: renewal.paymentId, periodNumber: renewal.periodNumber, previousDueDate: renewal.previousDueDate, newDueDate: renewal.newDueDate,
    principalBaseCents: renewal.principalBaseCents, interestCents: renewal.interestCents, createdAt: renewal.createdAt.toISOString(),
  };
}

export function toOperationRecord(operation: OperationRow, clientName: string, renewals: RenewalRecord[]): OperationRecord {
  return {
    id: operation.id, clientId: operation.clientId, clientName, principalCents: operation.principalCents, interestRateBps: operation.interestRateBps,
    interestCents: operation.interestCents, totalCents: operation.totalCents, loanDate: operation.loanDate, dueDate: operation.dueDate,
    status: operation.status, settledAt: operation.settledAt, calculationRule: operation.calculationRule, createdAt: operation.createdAt.toISOString(), updatedAt: operation.updatedAt.toISOString(),
    renewals,
    modality: operation.modality === "INSTALLMENT" ? "INSTALLMENT" as const : "SINGLE" as const,
    installmentCount: operation.installmentCount, installmentCents: operation.installmentCents, firstDueDate: operation.firstDueDate,
  };
}

export function toPaymentRecord(payment: PaymentRow, clientName: string, revisions: PaymentRevisionRecord[] = []): PaymentRecord {
  return {
    id: payment.id, operationId: payment.operationId, clientName, amountCents: payment.amountCents, paidAt: payment.paidAt, notes: payment.notes, createdAt: payment.createdAt.toISOString(),
    revisions,
  };
}

// Ciclo atual de cada linha: o da carteira do tenant (1 quando ainda não existe carteira).
const currentCycle = (tenantColumn: string) => sql.raw(`coalesce((select w.cycle_number from wallet w where w.tenant_id = ${tenantColumn}), 1)`);

// Carteira (ciclo atual) de vários tenants de uma vez, calculada por buildPortfolio, como no dashboard de cada um.
// Só para a administração da plataforma: precisa rodar em withPlatformContext.
export async function loadTenantPortfolios(tx: TenantTransaction, tenantIds: string[]) {
  const result = new Map<string, ReturnType<typeof buildPortfolio> & { payments: PaymentRecord[] }>();
  if (tenantIds.length === 0) return result;
  const walletRows = await tx.select().from(wallets).where(inArray(wallets.tenantId, tenantIds));
  const movementRows = await tx.select().from(capitalMovements)
    .where(and(inArray(capitalMovements.tenantId, tenantIds), sql`${capitalMovements.cycleNumber} = ${currentCycle("capital_movement.tenant_id")}`))
    .orderBy(asc(capitalMovements.occurredAt), asc(capitalMovements.createdAt));
  const operationRows = await tx.select({ operation: loanOperations, clientName: clients.name }).from(loanOperations)
    .innerJoin(clients, eq(clients.id, loanOperations.clientId))
    .where(and(inArray(loanOperations.tenantId, tenantIds), sql`${loanOperations.cycleNumber} = ${currentCycle("loan_operation.tenant_id")}`))
    .orderBy(desc(loanOperations.loanDate), desc(loanOperations.createdAt));
  const paymentRows = await tx.select({ payment: payments, clientName: clients.name }).from(payments)
    .innerJoin(loanOperations, eq(loanOperations.id, payments.operationId))
    .innerJoin(clients, eq(clients.id, loanOperations.clientId))
    .where(and(inArray(payments.tenantId, tenantIds), sql`${loanOperations.cycleNumber} = ${currentCycle("loan_operation.tenant_id")}`))
    .orderBy(desc(payments.paidAt), desc(payments.createdAt));
  const renewalRows = await tx.select({ renewal: loanRenewals }).from(loanRenewals)
    .innerJoin(loanOperations, eq(loanOperations.id, loanRenewals.operationId))
    .where(and(inArray(loanRenewals.tenantId, tenantIds), sql`${loanOperations.cycleNumber} = ${currentCycle("loan_operation.tenant_id")}`))
    .orderBy(asc(loanRenewals.periodNumber));

  const group = <T,>(rows: T[], key: (row: T) => string) => {
    const map = new Map<string, T[]>();
    for (const row of rows) map.set(key(row), [...(map.get(key(row)) ?? []), row]);
    return map;
  };
  const renewalsByOperation = group(renewalRows.map(({ renewal }) => renewal), (renewal) => renewal.operationId);
  const movementsByTenant = group(movementRows, (movement) => movement.tenantId);
  const operationsByTenant = group(operationRows, (row) => row.operation.tenantId);
  const paymentsByTenant = group(paymentRows, (row) => row.payment.tenantId);
  const today = todayIso();

  for (const tenantId of tenantIds) {
    const wallet = walletRows.find((row) => row.tenantId === tenantId);
    const tenantPayments = (paymentsByTenant.get(tenantId) ?? []).map(({ payment, clientName }) => toPaymentRecord(payment, clientName));
    const portfolio = buildPortfolio({
      hasWallet: Boolean(wallet),
      initialCapitalCents: wallet?.initialCapitalCents ?? 0,
      walletCreatedOn: wallet ? todayIso(wallet.cycleStartedAt ?? wallet.createdAt) : null,
      cycleNumber: wallet?.cycleNumber ?? 1,
      capitalMovements: (movementsByTenant.get(tenantId) ?? []).map(toMovementRecord),
      today,
      operations: (operationsByTenant.get(tenantId) ?? []).map(({ operation, clientName }) =>
        toOperationRecord(operation, clientName, (renewalsByOperation.get(operation.id) ?? []).map(toRenewalRecord))),
      payments: tenantPayments,
    });
    result.set(tenantId, { ...portfolio, payments: tenantPayments });
  }
  return result;
}
