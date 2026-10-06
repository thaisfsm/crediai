import "server-only";
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { withPlatformContext, type TenantTransaction } from "@/lib/auth/guards";
import { loadTenantPortfolios } from "@/lib/finance/summaries";
import { todayIso } from "@/lib/finance/format";
import { commercialState, type CommercialCondition, type CommercialStatus } from "@/lib/billing/rules";
import { clients, loanOperations, payments, plans, subscriptionCharges, subscriptions, tenants, users, wallets } from "@/lib/db/schema";

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
type SubscriptionRow = {
  id: string; status: string; plan_id: string; expires_at: string | null; contracted_price_cents: number | null; commercial_condition: string | null;
  activated_at: string | null; first_due_date: string | null; next_due_date: string | null; billing_cycle: string; grace_days: number; last_paid_at: string | null;
};
export type SaasSort = "nome" | "emprestado" | "clientes" | "atividade" | "vencimento";

// Agrupa a situação comercial nos cinco status da Central (teste vencido conta como Em teste; tolerância
// esgotada conta como Vencido).
export function commercialGroup(status: CommercialStatus) {
  if (status === "TRIAL_EXPIRED") return "TRIALING";
  if (status === "SUSPENSION_DUE") return "PAST_DUE";
  return status;
}
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
    // Assinatura vigente (a mais recente) inteira, e a última mensalidade paga dela.
    subscription: sql<SubscriptionRow | null>`(select json_build_object('id', s.id, 'status', s.status, 'plan_id', s.plan_id, 'expires_at', s.expires_at, 'contracted_price_cents', s.contracted_price_cents, 'commercial_condition', s.commercial_condition, 'activated_at', s.activated_at, 'first_due_date', s.first_due_date, 'next_due_date', s.next_due_date, 'billing_cycle', s.billing_cycle, 'grace_days', s.grace_days, 'last_paid_at', (select max(c.paid_at) from subscription_charge c where c.subscription_id = s.id and c.status = 'PAID')) from subscription s where s.tenant_id = tenant.id order by s.created_at desc limit 1)`,
    clientCount: sql<string>`(select count(*) from client c where c.tenant_id = tenant.id)`,
    activeClientCount: sql<string>`(select count(*) from client c where c.tenant_id = tenant.id and c.archived_at is null)`,
  }).from(tenants).innerJoin(plans, eq(plans.id, tenants.planId))
    .where(tenantIds ? inArray(tenants.id, tenantIds) : undefined)
    .orderBy(asc(tenants.name));
  const portfolios = await loadTenantPortfolios(tx, rows.map((row) => row.tenantId));
  const now = Date.now();
  const today = todayIso();

  return rows.map((row) => {
    const portfolio = portfolios.get(row.tenantId)!;
    const { summary } = portfolio;
    const sub = row.subscription;
    const expiresAt = sub?.expires_at ? new Date(sub.expires_at) : null;
    const subscriptionValid = ["TRIALING", "ACTIVE"].includes(sub?.status ?? "") && (!expiresAt || expiresAt.getTime() > now);
    const graceDays = sub?.grace_days ?? 5;
    const state = commercialState({ isPlatformOwner: row.isPlatformOwner, tenantStatus: row.status, subscriptionStatus: sub?.status ?? null, trialEndsAt: sub?.expires_at ?? null, nextDueDate: sub?.next_due_date ?? null, graceDays }, today, new Date(now));
    // Mesmo critério de requireTenantUser: o cliente SaaS só entra com tenant e assinatura válidos e usuário ativo.
    const canAccess = Boolean(row.userActive) && (row.isPlatformOwner ? row.status !== "CLOSED" : ["TRIALING", "ACTIVE"].includes(row.status) && subscriptionValid);
    const lastAccessAt = row.lastAccessAt ? new Date(row.lastAccessAt) : null;
    const daysToExpire = expiresAt ? Math.ceil((expiresAt.getTime() - now) / DAY_MS) : null;
    const attention: string[] = [];
    if (!row.isPlatformOwner) {
      if (row.status === "SUSPENDED") attention.push("Suspenso");
      if (row.userActive === false) attention.push("Acesso bloqueado");
      if (state.status === "TRIAL_EXPIRED") attention.push("Período de teste vencido");
      else if (["TRIALING", "ACTIVE"].includes(row.status) && !subscriptionValid) attention.push("Assinatura vencida");
      else if (state.status === "TRIALING" && daysToExpire !== null && daysToExpire <= 3) attention.push(daysToExpire <= 1 ? "Teste vence em 1 dia" : `Teste vence em ${daysToExpire} dias`);
      if (state.status === "PAST_DUE") attention.push(`Mensalidade vencida há ${state.daysOverdue} ${state.daysOverdue === 1 ? "dia" : "dias"} (na tolerância)`);
      if (state.status === "SUSPENSION_DUE") attention.push(`Mensalidade vencida há ${state.daysOverdue} dias: tolerância esgotada`);
      if (state.status === "ACTIVE" && state.daysToDue !== null && state.daysToDue <= 3) attention.push(state.daysToDue === 0 ? "Mensalidade vence hoje" : `Mensalidade vence em ${state.daysToDue} ${state.daysToDue === 1 ? "dia" : "dias"}`);
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
      subscriptionStatus: sub?.status ?? null, subscriptionExpiresAt: expiresAt?.toISOString() ?? null, subscriptionValid, canAccess,
      // Condição comercial: valor contratado (independente do preço padrão do plano), condição e ciclo de vencimento.
      commercial: {
        status: state.status as CommercialStatus,
        contractedPriceCents: sub?.contracted_price_cents ?? null,
        condition: (sub?.commercial_condition ?? null) as CommercialCondition | null,
        activatedAt: sub?.activated_at ?? null,
        firstDueDate: sub?.first_due_date ?? null,
        nextDueDate: sub?.next_due_date ?? null,
        billingCycle: sub?.billing_cycle ?? "MONTHLY",
        graceDays,
        lastPaidAt: sub?.last_paid_at ?? null,
        daysToDue: state.daysToDue,
        daysOverdue: state.daysOverdue,
        graceEndsOn: state.graceEndsOn,
      },
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
    const group = (row: SaasClient) => commercialGroup(row.commercial.status);
    const paying = (row: SaasClient) => ["ACTIVE", "PAST_DUE"].includes(group(row));
    const kpis = {
      total: customers.length,
      active: customers.filter((row) => group(row) === "ACTIVE").length,
      trialing: customers.filter((row) => group(row) === "TRIALING").length,
      pastDue: customers.filter((row) => group(row) === "PAST_DUE").length,
      suspended: customers.filter((row) => group(row) === "SUSPENDED").length,
      closed: customers.filter((row) => group(row) === "CLOSED").length,
      courtesy: customers.filter((row) => paying(row) && row.commercial.condition === "COURTESY").length,
      // Receita mensal contratada: soma dos VALORES CONTRATADOS das assinaturas ativas (em dia ou vencidas), não do
      // preço padrão do plano. Clientes em teste aparecem à parte, pelo preço padrão do plano escolhido.
      monthlyRevenueCents: sum((row) => (!row.isPlatformOwner && paying(row) ? row.commercial.contractedPriceCents ?? 0 : 0)),
      trialRevenueCents: sum((row) => (!row.isPlatformOwner && row.userId && group(row) === "TRIALING" ? row.planPriceInCents : 0)),
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
    const status = ["TRIALING", "ACTIVE", "PAST_DUE", "SUSPENDED", "CLOSED"].includes(filters.status ?? "") ? filters.status : "";
    const plan = planRows.some((row) => row.id === filters.plano) ? filters.plano : "";
    const sort: SaasSort = (["nome", "emprestado", "clientes", "atividade", "vencimento"] as const).find((key) => key === filters.ordem) ?? "nome";
    const filtered = all.filter((row) => (!query || [row.name, row.email ?? "", row.tenantName].some((value) => value.toLocaleLowerCase("pt-BR").includes(query)))
      && (!status || (!row.isPlatformOwner && group(row) === status)) && (!plan || row.planId === plan));
    const byName = (a: SaasClient, b: SaasClient) => a.name.localeCompare(b.name, "pt-BR");
    filtered.sort(sort === "emprestado" ? (a, b) => b.money.lentCents - a.money.lentCents || byName(a, b)
      : sort === "clientes" ? (a, b) => b.clients.total - a.clients.total || byName(a, b)
      : sort === "atividade" ? (a, b) => (b.lastAccessAt ?? "").localeCompare(a.lastAccessAt ?? "") || byName(a, b)
      : sort === "vencimento" ? (a, b) => (a.commercial.nextDueDate ?? "9999").localeCompare(b.commercial.nextDueDate ?? "9999") || byName(a, b)
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
    // Mensalidades registradas da assinatura vigente (as mais recentes primeiro).
    const [current] = await tx.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.tenantId, tenantId)).orderBy(desc(subscriptions.createdAt)).limit(1);
    const charges = current
      ? await tx.select({ id: subscriptionCharges.id, dueDate: subscriptionCharges.dueDate, amountCents: subscriptionCharges.amountCents, status: subscriptionCharges.status, paidAt: subscriptionCharges.paidAt, provider: subscriptionCharges.provider })
        .from(subscriptionCharges).where(eq(subscriptionCharges.subscriptionId, current.id)).orderBy(desc(subscriptionCharges.dueDate)).limit(12)
      : [];
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
      charges,
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

// Catálogo de planos para a área Administração → Planos, com quantos clientes SaaS usam cada um.
export async function loadPlanCatalog() {
  return withPlatformContext(async (tx) => {
    const rows = await tx.select({
      id: plans.id, name: plans.name, slug: plans.slug, description: plans.description, priceInCents: plans.priceInCents, active: plans.active,
      features: plans.features, limits: plans.limits, updatedAt: plans.updatedAt,
      tenantCount: sql<string>`(select count(*) from tenant t where t.plan_id = plan.id and not exists(select 1 from "user" u where u.tenant_id = t.id and u.role = 'SUPER_ADMIN'))`,
    }).from(plans).orderBy(desc(plans.active), asc(plans.name));
    return rows.map((row) => ({ ...row, tenantCount: Number(row.tenantCount), updatedAt: row.updatedAt.toISOString() }));
  });
}

export type PlanCatalogItem = Awaited<ReturnType<typeof loadPlanCatalog>>[number];
