import Link from "next/link";
import { databaseAvailable, databaseConfigured } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  if (await databaseAvailable()) return <main className="setup-page"><section className="setup-card"><div className="auth-kicker"><i /> POSTGRESQL CONECTADO</div><h1>Ambiente pronto para migração</h1><p>O PostgreSQL configurado está acessível. Execute <code>pnpm db:migrate</code> para criar o esquema CrediAI.</p><ol><li>Confirme `DATABASE_URL` e `DATABASE_MIGRATION_URL` em <code>.env.local</code>.</li><li>Aplique as migrations usando a URL de migração.</li><li>Crie a conta administrativa com <code>pnpm admin:create</code>.</li></ol></section></main>;
  return <main className="setup-page"><section className="setup-card"><div className="auth-kicker"><i /> CONFIGURAÇÃO LOCAL</div><h1>{databaseConfigured ? "PostgreSQL gerenciado indisponível" : "Conecte o PostgreSQL gerenciado"}</h1><p>O CrediAI pode ser executado localmente sem Docker. Para habilitar cadastro e login, configure a conexão PostgreSQL gerenciada em `DATABASE_URL`.</p><ol><li>Configure `DATABASE_URL` com a URL PostgreSQL de runtime.</li><li>Configure `DATABASE_MIGRATION_URL` para executar as migrations.</li><li>Reinicie o servidor local e aplique <code>pnpm db:migrate</code>.</li></ol><p className="setup-note">Os dados demonstrativos não são persistidos. Sem banco, autenticação e áreas privadas permanecem protegidas.</p><Link href="/" className="auth-submit">Verificar novamente <span>→</span></Link></section></main>;
}
