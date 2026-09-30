import "server-only";
import { asc, desc, eq } from "drizzle-orm";
import { withTenantContext } from "@/lib/auth/guards";
import { clients, loanOperations, payments, wallets } from "@/lib/db/schema";
import { todayIso } from "./format";
import { buildPortfolio, type ClientRecord } from "./portfolio";

// Todas as consultas rodam no contexto do tenant da sessão (RLS) e também filtram por tenant_id,
// para que o isolamento não dependa só do papel de banco usado em produção.
export async function loadTenantPortfolio() {
  const data = await withTenantContext(async (tx, { tenantId }) => {
    const wallet = await tx.query.wallets.findFirst({ where: eq(wallets.tenantId, tenantId) });
    const clientRows = await tx.select().from(clients).where(eq(clients.tenantId, tenantId)).orderBy(asc(clients.name));
    const operationRows = await tx.select({ operation: loanOperations, clientName: clients.name })
      .from(loanOperations)
      .innerJoin(clients, eq(clients.id, loanOperations.clientId))
      .where(eq(loanOperations.tenantId, tenantId))
      .orderBy(desc(loanOperations.loanDate), desc(loanOperations.createdAt));
    const paymentRows = await tx.select({ payment: payments, clientName: clients.name })
      .from(payments)
      .innerJoin(loanOperations, eq(loanOperations.id, payments.operationId))
      .innerJoin(clients, eq(clients.id, loanOperations.clientId))
      .where(eq(payments.tenantId, tenantId))
      .orderBy(desc(payments.paidAt), desc(payments.createdAt));
    return { wallet, clientRows, operationRows, paymentRows };
  });

  const clientList: ClientRecord[] = data.clientRows.map((client) => ({
    id: client.id, name: client.name, document: client.document, phone: client.phone, notes: client.notes, createdAt: client.createdAt.toISOString(),
  }));
  const portfolio = buildPortfolio({
    hasWallet: Boolean(data.wallet),
    initialCapitalCents: data.wallet?.initialCapitalCents ?? 0,
    today: todayIso(),
    operations: data.operationRows.map(({ operation, clientName }) => ({
      id: operation.id, clientId: operation.clientId, clientName, principalCents: operation.principalCents, interestRateBps: operation.interestRateBps,
      interestCents: operation.interestCents, totalCents: operation.totalCents, loanDate: operation.loanDate, dueDate: operation.dueDate,
      status: operation.status, settledAt: operation.settledAt, calculationRule: operation.calculationRule, createdAt: operation.createdAt.toISOString(),
    })),
    payments: data.paymentRows.map(({ payment, clientName }) => ({
      id: payment.id, operationId: payment.operationId, clientName, amountCents: payment.amountCents, paidAt: payment.paidAt, notes: payment.notes, createdAt: payment.createdAt.toISOString(),
    })),
  });
  const operationCountByClient = new Map<string, number>();
  for (const operation of portfolio.operations) operationCountByClient.set(operation.clientId, (operationCountByClient.get(operation.clientId) ?? 0) + 1);

  return {
    ...portfolio,
    today: todayIso(),
    clients: clientList.map((client) => ({ ...client, operationCount: operationCountByClient.get(client.id) ?? 0 })),
    payments: portfolio.charges.Histórico,
  };
}

export type TenantPortfolio = Awaited<ReturnType<typeof loadTenantPortfolio>>;
