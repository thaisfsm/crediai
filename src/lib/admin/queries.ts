import "server-only";
import { desc, eq, sql } from "drizzle-orm";
import { withPlatformContext } from "@/lib/auth/guards";
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
