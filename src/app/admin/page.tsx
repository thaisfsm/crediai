import { requireSuperAdmin } from "@/lib/auth/guards";
import { databaseAvailable } from "@/lib/db";
import { redirect } from "next/navigation";
import SignOutButton from "@/app/sign-out-button";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  if (!(await databaseAvailable())) redirect("/setup");
  const session = await requireSuperAdmin();
  return <main className="setup-page"><section className="setup-card"><div className="auth-kicker"><i /> CREDIAI · PLATAFORMA</div><h1>Administração da plataforma</h1><p>Olá, {session.user.name}. Este ambiente está reservado à administração global. Contas, planos e licenças serão habilitados nas próximas etapas.</p><div className="admin-modules"><span>Tenants isolados</span><span>Planos</span><span>Licenças e assinaturas</span></div><SignOutButton label="Sair da plataforma" /></section></main>;
}
