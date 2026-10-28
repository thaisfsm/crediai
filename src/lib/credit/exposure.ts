import { and, eq, sql } from "drizzle-orm";
import type { TenantTransaction } from "@/lib/auth/guards";
import { clients, loanOperations } from "@/lib/db/schema";

// Principal das operações em aberto da carteira, somado por CPF do cliente (só dígitos).
export async function openExposureByCpf(tx: TenantTransaction, tenantId: string): Promise<Map<string, number>> {
  const cpf = sql<string>`regexp_replace(${clients.document}, '\\D', '', 'g')`;
  const rows = await tx.select({ cpf, total: sql<string>`coalesce(sum(${loanOperations.principalCents}), 0)` })
    .from(loanOperations).innerJoin(clients, and(eq(clients.id, loanOperations.clientId), eq(clients.tenantId, loanOperations.tenantId)))
    .where(and(eq(loanOperations.tenantId, tenantId), eq(loanOperations.status, "OPEN"), sql`${clients.document} is not null`)).groupBy(cpf);
  return new Map(rows.map((row) => [row.cpf, Number(row.total)]));
}

// CPFs (só dígitos) que já tiveram alguma operação na carteira, em qualquer situação: quem não está aqui é cliente novo.
export async function cpfsWithOperations(tx: TenantTransaction, tenantId: string): Promise<Set<string>> {
  const cpf = sql<string>`regexp_replace(${clients.document}, '\\D', '', 'g')`;
  const rows = await tx.selectDistinct({ cpf }).from(loanOperations)
    .innerJoin(clients, and(eq(clients.id, loanOperations.clientId), eq(clients.tenantId, loanOperations.tenantId)))
    .where(and(eq(loanOperations.tenantId, tenantId), sql`${clients.document} is not null`));
  return new Set(rows.map((row) => row.cpf));
}
