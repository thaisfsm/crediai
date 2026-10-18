import "server-only";
import { and, asc, count, desc, eq, gte, ilike, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { investmentContracts, investmentDocuments, investmentRevisions, investmentScheduleItems, investments, investorBankAccounts, investorDocuments, investors, tenants, users } from "@/lib/db/schema";
import { bankAccountLabel, maskAccountNumber, maskDocument, maskPixKey } from "./bank-accounts";
import { investmentDivergences, investmentPosition, scheduleLines } from "./position";
import { onlyDigits, todayIso } from "@/lib/finance/format";
import { tenantFilter, withInvestorContext, type InvestorScope } from "./access";
import { missingContractData } from "./contract";
import { buildObligations, entryDateOf } from "./payables";
import { loadInvestmentCash } from "./payables-queries";
import { contractDataHash, contractSource, contractorData, loadContractor } from "./contract-source";
import {
  INVESTORS_PAGE_SIZE, investorFilters, personTypeOf, scheduleTotals, scheduleVersion, summarizeInvestments,
  type DocumentKind, type InvestmentPaymentMethod, type InvestmentStatus, type InvestorDocumentKind, type InvestorStatus, type PaymentFrequency, type RatePeriod, type RedemptionRule, type TermUnit,
} from "./rules";

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

    // Somas dos registros por contrato (cronograma digitado e baixas); nada é calculado por taxa.
    const summaryRows = await tx.select({
      status: investments.status, amountCents: investments.amountCents, maturityDate: investments.maturityDate,
      scheduledYieldCents: sql<string>`(select coalesce(sum(s.yield_cents), 0) from investment_schedule_item s where s.investment_id = investment.id and s.tenant_id = investment.tenant_id)`,
      paidYieldCents: sql<string>`(select coalesce(sum(p.amount_cents), 0) from investment_payment p where p.investment_id = investment.id and p.tenant_id = investment.tenant_id and p.kind = 'YIELD')`,
      paidPrincipalCents: sql<string>`(select coalesce(sum(p.amount_cents), 0) from investment_payment p where p.investment_id = investment.id and p.tenant_id = investment.tenant_id and p.kind = 'PRINCIPAL')`,
    }).from(investments).where(scopeOn(investments.tenantId));
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
      summary: summarizeInvestments(summaryRows.map((row) => ({
        ...row, status: row.status as InvestmentStatus, scheduledYieldCents: Number(row.scheduledYieldCents), paidYieldCents: Number(row.paidYieldCents), paidPrincipalCents: Number(row.paidPrincipalCents),
      })), today),
      upcoming: upcoming.map((row) => ({ ...row, maturityDate: row.maturityDate as string })),
      // A lista não leva dados bancários nem data de nascimento: só o que aparece nela.
      investors: rows.map(({ investor, tenantName, investmentCount }) => ({
        id: investor.id, name: investor.name, tradeName: investor.tradeName, personType: personTypeOf(investor), document: investor.document, phone: investor.phone, whatsapp: investor.whatsapp,
        email: investor.email, instagram: investor.instagram, facebook: investor.facebook, status: investor.status as InvestorStatus, createdAt: investor.createdAt.toISOString(),
        tenantName, investmentCount: Number(investmentCount),
      })),
      matched: total,
      page,
      pages,
    };
  });
}

function toInvestorView(investor: typeof investors.$inferSelect) {
  return {
    id: investor.id, tenantId: investor.tenantId, name: investor.name, document: investor.document, phone: investor.phone, whatsapp: investor.whatsapp,
    // Tipo gravado (null = cadastro anterior à 0024) e o que se lê do documento para exibir.
    personTypeStored: investor.personType as "PF" | "PJ" | null, personType: personTypeOf(investor), tradeName: investor.tradeName, birthDate: investor.birthDate,
    email: investor.email, instagram: investor.instagram, facebook: investor.facebook, notes: investor.notes, status: investor.status as InvestorStatus,
    addressCep: investor.addressCep, addressStreet: investor.addressStreet, addressNumber: investor.addressNumber, addressComplement: investor.addressComplement,
    addressDistrict: investor.addressDistrict, addressCity: investor.addressCity, addressState: investor.addressState,
    // Conta do formato anterior (colunas do investidor), só mascarada e só se existir.
    legacyBank: investor.bankAccount || investor.pixKey || investor.bankName ? {
      label: bankAccountLabel({ bankCode: null, bankName: investor.bankName, branch: investor.bankBranch, branchDigit: null, account: investor.bankAccount, accountDigit: null, pixKeyType: investor.pixKeyType, pixKey: investor.pixKey }),
      holder: [investor.bankHolderName, maskDocument(investor.bankHolderDocument)].filter(Boolean).join(" · ") || null,
    } : null,
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
    contractedOn: investment.contractedOn, termCount: investment.termCount, termUnit: investment.termUnit as TermUnit | null, paymentMethod: investment.paymentMethod as InvestmentPaymentMethod | null,
    bankAccountId: investment.bankAccountId, yieldTerms: investment.yieldTerms, principalTerms: investment.principalTerms,
    redemptionRule: investment.redemptionRule as RedemptionRule | null, redemptionDays: investment.redemptionDays, yieldPaymentCents: investment.yieldPaymentCents, renewedFromInvestmentId: investment.renewedFromInvestmentId,
    createdAt: investment.createdAt.toISOString(), updatedAt: investment.updatedAt.toISOString(),
  };
}

