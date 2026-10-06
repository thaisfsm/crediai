import { redirect } from "next/navigation";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { databaseAvailable } from "@/lib/db";
import { loadPlanCatalog } from "@/lib/admin/queries";
import { AdminShell, dateLabel } from "../admin-ui";
import PlanForm from "./plan-form";
import { planPriceLabel } from "@/lib/admin/plan-price";

export const dynamic = "force-dynamic";

// Administração → Planos: produto e preço PADRÃO. O valor que cada cliente paga fica na assinatura dele.
export default async function PlansPage() {
  if (!(await databaseAvailable())) redirect("/setup");
  const session = await requireSuperAdmin();
  const plans = await loadPlanCatalog();

  return (
    <AdminShell active="planos" userName={session.user.name} hasOwnWallet={Boolean(session.user.tenantId)}>
      <section className="central-panel">
        <header className="central-panel-head"><div><h2>Planos</h2><p>O plano define o produto e o preço padrão. Mudar o preço padrão não altera o valor contratado de nenhum cliente: cada assinatura guarda o seu.</p></div></header>
        <div className="plan-grid">
          {plans.map((plan) => (
            <article key={plan.id} className="plan-card">
              <header>
                <div><h3>{plan.name}</h3><p>{plan.description || "Sem descrição"}</p></div>
                <span className={`saas-status saas-status-${plan.active ? "active" : "closed"}`}><i aria-hidden />{plan.active ? "Ativo" : "Inativo"}</span>
              </header>
              <strong className="plan-price">{plan.priceInCents > 0 ? planPriceLabel(plan.priceInCents) : "Preço padrão não definido"}</strong>
              <p>{plan.tenantCount === 1 ? "1 cliente SaaS neste plano" : `${plan.tenantCount} clientes SaaS neste plano`} · atualizado em {dateLabel(plan.updatedAt)}</p>
              <p>Recursos e limites: {Object.keys(plan.features).length + Object.keys(plan.limits).length === 0 ? "ainda não configurados (estrutura pronta)" : `${Object.keys(plan.features).length} recursos, ${Object.keys(plan.limits).length} limites`}</p>
              <details>
                <summary>Editar plano</summary>
                <PlanForm initial={{ planId: plan.id, name: plan.name, description: plan.description, priceInCents: plan.priceInCents, active: plan.active }} />
              </details>
            </article>
          ))}
        </div>
      </section>
      <section className="central-panel central-narrow">
        <header className="central-panel-head"><div><h2>Novo plano</h2><p>Nome, descrição e preço padrão. Pode começar com R$ 0,00 enquanto o preço não estiver definido.</p></div></header>
        <PlanForm />
      </section>
    </AdminShell>
  );
}
