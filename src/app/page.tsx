import { redirect } from "next/navigation";
import Dashboard from "./dashboard";
import { databaseAvailable } from "@/lib/db";
import { requireActiveAccount } from "@/lib/auth/guards";
import { loadTenantPortfolio } from "@/lib/finance/queries";

export const dynamic = "force-dynamic";

export default async function Home() {
  if (!(await databaseAvailable())) redirect("/setup");
  // Sem sessão vai para /login; conta bloqueada para /account-disabled; senha provisória para /definir-senha.
  const { session, state } = await requireActiveAccount();
  const isSuperAdmin = state.role === "SUPER_ADMIN";
  // MASTER sem tenant próprio só tem a administração global; com tenant, usa a própria carteira aqui normalmente.
  if (!session.user.tenantId) redirect(isSuperAdmin ? "/admin" : "/account-disabled");
  // loadTenantPortfolio passa por requireTenantUser: confere tenant ativo e assinatura válida antes de ler a carteira.
  const portfolio = await loadTenantPortfolio();
  return <Dashboard userName={session.user.name} portfolio={portfolio} isSuperAdmin={isSuperAdmin} />;
}
