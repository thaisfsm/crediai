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

- As regras financeiras ficam só em `src/lib/finance/rules.ts`: cálculo da operação (principal + taxa única), apropriação dos pagamentos (juros pendentes primeiro, depois principal) e limite do pagamento ao saldo em aberto. Capital disponível = capital inicial (`wallet`) + aportes − retiradas − estornos de aporte (`capital_movement`) − principal das operações não excluídas + pagamentos recebidos. Operação excluída fica com status `CANCELED` (só sem pagamentos); cliente com histórico é arquivado (`client.archived_at`) e só cliente sem nenhuma operação é apagado (a política de DELETE de `client` permite apagar só do próprio tenant). A divisão juros/principal de cada pagamento é calculada a partir da tabela `payment`, sem coluna extra. A carteira tem ciclos: `wallet.cycle_number` é o ciclo atual e operações e movimentos de capital guardam o ciclo em que foram lançados (pagamentos seguem a operação). "Zerar carteira" registra o ciclo em `wallet_cycle` e abre o seguinte com capital inicial 0, sem apagar nada; telas e cards usam só o ciclo atual. Pagamento registrado pode ser corrigido (valor, data, observação): a linha de `payment` é atualizada e os valores de antes e depois ficam em `payment_revision`; a situação da operação e o capital são recalculados, e uma redução que deixaria o capital disponível negativo é bloqueada. A rentabilidade por cliente e da carteira (`summarizeOperations` em `src/lib/finance/portfolio.ts`) usa só pagamentos registrados.
- Renovação (regra oficial): pagar exatamente os juros pendentes do período, com principal em aberto, grava o pagamento e uma linha em `loan_renewal` (período, vencimento antes e depois, principal base e juros do novo período = taxa × principal em aberto, sem juros sobre juros) e avança `loan_operation.due_date` (+30 dias ou o informado). Os juros contratados de uma operação são os do período original mais os de cada renovação; a apropriação continua juros primeiro, então o valor para quitação volta a ser principal + juros do período. O valor de um pagamento de renovação não pode ser corrigido (só data e observação).
- Cadastro completo do cliente: endereços residencial e comercial, duas referências e avalista ficam em colunas de `client`. O CEP é consultado no navegador (ViaCEP, com a BrasilAPI como reserva) e os campos continuam editáveis. Documentos ficam em `client_document` (PDF/JPG/PNG/WEBP de até 5 MB, conferidos pelo conteúdo), ligados ao cliente por FK composta com ON DELETE CASCADE; o download passa por `/documentos/[id]` com o contexto do tenant.
- Modalidades de operação (`loan_operation.modality`): `SINGLE` (pagamento único, com a renovação acima; o novo período vence no mesmo dia do mês seguinte) e `INSTALLMENT` (parcelado: valor presente, parcela fixa `installment_cents`, `installment_count` parcelas mensais a partir de `first_due_date`; total = PMT × parcelas, lucro = total − valor presente, taxa mensal calculada pela tabela Price). No parcelado cada pagamento é dividido entre juros e principal na proporção do contrato e cobre as parcelas em ordem.
- Datas são escolhidas no componente `src/app/date-field.tsx` (calendário próprio; aceita datas passadas, atuais e futuras).
- Multa e juros de mora ainda precisam ser definidos.
- Nenhuma migração ou política RLS foi validada contra uma instância PostgreSQL nesta preparação sem banco ativo.
- Autorização, isolamento e RLS precisam de testes de integração com ao menos dois tenants antes de dados financeiros reais.
- Não há gateway, notificações, rotina agendada, armazenamento de arquivos ou recursos de IA funcionais.
