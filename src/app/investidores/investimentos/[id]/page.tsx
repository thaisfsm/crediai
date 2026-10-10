import { notFound, redirect } from "next/navigation";
import { DatabaseErrorState, databaseGate } from "@/app/database-error-state";
import { requireActiveAccount } from "@/lib/auth/guards";
import { loadInvestmentDetail } from "@/lib/investors/queries";
import { AppShell } from "../../../app-shell";
import { InvestmentDetailView } from "../../investor-ui";

export const dynamic = "force-dynamic";

export default async function InvestmentPage({ params }: { params: Promise<{ id: string }> }) {
  const gate = await databaseGate();
  if (gate === "not_configured") redirect("/setup");
  if (gate !== "ok") return <DatabaseErrorState kind={gate} />;
  const { session, state } = await requireActiveAccount();
  // Investimento de outra carteira (para quem não é MASTER) responde como inexistente.
  const data = await loadInvestmentDetail((await params).id);
  if (!data) notFound();
  return (
    <AppShell userName={session.user.name} isSuperAdmin={state.role === "SUPER_ADMIN"} active="Investidores"
      trail={[{ label: "Investidores", href: "/investidores" }, { label: data.investor.name, href: `/investidores/${data.investor.id}` }, { label: "Investimento" }]}>
      <InvestmentDetailView data={data} />
    </AppShell>
  );
}
