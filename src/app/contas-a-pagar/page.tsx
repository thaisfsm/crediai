import { redirect } from "next/navigation";
import { DatabaseErrorState, databaseGate } from "@/app/database-error-state";
import { requireActiveAccount } from "@/lib/auth/guards";
import { loadPayablesPage } from "@/lib/investors/payables-queries";
import { AppShell } from "../app-shell";
import { PayablesHome } from "./payables-ui";

export const dynamic = "force-dynamic";

type Search = { q?: string; de?: string; ate?: string; situacao?: string; tipo?: string };

export default async function PayablesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const gate = await databaseGate();
  if (gate === "not_configured") redirect("/setup");
  if (gate !== "ok") return <DatabaseErrorState kind={gate} />;
  const { session, state } = await requireActiveAccount();
  // Como no Financeiro: MASTER sem carteira própria só tem a administração global.
  if (!session.user.tenantId) redirect(state.role === "SUPER_ADMIN" ? "/admin" : "/account-disabled");
  // withTenantContext: só a carteira da sessão, também para o MASTER (nunca a de outro tenant).
  const data = await loadPayablesPage(await searchParams);
  return (
    <AppShell userName={session.user.name} isSuperAdmin={state.role === "SUPER_ADMIN"} active="Contas a pagar" trail={[{ label: "Contas a pagar" }]}>
      <PayablesHome data={data} />
    </AppShell>
  );
}
