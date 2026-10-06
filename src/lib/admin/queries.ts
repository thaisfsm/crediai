import "server-only";
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { withPlatformContext, type TenantTransaction } from "@/lib/auth/guards";
import { loadTenantPortfolios } from "@/lib/finance/summaries";
import { clients, loanOperations, payments, plans, tenants, users, wallets } from "@/lib/db/schema";

// Visão global da plataforma, somente leitura. Roda em withPlatformContext: exige SUPER_ADMIN na sessão e no banco,
// e abre o contexto 'SUPER_ADMIN' do RLS só dentro desta transação.
const LIST_LIMIT = 100;

export async function loadPlatformOverview() {
  return withPlatformContext(async (tx) => {
    const [totals] = await tx.execute<Record<string, string>>(sql`select
      (select count(*) from tenant) as tenants,
      (select count(*) from "user") as users,
      (select count(*) from "user" where role = 'SUPER_ADMIN') as super_admins,
      (select count(*) from client) as clients,
      (select count(*) from loan_operation where status = 'OPEN') as open_operations,
      (select count(*) from loan_operation where status <> 'CANCELED') as operations,
      (select coalesce(sum(principal_cents), 0) from loan_operation where status <> 'CANCELED') as lent_cents,
      (select count(*) from payment) as payments,
      (select coalesce(sum(amount_cents), 0) from payment) as received_cents,
      (select count(*) from wallet) as wallets`);

    // Relatório por tenant: nomes de tabela qualificados à mão dentro de sql``.
    const tenantRows = await tx.select({
      id: tenants.id, name: tenants.name, status: tenants.status, createdAt: tenants.createdAt, planName: plans.name,
      owners: sql<string>`(select string_agg(u.email, ', ' order by u.created_at) from "user" u where u.tenant_id = tenant.id)`,
      hasSuperAdmin: sql<boolean>`exists(select 1 from "user" u where u.tenant_id = tenant.id and u.role = 'SUPER_ADMIN')`,
      subscriptionStatus: sql<string | null>`(select s.status::text from subscription s where s.tenant_id = tenant.id order by s.created_at desc limit 1)`,
      subscriptionExpiresAt: sql<string | null>`(select s.expires_at::text from subscription s where s.tenant_id = tenant.id order by s.created_at desc limit 1)`,
      clientCount: sql<string>`(select count(*) from client c where c.tenant_id = tenant.id)`,
      openOperationCount: sql<string>`(select count(*) from loan_operation o where o.tenant_id = tenant.id and o.status = 'OPEN')`,
      lentCents: sql<string>`(select coalesce(sum(o.principal_cents), 0) from loan_operation o where o.tenant_id = tenant.id and o.status <> 'CANCELED')`,
      receivedCents: sql<string>`(select coalesce(sum(p.amount_cents), 0) from payment p where p.tenant_id = tenant.id)`,
    }).from(tenants).innerJoin(plans, eq(plans.id, tenants.planId)).orderBy(desc(tenants.createdAt));

    const userRows = await tx.select({
      id: users.id, name: users.name, email: users.email, role: users.role, active: users.active, createdAt: users.createdAt, tenantName: tenants.name,
    }).from(users).leftJoin(tenants, eq(tenants.id, users.tenantId)).orderBy(desc(users.createdAt)).limit(LIST_LIMIT);

    const clientRows = await tx.select({
      id: clients.id, name: clients.name, archivedAt: clients.archivedAt, createdAt: clients.createdAt, tenantName: tenants.name,
    }).from(clients).innerJoin(tenants, eq(tenants.id, clients.tenantId)).orderBy(desc(clients.createdAt)).limit(LIST_LIMIT);

    const operationRows = await tx.select({
      id: loanOperations.id, clientName: clients.name, tenantName: tenants.name, principalCents: loanOperations.principalCents, totalCents: loanOperations.totalCents,
      status: loanOperations.status, modality: loanOperations.modality, loanDate: loanOperations.loanDate, dueDate: loanOperations.dueDate,
    }).from(loanOperations)
      .innerJoin(clients, eq(clients.id, loanOperations.clientId))
      .innerJoin(tenants, eq(tenants.id, loanOperations.tenantId))
      .orderBy(desc(loanOperations.createdAt)).limit(LIST_LIMIT);

    const paymentRows = await tx.select({
      id: payments.id, clientName: clients.name, tenantName: tenants.name, amountCents: payments.amountCents, paidAt: payments.paidAt,
    }).from(payments)
      .innerJoin(loanOperations, eq(loanOperations.id, payments.operationId))
      .innerJoin(clients, eq(clients.id, loanOperations.clientId))
      .innerJoin(tenants, eq(tenants.id, payments.tenantId))
      .orderBy(desc(payments.paidAt), desc(payments.createdAt)).limit(LIST_LIMIT);

    const walletRows = await tx.select({
      id: wallets.id, tenantName: tenants.name, initialCapitalCents: wallets.initialCapitalCents, cycleNumber: wallets.cycleNumber, createdAt: wallets.createdAt,
    }).from(wallets).innerJoin(tenants, eq(tenants.id, wallets.tenantId)).orderBy(desc(wallets.createdAt)).limit(LIST_LIMIT);

    return {
      totals: {
        tenants: Number(totals.tenants), users: Number(totals.users), superAdmins: Number(totals.super_admins), clients: Number(totals.clients),
        openOperations: Number(totals.open_operations), operations: Number(totals.operations), lentCents: Number(totals.lent_cents),
        payments: Number(totals.payments), receivedCents: Number(totals.received_cents), wallets: Number(totals.wallets),
      },
      tenants: tenantRows.map((row) => ({
        ...row, clientCount: Number(row.clientCount), openOperationCount: Number(row.openOperationCount), lentCents: Number(row.lentCents), receivedCents: Number(row.receivedCents),
      })),
      users: userRows, clients: clientRows, operations: operationRows, payments: paymentRows, wallets: walletRows,
    };
  });
}

