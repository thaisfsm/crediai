import { redirect } from "next/navigation";
import { requireActiveAccount } from "@/lib/auth/guards";
import { DatabaseErrorState, databaseGate } from "@/app/database-error-state";
import PasswordForm from "./password-form";

export const dynamic = "force-dynamic";

export default async function DefinePasswordPage() {
  // Só banco não configurado vai para /setup; instabilidade ou erro mostram "tente novamente" aqui mesmo.
  const gate = await databaseGate();
  if (gate === "not_configured") redirect("/setup");
  if (gate !== "ok") return <DatabaseErrorState kind={gate} />;
  const { session, state } = await requireActiveAccount({ allowTemporaryPassword: true });
  if (!state.mustChangePassword) redirect("/");
  return <PasswordForm email={session.user.email} />;
}
