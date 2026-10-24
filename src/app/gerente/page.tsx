import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { DatabaseErrorState, databaseGate } from "@/app/database-error-state";
import { loadManagerPanel } from "@/lib/managers/queries";
import { THEME_COOKIE, type ManagerTheme } from "./theme";
import { ManagerPanelView } from "./manager-panel";
import "./gerente.css";

export const dynamic = "force-dynamic";

export default async function ManagerPage() {
  const gate = await databaseGate();
  if (gate === "not_configured") redirect("/setup");
  if (gate !== "ok") return <DatabaseErrorState kind={gate} />;
  // loadManagerPanel passa por requireAccountManager: sessão, conta ativa, papel de gerente, tenant ativo e cadastro de gerente ativo.
  const panel = await loadManagerPanel();
  const theme: ManagerTheme = (await cookies()).get(THEME_COOKIE)?.value === "roxo" ? "roxo" : "padrao";
  return <ManagerPanelView panel={panel} initialTheme={theme} />;
}
