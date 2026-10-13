import { redirect } from "next/navigation";
import { DatabaseErrorState, databaseGate } from "@/app/database-error-state";
import { requireActiveAccount } from "@/lib/auth/guards";
import { loadInvestorsPage } from "@/lib/investors/queries";
import { AppShell } from "../app-shell";
import { InvestorsHome } from "./investor-ui";

export const dynamic = "force-dynamic";

type Search = { q?: string; status?: string; carteira?: string; pagina?: string };

export default async function InvestorsPage({ searchParams }: { searchParams: Promise<Search> }) {
  // Só banco não configurado vai para /setup; instabilidade ou erro mostram "tente novamente" aqui mesmo.
  const gate = await databaseGate();
  if (gate === "not_configured") redirect("/setup");
  if (gate !== "ok") return <DatabaseErrorState kind={gate} />;
  const { session, state } = await requireActiveAccount();
  // loadInvestorsPage confere o acesso no servidor: MASTER (conferido no banco) vê todas as carteiras; usuário do
  // tenant só a própria, e só com tenant ativo e assinatura válida.
  const data = await loadInvestorsPage(await searchParams);
  return (
    <AppShell userName={session.user.name} isSuperAdmin={state.role === "SUPER_ADMIN"} active="Investidores" trail={[{ label: "Investidores" }]}>
      <InvestorsHome data={data} />
    </AppShell>
  );
}
