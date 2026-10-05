import { redirect } from "next/navigation";
import Dashboard from "./dashboard";
import { databaseAvailable } from "@/lib/db";
import { getSession } from "@/lib/auth/guards";
import { loadTenantPortfolio } from "@/lib/finance/queries";

export const dynamic = "force-dynamic";

export default async function Home() {
  if (!(await databaseAvailable())) redirect("/setup");
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.user.active) redirect("/account-disabled");
  const isSuperAdmin = session.user.role === "SUPER_ADMIN";
  // MASTER sem tenant próprio só tem a administração global; com tenant, usa a própria carteira aqui normalmente.
  if (!session.user.tenantId) redirect(isSuperAdmin ? "/admin" : "/account-disabled");
  // loadTenantPortfolio passa por requireTenantUser: confere tenant ativo e assinatura válida antes de ler a carteira.
  const portfolio = await loadTenantPortfolio();
  return <Dashboard userName={session.user.name} portfolio={portfolio} isSuperAdmin={isSuperAdmin} />;
}
