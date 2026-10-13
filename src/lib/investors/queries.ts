import "server-only";
import { and, asc, count, desc, eq, gte, ilike, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { investmentContracts, investmentDocuments, investmentRevisions, investmentScheduleItems, investments, investors, tenants, users } from "@/lib/db/schema";
import { onlyDigits, todayIso } from "@/lib/finance/format";
import { tenantFilter, withInvestorContext, type InvestorScope } from "./access";
import { missingContractData } from "./contract";
import { contractDataHash, contractSource, contractorData, loadContractor } from "./contract-source";
import { INVESTORS_PAGE_SIZE, investorFilters, scheduleTotals, summarizeInvestments, type DocumentKind, type InvestmentStatus, type InvestorStatus, type PaymentFrequency, type RatePeriod } from "./rules";

type Search = { q?: string; status?: string; carteira?: string; pagina?: string };

// Carteiras que o MASTER pode escolher (filtro da lista e carteira de um novo investidor). Encerradas ficam de fora.
async function tenantOptions(tx: Parameters<Parameters<typeof withInvestorContext>[0]>[0], scope: InvestorScope) {
  if (!scope.isMaster) return [];
  return tx.select({ id: tenants.id, name: tenants.name }).from(tenants).where(ne(tenants.status, "CLOSED")).orderBy(asc(tenants.name));
}

// Lista de investidores com busca, filtros e páginas, e o painel do topo. Tudo no escopo da sessão.
export async function loadInvestorsPage(search: Search) {
  const filters = investorFilters(search);
  const today = todayIso();
  return withInvestorContext(async (tx, scope) => {
    const tenantsList = await tenantOptions(tx, scope);
    // O filtro de carteira só existe para o MASTER; para o usuário do tenant vale sempre a própria carteira.
    const carteira = scope.isMaster && tenantsList.some((tenant) => tenant.id === filters.carteira) ? filters.carteira : "";
    const scopeOn = (column: typeof investors.tenantId | typeof investments.tenantId) => and(tenantFilter(scope, column), carteira ? eq(column, carteira) : undefined);

    const conditions: (SQL | undefined)[] = [scopeOn(investors.tenantId)];
    if (filters.status) conditions.push(eq(investors.status, filters.status));
    if (filters.q) {
      const like = `%${filters.q.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
      const digits = onlyDigits(filters.q);
      conditions.push(or(
        ilike(investors.name, like), ilike(investors.email, like), ilike(investors.instagram, like), ilike(investors.facebook, like),
        ...(digits.length >= 3 ? [sql`${investors.document} like ${`%${digits}%`}`, sql`${investors.phone} like ${`%${digits}%`}`, sql`${investors.whatsapp} like ${`%${digits}%`}`] : []),
      ));
    }
    const where = and(...conditions);
    const [{ total }] = await tx.select({ total: count() }).from(investors).where(where);
    const pages = Math.max(Math.ceil(total / INVESTORS_PAGE_SIZE), 1);
    const page = Math.min(filters.page, pages);
    const rows = await tx.select({
      investor: investors,
      tenantName: tenants.name,
      // Nome qualificado à mão: dentro de sql`` o Drizzle não qualifica colunas de outras tabelas.
      investmentCount: sql<string>`(select count(*) from investment i where i.investor_id = investor.id and i.tenant_id = investor.tenant_id)`,
    }).from(investors).innerJoin(tenants, eq(tenants.id, investors.tenantId)).where(where)
      .orderBy(asc(investors.name), asc(investors.id)).limit(INVESTORS_PAGE_SIZE).offset((page - 1) * INVESTORS_PAGE_SIZE);

    const summaryRows = await tx.select({ status: investments.status, amountCents: investments.amountCents, maturityDate: investments.maturityDate })
      .from(investments).where(scopeOn(investments.tenantId));
    const upcoming = await tx.select({ id: investments.id, investorId: investors.id, investorName: investors.name, amountCents: investments.amountCents, maturityDate: investments.maturityDate })
      .from(investments).innerJoin(investors, and(eq(investors.id, investments.investorId), eq(investors.tenantId, investments.tenantId)))
      .where(and(scopeOn(investments.tenantId), eq(investments.status, "ACTIVE"), gte(investments.maturityDate, today)))
      .orderBy(asc(investments.maturityDate), asc(investments.id)).limit(5);

    return {
      isMaster: scope.isMaster,
      ownTenantId: scope.tenantId,
      today,
      tenants: tenantsList,
      filters: { q: filters.q, status: filters.status, carteira },
      summary: summarizeInvestments(summaryRows.map((row) => ({ ...row, status: row.status as InvestmentStatus })), today),
      upcoming: upcoming.map((row) => ({ ...row, maturityDate: row.maturityDate as string })),
      investors: rows.map(({ investor, tenantName, investmentCount }) => ({ ...toInvestorView(investor), tenantName, investmentCount: Number(investmentCount) })),
      matched: total,
      page,
      pages,
    };
  });
}

function toInvestorView(investor: typeof investors.$inferSelect) {
  return {
    id: investor.id, tenantId: investor.tenantId, name: investor.name, document: investor.document, phone: investor.phone, whatsapp: investor.whatsapp,
    email: investor.email, instagram: investor.instagram, facebook: investor.facebook, notes: investor.notes, status: investor.status as InvestorStatus,
    addressCep: investor.addressCep, addressStreet: investor.addressStreet, addressNumber: investor.addressNumber, addressComplement: investor.addressComplement,
    addressDistrict: investor.addressDistrict, addressCity: investor.addressCity, addressState: investor.addressState,
    bankHolderName: investor.bankHolderName, bankHolderDocument: investor.bankHolderDocument, bankName: investor.bankName, bankBranch: investor.bankBranch,
    bankAccount: investor.bankAccount, bankAccountType: investor.bankAccountType, pixKeyType: investor.pixKeyType, pixKey: investor.pixKey,
    createdAt: investor.createdAt.toISOString(), updatedAt: investor.updatedAt.toISOString(),
  };
}

function toInvestmentView(investment: typeof investments.$inferSelect) {
  return {
    id: investment.id, tenantId: investment.tenantId, investorId: investment.investorId, amountCents: investment.amountCents,
    agreedRateBps: investment.agreedRateBps, ratePeriod: investment.ratePeriod as RatePeriod, startDate: investment.startDate,
    maturityDate: investment.maturityDate, dueDay: investment.dueDay, notes: investment.notes, status: investment.status as InvestmentStatus,
    contractNumber: investment.contractNumber, investedOn: investment.investedOn, termMonths: investment.termMonths,
    paymentFrequency: investment.paymentFrequency as PaymentFrequency | null, installmentCount: investment.installmentCount,
    createdAt: investment.createdAt.toISOString(), updatedAt: investment.updatedAt.toISOString(),
  };
}

// Ficha do investidor com todos os contratos dele e quantos documentos cada um tem. null = não existe no escopo.
export async function loadInvestorDetail(investorId: string) {
  return withInvestorContext(async (tx, scope) => {
    const [row] = await tx.select({ investor: investors, tenantName: tenants.name }).from(investors).innerJoin(tenants, eq(tenants.id, investors.tenantId))
      .where(and(eq(investors.id, investorId), tenantFilter(scope, investors.tenantId)));
    if (!row) return null;
    const contractRows = await tx.select({
      investment: investments,
      documentCount: sql<string>`(select count(*) from investment_document d where d.investment_id = investment.id and d.tenant_id = investment.tenant_id and d.replaced_at is null)`,
      hasSignedContract: sql<boolean>`exists (select 1 from investment_document d where d.investment_id = investment.id and d.tenant_id = investment.tenant_id and d.kind = 'SIGNED_CONTRACT' and d.replaced_at is null)`,
    }).from(investments).where(and(eq(investments.investorId, row.investor.id), eq(investments.tenantId, row.investor.tenantId)))
      .orderBy(desc(investments.startDate), desc(investments.createdAt));
    // Documentos vigentes de todos os contratos do investidor (cada um continua ligado ao seu investimento).
    const documentRows = await tx.select({
      id: investmentDocuments.id, investmentId: investmentDocuments.investmentId, kind: investmentDocuments.kind, fileName: investmentDocuments.fileName,
      sizeBytes: investmentDocuments.sizeBytes, createdAt: investmentDocuments.createdAt,
    }).from(investmentDocuments).innerJoin(investments, and(eq(investments.id, investmentDocuments.investmentId), eq(investments.tenantId, investmentDocuments.tenantId)))
      .where(and(eq(investments.investorId, row.investor.id), eq(investmentDocuments.tenantId, row.investor.tenantId), isNull(investmentDocuments.replacedAt)))
      .orderBy(desc(investmentDocuments.createdAt), asc(investmentDocuments.id));
    return {
      documents: documentRows.map((document) => ({ ...document, kind: document.kind as DocumentKind, createdAt: document.createdAt.toISOString() })),
      isMaster: scope.isMaster,
      investor: { ...toInvestorView(row.investor), tenantName: row.tenantName },
      investments: contractRows.map(({ investment, documentCount, hasSignedContract }) => ({ ...toInvestmentView(investment), documentCount: Number(documentCount), hasSignedContract: Boolean(hasSignedContract) })),
    };
  });
}

// Contrato de investimento com o investidor, os documentos (vigentes e substituídos), as versões do contrato gerado e o
// que falta para gerar o contrato. Nada traz o conteúdo dos arquivos.
export async function loadInvestmentDetail(investmentId: string) {
  return withInvestorContext(async (tx, scope) => {
    const [row] = await tx.select({ investment: investments, investor: investors, tenantName: tenants.name }).from(investments)
      .innerJoin(investors, and(eq(investors.id, investments.investorId), eq(investors.tenantId, investments.tenantId)))
      .innerJoin(tenants, eq(tenants.id, investments.tenantId))
      .where(and(eq(investments.id, investmentId), tenantFilter(scope, investments.tenantId)));
    if (!row) return null;
    const scopeOfInvestment = (tenantColumn: typeof investmentDocuments.tenantId | typeof investmentContracts.tenantId) => eq(tenantColumn, row.investment.tenantId);
    // Quem enviou: usuário do mesmo tenant ou o MASTER (a tabela de usuários não tem RLS; o nome é só para exibição).
    const documents = await tx.select({
      id: investmentDocuments.id, kind: investmentDocuments.kind, fileName: investmentDocuments.fileName, contentType: investmentDocuments.contentType,
      sizeBytes: investmentDocuments.sizeBytes, createdAt: investmentDocuments.createdAt, replacedAt: investmentDocuments.replacedAt,
      replacedByDocumentId: investmentDocuments.replacedByDocumentId, uploadedBy: users.name, contractId: investmentDocuments.contractId,
    }).from(investmentDocuments)
      .leftJoin(users, and(eq(users.id, investmentDocuments.uploadedByUserId), or(eq(users.tenantId, investmentDocuments.tenantId), eq(users.role, "SUPER_ADMIN"))))
      .where(and(eq(investmentDocuments.investmentId, row.investment.id), scopeOfInvestment(investmentDocuments.tenantId)))
      .orderBy(asc(investmentDocuments.createdAt), asc(investmentDocuments.id));

    const generator = alias(users, "generator");
    const contracts = await tx.select({
      id: investmentContracts.id, version: investmentContracts.version, fileName: investmentContracts.fileName, sizeBytes: investmentContracts.sizeBytes,
      sha256: investmentContracts.sha256, dataHash: investmentContracts.dataHash, includesNotes: investmentContracts.includesNotes, templateVersion: investmentContracts.templateVersion,
      createdAt: investmentContracts.createdAt, sentAt: investmentContracts.sentAt, supersededAt: investmentContracts.supersededAt, generatedBy: generator.name,
    }).from(investmentContracts)
      .leftJoin(generator, and(eq(generator.id, investmentContracts.generatedByUserId), or(eq(generator.tenantId, investmentContracts.tenantId), eq(generator.role, "SUPER_ADMIN"))))
      .where(and(eq(investmentContracts.investmentId, row.investment.id), scopeOfInvestment(investmentContracts.tenantId)))
      .orderBy(desc(investmentContracts.version));

    // Cronograma digitado pelo usuário, em ordem de data, e o histórico de alterações do contrato (mais recente primeiro).
    const scheduleRows = await tx.select({
      id: investmentScheduleItems.id, number: investmentScheduleItems.number, dueDate: investmentScheduleItems.dueDate, yieldCents: investmentScheduleItems.yieldCents,
      principalCents: investmentScheduleItems.principalCents, description: investmentScheduleItems.description,
    }).from(investmentScheduleItems)
      .where(and(eq(investmentScheduleItems.investmentId, row.investment.id), eq(investmentScheduleItems.tenantId, row.investment.tenantId)))
      .orderBy(asc(investmentScheduleItems.dueDate), asc(investmentScheduleItems.number));
    const reviser = alias(users, "reviser");
    const revisionRows = await tx.select({
      id: investmentRevisions.id, kind: investmentRevisions.kind, description: investmentRevisions.description, changes: investmentRevisions.changes,
      createdAt: investmentRevisions.createdAt, changedBy: reviser.name,
    }).from(investmentRevisions)
      .leftJoin(reviser, and(eq(reviser.id, investmentRevisions.changedByUserId), or(eq(reviser.tenantId, investmentRevisions.tenantId), eq(reviser.role, "SUPER_ADMIN"))))
      .where(and(eq(investmentRevisions.investmentId, row.investment.id), eq(investmentRevisions.tenantId, row.investment.tenantId)))
      .orderBy(desc(investmentRevisions.createdAt), desc(investmentRevisions.id));

    const contractorRow = await loadContractor(tx, row.investment.tenantId);
    const source = contractSource(row.investment, row.investor, contractorRow);
    const current = contracts.find((contract) => !contract.supersededAt) ?? null;
    // Observações entram no contrato por escolha do usuário; a sugestão é repetir a escolha da versão vigente.
    const includeNotesDefault = current ? current.includesNotes : Boolean(row.investment.notes?.trim());
    const signedContractIds = new Set(documents.filter((document) => document.kind === "SIGNED_CONTRACT" && document.contractId).map((document) => document.contractId as string));
    const versionOf = new Map(contracts.map((contract) => [contract.id, contract.version]));
    return {
      isMaster: scope.isMaster,
      tenantName: row.tenantName,
      investment: toInvestmentView(row.investment),
      investor: { id: row.investor.id, name: row.investor.name, status: row.investor.status as InvestorStatus },
      schedule: { items: scheduleRows, totals: scheduleTotals(scheduleRows) },
      revisions: revisionRows.map((revision) => ({ ...revision, kind: revision.kind as "CONTRACT" | "SCHEDULE", createdAt: revision.createdAt.toISOString(), changedBy: revision.changedBy ?? null })),
      documents: documents.map(({ contractId, ...document }) => ({
        ...document, kind: document.kind as DocumentKind, createdAt: document.createdAt.toISOString(), replacedAt: document.replacedAt?.toISOString() ?? null, uploadedBy: document.uploadedBy ?? null,
        contractId, contractVersion: contractId ? versionOf.get(contractId) ?? null : null,
      })),
      contract: {
        contractor: contractorData(contractorRow),
        contractorUpdatedAt: contractorRow?.updatedAt.toISOString() ?? null,
        investorAddressFilled: Boolean(row.investor.addressStreet || row.investor.addressCity),
        hasNotes: Boolean(row.investment.notes?.trim()),
        includeNotesDefault,
        // O que falta, com e sem as observações (o período "outro" depende delas).
        missing: { withNotes: missingContractData(source, true), withoutNotes: missingContractData(source, false) },
        // Os dados do contrato mudaram desde a versão vigente (mesma escolha de observações)?
        dataChanged: current ? current.dataHash !== contractDataHash(source, current.includesNotes) : null,
        versions: contracts.map((contract) => ({
          id: contract.id, version: contract.version, fileName: contract.fileName, sizeBytes: contract.sizeBytes, sha256: contract.sha256,
          includesNotes: contract.includesNotes, templateVersion: contract.templateVersion, generatedBy: contract.generatedBy ?? null, createdAt: contract.createdAt.toISOString(), sentAt: contract.sentAt?.toISOString() ?? null,
          supersededAt: contract.supersededAt?.toISOString() ?? null, signed: signedContractIds.has(contract.id),
        })),
      },
    };
  });
}

// Conteúdo de um contrato gerado para visualizar ou baixar. undefined = não existe no escopo da sessão.
export async function loadInvestmentContractFile(contractId: string) {
  return withInvestorContext(async (tx, scope) => {
    const [row] = await tx.select({ fileName: investmentContracts.fileName, sizeBytes: investmentContracts.sizeBytes, content: investmentContracts.content })
      .from(investmentContracts).where(and(eq(investmentContracts.id, contractId), tenantFilter(scope, investmentContracts.tenantId)));
    return row;
  });
}

// Conteúdo de um documento para visualizar ou baixar. undefined = não existe no escopo da sessão.
export async function loadInvestmentDocumentFile(documentId: string) {
  return withInvestorContext(async (tx, scope) => {
    const [row] = await tx.select().from(investmentDocuments).where(and(eq(investmentDocuments.id, documentId), tenantFilter(scope, investmentDocuments.tenantId)));
    return row;
  });
}

export type InvestorsPage = Awaited<ReturnType<typeof loadInvestorsPage>>;
export type InvestorDetail = NonNullable<Awaited<ReturnType<typeof loadInvestorDetail>>>;
export type InvestmentDetail = NonNullable<Awaited<ReturnType<typeof loadInvestmentDetail>>>;
export type InvestorView = InvestorDetail["investor"];
export type InvestmentView = InvestorDetail["investments"][number];
