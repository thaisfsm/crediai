import "server-only";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { withManagerContext, withTenantContext } from "@/lib/auth/guards";
import { accountManagers, capitalMovements, clientDocuments, clients, creditPolicies, creditProposalDocuments, creditProposalReviews, creditProposals, proposalLinks, operationRequests, investmentPriorContributions, loanOperationRevisions, installmentDeferrals, loanOperations, loanRenewals, paymentRevisions, payments, users, walletCycles, wallets } from "@/lib/db/schema";
import { bankKeys } from "../bank-account";
import { clientProfileKeys, type ClientProfile } from "./client-profile";
import { todayIso } from "./format";
import { buildPortfolio, summarizeOperations, type ClientRecord, type DeferralRecord, type OperationCorrection, type PaymentRevisionRecord, type RenewalRecord } from "./portfolio";
import { toMovementRecord, toOperationRecord, toDeferralRecord, toPaymentRecord, toRenewalRecord } from "./summaries";

// Todas as consultas rodam no contexto do tenant da sessão (RLS) e também filtram por tenant_id,
// para que o isolamento não dependa só do papel de banco usado em produção.
// scope: carteira inteira do tenant (null) ou só os clientes indicados por UM gerente de contas (todos os ciclos, sem capital: o gerente
// não vê o caixa do dono). Toda consulta filtra tenant_id e, no escopo do gerente, os clientes dele.
export type PortfolioScope = { managerId: string } | null;
type PortfolioTx = Parameters<Parameters<typeof withTenantContext>[0]>[0];

