# Preparação de deploy

Este documento prepara o projeto para um deploy futuro. Não há publicação, repositório remoto, domínio ou banco hospedado configurados por este passo.

## Fluxo previsto

```text
Git local → GitHub → integração de deploy Next.js (Vercel a avaliar)
                            └── PostgreSQL gerenciado
```

Vercel é uma opção inicial para hospedar Next.js. O banco deve ser um serviço PostgreSQL gerenciado independente da máquina local. A escolha final do provedor depende de disponibilidade regional, limites gratuitos atuais, backups, pooling, SSL, suporte a RLS e preço após o período gratuito; confirme os termos diretamente antes de contratar.

## Checklist antes do primeiro deploy

1. Criar ou escolher um projeto PostgreSQL gerenciado e habilitar conexões TLS.
2. Criar credenciais distintas para runtime e migrações, se o provedor permitir. A credencial de runtime não deve ter `BYPASSRLS` nem ser superusuária; não disponibilize a credencial DDL ao servidor web.
3. Aplicar as migrations versionadas com `DATABASE_MIGRATION_URL` em uma etapa administrativa protegida, antes de direcionar tráfego à nova versão.
4. Configurar no ambiente hospedado `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` e `NEXT_PUBLIC_APP_URL`. `ADMIN_*` só é necessário temporariamente para bootstrap explícito do primeiro administrador; remova depois.
5. Garantir que `BETTER_AUTH_URL` e `NEXT_PUBLIC_APP_URL` usem a origem HTTPS pública. `NEXT_PUBLIC_APP_URL` é incorporada ao bundle cliente durante o build; configure-a antes de compilar. O segredo de autenticação deve ser aleatório, exclusivo por ambiente e armazenado como secret.
6. Executar `pnpm lint`, `pnpm exec tsc --noEmit` e `pnpm build`; então validar cadastro, login, logout, trial, criação do administrador e isolamento entre tenants em um banco de staging.
7. Configurar domínio e política de backup/retensão do PostgreSQL antes de uso real.

## GitHub e higiene do repositório

- `.gitignore` ignora `.env*`, exceto `.env.example`, além de dependências, build e dados locais.
- Revise `git status` e `git diff --check` antes de cada commit; inspecione os arquivos staged em busca de secrets.
- Nunca adicione `.env.local`, dumps, dados reais, tokens, credenciais, chaves privadas ou URLs de conexão.
- Este preparo não cria remoto nem faz push. Configure a conta e autorize explicitamente qualquer publicação.

## Deploy contínuo e migrations

Para o primeiro ambiente, prefira um deploy manual controlado e migração explícita. Não execute migrations automaticamente em cada instância web ou em múltiplas réplicas. Uma futura pipeline deve aplicar migrations uma vez, com credencial restrita e antes do rollout que dependa do novo schema. Planeje migrations compatíveis com deploy gradual e defina procedimento de backup/restore.

## O que ainda impede uma URL pública

É necessário provisionar e escolher os provedores, inserir segredos nos painéis apropriados, conectar um repositório GitHub, executar migrations, concluir o deploy e validar domínio, auth, RLS e conexões reais. Até essas etapas, `http://localhost:3000` é somente prévia local e não está acessível publicamente.
