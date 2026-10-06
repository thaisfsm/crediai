import Link from "next/link";
import { databaseStatus } from "@/lib/db";
import { DatabaseErrorState } from "@/app/database-error-state";

export const dynamic = "force-dynamic";

// /setup só explica a configuração quando DATABASE_URL não existe. Banco configurado e fora do ar (ou com erro) mostra
// a mesma tela de nova tentativa das outras páginas, e banco no ar manda de volta para o app.
export default async function SetupPage() {
  const status = await databaseStatus();
  if (status === "unavailable" || status === "error") return <DatabaseErrorState kind={status} />;
  if (status === "ok") {
    return <main className="setup-page"><section className="setup-card"><div className="auth-kicker"><i /> BANCO DE DADOS CONECTADO</div><h1>Tudo certo com o banco de dados</h1><p>O CrediAI está conectado ao PostgreSQL. Você pode voltar para o sistema.</p>{process.env.NODE_ENV !== "production" && <p className="setup-note">Ambiente local novo? Aplique o esquema com <code>pnpm db:migrate</code> e crie a conta administrativa com <code>pnpm admin:create</code>.</p>}<Link href="/" className="auth-submit">Ir para o CrediAI <span>→</span></Link></section></main>;
  }
  return <main className="setup-page"><section className="setup-card"><div className="auth-kicker"><i /> CONFIGURAÇÃO</div><h1>Conecte o PostgreSQL gerenciado</h1><p>O banco de dados ainda não foi configurado neste ambiente (`DATABASE_URL` ausente).</p><ol><li>Configure `DATABASE_URL` com a URL PostgreSQL de runtime.</li><li>Configure `DATABASE_MIGRATION_URL` para executar as migrations.</li><li>Reinicie o servidor e aplique <code>pnpm db:migrate</code>.</li></ol><p className="setup-note">Sem banco, autenticação e áreas privadas permanecem protegidas.</p><Link href="/" className="auth-submit">Verificar novamente <span>→</span></Link></section></main>;
}