async function readPortfolioData(tx: PortfolioTx, tenantId: string, scope: PortfolioScope) {
    const wallet = scope ? undefined : await tx.query.wallets.findFirst({ where: eq(wallets.tenantId, tenantId) });
    const scopedClients = scope ? (await tx.select({ id: clients.id }).from(clients).where(and(eq(clients.tenantId, tenantId), eq(clients.accountManagerId, scope.managerId)))).map((row) => row.id) : null;
    // Ciclo atual (carteira inteira) ou todos os ciclos dos clientes do gerente.
    const cycleOf = (column: typeof loanOperations.cycleNumber) => (scope ? undefined : eq(column, cycleNumber));
    const clientIn = (column: typeof loanOperations.clientId) => (scopedClients ? inArray(column, scopedClients.length ? scopedClients : ["-"]) : undefined);
    // Só o ciclo atual entra nos cálculos; os pagamentos seguem o ciclo da operação.
    const cycleNumber = wallet?.cycleNumber ?? 1;
    const movementRows = scope ? [] : await tx.select().from(capitalMovements).where(and(eq(capitalMovements.tenantId, tenantId), eq(capitalMovements.cycleNumber, cycleNumber))).orderBy(asc(capitalMovements.occurredAt), asc(capitalMovements.createdAt));
    // Aportes indicados como a entrada do dinheiro de um contrato antigo de investidor (migração 0023): não se estornam.
    const investorLinkedRows = scope ? [] : await tx.select({ id: investmentPriorContributions.capitalMovementId }).from(investmentPriorContributions).where(eq(investmentPriorContributions.tenantId, tenantId));
    const clientRows = await tx.select().from(clients).where(and(eq(clients.tenantId, tenantId), scope ? eq(clients.accountManagerId, scope.managerId) : undefined)).orderBy(asc(clients.name));
    const operationRows = await tx.select({ operation: loanOperations, clientName: clients.name })
      .from(loanOperations)
      .innerJoin(clients, eq(clients.id, loanOperations.clientId))
      .where(and(eq(loanOperations.tenantId, tenantId), cycleOf(loanOperations.cycleNumber), clientIn(loanOperations.clientId)))
      .orderBy(desc(loanOperations.loanDate), desc(loanOperations.createdAt));
    const paymentRows = await tx.select({ payment: payments, clientName: clients.name })
      .from(payments)
      .innerJoin(loanOperations, eq(loanOperations.id, payments.operationId))
      .innerJoin(clients, eq(clients.id, loanOperations.clientId))
      .where(and(eq(payments.tenantId, tenantId), cycleOf(loanOperations.cycleNumber), clientIn(loanOperations.clientId)))
      .orderBy(desc(payments.paidAt), desc(payments.createdAt));
    // Quem fez a correção: usuário do mesmo tenant (a tabela de usuários não tem RLS, por isso o filtro explícito).
    const revisionRows = await tx.select({ payment_revision: paymentRevisions, editorName: users.name }).from(paymentRevisions)
      .innerJoin(payments, eq(payments.id, paymentRevisions.paymentId))
      .leftJoin(users, and(eq(users.id, paymentRevisions.editedByUserId), eq(users.tenantId, tenantId)))
      .innerJoin(loanOperations, eq(loanOperations.id, payments.operationId))
      .where(and(eq(paymentRevisions.tenantId, tenantId), cycleOf(loanOperations.cycleNumber), clientIn(loanOperations.clientId)))
      .orderBy(asc(paymentRevisions.editedAt));
    const renewalRows = await tx.select({ renewal: loanRenewals }).from(loanRenewals)
      .innerJoin(loanOperations, eq(loanOperations.id, loanRenewals.operationId))
      .where(and(eq(loanRenewals.tenantId, tenantId), cycleOf(loanOperations.cycleNumber), clientIn(loanOperations.clientId)))
      .orderBy(asc(loanRenewals.periodNumber));
    const deferralRows = await tx.select({ deferral: installmentDeferrals }).from(installmentDeferrals)
      .innerJoin(loanOperations, eq(loanOperations.id, installmentDeferrals.operationId))
      .where(and(eq(installmentDeferrals.tenantId, tenantId), cycleOf(loanOperations.cycleNumber), clientIn(loanOperations.clientId)))
      .orderBy(asc(installmentDeferrals.createdAt));
    // Correções de operação (Etapa G): motivo, campos alterados e quem corrigiu (usuário do mesmo tenant).
    const correctionRows = await tx.select({ revision: loanOperationRevisions, editorName: users.name }).from(loanOperationRevisions)
      .innerJoin(loanOperations, eq(loanOperations.id, loanOperationRevisions.operationId))
      .leftJoin(users, and(eq(users.id, loanOperationRevisions.editedByUserId), eq(users.tenantId, tenantId)))
      .where(and(eq(loanOperationRevisions.tenantId, tenantId), cycleOf(loanOperations.cycleNumber), clientIn(loanOperations.clientId)))
      .orderBy(asc(loanOperationRevisions.createdAt));
    // Documentos: só os dados do arquivo; o conteúdo é baixado sob demanda pela rota de download.
    const documentRows = scope ? [] : await tx.select({
      id: clientDocuments.id, clientId: clientDocuments.clientId, label: clientDocuments.label, fileName: clientDocuments.fileName,
      contentType: clientDocuments.contentType, sizeBytes: clientDocuments.sizeBytes, createdAt: clientDocuments.createdAt,
    }).from(clientDocuments).where(eq(clientDocuments.tenantId, tenantId)).orderBy(asc(clientDocuments.createdAt));
    // Clientes com operações em qualquer ciclo têm histórico: são arquivados, nunca apagados.
    const historyRows = await tx.select({ clientId: loanOperations.clientId }).from(loanOperations).where(and(eq(loanOperations.tenantId, tenantId), clientIn(loanOperations.clientId)));
    // Ciclos encerrados, com a contagem do que ficou guardado em cada um.
    const closedCycles = scope ? [] : await tx.select({
      cycleNumber: walletCycles.cycleNumber, initialCapitalCents: walletCycles.initialCapitalCents, startedAt: walletCycles.startedAt, closedAt: walletCycles.closedAt,
      // Nomes qualificados à mão: dentro de sql`` o Drizzle não qualifica colunas de outras tabelas.
      operationCount: sql<string>`(select count(*) from loan_operation o where o.tenant_id = wallet_cycle.tenant_id and o.cycle_number = wallet_cycle.cycle_number and o.status <> 'CANCELED')`,
      paymentCount: sql<string>`(select count(*) from payment p join loan_operation o on o.id = p.operation_id where p.tenant_id = wallet_cycle.tenant_id and o.cycle_number = wallet_cycle.cycle_number)`,
      receivedCents: sql<string>`(select coalesce(sum(p.amount_cents), 0) from payment p join loan_operation o on o.id = p.operation_id where p.tenant_id = wallet_cycle.tenant_id and o.cycle_number = wallet_cycle.cycle_number)`,
    }).from(walletCycles).where(eq(walletCycles.tenantId, tenantId)).orderBy(desc(walletCycles.cycleNumber));
    // Pedidos de operação dos gerentes de contas (aguardando e decididos): o dono vê todos; a gerente, só os dela.
    const requestRows = await tx.select({
      id: operationRequests.id, managerName: accountManagers.name, clientId: operationRequests.clientId, clientName: clients.name, principalCents: operationRequests.principalCents,
      totalCents: operationRequests.totalCents, loanDate: operationRequests.loanDate, form: operationRequests.form, status: operationRequests.status, decisionNote: operationRequests.decisionNote,
      createdAt: operationRequests.createdAt, decidedAt: operationRequests.decidedAt, pixPaidOn: operationRequests.pixPaidOn,
    }).from(operationRequests)
      .innerJoin(accountManagers, and(eq(accountManagers.id, operationRequests.managerId), eq(accountManagers.tenantId, operationRequests.tenantId)))
      .innerJoin(clients, and(eq(clients.id, operationRequests.clientId), eq(clients.tenantId, operationRequests.tenantId)))
      .where(and(eq(operationRequests.tenantId, tenantId), scope ? eq(operationRequests.managerId, scope.managerId) : undefined))
      .orderBy(desc(operationRequests.createdAt)).limit(60);
    const [policyRow] = scope ? [] : await tx.select().from(creditPolicies).where(eq(creditPolicies.tenantId, tenantId));
    const proposalRows = scope ? [] : await tx.select().from(creditProposals).where(and(eq(creditProposals.tenantId, tenantId), ne(creditProposals.status, "DRAFT"))).orderBy(desc(creditProposals.createdAt)).limit(300);
    const proposalDocumentRows = scope || proposalRows.length === 0 ? [] : await tx.select({ id: creditProposalDocuments.id, proposalId: creditProposalDocuments.proposalId, kind: creditProposalDocuments.kind, fileName: creditProposalDocuments.fileName })
      .from(creditProposalDocuments).where(and(eq(creditProposalDocuments.tenantId, tenantId), inArray(creditProposalDocuments.proposalId, proposalRows.map((row) => row.id))));
    const proposalReviewRows = scope || proposalRows.length === 0 ? [] : await tx.select().from(creditProposalReviews)
      .where(and(eq(creditProposalReviews.tenantId, tenantId), inArray(creditProposalReviews.proposalId, proposalRows.map((row) => row.id))));
    const [linkRow] = scope ? [] : await tx.select({ token: proposalLinks.token, enabled: proposalLinks.enabled }).from(proposalLinks).where(eq(proposalLinks.tenantId, tenantId));
    return { wallet, cycleNumber, policyRow, proposalRows, proposalDocumentRows, proposalReviewRows, linkRow, requestRows, movementRows, investorLinkedRows, clientRows, operationRows, paymentRows, revisionRows, renewalRows, deferralRows, correctionRows, documentRows, historyRows, closedCycles };
}

