import "server-only";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { withTenantContext } from "@/lib/auth/guards";
import { capitalMovements, clientDocuments, clients, loanOperations, loanRenewals, paymentRevisions, payments, users, walletCycles, wallets } from "@/lib/db/schema";
import { clientProfileKeys, type ClientProfile } from "./client-profile";
import { todayIso } from "./format";
import { buildPortfolio, summarizeOperations, type ClientRecord, type PaymentRevisionRecord, type RenewalRecord } from "./portfolio";
import { toMovementRecord, toOperationRecord, toPaymentRecord, toRenewalRecord } from "./summaries";

// Todas as consultas rodam no contexto do tenant da sessão (RLS) e também filtram por tenant_id,
// para que o isolamento não dependa só do papel de banco usado em produção.
export async function loadTenantPortfolio() {
  const data = await withTenantContext(async (tx, { tenantId }) => {
    const wallet = await tx.query.wallets.findFirst({ where: eq(wallets.tenantId, tenantId) });
    // Só o ciclo atual entra nos cálculos; os pagamentos seguem o ciclo da operação.
    const cycleNumber = wallet?.cycleNumber ?? 1;
    const movementRows = await tx.select().from(capitalMovements).where(and(eq(capitalMovements.tenantId, tenantId), eq(capitalMovements.cycleNumber, cycleNumber))).orderBy(asc(capitalMovements.occurredAt), asc(capitalMovements.createdAt));
    const clientRows = await tx.select().from(clients).where(eq(clients.tenantId, tenantId)).orderBy(asc(clients.name));
    const operationRows = await tx.select({ operation: loanOperations, clientName: clients.name })
      .from(loanOperations)
      .innerJoin(clients, eq(clients.id, loanOperations.clientId))
      .where(and(eq(loanOperations.tenantId, tenantId), eq(loanOperations.cycleNumber, cycleNumber)))
      .orderBy(desc(loanOperations.loanDate), desc(loanOperations.createdAt));
    const paymentRows = await tx.select({ payment: payments, clientName: clients.name })
      .from(payments)
      .innerJoin(loanOperations, eq(loanOperations.id, payments.operationId))
      .innerJoin(clients, eq(clients.id, loanOperations.clientId))
      .where(and(eq(payments.tenantId, tenantId), eq(loanOperations.cycleNumber, cycleNumber)))
      .orderBy(desc(payments.paidAt), desc(payments.createdAt));
    // Quem fez a correção: usuário do mesmo tenant (a tabela de usuários não tem RLS, por isso o filtro explícito).
    const revisionRows = await tx.select({ payment_revision: paymentRevisions, editorName: users.name }).from(paymentRevisions)
      .innerJoin(payments, eq(payments.id, paymentRevisions.paymentId))
      .leftJoin(users, and(eq(users.id, paymentRevisions.editedByUserId), eq(users.tenantId, tenantId)))
      .innerJoin(loanOperations, eq(loanOperations.id, payments.operationId))
      .where(and(eq(paymentRevisions.tenantId, tenantId), eq(loanOperations.cycleNumber, cycleNumber)))
      .orderBy(asc(paymentRevisions.editedAt));
    const renewalRows = await tx.select({ renewal: loanRenewals }).from(loanRenewals)
      .innerJoin(loanOperations, eq(loanOperations.id, loanRenewals.operationId))
      .where(and(eq(loanRenewals.tenantId, tenantId), eq(loanOperations.cycleNumber, cycleNumber)))
      .orderBy(asc(loanRenewals.periodNumber));
    // Documentos: só os dados do arquivo; o conteúdo é baixado sob demanda pela rota de download.
    const documentRows = await tx.select({
      id: clientDocuments.id, clientId: clientDocuments.clientId, label: clientDocuments.label, fileName: clientDocuments.fileName,
      contentType: clientDocuments.contentType, sizeBytes: clientDocuments.sizeBytes, createdAt: clientDocuments.createdAt,
    }).from(clientDocuments).where(eq(clientDocuments.tenantId, tenantId)).orderBy(asc(clientDocuments.createdAt));
    // Clientes com operações em qualquer ciclo têm histórico: são arquivados, nunca apagados.
    const historyRows = await tx.select({ clientId: loanOperations.clientId }).from(loanOperations).where(eq(loanOperations.tenantId, tenantId));
    // Ciclos encerrados, com a contagem do que ficou guardado em cada um.
    const closedCycles = await tx.select({
      cycleNumber: walletCycles.cycleNumber, initialCapitalCents: walletCycles.initialCapitalCents, startedAt: walletCycles.startedAt, closedAt: walletCycles.closedAt,
      // Nomes qualificados à mão: dentro de sql`` o Drizzle não qualifica colunas de outras tabelas.
      operationCount: sql<string>`(select count(*) from loan_operation o where o.tenant_id = wallet_cycle.tenant_id and o.cycle_number = wallet_cycle.cycle_number and o.status <> 'CANCELED')`,
      paymentCount: sql<string>`(select count(*) from payment p join loan_operation o on o.id = p.operation_id where p.tenant_id = wallet_cycle.tenant_id and o.cycle_number = wallet_cycle.cycle_number)`,
      receivedCents: sql<string>`(select coalesce(sum(p.amount_cents), 0) from payment p join loan_operation o on o.id = p.operation_id where p.tenant_id = wallet_cycle.tenant_id and o.cycle_number = wallet_cycle.cycle_number)`,
    }).from(walletCycles).where(eq(walletCycles.tenantId, tenantId)).orderBy(desc(walletCycles.cycleNumber));
    return { wallet, cycleNumber, movementRows, clientRows, operationRows, paymentRows, revisionRows, renewalRows, documentRows, historyRows, closedCycles };
  });

  const revisionsByPayment = new Map<string, PaymentRevisionRecord[]>();
  for (const { payment_revision: revision, editorName } of data.revisionRows) {
    revisionsByPayment.set(revision.paymentId, [...(revisionsByPayment.get(revision.paymentId) ?? []), {
      id: revision.id, previousAmountCents: revision.previousAmountCents, previousPaidAt: revision.previousPaidAt, amountCents: revision.amountCents, paidAt: revision.paidAt, editedAt: revision.editedAt.toISOString(),
      editedBy: editorName ?? null,
    }]);
  }
  const renewalsByOperation = new Map<string, RenewalRecord[]>();
  for (const { renewal } of data.renewalRows) {
    renewalsByOperation.set(renewal.operationId, [...(renewalsByOperation.get(renewal.operationId) ?? []), toRenewalRecord(renewal)]);
  }
  const documentsByClient = new Map<string, ClientDocumentInfo[]>();
  for (const document of data.documentRows) {
    documentsByClient.set(document.clientId, [...(documentsByClient.get(document.clientId) ?? []), { ...document, createdAt: document.createdAt.toISOString() }]);
  }
  const clientList: ClientRecord[] = data.clientRows.map((client) => ({
    id: client.id, name: client.name, document: client.document, phone: client.phone, notes: client.notes, archivedAt: client.archivedAt?.toISOString() ?? null, createdAt: client.createdAt.toISOString(),
    ...(Object.fromEntries(clientProfileKeys.map((key) => [key, client[key]])) as ClientProfile),
  }));
  const portfolio = buildPortfolio({
    hasWallet: Boolean(data.wallet),
    initialCapitalCents: data.wallet?.initialCapitalCents ?? 0,
    walletCreatedOn: data.wallet ? todayIso(data.wallet.cycleStartedAt ?? data.wallet.createdAt) : null,
    cycleNumber: data.cycleNumber,
    capitalMovements: data.movementRows.map(toMovementRecord),
    today: todayIso(),
    operations: data.operationRows.map(({ operation, clientName }) => toOperationRecord(operation, clientName, renewalsByOperation.get(operation.id) ?? [])),
    payments: data.paymentRows.map(({ payment, clientName }) => toPaymentRecord(payment, clientName, revisionsByPayment.get(payment.id) ?? [])),
  });
  // Contagens por cliente para a exclusão: operações visíveis, em aberto e qualquer histórico (inclusive excluídas).
  const countBy = (rows: { clientId: string }[]) => {
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.clientId, (counts.get(row.clientId) ?? 0) + 1);
    return counts;
  };
  const operationCountByClient = countBy(portfolio.operations);
  const openCountByClient = countBy(portfolio.operations.filter((operation) => operation.status === "OPEN"));
  const historyCountByClient = countBy(data.historyRows);

  return {
    ...portfolio,
    today: todayIso(),
    // Clientes arquivados ficam fora da lista e do cadastro de operação; o histórico das operações continua com o nome.
    clients: clientList.filter((client) => !client.archivedAt).map((client) => ({
      ...client,
      operationCount: operationCountByClient.get(client.id) ?? 0,
      openOperationCount: openCountByClient.get(client.id) ?? 0,
      hasHistory: (historyCountByClient.get(client.id) ?? 0) > 0,
      documents: documentsByClient.get(client.id) ?? [],
      // Rentabilidade do cliente no ciclo atual, calculada só com os pagamentos registrados.
      profile: summarizeOperations(portfolio.operations.filter((operation) => operation.clientId === client.id)),
    })),
    archivedClients: clientList.filter((client) => client.archivedAt),
    closedCycles: data.closedCycles.map((cycle) => ({
      cycleNumber: cycle.cycleNumber, initialCapitalCents: cycle.initialCapitalCents, startedOn: todayIso(cycle.startedAt), closedOn: todayIso(cycle.closedAt),
      operationCount: Number(cycle.operationCount), paymentCount: Number(cycle.paymentCount), receivedCents: Number(cycle.receivedCents),
    })),
    payments: portfolio.charges.Histórico,
  };
}

export type ClientDocumentInfo = { id: string; clientId: string; label: string; fileName: string; contentType: string; sizeBytes: number; createdAt: string };

export type TenantPortfolio = Awaited<ReturnType<typeof loadTenantPortfolio>>;