export type PlatformOverview = Awaited<ReturnType<typeof loadPlatformOverview>>;

// ---------------------------------------------------------------------------------------------------------------
// Clientes SaaS: quem usa o CrediAI (um tenant e o usuário dele). Não confundir com os clientes finais,
// que são as pessoas cadastradas dentro da carteira de cada cliente SaaS (tabela client).

export type SaasStatus = "TRIALING" | "ACTIVE" | "SUSPENDED" | "CLOSED";
export type SaasSort = "nome" | "emprestado" | "clientes" | "atividade";
export const SAAS_PAGE_SIZE = 12;
const DAY_MS = 24 * 60 * 60 * 1000;

async function loadSaasRows(tx: TenantTransaction, tenantIds?: string[]) {
  const rows = await tx.select({
    tenantId: tenants.id, tenantName: tenants.name, status: tenants.status, planId: tenants.planId, planName: plans.name, planPriceInCents: plans.priceInCents, contactPhone: tenants.contactPhone, createdAt: tenants.createdAt,
    // Conta principal do tenant: o primeiro usuário criado nele.
    userId: sql<string | null>`(select u.id from "user" u where u.tenant_id = tenant.id order by u.created_at limit 1)`,
    userName: sql<string | null>`(select u.name from "user" u where u.tenant_id = tenant.id order by u.created_at limit 1)`,
    email: sql<string | null>`(select u.email from "user" u where u.tenant_id = tenant.id order by u.created_at limit 1)`,
    userActive: sql<boolean | null>`(select u.active from "user" u where u.tenant_id = tenant.id order by u.created_at limit 1)`,
    mustChangePassword: sql<boolean | null>`(select u.must_change_password from "user" u where u.tenant_id = tenant.id order by u.created_at limit 1)`,
    isPlatformOwner: sql<boolean>`exists(select 1 from "user" u where u.tenant_id = tenant.id and u.role = 'SUPER_ADMIN')`,
    // Último acesso: login registrado (last_login_at) ou, para contas anteriores a esse registro, a sessão mais recente.
    lastAccessAt: sql<string | null>`(select greatest(max(u.last_login_at), (select max(s.created_at) from session s join "user" su on su.id = s.user_id where su.tenant_id = tenant.id))::text from "user" u where u.tenant_id = tenant.id)`,
    subscriptionStatus: sql<string | null>`(select s.status::text from subscription s where s.tenant_id = tenant.id order by s.created_at desc limit 1)`,
    subscriptionExpiresAt: sql<string | null>`(select s.expires_at::text from subscription s where s.tenant_id = tenant.id order by s.created_at desc limit 1)`,
    clientCount: sql<string>`(select count(*) from client c where c.tenant_id = tenant.id)`,
    activeClientCount: sql<string>`(select count(*) from client c where c.tenant_id = tenant.id and c.archived_at is null)`,
  }).from(tenants).innerJoin(plans, eq(plans.id, tenants.planId))
    .where(tenantIds ? inArray(tenants.id, tenantIds) : undefined)
    .orderBy(asc(tenants.name));
  const portfolios = await loadTenantPortfolios(tx, rows.map((row) => row.tenantId));
  const now = Date.now();

  return rows.map((row) => {
    const portfolio = portfolios.get(row.tenantId)!;
    const { summary } = portfolio;
    const expiresAt = row.subscriptionExpiresAt ? new Date(row.subscriptionExpiresAt) : null;
    const subscriptionValid = ["TRIALING", "ACTIVE"].includes(row.subscriptionStatus ?? "") && (!expiresAt || expiresAt.getTime() > now);
    // Mesmo critério de requireTenantUser: o cliente SaaS só entra com tenant e assinatura válidos e usuário ativo.
    const canAccess = Boolean(row.userActive) && (row.isPlatformOwner ? row.status !== "CLOSED" : ["TRIALING", "ACTIVE"].includes(row.status) && subscriptionValid);
    const lastAccessAt = row.lastAccessAt ? new Date(row.lastAccessAt) : null;
    const daysToExpire = expiresAt ? Math.ceil((expiresAt.getTime() - now) / DAY_MS) : null;
    const attention: string[] = [];
    if (!row.isPlatformOwner) {
      if (row.status === "SUSPENDED") attention.push("Suspenso");
      if (row.userActive === false) attention.push("Acesso bloqueado");
      if (["TRIALING", "ACTIVE"].includes(row.status) && !subscriptionValid) attention.push(row.status === "TRIALING" ? "Período de teste vencido" : "Assinatura vencida");
      else if (daysToExpire !== null && daysToExpire <= 3 && ["TRIALING", "ACTIVE"].includes(row.status)) attention.push(daysToExpire <= 1 ? "Teste vence em 1 dia" : `Teste vence em ${daysToExpire} dias`);
      if (row.mustChangePassword) attention.push("Ainda não trocou a senha provisória");
      else if (!lastAccessAt) attention.push("Nunca acessou");
      else if (now - lastAccessAt.getTime() > 30 * DAY_MS) attention.push("Sem acesso há mais de 30 dias");
    }
    if (summary.counts.overdue > 0) attention.push(summary.counts.overdue === 1 ? "1 operação em atraso" : `${summary.counts.overdue} operações em atraso`);
    return {
      tenantId: row.tenantId, tenantName: row.tenantName, name: row.userName ?? row.tenantName, email: row.email, userId: row.userId,
      status: row.status as SaasStatus, planId: row.planId, planName: row.planName, planPriceInCents: row.planPriceInCents, contactPhone: row.contactPhone,
      createdAt: row.createdAt.toISOString(), lastAccessAt: lastAccessAt?.toISOString() ?? null,
      userActive: Boolean(row.userActive), mustChangePassword: Boolean(row.mustChangePassword), isPlatformOwner: row.isPlatformOwner,
      subscriptionStatus: row.subscriptionStatus, subscriptionExpiresAt: expiresAt?.toISOString() ?? null, subscriptionValid, canAccess,
      clients: { total: Number(row.clientCount), active: Number(row.activeClientCount), archived: Number(row.clientCount) - Number(row.activeClientCount) },
      operations: { open: summary.counts.active, paid: summary.counts.paid, overdue: summary.counts.overdue, dueToday: summary.counts.dueToday, total: summary.counts.total },
      money: {
        availableCents: summary.availableCents, lentCents: summary.lentCents, receivableCents: summary.receivableCents,
        expectedInterestCents: summary.expectedInterestCents, receivedInterestCents: summary.receivedInterestCents, receivedCents: summary.receivedCents,
      },
      paymentCount: portfolio.payments.length,
      hasWallet: summary.hasWallet, needsInitialCapital: summary.needsInitialCapital, cycleNumber: summary.cycleNumber,
      attention,
      portfolio,
    };
  });
}