export async function loadTenantPortfolio() {
  const data = await withTenantContext((tx, { tenantId }) => readPortfolioData(tx, tenantId, null));
  return assemblePortfolio(data, false);
}

// Carteira só dos clientes de um gerente de contas (mesmas telas e contas do dono, sem capital, sem cadastro bancário, notas nem documentos).
export async function loadManagerPortfolio() {
  const { data, managerName } = await withManagerContext(async (tx, { tenantId, manager }) => ({ data: await readPortfolioData(tx, tenantId, { managerId: manager.id }), managerName: manager.name }));
  return { portfolio: assemblePortfolio(data, true), managerName };
}

type PortfolioData = Awaited<ReturnType<typeof readPortfolioData>>;

function assemblePortfolio(data: PortfolioData, scoped: boolean) {

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
  const deferralsByOperation = new Map<string, DeferralRecord[]>();
  for (const { deferral } of data.deferralRows) {
    deferralsByOperation.set(deferral.operationId, [...(deferralsByOperation.get(deferral.operationId) ?? []), toDeferralRecord(deferral)]);
  }
  const correctionsByOperation = new Map<string, OperationCorrection[]>();
  for (const { revision, editorName } of data.correctionRows) {
    correctionsByOperation.set(revision.operationId, [...(correctionsByOperation.get(revision.operationId) ?? []), {
      id: revision.id, reason: revision.reason, changes: revision.changes, editedAt: revision.createdAt.toISOString(), editedBy: editorName ?? null,
    }]);
  }
  const documentsByClient = new Map<string, ClientDocumentInfo[]>();
  for (const document of data.documentRows) {
    documentsByClient.set(document.clientId, [...(documentsByClient.get(document.clientId) ?? []), { ...document, createdAt: document.createdAt.toISOString() }]);
  }
  const clientList: ClientRecord[] = data.clientRows.map((client) => ({
    id: client.id, name: client.name, document: client.document, phone: client.phone, notes: scoped ? null : client.notes, onlineCasinoBettor: scoped ? false : client.onlineCasinoBettor, archivedAt: client.archivedAt?.toISOString() ?? null, createdAt: client.createdAt.toISOString(),
    ...(Object.fromEntries(clientProfileKeys.map((key) => [key, scoped && (bankKeys as readonly string[]).includes(key) ? null : client[key]])) as ClientProfile),
  }));
  const portfolio = buildPortfolio({
    hasWallet: scoped || Boolean(data.wallet),
    initialCapitalCents: data.wallet?.initialCapitalCents ?? 0,
    walletCreatedOn: data.wallet ? todayIso(data.wallet.cycleStartedAt ?? data.wallet.createdAt) : null,
    cycleNumber: data.cycleNumber,
    capitalMovements: data.movementRows.map(toMovementRecord),
    today: todayIso(),
    operations: data.operationRows.map(({ operation, clientName }) => ({ ...toOperationRecord(operation, clientName, renewalsByOperation.get(operation.id) ?? [], deferralsByOperation.get(operation.id) ?? []), corrections: correctionsByOperation.get(operation.id) ?? [] })),
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
    investorLinkedContributionIds: data.investorLinkedRows.map((row) => row.id),
    proposals: data.proposalRows.map((row) => ({
      id: row.id, applicantName: row.applicantName, cpf: row.cpf, email: row.email, phone: row.phone, requestedCents: row.requestedCents,
      termMonths: row.termMonths, phase: row.phase, status: row.status, decisionNote: row.decisionNote,
      createdAt: row.createdAt.toISOString(), phaseChangedAt: row.phaseChangedAt.toISOString(),
      reviews: data.proposalReviewRows.filter((review) => review.proposalId === row.id).map((review) => ({ phase: review.phase, checks: review.checks, note: review.note, completed: review.completed })),
      source: row.source, monthlyIncomeCents: row.monthlyIncomeCents, documents: data.proposalDocumentRows.filter((doc) => doc.proposalId === row.id).map((doc) => ({ id: doc.id, kind: doc.kind, fileName: doc.fileName })),
    })),
    proposalLink: data.linkRow?.enabled ? data.linkRow.token : null,
    creditPolicy: {
      maxExposurePerCpfCents: data.policyRow?.maxExposurePerCpfCents ?? null, maxTermMonths: data.policyRow?.maxTermMonths ?? null,
      maxContractCents: data.policyRow?.maxContractCents ?? null, minRateBps: data.policyRow?.minRateBps ?? null,
    },
    operationRequests: data.requestRows.map((row): OperationRequestView => ({
      id: row.id, managerName: row.managerName, clientId: row.clientId, clientName: row.clientName, principalCents: row.principalCents, totalCents: row.totalCents, loanDate: row.loanDate,
      modality: row.form.modality === "INSTALLMENT" ? "Parcelado" : "Pagamento único", status: row.status as OperationRequestView["status"], decisionNote: row.decisionNote,
      createdAt: row.createdAt.toISOString(), decidedAt: row.decidedAt?.toISOString() ?? null, pixPaidOn: row.pixPaidOn,
    })),
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

// Relatório com TODOS os ciclos (Etapa E, D-E1): operações, pagamentos e renovações de todos os ciclos da carteira, com
// as mesmas contas do extrato. Só leitura; ciclos encerrados não mudam. Operações excluídas ficam de fora do relatório.
export async function loadAllCyclesOperations() {
  const data = await withTenantContext(async (tx, { tenantId }) => {
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
    const renewalRows = await tx.select({ renewal: loanRenewals }).from(loanRenewals)
      .where(eq(loanRenewals.tenantId, tenantId))
      .orderBy(asc(loanRenewals.periodNumber));
    const deferralRows = await tx.select({ deferral: installmentDeferrals }).from(installmentDeferrals)
      .where(eq(installmentDeferrals.tenantId, tenantId))
      .orderBy(asc(installmentDeferrals.createdAt));
    return { operationRows, paymentRows, renewalRows, deferralRows };
  });
  const renewalsByOperation = new Map<string, RenewalRecord[]>();
  for (const { renewal } of data.renewalRows) {
    renewalsByOperation.set(renewal.operationId, [...(renewalsByOperation.get(renewal.operationId) ?? []), toRenewalRecord(renewal)]);
  }
  const deferralsByOperation = new Map<string, DeferralRecord[]>();
  for (const { deferral } of data.deferralRows) {
    deferralsByOperation.set(deferral.operationId, [...(deferralsByOperation.get(deferral.operationId) ?? []), toDeferralRecord(deferral)]);
  }
  const { operations } = buildPortfolio({
    hasWallet: true, initialCapitalCents: 0, today: todayIso(),
    operations: data.operationRows.map(({ operation, clientName }) => ({ ...toOperationRecord(operation, clientName, renewalsByOperation.get(operation.id) ?? [], deferralsByOperation.get(operation.id) ?? []), cycleNumber: operation.cycleNumber })),
    payments: data.paymentRows.map(({ payment, clientName }) => toPaymentRecord(payment, clientName)),
  });
  return operations;
}

export type OperationRequestView = {
  id: string; managerName: string; clientId: string; clientName: string; principalCents: number; totalCents: number; loanDate: string; modality: string;
  status: "PENDING" | "APPROVED" | "REJECTED"; decisionNote: string | null; createdAt: string; decidedAt: string | null; pixPaidOn: string | null;
};

export type ClientDocumentInfo = { id: string; clientId: string; label: string; fileName: string; contentType: string; sizeBytes: number; createdAt: string };

export type TenantPortfolio = Awaited<ReturnType<typeof loadTenantPortfolio>>;
