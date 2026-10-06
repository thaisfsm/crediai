import AuthForm from "../auth-form";
import { DatabaseErrorState, databaseGate } from "@/app/database-error-state";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/guards";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  // Só banco não configurado vai para /setup; instabilidade ou erro mostram "tente novamente" aqui mesmo.
  const gate = await databaseGate();
  if (gate === "not_configured") redirect("/setup");
  if (gate !== "ok") return <DatabaseErrorState kind={gate} />;
  if (await getSession()) redirect("/");
  return <AuthForm />;
}