// Elos de renovação de um contrato e a conferência do banco de que o dinheiro da cadeia está no capital.
async function loadRenewalLinks(tx: Parameters<Parameters<typeof withInvestorContext>[0]>[0], investment: typeof investments.$inferSelect) {
  const [parent] = investment.renewedFromInvestmentId ? await tx.select({ id: investments.id, amountCents: investments.amountCents, startDate: investments.startDate, contractNumber: investments.contractNumber, maturityDate: investments.maturityDate })
    .from(investments).where(and(eq(investments.id, investment.renewedFromInvestmentId), eq(investments.tenantId, investment.tenantId))) : [];
  const [child] = await tx.select({ id: investments.id, amountCents: investments.amountCents, startDate: investments.startDate, contractNumber: investments.contractNumber, createdAt: investments.createdAt })
    .from(investments).where(and(eq(investments.renewedFromInvestmentId, investment.id), eq(investments.tenantId, investment.tenantId)));
  const [{ originHasCapital }] = await tx.select({ originHasCapital: sql<boolean>`crediai_investment_has_capital(${investment.tenantId}, ${investment.id})` }).from(investments)
    .where(and(eq(investments.id, investment.id), eq(investments.tenantId, investment.tenantId)));
  return { parent: parent ?? null, child: child ? { ...child, createdAt: child.createdAt.toISOString() } : null, originHasCapital: Boolean(originHasCapital) };
}

