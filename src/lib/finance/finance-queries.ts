import "server-only";
import { eq } from "drizzle-orm";
import { withTenantContext, type TenantTransaction } from "@/lib/auth/guards";
import { users, wallets } from "@/lib/db/schema";
import { financeRows, financeStatement, parseFinanceFilters, presetPeriods } from "./cashflow";
import { todayIso } from "./format";
import { loadTenantPortfolios } from "./summaries";

type WalletRow = typeof wallets.$inferSelect;
// Primeiro dia do ciclo atual da carteira (o mesmo que abre o extrato do capital).
export const cycleStartedOn = (wallet: Pick<WalletRow, "cycleStartedAt" | "createdAt"> | undefined) => (wallet ? todayIso(wallet.cycleStartedAt ?? wallet.createdAt) : null);

// Carteira do ciclo atual do tenant da sessão, pelo mesmo buildPortfolio do dashboard: o Financeiro lê o saldo e o
// extrato daqui e nunca guarda um saldo próprio.
export async function tenantCapital(tx: TenantTransaction, tenantId: string) {
  const portfolio = (await loadTenantPortfolios(tx, [tenantId])).get(tenantId);
  if (!portfolio) throw new Error("Carteira não carregada.");
  return portfolio;
}

// Página Financeiro: o tenant vem só da sessão (withTenantContext: TENANT_USER ou MASTER na própria carteira).
export async function loadFinancePage(search: { de?: string; ate?: string; tipo?: string; categoria?: string }) {
  return withTenantContext(async (tx, { tenantId }) => {
    const wallet = await tx.query.wallets.findFirst({ where: eq(wallets.tenantId, tenantId) });
    const portfolio = await tenantCapital(tx, tenantId);
    // Quem lançou: só usuários do mesmo tenant (a tabela de usuários não tem RLS, por isso o filtro explícito).
    const people = await tx.select({ id: users.id, name: users.name }).from(users).where(eq(users.tenantId, tenantId));
    const today = todayIso();
    const startedOn = cycleStartedOn(wallet);
    const filters = parseFinanceFilters(search, today, startedOn);
    const rows = financeRows(portfolio.capitalLedger, new Map(people.map((person) => [person.id, person.name])));
    return {
      today, cycleStartedOn: startedOn, hasWallet: Boolean(wallet), cycleNumber: portfolio.summary.cycleNumber,
      availableCents: portfolio.summary.availableCents, filters, presets: presetPeriods(today, startedOn),
      statement: financeStatement(rows, filters),
    };
  });
}

export type FinancePageData = Awaited<ReturnType<typeof loadFinancePage>>;
