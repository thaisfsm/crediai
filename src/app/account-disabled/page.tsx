import { getSession } from "@/lib/auth/guards";
import { redirect } from "next/navigation";
import SignOutButton from "@/app/sign-out-button";

export const dynamic = "force-dynamic";

export default async function DisabledPage() {
  if (!(await getSession())) redirect("/login");
  return <main className="setup-page"><section className="setup-card"><div className="auth-kicker"><i className="warning-dot" /> ACESSO INDISPONÍVEL</div><h1>Conta desativada</h1><p>Esta conta está suspensa ou precisa de suporte da equipe CrediAI.</p><SignOutButton label="Sair da conta" /></section></main>;
}
