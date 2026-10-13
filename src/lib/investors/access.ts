import "server-only";
import { eq, type SQLWrapper } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { requireActiveAccount, withPlatformContext, withTenantContext, type TenantTransaction } from "@/lib/auth/guards";

// Quem está usando o módulo Investidores. O MASTER (SUPER_ADMIN, conferido de novo no banco por withPlatformContext)
// vê e administra os investidores de todas as carteiras; o usuário do tenant só os da própria (RLS + filtro explícito).
export type InvestorScope = {
  isMaster: boolean;
  // Carteira da sessão: a do usuário do tenant ou, para o MASTER, a carteira própria (null se ele não tiver).
  tenantId: string | null;
  user: { id: string; name: string; email: string };
};

export async function withInvestorContext<T>(operation: (tx: TenantTransaction, scope: InvestorScope) => Promise<T>) {
  // O papel vem do banco (accountState), não da sessão: um rebaixamento vale na hora.
  const { state } = await requireActiveAccount();
  if (state.role === "SUPER_ADMIN") {
    return withPlatformContext((tx, { session }) => operation(tx, { isMaster: true, tenantId: session.user.tenantId ?? null, user: session.user }));
  }
  return withTenantContext((tx, { tenantId, session }) => operation(tx, { isMaster: false, tenantId, user: session.user }));
}

// Filtro por tenant em toda consulta, além do RLS (a produção conecta com um papel que ignora RLS).
// Para o MASTER não há filtro: ele administra todas as carteiras.
export function tenantFilter(scope: InvestorScope, column: PgColumn | SQLWrapper): ReturnType<typeof eq> | undefined {
  if (scope.isMaster) return undefined;
  return eq(column as PgColumn, scope.tenantId ?? "");
}
