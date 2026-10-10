import "server-only";
import { and, asc, count, desc, eq, gte, ilike, ne, or, sql, type SQL } from "drizzle-orm";
import { investmentDocuments, investments, investors, tenants, users } from "@/lib/db/schema";
import { onlyDigits, todayIso } from "@/lib/finance/format";
import { tenantFilter, withInvestorContext, type InvestorScope } from "./access";
import { INVESTORS_PAGE_SIZE, investorFilters, summarizeInvestments, type DocumentKind, type InvestmentStatus, type InvestorStatus, type RatePeriod } from "./rules";

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
    createdAt: investor.createdAt.toISOString(), updatedAt: investor.updatedAt.toISOString(),
  };
}

function toInvestmentView(investment: typeof investments.$inferSelect) {
  return {
    id: investment.id, tenantId: investment.tenantId, investorId: investment.investorId, amountCents: investment.amountCents,
    agreedRateBps: investment.agreedRateBps, ratePeriod: investment.ratePeriod as RatePeriod, startDate: investment.startDate,
    maturityDate: investment.maturityDate, dueDay: investment.dueDay, notes: investment.notes, status: investment.status as InvestmentStatus,
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
    return {
      isMaster: scope.isMaster,
      investor: { ...toInvestorView(row.investor), tenantName: row.tenantName },
      investments: contractRows.map(({ investment, documentCount, hasSignedContract }) => ({ ...toInvestmentView(investment), documentCount: Number(documentCount), hasSignedContract: Boolean(hasSignedContract) })),
    };
  });
}

// Contrato de investimento com o investidor e os documentos (vigentes e substituídos), sem o conteúdo dos arquivos.
export async function loadInvestmentDetail(investmentId: string) {
  return withInvestorContext(async (tx, scope) => {
    const [row] = await tx.select({ investment: investments, investor: investors, tenantName: tenants.name }).from(investments)
      .innerJoin(investors, and(eq(investors.id, investments.investorId), eq(investors.tenantId, investments.tenantId)))
      .innerJoin(tenants, eq(tenants.id, investments.tenantId))
      .where(and(eq(investments.id, investmentId), tenantFilter(scope, investments.tenantId)));
    if (!row) return null;
    // Quem enviou: usuário do mesmo tenant ou o MASTER (a tabela de usuários não tem RLS; o nome é só para exibição).
    const documents = await tx.select({
      id: investmentDocuments.id, kind: investmentDocuments.kind, fileName: investmentDocuments.fileName, contentType: investmentDocuments.contentType,
      sizeBytes: investmentDocuments.sizeBytes, createdAt: investmentDocuments.createdAt, replacedAt: investmentDocuments.replacedAt,
      replacedByDocumentId: investmentDocuments.replacedByDocumentId, uploadedBy: users.name,
    }).from(investmentDocuments)
      .leftJoin(users, and(eq(users.id, investmentDocuments.uploadedByUserId), or(eq(users.tenantId, investmentDocuments.tenantId), eq(users.role, "SUPER_ADMIN"))))
      .where(and(eq(investmentDocuments.investmentId, row.investment.id), eq(investmentDocuments.tenantId, row.investment.tenantId)))
      .orderBy(asc(investmentDocuments.createdAt), asc(investmentDocuments.id));
    return {
      isMaster: scope.isMaster,
      tenantName: row.tenantName,
      investment: toInvestmentView(row.investment),
      investor: { id: row.investor.id, name: row.investor.name, status: row.investor.status as InvestorStatus },
      documents: documents.map((document) => ({
        ...document, kind: document.kind as DocumentKind, createdAt: document.createdAt.toISOString(), replacedAt: document.replacedAt?.toISOString() ?? null, uploadedBy: document.uploadedBy ?? null,
      })),
    };
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
