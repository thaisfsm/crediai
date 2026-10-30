import { redirect } from "next/navigation";
import { DatabaseErrorState, databaseGate } from "@/app/database-error-state";
import { requireActiveAccount } from "@/lib/auth/guards";
import { loadFinancePage } from "@/lib/finance/finance-queries";
import { AppShell } from "../app-shell";
import { FinanceHome } from "./finance-ui";

export const dynamic = "force-dynamic";

type Search = { de?: string; ate?: string; tipo?: string; categoria?: string };

export default async function FinancePage({ searchParams }: { searchParams: Promise<Search> }) {
  // Só banco não configurado vai para /setup; instabilidade ou erro mostram "tente novamente" aqui mesmo.
  const gate = await databaseGate();
  if (gate === "not_configured") redirect("/setup");
  if (gate !== "ok") return <DatabaseErrorState kind={gate} />;
  const { session, state } = await requireActiveAccount();
  // MASTER sem carteira própria só tem a administração global, como no dashboard.
  if (!session.user.tenantId) redirect(state.role === "SUPER_ADMIN" ? "/admin" : "/account-disabled");
  // loadFinancePage passa por withTenantContext: tenant ativo, assinatura válida e só a carteira da sessão.
  const data = await loadFinancePage(await searchParams);
  return (
    <AppShell userId={session.user.id} userName={session.user.name} isSuperAdmin={state.role === "SUPER_ADMIN"} active="Financeiro" trail={[{ label: "Financeiro" }]}>
      <FinanceHome data={data} />
    </AppShell>
  );
}