export type SaasClient = Omit<Awaited<ReturnType<typeof loadSaasRows>>[number], "portfolio">;

export async function loadSaasClients(filters: { q?: string; status?: string; plano?: string; ordem?: string; pagina?: string }) {
  return withPlatformContext(async (tx) => {
    const all: SaasClient[] = (await loadSaasRows(tx)).map((row) => {
      const { portfolio, ...client } = row;
      void portfolio;
      return client;
    });
    const planRows = await tx.select({ id: plans.id, name: plans.name, priceInCents: plans.priceInCents, active: plans.active }).from(plans).orderBy(asc(plans.name));
    const sum = (pick: (row: SaasClient) => number) => all.reduce((total, row) => total + pick(row), 0);
    const customers = all.filter((row) => !row.isPlatformOwner);
    const kpis = {
      total: customers.length,
      active: customers.filter((row) => row.status === "ACTIVE").length,
      trialing: customers.filter((row) => row.status === "TRIALING").length,
      suspended: customers.filter((row) => row.status === "SUSPENDED").length,
      closed: customers.filter((row) => row.status === "CLOSED").length,
      // Receita mensal contratada: soma do preço do plano dos clientes SaaS com assinatura ativa. Clientes em teste
      // aparecem à parte, como o valor que passaria a entrar se fossem ativados. Ambiente sem usuário não conta.
      monthlyRevenueCents: sum((row) => (!row.isPlatformOwner && row.userId && row.status === "ACTIVE" ? row.planPriceInCents : 0)),
      trialRevenueCents: sum((row) => (!row.isPlatformOwner && row.userId && row.status === "TRIALING" ? row.planPriceInCents : 0)),
      finalClients: sum((row) => row.clients.total),
      activeFinalClients: sum((row) => row.clients.active),
      openOperations: sum((row) => row.operations.open),
      overdueOperations: sum((row) => row.operations.overdue),
      lentCents: sum((row) => row.money.lentCents),
      receivableCents: sum((row) => row.money.receivableCents),
      receivedCents: sum((row) => row.money.receivedCents),
      receivedInterestCents: sum((row) => row.money.receivedInterestCents),
      expectedInterestCents: sum((row) => row.money.expectedInterestCents),
    };

    const query = (filters.q ?? "").trim().toLocaleLowerCase("pt-BR").slice(0, 120);
    const status = ["TRIALING", "ACTIVE", "SUSPENDED", "CLOSED"].includes(filters.status ?? "") ? filters.status : "";
    const plan = planRows.some((row) => row.id === filters.plano) ? filters.plano : "";
    const sort: SaasSort = (["nome", "emprestado", "clientes", "atividade"] as const).find((key) => key === filters.ordem) ?? "nome";
    const filtered = all.filter((row) => (!query || [row.name, row.email ?? "", row.tenantName].some((value) => value.toLocaleLowerCase("pt-BR").includes(query)))
      && (!status || row.status === status) && (!plan || row.planId === plan));
    const byName = (a: SaasClient, b: SaasClient) => a.name.localeCompare(b.name, "pt-BR");
    filtered.sort(sort === "emprestado" ? (a, b) => b.money.lentCents - a.money.lentCents || byName(a, b)
      : sort === "clientes" ? (a, b) => b.clients.total - a.clients.total || byName(a, b)
      : sort === "atividade" ? (a, b) => (b.lastAccessAt ?? "").localeCompare(a.lastAccessAt ?? "") || byName(a, b)
      : byName);
    const pages = Math.max(1, Math.ceil(filtered.length / SAAS_PAGE_SIZE));
    const page = Math.min(Math.max(1, Number.parseInt(filters.pagina ?? "1", 10) || 1), pages);

    return {
      kpis,
      attention: customers.filter((row) => row.attention.length > 0).slice(0, 8),
      clients: filtered.slice((page - 1) * SAAS_PAGE_SIZE, page * SAAS_PAGE_SIZE),
      matched: filtered.length,
      page, pages,
      filters: { q: filters.q?.trim() ?? "", status: status ?? "", plano: plan ?? "", ordem: sort },
      plans: planRows,
    };
  });
}

