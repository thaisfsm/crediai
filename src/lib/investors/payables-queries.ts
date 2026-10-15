import "server-only";
import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import { withTenantContext, type TenantTransaction } from "@/lib/auth/guards";
import { capitalMovements, investmentCapitalEntries, investmentPayments, investmentPriorContributions, investmentScheduleItems, investments, investors, users, wallets } from "@/lib/db/schema";
import { cycleStartedOn, tenantCapital } from "@/lib/finance/finance-queries";
import { todayIso } from "@/lib/finance/format";
import {
  buildObligations, filterObligations, parsePayablesFilters, payablesSections, payablesTotals,
  type ObligationKind, type PayableInvestment, type PayablePayment, type PaymentMethod,
} from "./payables";

type Search = { q?: string; de?: string; ate?: string; situacao?: string; tipo?: string };

// Baixas do tenant (todas ou de um contrato), com o nome de quem registrou. Usuários não têm RLS: o filtro é explícito
// (mesmo tenant ou o MASTER).
export async function loadPayments(tx: TenantTransaction, tenantId: string, investmentId?: string): Promise<PayablePayment[]> {
  const rows = await tx.select({ payment: investmentPayments, createdBy: users.name }).from(investmentPayments)
    .leftJoin(users, and(eq(users.id, investmentPayments.createdByUserId), or(eq(users.tenantId, tenantId), eq(users.role, "SUPER_ADMIN"))))
    .where(and(eq(investmentPayments.tenantId, tenantId), investmentId ? eq(investmentPayments.investmentId, investmentId) : undefined))
    .orderBy(asc(investmentPayments.paidOn), asc(investmentPayments.createdAt));
  return rows.map(({ payment, createdBy }) => ({
    id: payment.id, scheduleItemId: payment.scheduleItemId, kind: payment.kind as ObligationKind, amountCents: payment.amountCents, paidOn: payment.paidOn,
    method: payment.method as PaymentMethod, reference: payment.reference, notes: payment.notes, createdAt: payment.createdAt.toISOString(), createdBy: createdBy ?? null,
    capitalMovementId: payment.capitalMovementId,
  }));
}

// Contratos do tenant que já têm a entrada registrada ou o aporte anterior indicado (e esse aporte não foi estornado).
export async function loadEntryEvidence(tx: TenantTransaction, tenantId: string, investmentId?: string) {
  const entries = await tx.select({ investmentId: investmentCapitalEntries.investmentId }).from(investmentCapitalEntries)
    .where(and(eq(investmentCapitalEntries.tenantId, tenantId), investmentId ? eq(investmentCapitalEntries.investmentId, investmentId) : undefined));
  const priors = await tx.select({ investmentId: investmentPriorContributions.investmentId, movementId: investmentPriorContributions.capitalMovementId }).from(investmentPriorContributions)
    .where(and(eq(investmentPriorContributions.tenantId, tenantId), investmentId ? eq(investmentPriorContributions.investmentId, investmentId) : undefined));
  const reversed = priors.length ? new Set((await tx.select({ id: capitalMovements.reversedMovementId }).from(capitalMovements)
    .where(and(eq(capitalMovements.tenantId, tenantId), inArray(capitalMovements.reversedMovementId, priors.map((prior) => prior.movementId))))).map((row) => row.id)) : new Set();
  return { entries: new Set(entries.map((row) => row.investmentId)), priors: new Set(priors.filter((prior) => !reversed.has(prior.movementId)).map((prior) => prior.investmentId)) };
}

// Obrigações de todos os contratos da carteira da sessão. Só a carteira da sessão: o MASTER vê aqui a própria carteira,
// nunca a de outro tenant (as contas a pagar mexem no capital, que é de cada carteira).
export async function loadTenantObligations(tx: TenantTransaction, tenantId: string, today: string) {
  const investmentRows = await tx.select({
    id: investments.id, investorId: investments.investorId, investorName: investors.name, contractNumber: investments.contractNumber, status: investments.status,
    startDate: investments.startDate, amountCents: investments.amountCents, capitalEntryRule: investments.capitalEntryRule,
  }).from(investments).innerJoin(investors, and(eq(investors.id, investments.investorId), eq(investors.tenantId, investments.tenantId)))
    .where(eq(investments.tenantId, tenantId));
  const evidence = await loadEntryEvidence(tx, tenantId);
  const items = await tx.select({
    id: investmentScheduleItems.id, investmentId: investmentScheduleItems.investmentId, number: investmentScheduleItems.number, dueDate: investmentScheduleItems.dueDate,
    yieldCents: investmentScheduleItems.yieldCents, principalCents: investmentScheduleItems.principalCents, description: investmentScheduleItems.description,
  }).from(investmentScheduleItems).where(eq(investmentScheduleItems.tenantId, tenantId));
  const payments = await loadPayments(tx, tenantId);
  const withEvidence = investmentRows.map((row) => ({ ...row, hasEntry: evidence.entries.has(row.id), hasPriorContribution: evidence.priors.has(row.id) }));
  return buildObligations({ investments: withEvidence as PayableInvestment[], items, payments, today });
}

