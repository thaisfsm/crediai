import { redirect } from "next/navigation";
import { DatabaseErrorState, databaseGate } from "@/app/database-error-state";
import { requireActiveAccount } from "@/lib/auth/guards";
import { loadManagersPage } from "@/lib/managers/queries";
import { AppShell } from "../app-shell";
import { createManagerAccessAction, createManagerAction, deleteManagerAction, linkClientAction, registerManagerPayoutAction, resetManagerPasswordAction, unlinkClientAction, updateManagerAction } from "./actions";
import { ManagersHome, type ManagerActions } from "./managers-ui";

const actions: ManagerActions = {
  createManager: createManagerAction, updateManager: updateManagerAction, linkClient: linkClientAction, unlinkClient: unlinkClientAction, deleteManager: deleteManagerAction,
  registerPayout: registerManagerPayoutAction, createAccess: createManagerAccessAction, resetPassword: resetManagerPasswordAction,
};

export const dynamic = "force-dynamic";

export default async function ManagersPage() {
  const gate = await databaseGate();
  if (gate === "not_configured") redirect("/setup");
  if (gate !== "ok") return <DatabaseErrorState kind={gate} />;
  const { session, state } = await requireActiveAccount();
  if (!session.user.tenantId) redirect(state.role === "SUPER_ADMIN" ? "/admin" : "/account-disabled");
  // withTenantContext (dentro do loader): só a carteira da sessão; o gerente de contas é mandado para /gerente.
  const data = await loadManagersPage();
  return (
    <AppShell userName={session.user.name} isSuperAdmin={state.role === "SUPER_ADMIN"} active="Gerentes" trail={[{ label: "Gerentes de contas" }]}>
      <ManagersHome data={data} actions={actions} />
    </AppShell>
  );
}
