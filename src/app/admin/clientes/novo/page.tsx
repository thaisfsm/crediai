import { todayIso } from "@/lib/finance/format";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { DatabaseErrorState, databaseGate } from "@/app/database-error-state";
import { loadPlans } from "@/lib/admin/queries";
import { AdminShell } from "../../admin-ui";
import SaasClientForm from "../saas-client-form";

export const dynamic = "force-dynamic";

export default async function NewSaasClientPage() {
  // Só banco não configurado vai para /setup; instabilidade ou erro mostram "tente novamente" aqui mesmo.
  const gate = await databaseGate();
  if (gate === "not_configured") redirect("/setup");
  if (gate !== "ok") return <DatabaseErrorState kind={gate} />;
  const session = await requireSuperAdmin();
  const plans = await loadPlans();
  return (
    <AdminShell active="clientes" userName={session.user.name} hasOwnWallet={Boolean(session.user.tenantId)}>
      <section className="central-panel central-narrow">
        <Link href="/admin" className="central-back">← Clientes SaaS</Link>
        <header className="central-panel-head"><div><h2>Novo cliente SaaS</h2><p>Cadastre quem vai usar o CrediAI. Ele recebe o próprio ambiente, isolado dos demais.</p></div></header>
        <SaasClientForm plans={plans} today={todayIso()} />
      </section>
    </AdminShell>
  );
}
