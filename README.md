# CrediAI

**CrediAI** é uma aplicação web responsiva para apoiar a gestão de carteiras de crédito. O projeto está em estágio de fundação: combina uma interface demonstrativa com a base técnica para autenticação, contas SaaS isoladas e persistência em PostgreSQL.

> **Estado da demonstração:** os indicadores e operações exibidos no dashboard são demonstrativos. O motor financeiro, clientes, operações, pagamentos, cobranças reais, relatórios baseados em dados e notificações ainda estão em desenvolvimento. Não use os números da interface para decisões financeiras.

## Objetivo

Preparar uma plataforma SaaS em que cada cliente tenha seu próprio ambiente. A arquitetura separa a administração da plataforma dos usuários de tenant e usa PostgreSQL com políticas Row-Level Security (RLS) como defesa adicional no banco.

## Estado atual

### Disponível na fundação

- Interface dark/tech responsiva do CrediAI com dashboard demonstrativo.
- Cadastro e login por e-mail e senha usando Better Auth.
- Estrutura de usuários, tenant, plano inicial e assinatura de trial de 14 dias.
- Papéis `TENANT_USER` e `SUPER_ADMIN`, guardas de rota e área administrativa inicial.
- Schema PostgreSQL tipado com Drizzle, migration inicial e políticas RLS para tenants, planos e assinaturas.
- Tela de configuração quando não há conexão PostgreSQL disponível.

### Em desenvolvimento

- Gestão persistente de clientes, operações de crédito, pagamentos, cobranças e histórico.
- Regras e cálculos financeiros, relatórios e evolução real da carteira.
- Notificações, rotina programada de cobranças, integrações de pagamento e recursos de IA.
- Validação de integração e isolamento RLS contra um PostgreSQL de staging.

## Stack

- Next.js 16.3.6 (App Router), React 19 e TypeScript
- Better Auth para autenticação e sessões
- PostgreSQL, Drizzle ORM e migrations SQL
- Row-Level Security (RLS) do PostgreSQL
- CSS e Tailwind CSS 4
- pnpm 11.25.0
- Node.js 20.9 ou superior

## Arquitetura resumida

```text
Navegador responsivo
        │
        ▼
Next.js (interface e lógica de servidor)
   ├── Better Auth (identidade e sessão)
   ├── Drizzle ORM (acesso PostgreSQL tipado)
   └── PostgreSQL (dados e políticas RLS)
```

### Autenticação, tenants e trial

Better Auth gerencia login por e-mail/senha e sessões. No cadastro, a fundação cria um usuário `TENANT_USER`, seu tenant e uma assinatura de avaliação de 14 dias associada ao plano inicial. A criação do primeiro `SUPER_ADMIN` é um comando administrativo separado.

O tenant de uma requisição deve ser derivado da sessão no servidor, nunca de um identificador confiado vindo do navegador. `withTenantContext` configura o contexto de tenant e papel na mesma transação das consultas que usam RLS. A migration habilita RLS para tenant, plano e assinatura. Ainda não existem tabelas de dados financeiros; cada módulo futuro precisa de schema, políticas, autorização de servidor e testes de isolamento próprios antes de armazenar dados reais.

### Estrutura do projeto

```text
src/app/          rotas, páginas, interface e endpoint Better Auth
src/lib/auth/     guardas de sessão e autorização
src/lib/db/       cliente PostgreSQL e schema Drizzle
drizzle/          migrations e snapshots versionados
database/init/    criação opcional do papel de runtime no Compose local
scripts/          comandos administrativos explícitos
docs/             arquitetura e preparação de deploy
public/           assets usados pela aplicação
```

## Executar localmente

Pré-requisitos: Node.js 20.9+ e pnpm 11.25.0.

```powershell
pnpm install --frozen-lockfile
Copy-Item .env.example .env.local
```

Edite `.env.local` e substitua `BETTER_AUTH_SECRET` por um segredo aleatório local. Para executar apenas a interface, mantenha `DATABASE_URL` e `DATABASE_MIGRATION_URL` vazias:

```powershell
pnpm dev --hostname 127.0.0.1
```

Abra [http://localhost:3000](http://localhost:3000). Sem banco, o CrediAI apresenta a tela de configuração; cadastro, login e persistência ficam indisponíveis. Esse modo não usa Docker.

## Conectar um PostgreSQL sem Docker

É possível usar uma instância PostgreSQL local ou gerenciada sem executar o Compose. Configure em `.env.local`:

| Variável | Uso |
| --- | --- |
| `DATABASE_URL` | Conexão da aplicação em runtime |
| `DATABASE_MIGRATION_URL` | Conexão administrativa usada pelo Drizzle Kit para migrations |
| `BETTER_AUTH_SECRET` | Segredo exclusivo para assinar/verificar sessões |
| `BETTER_AUTH_URL` | URL base do Better Auth |
| `NEXT_PUBLIC_APP_URL` | URL pública usada pelo cliente Better Auth; configure antes do build/deploy |
| `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Valores temporários para o bootstrap explícito do primeiro administrador |

Nunca use a credencial de migrations como `DATABASE_URL` de runtime. Em produção, mantenha `DATABASE_MIGRATION_URL` fora das variáveis disponíveis ao servidor web; use uma role runtime de privilégio mínimo, sem superusuário ou `BYPASSRLS`.

Depois de configurar uma instância de desenvolvimento:

```powershell
pnpm db:migrate
pnpm dev --hostname 127.0.0.1
```

Para criar o primeiro administrador, preencha temporariamente `ADMIN_NAME`, `ADMIN_EMAIL` e `ADMIN_PASSWORD` e execute `pnpm admin:create`. Remova esses valores do ambiente após o bootstrap. O comando não eleva nem redefine contas existentes.

### PostgreSQL local opcional via Docker Compose

O `compose.yaml` é uma alternativa para quem deseja banco local em container. Ele não faz parte do fluxo padrão e agora exige senhas fornecidas no ambiente em vez de armazenar senhas fixas no arquivo:

```powershell
$env:CREDIAI_POSTGRES_OWNER_PASSWORD = "<senha-local-aleatoria>"
$env:CREDIAI_POSTGRES_APP_PASSWORD = "<outra-senha-local-aleatoria>"
docker compose up -d db
```

Configure então as URLs PostgreSQL locais em `.env.local`. O Docker Desktop não é necessário para executar a interface sem banco nem para usar um PostgreSQL externo.

## Migrations

O schema de referência está em `src/lib/db/schema.ts`; migrations SQL aplicáveis e snapshots ficam em `drizzle/`.

```powershell
pnpm db:generate
pnpm db:migrate
```

`db:generate` produz uma migration a partir das mudanças do schema. Revise e versione a migration gerada. `db:migrate` aplica as migrations pendentes usando `DATABASE_MIGRATION_URL`. Execute migrations uma vez por ambiente, antes de disponibilizar código que dependa do novo schema; não as acople à inicialização de cada instância web.

Os scripts de banco e bootstrap carregam o arquivo local `.env.local`. Em CI ou em um ambiente administrativo que injete variáveis diretamente no processo, execute o Drizzle Kit/tsx diretamente (`pnpm exec drizzle-kit migrate` ou `pnpm exec tsx scripts/create-super-admin.ts`) para usar as variáveis já fornecidas pelo ambiente.

## Validação local

```powershell
pnpm lint
pnpm exec tsc --noEmit
pnpm build
```

## Deploy

O projeto ainda não foi publicado e não há provedor PostgreSQL configurado. Para o caminho proposto GitHub → Vercel → PostgreSQL gerenciado, siga [docs/DEPLOY.md](docs/DEPLOY.md). A versão online precisa de segredos configurados no ambiente da hospedagem, migrations aplicadas e validação de auth/RLS com banco de staging. Não coloque `.env.local`, secrets, credenciais ou dados reais no GitHub.

## Documentação

- [Arquitetura e limites atuais](docs/ARQUITETURA.md)
- [Preparação de deploy](docs/DEPLOY.md)