// Contas bancárias do investidor, só mascaradas (os números completos só vão para o formulário de edição, sob pedido).
// Quantos contratos usam cada conta também vem, para a tela saber o que pode ser alterado ou retirado.
export async function loadBankAccountViews(tx: Parameters<Parameters<typeof withInvestorContext>[0]>[0], tenantId: string, investorId: string) {
  const rows = await tx.select({
    account: investorBankAccounts,
    linkedCount: sql<string>`(select count(*) from investment i where i.bank_account_id = investor_bank_account.id and i.tenant_id = investor_bank_account.tenant_id)`,
    activeLinkedCount: sql<string>`(select count(*) from investment i where i.bank_account_id = investor_bank_account.id and i.tenant_id = investor_bank_account.tenant_id and i.status not in ('CLOSED', 'CANCELED'))`,
  }).from(investorBankAccounts).where(and(eq(investorBankAccounts.investorId, investorId), eq(investorBankAccounts.tenantId, tenantId)))
    .orderBy(desc(investorBankAccounts.isPreferred), asc(investorBankAccounts.createdAt), asc(investorBankAccounts.id));
  return rows.map(({ account, linkedCount, activeLinkedCount }) => ({
    id: account.id, label: bankAccountLabel(account), bankCode: account.bankCode, bankName: account.bankName,
    branch: account.branch ? `${account.branch}${account.branchDigit ? `-${account.branchDigit}` : ""}` : null,
    account: maskAccountNumber(account.account, account.accountDigit), accountType: account.accountType,
    holderName: account.holderName, holderDocument: maskDocument(account.holderDocument), pixKeyType: account.pixKeyType, pixKey: maskPixKey(account.pixKeyType, account.pixKey),
    hasPix: Boolean(account.pixKey), hasTransfer: Boolean(account.account && account.branch),
    isPreferred: account.isPreferred, notes: account.notes, archivedAt: account.archivedAt?.toISOString() ?? null,
    linkedCount: Number(linkedCount), activeLinkedCount: Number(activeLinkedCount),
  }));
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
    const bankAccounts = await loadBankAccountViews(tx, row.investor.tenantId, row.investor.id);
    // Documentos do próprio investidor (vigentes e retirados; o conteúdo não vem).
    const uploader = alias(users, "uploader");
    const investorDocumentRows = await tx.select({
      id: investorDocuments.id, kind: investorDocuments.kind, label: investorDocuments.label, fileName: investorDocuments.fileName, sizeBytes: investorDocuments.sizeBytes,
      createdAt: investorDocuments.createdAt, removedAt: investorDocuments.removedAt, uploadedBy: uploader.name,
    }).from(investorDocuments)
      .leftJoin(uploader, and(eq(uploader.id, investorDocuments.uploadedByUserId), or(eq(uploader.tenantId, investorDocuments.tenantId), eq(uploader.role, "SUPER_ADMIN"))))
      .where(and(eq(investorDocuments.investorId, row.investor.id), eq(investorDocuments.tenantId, row.investor.tenantId)))
      .orderBy(desc(investorDocuments.createdAt), asc(investorDocuments.id));
    return {
      bankAccounts,
      investorDocuments: investorDocumentRows.map((document) => ({
        ...document, kind: document.kind as InvestorDocumentKind, createdAt: document.createdAt.toISOString(), removedAt: document.removedAt?.toISOString() ?? null, uploadedBy: document.uploadedBy ?? null,
      })),
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
      principalCents: investmentScheduleItems.principalCents, description: investmentScheduleItems.description, updatedAt: investmentScheduleItems.updatedAt,
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

    // Renovação: o contrato de que este veio, o que veio deste e se o dinheiro da cadeia está no capital.
    const renewal = await loadRenewalLinks(tx, row.investment);
    // Contas a Pagar: entrada no capital e baixas deste contrato, e as obrigações do cronograma com o que já foi pago.
    const cash = await loadInvestmentCash(tx, row.investment, scope.tenantId);
    const obligations = buildObligations({
      investments: [{ id: row.investment.id, investorId: row.investor.id, investorName: row.investor.name, contractNumber: row.investment.contractNumber, status: row.investment.status, startDate: row.investment.startDate, amountCents: row.investment.amountCents,
        capitalEntryRule: row.investment.capitalEntryRule, hasEntry: Boolean(cash.entry), hasPriorContribution: Boolean(cash.prior),
        renewedFrom: row.investment.renewedFromInvestmentId, originHasCapital: renewal.originHasCapital, renewed: Boolean(renewal.child), paymentMethod: row.investment.paymentMethod }],
      items: scheduleRows.map((item) => ({ ...item, investmentId: row.investment.id })), payments: cash.payments, today: todayIso(),
    });
    const today = todayIso();
    const lines = scheduleLines(scheduleRows, cash.payments, row.investment.status, today, { renewed: Boolean(renewal.child) });
    const position = investmentPosition({ investment: row.investment, lines, entryCents: cash.entry?.amountCents ?? null, priorContribution: Boolean(cash.prior), today, renewedFrom: Boolean(renewal.parent), renewed: Boolean(renewal.child) });
    const divergences = investmentDivergences({ investment: row.investment, lines, entryCents: cash.entry?.amountCents ?? null, renewed: Boolean(renewal.child) });
    // Contas do investidor para escolher no contrato: as em uso e a já escolhida (mesmo se retirada depois).
    const bankAccounts = (await loadBankAccountViews(tx, row.investment.tenantId, row.investor.id)).filter((account) => !account.archivedAt || account.id === row.investment.bankAccountId);
    const contractorRow = await loadContractor(tx, row.investment.tenantId);
    const source = contractSource(row.investment, row.investor, contractorRow, scheduleRows.map((item) => item.dueDate));
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
      schedule: { items: scheduleRows.map(({ updatedAt, ...item }) => ({ ...item, updatedAt: updatedAt.toISOString() })), lines, totals: scheduleTotals(scheduleRows), version: scheduleVersion(scheduleRows) },
      position,
      divergences,
      renewal,
      bankAccounts,
      cash: { ...cash, today: todayIso(), entryDate: entryDateOf(row.investment), obligations, paidItemIds: [...new Set(cash.payments.map((payment) => payment.scheduleItemId))] },
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

// Conteúdo de um documento do investidor (também os retirados, que ficam no histórico). undefined = fora do escopo.
export async function loadInvestorDocumentFile(documentId: string) {
  return withInvestorContext(async (tx, scope) => {
    const [row] = await tx.select().from(investorDocuments).where(and(eq(investorDocuments.id, documentId), tenantFilter(scope, investorDocuments.tenantId)));
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
export type BankAccountView = InvestorDetail["bankAccounts"][number];
export type InvestmentView = InvestorDetail["investments"][number];
