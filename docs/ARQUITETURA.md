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

O schema contém identidade, tenant, plano, assinatura e a carteira financeira (`wallet`, `capital_movement`, `client`, `loan_operation`, `payment`). RLS está habilitada e forçada em todas as tabelas de tenant. As tabelas financeiras usam chaves estrangeiras compostas `(tenant_id, id)`, então uma operação só aponta para cliente do mesmo tenant e um pagamento só aponta para operação do mesmo tenant. O código em `src/lib/finance/queries.ts` e `src/app/actions.ts` também filtra por `tenant_id` explicitamente, para que o isolamento se mantenha mesmo que a role de runtime tenha `BYPASSRLS`. RLS no PostgreSQL não substitui autorização de aplicação nem validação dos papéis.

## Ambientes e configuração

| Ambiente | Aplicação | Banco |
| --- | --- | --- |
| Local sem banco | Next.js e tela de configuração | URLs vazias; nenhuma tentativa de conectar |
| Desenvolvimento integrado | Next.js local | PostgreSQL local opcional ou gerenciado |
| Produção | Next.js hospedado | PostgreSQL gerenciado |

Segredos são fornecidos em ambiente, nunca no código. `.env.local` não deve ser versionado. `DATABASE_MIGRATION_URL` deve ser limitada a migrações e não exposta ao runtime público. Configure uma role de runtime com privilégio mínimo e sem `BYPASSRLS`, respeitando o modelo de permissões suportado pelo provedor.

## Limites conhecidos

- As regras financeiras ficam só em `src/lib/finance/rules.ts`: cálculo da operação (principal + taxa única), apropriação dos pagamentos (juros pendentes primeiro, depois principal) e limite do pagamento ao saldo em aberto. Capital disponível = capital inicial (`wallet`) + aportes − retiradas − estornos de aporte (`capital_movement`) − principal das operações não excluídas + pagamentos recebidos. Operação excluída fica com status `CANCELED` (só sem pagamentos); cliente com histórico é arquivado (`client.archived_at`) e só cliente sem nenhuma operação é apagado (a política de DELETE de `client` permite apagar só do próprio tenant). A divisão juros/principal de cada pagamento é calculada a partir da tabela `payment`, sem coluna extra. A carteira tem ciclos: `wallet.cycle_number` é o ciclo atual e operações e movimentos de capital guardam o ciclo em que foram lançados (pagamentos seguem a operação). "Zerar carteira" registra o ciclo em `wallet_cycle` e abre o seguinte com capital inicial 0, sem apagar nada; telas e cards usam só o ciclo atual. A rentabilidade por cliente e da carteira (`summarizeOperations` em `src/lib/finance/portfolio.ts`) usa só pagamentos registrados. Parcelas, multa, juros de mora e renegociação ainda precisam ser definidos.
- Nenhuma migração ou política RLS foi validada contra uma instância PostgreSQL nesta preparação sem banco ativo.
- Autorização, isolamento e RLS precisam de testes de integração com ao menos dois tenants antes de dados financeiros reais.
- Não há gateway, notificações, rotina agendada, armazenamento de arquivos ou recursos de IA funcionais.
