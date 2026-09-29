# Arquitetura do CrediAI

## Visão

O CrediAI é um monólito modular web: uma aplicação Next.js concentra páginas e lógica de servidor; PostgreSQL persiste identidade e, futuramente, os dados financeiros. O banco pode ser local ou gerenciado. O runtime recebe `DATABASE_URL`; Drizzle Kit recebe `DATABASE_MIGRATION_URL` para tarefas DDL.

```text
Navegador responsivo
        │ HTTPS
        ▼
Next.js (interface + servidor)
   ├── Better Auth (sessão)
   ├── Drizzle ORM (acesso tipado)
   └── PostgreSQL gerenciado (produção) ou PostgreSQL local opcional
          └── RLS + contexto transacional de tenant
```

## Isolamento de tenant

Usuários normais pertencem a um tenant e recebem o papel `TENANT_USER`. A identidade da sessão no servidor determina o tenant. O contexto `app.tenant_id` e `app.crediai_role` é estabelecido na mesma transação da consulta por `withTenantContext`; políticas RLS são a barreira no banco. `SUPER_ADMIN` é uma função global distinta, usada apenas por rotas administrativas protegidas.

O schema atual contém identidade, tenant, plano e assinatura. RLS está habilitada para tenant, plan e subscription; tabelas futuras de clientes, operações, pagamentos, cobranças e carteira precisam de `tenant_id`, políticas próprias, índices e acesso somente através do contexto autenticado antes de armazenar dados reais. RLS no PostgreSQL não substitui autorização de aplicação nem validação dos papéis.

## Ambientes e configuração

| Ambiente | Aplicação | Banco |
| --- | --- | --- |
| Local sem banco | Next.js e tela de configuração | URLs vazias; nenhuma tentativa de conectar |
| Desenvolvimento integrado | Next.js local | PostgreSQL local opcional ou gerenciado |
| Produção | Next.js hospedado | PostgreSQL gerenciado |

Segredos são fornecidos em ambiente, nunca no código. `.env.local` não deve ser versionado. `DATABASE_MIGRATION_URL` deve ser limitada a migrações e não exposta ao runtime público. Configure uma role de runtime com privilégio mínimo e sem `BYPASSRLS`, respeitando o modelo de permissões suportado pelo provedor.

## Limites conhecidos

- O dashboard ainda usa informação demonstrativa e não persiste operações financeiras.
- Nenhuma migração ou política RLS foi validada contra uma instância PostgreSQL nesta preparação sem banco ativo.
- Autorização, isolamento e RLS precisam de testes de integração com ao menos dois tenants antes de dados financeiros reais.
- Não há gateway, notificações, rotina agendada, armazenamento de arquivos ou recursos de IA funcionais.
