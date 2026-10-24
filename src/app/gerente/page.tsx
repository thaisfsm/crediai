import { redirect } from "next/navigation";
import Dashboard from "../dashboard";
import { DatabaseErrorState, databaseGate } from "@/app/database-error-state";
import { loadManagerPortfolio } from "@/lib/finance/queries";
import { loadManagerPanel } from "@/lib/managers/queries";

export const dynamic = "force-dynamic";

// Painel da gerente de contas: as mesmas telas do dono (visão geral, clientes, operações, pagamentos, cobranças), só com os clientes
// indicados por ela, sem nenhuma edição, sem capital e sem cadastro bancário. Tudo passa por requireAccountManager (sessão, conta ativa,
// papel, tenant ativo e cadastro de gerente ativo) e cada consulta filtra tenant e os clientes dela.
export default async function ManagerPage({ searchParams }: { searchParams: Promise<{ tela?: string }> }) {
  const gate = await databaseGate();
  if (gate === "not_configured") redirect("/setup");
  if (gate !== "ok") return <DatabaseErrorState kind={gate} />;
  const panel = await loadManagerPanel();
  const { portfolio } = await loadManagerPortfolio();
  const { tela } = await searchParams;
  return <Dashboard userName={panel.userName} portfolio={portfolio} payables={null} initialSection={tela} manager={{ panel }} />;
}