export async function loadSaasClientDetail(tenantId: string) {
  return withPlatformContext(async (tx) => {
    const [row] = await loadSaasRows(tx, [tenantId]);
    if (!row) return null;
    const planRows = await tx.select({ id: plans.id, name: plans.name, priceInCents: plans.priceInCents, active: plans.active }).from(plans).orderBy(asc(plans.name));
    const tenantUsers = await tx.select({ id: users.id, name: users.name, email: users.email, role: users.role, active: users.active, mustChangePassword: users.mustChangePassword, lastLoginAt: users.lastLoginAt, createdAt: users.createdAt })
      .from(users).where(eq(users.tenantId, tenantId)).orderBy(asc(users.createdAt));
    const { portfolio, ...client } = row;
    // Recebido por mês (últimos 6 meses do ciclo atual), somando os pagamentos registrados.
    const months = Array.from({ length: 6 }, (_, index) => {
      const date = new Date();
      date.setUTCDate(1);
      date.setUTCMonth(date.getUTCMonth() - (5 - index));
      return date.toISOString().slice(0, 7);
    });
    const receivedByMonth = months.map((month) => ({ month, cents: portfolio.payments.filter((payment) => payment.paidAt.startsWith(month)).reduce((total, payment) => total + payment.amountCents, 0) }));
    return {
      client,
      users: tenantUsers.map((user) => ({ ...user, lastLoginAt: user.lastLoginAt?.toISOString() ?? null, createdAt: user.createdAt.toISOString() })),
      plans: planRows,
      recentPayments: portfolio.charges.Histórico.slice(0, 8),
      overdue: portfolio.charges["Em atraso"].slice(0, 8),
      receivableChart: portfolio.chart["90D"],
      receivedByMonth,
      profitability: portfolio.profitability,
      initialCapitalCents: portfolio.summary.initialCapitalCents,
      investedCents: portfolio.summary.investedCents,
    };
  });
}

export type SaasClientDetail = NonNullable<Awaited<ReturnType<typeof loadSaasClientDetail>>>;

export async function loadPlans() {
  return withPlatformContext((tx) => tx.select({ id: plans.id, name: plans.name, priceInCents: plans.priceInCents, active: plans.active }).from(plans).orderBy(asc(plans.name)));
}
