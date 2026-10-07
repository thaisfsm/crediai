import { redirect } from "next/navigation";
import Dashboard from "./dashboard";
import { DatabaseErrorState, databaseGate } from "@/app/database-error-state";
import { requireActiveAccount } from "@/lib/auth/guards";
import { loadTenantPortfolio } from "@/lib/finance/queries";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ tela?: string }> }) {
  // Só banco não configurado vai para /setup; instabilidade ou erro mostram "tente novamente" aqui mesmo.
  const gate = await databaseGate();
  if (gate === "not_configured") redirect("/setup");
  if (gate !== "ok") return <DatabaseErrorState kind={gate} />;
  // Sem sessão vai para /login; conta bloqueada para /account-disabled; senha provisória para /definir-senha.
  const { session, state } = await requireActiveAccount();
  const isSuperAdmin = state.role === "SUPER_ADMIN";
  // MASTER sem tenant próprio só tem a administração global; com tenant, usa a própria carteira aqui normalmente.
  if (!session.user.tenantId) redirect(isSuperAdmin ? "/admin" : "/account-disabled");
  // loadTenantPortfolio passa por requireTenantUser: confere tenant ativo e assinatura válida antes de ler a carteira.
  const portfolio = await loadTenantPortfolio();
  const { tela } = await searchParams;
  return <Dashboard userName={session.user.name} portfolio={portfolio} isSuperAdmin={isSuperAdmin} initialSection={tela} />;
}