// Página /contas-a-pagar: withTenantContext (tenant ativo, assinatura válida, só a carteira da sessão).
export async function loadPayablesPage(search: Search) {
  return withTenantContext(async (tx, { tenantId }) => {
    const today = todayIso();
    const wallet = await tx.query.wallets.findFirst({ where: eq(wallets.tenantId, tenantId) });
    const portfolio = await tenantCapital(tx, tenantId);
    const filters = parsePayablesFilters(search);
    const all = await loadTenantObligations(tx, tenantId, today);
    const visible = filterObligations(all, filters);
    return {
      today, hasWallet: Boolean(wallet), cycleStartedOn: cycleStartedOn(wallet), availableCents: portfolio.summary.availableCents,
      filters, totalCount: all.length, matched: visible.length, sections: payablesSections(visible, today), totals: payablesTotals(visible, filters, today),
    };
  });
}
export type PayablesPageData = Awaited<ReturnType<typeof loadPayablesPage>>;

// Entrada no capital e baixas de UM contrato, para a página do investimento. A entrada só pode ser registrada pela
// própria carteira do contrato (canRegister): o MASTER olhando o contrato de outro tenant vê, mas não mexe no capital dele.
export async function loadInvestmentCash(tx: TenantTransaction, investment: { id: string; tenantId: string; capitalEntryRule: string | null }, sessionTenantId: string | null) {
  const [entry] = await tx.select({ entry: investmentCapitalEntries, createdBy: users.name }).from(investmentCapitalEntries)
    .leftJoin(users, and(eq(users.id, investmentCapitalEntries.createdByUserId), or(eq(users.tenantId, investment.tenantId), eq(users.role, "SUPER_ADMIN"))))
    .where(and(eq(investmentCapitalEntries.investmentId, investment.id), eq(investmentCapitalEntries.tenantId, investment.tenantId)));
  const payments = await loadPayments(tx, investment.tenantId, investment.id);
  const [wallet] = await tx.select({ cycleStartedAt: wallets.cycleStartedAt, createdAt: wallets.createdAt, cycleNumber: wallets.cycleNumber }).from(wallets).where(eq(wallets.tenantId, investment.tenantId));
  const [prior] = await tx.select({ prior: investmentPriorContributions, movement: capitalMovements, createdBy: users.name }).from(investmentPriorContributions)
    .innerJoin(capitalMovements, and(eq(capitalMovements.id, investmentPriorContributions.capitalMovementId), eq(capitalMovements.tenantId, investmentPriorContributions.tenantId)))
    .leftJoin(users, and(eq(users.id, investmentPriorContributions.createdByUserId), or(eq(users.tenantId, investment.tenantId), eq(users.role, "SUPER_ADMIN"))))
    .where(and(eq(investmentPriorContributions.investmentId, investment.id), eq(investmentPriorContributions.tenantId, investment.tenantId)));
  const ownWallet = sessionTenantId === investment.tenantId;
  const legacy = investment.capitalEntryRule === null;
  // Aportes que podem ser indicados (só para contrato antigo da própria carteira, sem entrada nem aporte indicado).
  const candidates = ownWallet && legacy && !entry && !prior ? await priorContributionCandidates(tx, investment.tenantId, wallet?.cycleNumber ?? null) : [];
  return {
    ownWallet,
    legacy,
    prior: prior ? {
      movementId: prior.movement.id, amountCents: prior.movement.amountCents, occurredAt: prior.movement.occurredAt, description: prior.movement.description,
      createdAt: prior.prior.createdAt.toISOString(), createdBy: prior.createdBy ?? null,
    } : null,
    candidates,
    hasWallet: Boolean(wallet),
    cycleStartedOn: cycleStartedOn(wallet),
    entry: entry ? { amountCents: entry.entry.amountCents, enteredOn: entry.entry.enteredOn, createdAt: entry.entry.createdAt.toISOString(), createdBy: entry.createdBy ?? null } : null,
    payments,
  };
}

// Aportes comuns da carteira que podem ser indicados como a entrada do dinheiro de um contrato antigo: CONTRIBUTION que
// não é de investidor, não estornado, do ciclo atual (o mesmo critério do estorno de aporte). Os mais recentes primeiro.
export async function priorContributionCandidates(tx: TenantTransaction, tenantId: string, cycleNumber: number | null) {
  if (cycleNumber === null) return [];
  const rows = await tx.select({ id: capitalMovements.id, occurredAt: capitalMovements.occurredAt, amountCents: capitalMovements.amountCents, description: capitalMovements.description, source: capitalMovements.source })
    .from(capitalMovements).where(and(eq(capitalMovements.tenantId, tenantId), eq(capitalMovements.kind, "CONTRIBUTION"), eq(capitalMovements.cycleNumber, cycleNumber)))
    .orderBy(desc(capitalMovements.occurredAt), desc(capitalMovements.createdAt));
  const reversed = new Set((await tx.select({ id: capitalMovements.reversedMovementId }).from(capitalMovements)
    .where(and(eq(capitalMovements.tenantId, tenantId), eq(capitalMovements.kind, "CONTRIBUTION_REVERSAL")))).map((row) => row.id));
  return rows.filter((row) => row.source !== "INVESTOR" && !reversed.has(row.id))
    .map(({ id, occurredAt, amountCents, description }) => ({ id, occurredAt, amountCents, description }));
}
