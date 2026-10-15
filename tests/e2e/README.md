# Testes de ponta a ponta (locais e descartáveis)

Estes testes **alteram dados, encerram sessões e param o PostgreSQL**. Eles se recusam a rodar fora de `localhost`
e nunca devem ser apontados para a produção. Não usam dados financeiros reais: os nomes e valores são fictícios.

| Arquivo | O que prova |
|---|---|
| `isolation.e2e.mjs` | Tenant A não lê nem altera clientes, operações, pagamentos, carteira, documentos, dashboard ou relatórios do tenant B (inclusive forjando ids nas server actions); TENANT_USER não entra na administração, não usa nenhuma ação administrativa, não muda assinatura/plano/valor e não vira SUPER_ADMIN; SUPER_ADMIN acessa a administração. |
| `admin-audit.e2e.mjs` | Cada ação administrativa grava auditoria (quem, quando, cliente SaaS, antes/depois, IP, navegador); tela Auditoria com busca, filtros e ordem; último acesso igual nas três telas; Registros com a conta MASTER e o vencimento original corretos. |
| `investors.e2e.mjs` | Investidores: cadastro, edição e status; investimentos com período da taxa explícito; lista, busca, filtros e fichas; documentos do investimento (enviar, visualizar, baixar, substituir com histórico); contatos e redes sociais do cliente; TENANT_USER não acessa outro tenant (páginas, download e ações com ids forjados); MASTER vê e administra todas as carteiras; auditoria sem conteúdo sensível; nenhum dado financeiro alterado. |
| `investor-contract.e2e.mjs` | Contrato de investimento gerado: geração recusada com a lista do que falta; empresa contratante (rascunho × confirmada, sempre no tenant do investimento); PDF com os dados corretos; visualizar e baixar; sem versão repetida; marcar como enviado; contrato assinado ligado à versão assinada; nova versão só com confirmação, sem tocar no assinado; geração simultânea sem duplicata; outro tenant recebe 404/"não encontrado"; MASTER gera em qualquer carteira; período "outro" e investimento cancelado; fluxo atual de documentos; nada fora do módulo muda. |
| `financeiro.e2e.mjs` | Módulo Financeiro: menu e painel com o saldo igual ao do dashboard; aporte, outras entradas e saídas (salário) somando/subtraindo uma única vez; empréstimo e recebimento pelos fluxos atuais sem lançamento duplicado (recebimento dividido em principal e juros); envio repetido e simultâneo gravado uma vez; valores zero/negativos, categoria, data e descrição inválidos recusados; saída maior que o saldo (hoje ou retroativa) recusada; falha simulada na auditoria desfaz tudo; tenant vem da sessão (A não vê nem grava em B); MASTER na própria carteira; filtros; telas existentes e dados do tenant B intactos. |
| `cobrancas.e2e.mjs` | Cobranças no navegador: "Em aberto" com as vencidas (a mais antiga primeiro), depois hoje e as futuras; parcelado pela 1ª parcela pendente e parcial na data original; quitada fora; as cinco abas com filtro, ordem crescente e contador iguais à lista, sem duplicata; empate pelo nome do cliente; depois de quitar ou renovar pela tela a lista se reordena sozinha; abrir a tela não grava nada; cada tenant vê só as próprias cobranças e o tenant B fica intacto. |
| `grafico-carteira.e2e.mjs` | Gráfico "Evolução da carteira" (só leitura): sem `<title>` no SVG; em 7D, 30D e 90D, no desktop e no celular, cada bolinha mostra no tooltip a própria data e o próprio saldo a receber (iguais à série enviada pelo servidor), junto da bolinha e dentro da tela; o foco pelo teclado mostra o mesmo tooltip; sem rolagem horizontal. |
| `clientes.e2e.mjs` | Clientes: CPF e CNPJ com dígitos verificadores recusados no servidor (e avisados na tela); o mesmo CPF uma vez por carteira (arquivados contam, outra carteira pode repetir, cadastros simultâneos gravam um só); CPF antigo sem alteração continua aceito; empresa e dados bancários com Pix conferidos; busca no servidor por nome sem acentos/em partes, CPF e telefone com ou sem máscara; a busca e a edição nunca alcançam outro tenant; tela de busca e ficha no desktop e no celular; nada que já existia muda. |
| `parcelado-quinzenal.e2e.mjs` | Parcelado quinzenal: R$ 600 em 3 × R$ 300 com vencimentos 06/11, 21/11 e 06/12; o banco só aceita parcelado quinzenal com parcelas coerentes; pagamento parcial, atraso e quitação; capital soma cada pagamento uma vez; prévia dos vencimentos na tela (desktop e celular); formulário sem periodicidade continua mensal; operações antigas não mudam. |
| `investidores-cronograma.e2e.mjs` | Investidores (Etapa B): CPF/CNPJ com dígitos verificadores; dados bancários e Pix gravados e fora da auditoria; identificação do contrato única por carteira; histórico de alterações do contrato e do cronograma; cronograma com os valores digitados, sem duplicar em reenvio ou envio simultâneo; incluir, editar e retirar pagamento; isolamento entre tenants com ids forjados; MASTER; investimento cancelado só para consulta; prévia das datas na tela (desktop e celular); nada fora do módulo muda. |
| `browser.e2e.mjs` | Clique no menu antes da hidratação; telas sem rolagem horizontal em 390 px; banco fora do ar sem ir para `/setup` e sem perder a sessão; sessões (várias, saída, vencida, senha provisória). |

## Ambiente

1. PostgreSQL local com as migrations aplicadas e os dados fictícios: tenants `ten_roberio` (A), `ten_fernando` (B),
   `ten_thais` (SUPER_ADMIN com carteira própria), usuários `roberio@`, `fernando@` e `thais@teste.local` com a senha
   `Senha-Teste-Local-123`, clientes/operações/pagamentos de teste (`c_alex`, `op_will`, `pay_will1`…).
2. `pnpm build && pnpm start` com `DATABASE_URL` de um papel **com BYPASSRLS** (como a produção), para provar que o
   isolamento vem dos filtros por tenant no código e não só do RLS. Repetir com um papel sem BYPASSRLS também é útil.
3. Rodar um arquivo por vez (os logins são espaçados por causa do limite de tentativas):

```
E2E_DATABASE_URL=postgres://dono:senha@127.0.0.1:5432/crediai node --test --test-concurrency=1 tests/e2e/investor-contract.e2e.mjs tests/e2e/investors.e2e.mjs tests/e2e/isolation.e2e.mjs tests/e2e/admin-audit.e2e.mjs
E2E_DATABASE_URL=… PLAYWRIGHT_MODULE=/caminho/playwright/index.mjs node --test tests/e2e/browser.e2e.mjs
```
