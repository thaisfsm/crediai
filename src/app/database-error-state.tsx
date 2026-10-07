import type { DatabaseStatus } from "@/lib/db";
import { databaseStatus } from "@/lib/db";
import RetryButton from "./retry-button";

// Porta de entrada das páginas: "ok" segue; "not_configured" vai para /setup; falha temporária ou erro mostram
// DatabaseErrorState no lugar da página, sem redirecionar, sem encerrar a sessão e sem alterar dados.
export const databaseGate = databaseStatus;

const COPY: Record<Exclude<DatabaseStatus, "ok" | "not_configured">, { kicker: string; title: string; text: string }> = {
  unavailable: {
    kicker: "INSTABILIDADE TEMPORÁRIA",
    title: "Não conseguimos falar com o banco de dados agora",
    text: "Seus dados estão preservados e sua sessão continua aberta. Isso costuma se resolver em poucos segundos: tente novamente.",
  },
  error: {
    kicker: "ERRO AO CARREGAR",
    title: "Não foi possível carregar esta página",
    text: "Seus dados estão preservados e sua sessão continua aberta. Tente novamente; se o erro continuar, avise o suporte do CrediAI.",
  },
};

export function DatabaseErrorState({ kind }: { kind: Exclude<DatabaseStatus, "ok" | "not_configured"> }) {
  const copy = COPY[kind];
  return (
    <main className="setup-page" data-database-status={kind}>
      <section className="setup-card" role="alert">
        <div className="auth-kicker"><i /> {copy.kicker}</div>
        <h1>{copy.title}</h1>
        <p>{copy.text}</p>
        <RetryButton />
      </section>
    </main>
  );
}
