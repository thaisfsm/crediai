# Testes de ponta a ponta (locais e descartáveis)

Estes testes **alteram dados, encerram sessões e param o PostgreSQL**. Eles se recusam a rodar fora de `localhost`
e nunca devem ser apontados para a produção. Não usam dados financeiros reais: os nomes e valores são fictícios.

| Arquivo | O que prova |
|---|---|
| `isolation.e2e.mjs` | Tenant A não lê nem altera clientes, operações, pagamentos, carteira, documentos, dashboard ou relatórios do tenant B (inclusive forjando ids nas server actions); TENANT_USER não entra na administração, não usa nenhuma ação administrativa, não muda assinatura/plano/valor e não vira SUPER_ADMIN; SUPER_ADMIN acessa a administração. |
| `admin-audit.e2e.mjs` | Cada ação administrativa grava auditoria (quem, quando, cliente SaaS, antes/depois, IP, navegador); tela Auditoria com busca, filtros e ordem; último acesso igual nas três telas; Registros com a conta MASTER e o vencimento original corretos. |
| `browser.e2e.mjs` | Clique no menu antes da hidratação; telas sem rolagem horizontal em 390 px; banco fora do ar sem ir para `/setup` e sem perder a sessão; sessões (várias, saída, vencida, senha provisória). |

## Ambiente

1. PostgreSQL local com as migrations aplicadas e os dados fictícios: tenants `ten_roberio` (A), `ten_fernando` (B),
   `ten_thais` (SUPER_ADMIN com carteira própria), usuários `roberio@`, `fernando@` e `thais@teste.local` com a senha
   `Senha-Teste-Local-123`, clientes/operações/pagamentos de teste (`c_alex`, `op_will`, `pay_will1`…).
2. `pnpm build && pnpm start` com `DATABASE_URL` de um papel **com BYPASSRLS** (como a produção), para provar que o
   isolamento vem dos filtros por tenant no código e não só do RLS. Repetir com um papel sem BYPASSRLS também é útil.
3. Rodar um arquivo por vez (os logins são espaçados por causa do limite de tentativas):

```
E2E_DATABASE_URL=postgres://dono:senha@127.0.0.1:5432/crediai node --test --test-concurrency=1 tests/e2e/isolation.e2e.mjs tests/e2e/admin-audit.e2e.mjs
E2E_DATABASE_URL=… PLAYWRIGHT_MODULE=/caminho/playwright/index.mjs node --test tests/e2e/browser.e2e.mjs
```
