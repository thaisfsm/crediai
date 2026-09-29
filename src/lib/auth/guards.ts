import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, inArray, isNull, or, sql, gt } from "drizzle-orm";
import { db } from "@/lib/db";
import { subscriptions, tenants } from "@/lib/db/schema";

export async function getSession() {
  const { auth } = await import("@/lib/auth");
  return auth.api.getSession({ headers: await headers() });
}

export async function requireTenantUser() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.user.active) redirect("/account-disabled");
  if (session.user.role !== "TENANT_USER" || !session.user.tenantId) redirect("/admin");
  const tenantId = session.user.tenantId;
  const tenantAllowed = await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.crediai_role', 'TENANT_USER', true)`);
    const tenant = await tx.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
    if (!tenant || !["TRIALING", "ACTIVE"].includes(tenant.status)) return false;
    const subscription = await tx.query.subscriptions.findFirst({
      where: and(
        eq(subscriptions.tenantId, tenantId),
        inArray(subscriptions.status, ["TRIALING", "ACTIVE"]),
        or(isNull(subscriptions.expiresAt), gt(subscriptions.expiresAt, new Date())),
      ),
    });
    return Boolean(subscription);
  });
  if (!tenantAllowed) redirect("/account-disabled");
  return { session, tenantId: session.user.tenantId };
}

export async function requireSuperAdmin() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.user.active) redirect("/account-disabled");
  if (session.user.role !== "SUPER_ADMIN") redirect("/");
  return session;
}

export async function withTenantContext<T>(operation: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>) {
  const { tenantId, session } = await requireTenantUser();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.crediai_role', ${session.user.role}, true)`);
    return operation(tx);
  });
}

export async function withPlatformContext<T>(operation: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>) {
  const session = await requireSuperAdmin();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', '', true), set_config('app.crediai_role', ${session.user.role}, true)`);
    return operation(tx);
  });
}
