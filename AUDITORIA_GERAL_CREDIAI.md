# CrediAI · Auditoria geral de requisitos, implementação, testes e produção

**Data:** 14/10/2026 · **Pedido:** mensagem de Thaís Fernanda no projeto CrediAi_Oficial (14/10/2026 12:17 UTC).
**Escopo:** repositório `thaisfsm/crediai` (main e PRs #1 a #19), Vercel (projeto `crediai`), Neon (somente leitura), relatórios e decisões já registrados.

> **Confirmação:** nesta auditoria **não houve merge, deploy, migration em produção nem alteração de dado real.** Na produção foram feitas só consultas `SELECT` no Neon, leitura de deployments e logs na Vercel e acessos `GET` sem login ao site. Todos os testes rodaram em PostgreSQL local descartável, com dados fictícios. As correções estão num PR **draft** novo, empilhado sobre o PR #19.

---

## 1. Resumo executivo

### Estado real
- **Produção:** commit `5c55e47` (merge do PR #11), deploy `dpl_HDVbhoZMqWSmGXpxHzSaFuW9ugZE` READY. É o mesmo commit da `main`.
- **Banco de produção:** 17 migrations (0001–0017). O schema (colunas, constraints, índices, policies de RLS, gatilhos, funções e enums) é **idêntico** ao gerado pelas migrations do repositório, conferido por impressão digital (seção 7.1).
- **Pendente (não publicado):** PRs #12 a #19, todos draft, com as migrations 0018 a 0023, e o PR novo desta auditoria (correções e este relatório).
- **Erros em produção:** a Vercel não registra nenhum erro de runtime nos últimos 7 dias.

### Números da matriz (seção 4)
| Medida | Quantidade |
|---|---|
| Requisitos individuais rastreados | **96** (85 dos grupos A–G + 11 extras achados nas fontes) |
| Implementados e testados (código atual da pilha, com as correções) | **83** |
| Implementados, mas não testados | **3** (D3, D5, G10) |
| Parcialmente implementados | **5** (B9, B11, D6, G4, G5) |
| Não implementados (aguardam decisão sua) | **4** (X8–X11) |
| Não foi possível verificar | **1** (F7, regressão visual pixel a pixel) |
| Falharam na validação nesta auditoria | **7 requisitos / 6 problemas** (A2, B10, B15, D7, E3, C9, G9), todos corrigidos em draft e retestados |
| Com o código no ar em produção | **63** (4 deles com falha no ar, corrigida só no PR #20: B10, B15, C9, G9) |
| Só em PR draft (não publicados) | **28** |
| Conferidos na produção sem login ou por leitura do banco | **4** (C3, G1, G7, G8) |
| Publicados **e** validados em produção com login | **0** (depende do seu login; seção 9) |

Um requisito pode aparecer em mais de uma linha: por exemplo, "implementado e testado" na pilha e "não publicado".

### O que esta auditoria achou e corrigiu (todos em draft, nada publicado)
| # | Prioridade | Problema | Onde estava |
|---|---|---|---|
| 1 | **P1** | Pagamento com **data futura** era aceito: quitava a operação, somava no capital e virava lucro realizado antes de o dinheiro chegar | produção e pilha |
| 2 | **P1** | Empréstimo novo, correção de operação e correção de pagamento conferiam só o saldo **de hoje**; um empréstimo retroativo podia deixar o extrato do capital negativo numa data passada | produção e pilha |
| 3 | **P1** | Cronograma do investidor aceitava **devolução de principal maior que o valor investido** (ex.: contrato de R$ 20.000 com R$ 40.000 de principal a devolver) | só pilha (PR #14) |
| 4 | **P2** | CPF/CNPJ com **letras ou dígitos de outros alfabetos** ("abc", "５２９…") era gravado como "sem documento" em vez de recusado (cliente, avalista, titular, Pix, investidor) | só pilha (PR #12); a produção não confere nem os dígitos verificadores |
| 5 | **P2** | Sem cabeçalhos contra **clickjacking** (página do CrediAI aberta dentro de outro site) | produção e pilha |
| 6 | **P3** | **Conta desativada** ainda conseguia abrir sessão (as telas recusavam, mas o login passava e mudava o "último acesso") | produção e pilha |
| 7 | teste | O teste A5 da administração falhava **justamente hoje (14/10/2026)** por comparar datas da linha inteira | testes |

Cada um foi reproduzido com um teste que falha no código anterior e passa depois da correção (seção 6).

### Pendências que dependem de você (resumo; detalhes na seção 9)
1. **Hoje, 14/10, às 13:24 (Brasília), termina o período de teste do Robério.** Depois disso o acesso dele é bloqueado pela regra de teste. Ele nunca entrou no sistema e não tem dados. Ativar, prorrogar ou deixar bloquear é decisão sua.
2. **Autorizar a publicação** em etapas (plano na seção 10). Nada será publicado sem o seu OK.
3. **Seis decisões de regra de negócio** (seção 9.2), entre elas: o que fazer com operações em aberto ao "Zerar carteira", e se um aporte comum pode ser indicado como origem do dinheiro de mais de um contrato antigo.
4. **Validação com login na produção:** depende do seu acesso; não usei nem pedi senha.
5. **Liberar uma vaga de branch no Neon** (limite de 10, todas ocupadas por backups) antes de cada backup de publicação.

---

## 2. Fontes consultadas e limitações

| Fonte | Como foi consultada | Resultado |
|---|---|---|
| GitHub `thaisfsm/crediai` | `git fetch` de todas as branches; API do GitHub para PRs | 15 branches; PRs #1–#11 mergeados; #12–#19 abertos em draft, empilhados, sem conflito |
| Código da `main` (= produção) | leitura, testes unitários, e2e, build, lint, typecheck | seção 5 |
| Código do topo da pilha (#19, `73169de`) | leitura por módulo, mesmos testes | seção 5 |
| Migrations e schema | leitura; aplicação em sequência em bancos locais; `drizzle-kit check`; comparação com a produção | seção 7 |
| Vercel | `list_deployments`, `get_runtime_errors` (7 dias), `GET` sem login nas rotas | seção 8 |
| Neon (produção) | só `SELECT` e listagem de branches | seção 8 |
| Relatórios anteriores e memória do projeto | `/mnt/project-files/**`, memória do projeto | usados como pista, sempre conferidos no código e nos testes |

**Limitações (não verificadas):**
- **Telas com login na produção:** não testadas. Não tenho e não pedi senha, e não contornei a autenticação.
- **Ambiente de preview da Vercel com banco:** as previews não têm `DATABASE_URL` (só Production tem), então nenhuma tela com dados foi testada em preview. Os testes de tela rodaram no build local.
- **Teste de carga:** não executado.
- **Revisão jurídica do modelo de contrato:** fora do alcance técnico.

---

## 3. Como ler os status

- **Implementado e testado:** código localizado e teste automatizado executado nesta auditoria prova o comportamento.
- **Implementado, não testado:** código localizado; nenhum teste prova o comportamento.
- **Parcial:** só parte do requisito funciona.
- **Não implementado:** ausente (em geral aguardando decisão sua).
- **Falhou na validação:** um teste desta auditoria revelou o problema (e a linha diz se foi corrigido).
- **Não verificável:** faltam acesso ou evidências.
- **Produção:** `No ar` = o código está no commit publicado `5c55e47`; `No ar (sem login)` = conferido no site sem login; `Validado c/ login` = nunca usado aqui (ninguém testou com login nesta auditoria); `Não publicado` = só em PR draft.

**Abreviações dos testes:**
- `U:arquivo` = teste unitário em `tests/arquivo.test.mjs` (`npm test`).
- `E:arquivo` = ponta a ponta em `tests/e2e/arquivo.e2e.mjs`, rodado contra o build local com banco descartável, **com BYPASSRLS** (como a produção) **e sem BYPASSRLS** (só RLS).
- `P:` = consulta somente leitura na produção.
- PRs: `#12`–`#19` = PRs draft da pilha; `#20` = PR desta auditoria.

---

## 4. Matriz de rastreabilidade

Colunas: **Req.** · **O que foi pedido** · **Onde está** (arquivo/função/migration) · **PR / commit** · **Teste executado → resultado** · **Código atual** · **Produção** · **Pendências e riscos**.

### A. Clientes e documentos

| Req. | O que foi pedido | Onde está | PR / commit | Teste → resultado | Código atual | Produção | Pendências e riscos |
|---|---|---|---|---|---|---|---|
| A1 | CPF com dígitos verificadores corretos | `src/lib/finance/format.ts` `isValidCpf`, `cpfProblem`, `normalizeCpf` | #12 `32b6de1`; #20 `d18a9cb` | U:cpf-cnpj-auditoria CPF1–CPF3 (300 CPFs válidos, 5.400 dígitos errados, 20.000 comparações com implementação de referência) → **8/8**; E:cpf-auditoria → **7/7** | Implementado e testado | **Não publicado.** A produção só confere tamanho e sequência repetida (`main:src/lib/finance/format.ts:125`) | Até a publicação do #12, a produção aceita CPF com dígito verificador errado. P: os 6 CPFs gravados hoje são válidos |
| A2 | Recusar CPF inválido, sequência repetida e entrada malformada | `format.ts` `malformedDocument`, `cpfProblem` | #12; **#20 corrigiu "abc"/outros alfabetos** | U:CPF4–CPF6; E:CPF-API1 → passam; **antes da correção, E:CPF-API1/3/4/5 falharam** | Implementado e testado | Não publicado | Falhou na validação → corrigido (seção 6, item 4) |
| A3 | Validação no servidor, além da tela | `src/app/actions.ts` `clientFields` → `createClientAction`/`updateClientAction` | #12, #20 | E:cpf-auditoria CPF-API1–3 (envio direto à server action, sem tela) → passam; nada gravado | Implementado e testado | Não publicado | — |
| A4 | CNPJ quando aplicável (empresa do cliente, titular, Pix, investidor) | `format.ts` `isValidCnpj`, `cnpjProblem`, `normalizeCpfCnpj`; `src/lib/bank-account.ts` | #12, #14, #20 | U:CNPJ1 (300 CNPJs); E:CPF-API4/5 → passam | Implementado e testado | Não publicado (produção só confere tamanho para investidor) | — |
| A5 | Duplicidade de CPF tratada | `duplicateCpfError` + índice `client_tenant_document_unique` (0018) | #12 | E:clientes CE2/CE3 (inclui envio simultâneo) e E:CPF-API2 → passam | Implementado e testado | Não publicado | P: 0 CPFs repetidos e 0 fora do padrão hoje: a 0018 não vai falhar. Repetir a checagem na janela. Cliente arquivado "segura" o CPF e não há desarquivar (P3) |
| A6 | Busca por nome, telefone e CPF | `searchClientsAction`, `src/lib/finance/client-search.ts` | #12 | U:clients; E:clientes CE6/CE7 → passam | Implementado e testado | Não publicado | Telefones/CPFs antigos gravados com máscara não seriam achados pela busca de dígitos; P: 0 casos hoje |
| A7 | Dados bancários e Pix (todos os tipos de chave) | `src/lib/bank-account.ts` `bankFields`, `normalizePixKey` | #12, #20 | U:clients CL3–CL5, CPF7; E:CE5, CPF-API4 → passam | Implementado e testado | Não publicado | #20 corrigiu titular "abc" gravado vazio. Telefone fixo é aceito como chave Pix de celular (P3) |
| A8 | Dados da empresa (nome e CNPJ) | `client-profile.ts` `companyKeys`; `clientFields` | #12 | E:CE5, CPF-API4 → passam | Implementado e testado | Não publicado | — |
| A9 | Mensagens claras, sem gravar cadastro inválido | `clientFields` (retorno antes da transação) | #12, #20 | E:CPF-API1–6: contagem de clientes e hash financeiro iguais → passam | Implementado e testado | Parcial no ar (mensagens antigas) | — |
| A10 | Contatos (WhatsApp, e-mail, redes) | `src/lib/contacts.ts`, `clientFields` | #7 (no ar) | E:investors (contatos) → passa | Implementado e testado | No ar | — |
| A11 | Cadastro completo: endereços, referências, avalista, documentos do cliente | `client-profile.ts`; `client_document`; rota `src/app/documentos/[id]/route.ts` | 0007/0008 (no ar) | E:isolation (documentos de outro tenant) → passa | Implementado e testado | No ar | Arquivos servidos inline sem `CSP: sandbox` (tipos já limitados a PDF/JPG/PNG/WEBP pelo conteúdo; P3) |

### B. Operações, juros e cobranças

| Req. | O que foi pedido | Onde está | PR / commit | Teste → resultado | Código atual | Produção | Pendências e riscos |
|---|---|---|---|---|---|---|---|
| B1 | Juros simples, sem Price e sem capitalização | `src/lib/finance/rules.ts` `simpleInterest`, `calculateOperation`, `calculateInstallments` | #4 `1503497` | U:finance-rules (inclui varredura do código por Price/PMT/composto) → passam; P: 0 operações de pagamento único com juros ≠ principal × taxa; 0 com total ≠ principal + juros | Implementado e testado | No ar | — |
| B2 | Calendário comercial 30/360 "conforme definido" | `rules.ts` `commercialDaysBetween`, `monthlyEquivalentRate` | #4 | U:finance-rules K → passa | Implementado e testado (como definido em 06/10) | No ar | Na regra aprovada, os juros são **taxa por período × principal** (o número de dias do mês não muda o valor); o 30/360 só entra na conversão da taxa diária/mensal exibida. Sem mora (decisão de 06/10) |
| B3 | Pagamento único mensal, quinzenal e diário | `rules.ts` `nextDueDate`, `calculateDaily`; 0013 | #4 | U:finance-rules B–F; E:cobrancas → passam | Implementado e testado | No ar | Diário com total em centavos menor que o nº de dias dá erro genérico (P3) |
| B4 | Parcelamento quinzenal e vencimentos (pares fixos de dias) | `rules.ts` `biweeklyDays`, `nextBiweeklyDue`; 0019 | #13 | U:Q1–Q5; E:parcelado-quinzenal → passam | Implementado e testado | **Não publicado** | — |
| B5 | Pagamentos parciais, quitação (só com valor integral), renovação (pagamento só de juros), saldos | `rules.ts` `operationLedger`, `checkPayment`, `interestOnlyRenewal`; `registerPaymentAction` | #4, #6 | U:finance-rules G–M; E:cobrancas, financeiro → passam | Implementado e testado | No ar | P: 0 operações quitadas com pagamentos abaixo do total; 0 com pagamentos acima do total |
| B6 | Ordenação pela próxima obrigação em aberto | `portfolio.ts` `compareByNextOpenDue`, `compareCharges` | #6, #10 | U:operations-order, charges-order; E:cobrancas → passam | Implementado e testado | No ar | — |
| B7 | Operações quitadas no fim da lista | mesmas funções | #6, #10 | U:O-* e C-* → passam | Implementado e testado | No ar | — |
| B8 | Correção de operação bloqueada com pagamento ou renovação | `planOperationEdit` (`actions.ts`) com trava da operação | #15 | E:edicao-operacao EO5/EO6 → passam | Implementado e testado (servidor) | Não publicado | O banco não impede `UPDATE` direto numa operação com pagamento (só o servidor). Proposta P2 na seção 10 |
| B9 | Integridade histórica dos pagamentos | `editPaymentAction` grava `payment_revision`; FK impede apagar pagamento | 0006 | E:isolation (edição forjada); E:REG3 | Parcial | No ar | `payment_revision` não tem gatilho "só inclusão" (os módulos novos têm). Nenhum fluxo apaga ou altera revisões hoje. Proposta P2 |
| B10 | Sem saldo negativo; regras de data | `checkPayment`, `fitsLedger`; **#20: data futura recusada** | #4; #20 `7486338` | E:regras-auditoria REG2 → passa; **antes: falhou** | Implementado e testado | **Falha no ar**: produção aceita pagamento com data futura (P: 0 casos gravados hoje) | Corrigido no #20 (seção 6, item 1) |
| B11 | Renegociação com nova taxa, prazo, motivo e simulação antes de gravar | `src/lib/finance/renegotiation.ts`; tela de simulação | #17 | U:renegotiation RN1–RN4; E:renegociacao → passam; a simulação não grava nada | **Parcial**: só simulação | Não publicado | Gravar a renegociação (H2) aguarda decisão sua: cobrar juros novos ou só parcelar o saldo. O motivo não é salvo porque nada é salvo ainda |
| B12 | Nenhum lucro realizado com juros só previstos | `portfolio.ts` (realizado × previsto separados) | #4, #16 | U:R7, report; E:relatorio → passam | Implementado e testado | No ar (com a falha B10: pagamento futuro virava lucro; corrigido no #20) | — |
| B13 | Correção de operação sem pagamento: prévia, motivo, histórico, auditoria | `previewOperationEditAction`, `updateOperationAction`, 0021 | #15; #20 (capital por data) | E:edicao-operacao → passa | Implementado e testado | Não publicado | — |
| B14 | Excluir operação sem pagamento (estorno do capital no extrato) | `cancelOperationAction`; extrato `LOAN_CANCELED` | carteira-real | E:financeiro (extrato) → passa | Implementado e testado | No ar | — |
| B15 | Capital disponível conferido ao emprestar | `createOperationAction` + `availableCapitalCents`; **#20: extrato por data** | #20 `7486338` | E:REG1 → passa; **antes: falhou** | Implementado e testado | **Falha no ar** (só confere o saldo de hoje). P: nenhum saldo negativo no extrato real hoje | Corrigido no #20 (seção 6, item 2) |
| B16 | Cobranças: abas, contadores, filtros | `ChargesPage`, `compareCharges` | #10 | E:cobrancas → passa | Implementado e testado | No ar | — |
| B17 | Juros fixos por quinzena e 1º vencimento do diário configurável | `rules.ts` `FIXED_INTEREST_PER_FORTNIGHT_V1` | #4 | U:finance-rules → passa | Implementado e testado | No ar | — |

### C. Clientes SaaS, usuários e permissões

| Req. | O que foi pedido | Onde está | PR / commit | Teste → resultado | Código atual | Produção | Pendências e riscos |
|---|---|---|---|---|---|---|---|
| C1 | Isolamento de dados entre tenants | `withTenantContext` + `tenant_id` explícito em toda consulta + FKs compostas `(tenant_id, id)` + RLS | #1, #5 | E:isolation (ids forjados em todas as ações) → passa nos dois perfis; revisão das 41 server actions e 3 rotas: todas filtram `tenant_id` | Implementado e testado | No ar | P: 0 pagamentos, renovações ou operações ligados a registros de outro tenant |
| C2 | MASTER e TENANT_USER com permissões corretas; papel lido do banco | `src/lib/auth/guards.ts`; gatilho 0009 | #1 | E:isolation, admin-audit → passam | Implementado e testado | No ar | P: 1 SUPER_ADMIN (o seu), 2 TENANT_USER |
| C3 | Cadastro público desabilitado | `src/lib/auth.ts` (`disableSignUp` + gancho que recusa criar usuário) | #2 | E:isolation; P: `/signup` redireciona para `/login` | Implementado e testado | **No ar (sem login)** | — |
| C4 | Criação controlada de usuários pelo MASTER | `src/lib/admin/saas-clients.ts`, `/admin` | #2 | E:admin-audit → passa | Implementado e testado | No ar | — |
| C5 | Senha provisória e troca obrigatória no 1º acesso | `requireActiveAccount` (`mustChangePassword`), `/definir-senha` | #2 | E:browser U4, E:SEG3 → passam | Implementado e testado | No ar | P: o usuário do Robério não tem senha provisória marcada e nunca entrou (criado antes do PR #2). Vale conferir com ele |
| C6 | Administração global sem misturar a carteira do MASTER | `withPlatformContext` × `withTenantContext` | #1 | E:isolation, financeiro (MASTER na própria carteira) → passam | Implementado e testado | No ar | No módulo Investidores o MASTER lê e edita investidores de **todos** os tenants (decisão do PR #7). Confirme se é isso que quer (seção 9.2) |
| C7 | Fernando, Robério e demais sem acesso cruzado | igual a C1 | — | E:isolation (tenant A × B × MASTER) → passa | Implementado e testado | No ar | — |
| C8 | Proteção no servidor e no banco, inclusive com BYPASSRLS | filtros por tenant no código; gatilhos do banco | — | toda a regressão roda nos dois perfis | Implementado e testado | No ar | Produção conecta com `neondb_owner` (dono das tabelas e BYPASSRLS): o RLS **não** é barreira lá; a barreira é o código e os gatilhos. Tabelas novas (0020–0023) têm RLS ligado mas não forçado: irrelevante com o papel atual, registrado como P3 |
| C9 | Conta desativada, tenant suspenso, teste vencido bloqueados | `requireActiveAccount`, `requireTenantUser`; **#20: sessão recusada para conta desativada** | #2, #3, #20 `33cc029` | E:SEG2 → passa; **antes: falhou** (login passava) | Implementado e testado | Parcial no ar (telas bloqueavam; login passava) | Corrigido no #20 (seção 6, item 6) |
| C10 | Planos, assinatura, valor contratado, tolerância | `src/lib/billing/rules.ts` | #3 | U:billing-rules → passa | Implementado e testado | No ar | Cobrança automática da assinatura não foi autorizada (sprint 5) |
| C11 | Auditoria administrativa (quem, quando, antes/depois) | `src/lib/admin/audit.ts`, 0014 (só inclusão) | #5 | E:admin-audit → **6/6 depois do ajuste do teste A5** (falhava por data, seção 6 item 7) | Implementado e testado | No ar | P: 10 registros de auditoria |
| C12 | Último acesso igual nas três telas | `last-access.ts` | #5 | E:admin-audit A4 → passa | Implementado e testado | No ar | — |
| C13 | Carteira do MASTER sem depender de período de teste | `requireTenantUser` (SUPER_ADMIN só exige tenant não fechado) | #1 | leitura do código; E:financeiro (MASTER) | Implementado e testado | No ar | P: o tenant da MASTER está como TRIALING com vencimento hoje 13:14 (Brasília); **não afeta você**, porque a regra ignora assinatura para o MASTER |

### D. Ciclos, capital e relatórios

| Req. | O que foi pedido | Onde está | PR / commit | Teste → resultado | Código atual | Produção | Pendências e riscos |
|---|---|---|---|---|---|---|---|
| D1 | Rentabilidade com ciclo atual e todos os ciclos | `src/lib/finance/report.ts`, `loadAllCyclesReportAction` | #16 | U:report; E:relatorio RL3 → passam | Implementado e testado | Não publicado | — |
| D2 | Ciclo atual como padrão | `report.ts` (padrão "Ciclo atual") | #16 | E:relatorio → passa | Implementado e testado | Não publicado | — |
| D3 | Ciclos encerrados só para consulta | ações filtram `cycle_number` atual | #16 | E:relatorio (tela) → passa | Implementado, servidor **não testado** | Não publicado | Nenhum teste prova que o servidor recusa gravar no ciclo encerrado (pela leitura do código, recusa) |
| D4 | Entradas, retiradas e saldos coerentes entre Capital, Financeiro, dashboard e relatórios | `buildPortfolio` (fonte única); `availableCapitalCents` (mesma conta em SQL) | #9 | E:financeiro F11/F14, relatorio → passam | Implementado e testado | No ar | — |
| D5 | Reset da carteira MASTER sem apagar dados de outros tenants | `resetWalletAction` (só o tenant da sessão, nada apagado) | carteira-real; reset de 13/10 | leitura do código; relatório do reset | Implementado, **não testado** por e2e | No ar | Nenhum teste automatizado confere os outros tenants depois do reset. Operações em aberto do ciclo encerrado ficam sem como receber pagamento (decisão sua, seção 9.2) |
| D6 | Sem duplicidade de movimentos | Financeiro, Contas a Pagar e entrada do investidor com chave de idempotência e índice único | #9, #18, #19 | E:financeiro FE9, contas-a-pagar → passam | **Parcial** | Parcial no ar | Pagamento, aporte, retirada e novo empréstimo pela tela antiga não têm chave de idempotência: um reenvio grava duas vezes (o saldo continua protegido). Exige migration; proposta P2 |
| D7 | Nenhuma saída que deixe o capital negativo, respeitando as datas | `checkOutflow` (retirada, Financeiro, baixa, estorno, capital inicial) + **#20: `negativeAfterChange`** (empréstimo, correção de operação e de pagamento) | #9, #20 | E:REG1/REG3 → passam; **antes: falharam** | Implementado e testado | **Parcial no ar** | Corrigido no #20 |
| D8 | Aporte e retirada pela tela Capital; estorno de aporte | `registerContributionAction`, `reverseContributionAction` | carteira-real, #9 | E:financeiro → passa | Implementado e testado | No ar | Aporte aceita data anterior ao início do ciclo (retirada não). P3 |
| D9 | Capital inicial com trava e auditoria | `saveWalletAction`, `checkInitialCapitalChange` | #9 `d052bb8` | E:financeiro → passa | Implementado e testado | No ar | — |
| D10 | Gráfico Evolução da carteira com tooltip de data e saldo | `src/lib/finance/chart.ts`, `WalletChart` | #11 | U:wallet-chart; E:grafico-carteira → passam | Implementado e testado | No ar | — |
| D11 | Relatório por período e situação | `report.ts` | #16 | U:report; E:relatorio → passam | Implementado e testado | Não publicado | Período com início depois do fim não é invertido (P3) |

### E. Investidores, contratos, documentos e Contas a Pagar

| Req. | O que foi pedido | Onde está | PR / commit | Teste → resultado | Código atual | Produção | Pendências e riscos |
|---|---|---|---|---|---|---|---|
| E1 | Cadastro e edição de investidores | `src/app/investidores/actions.ts`, `src/lib/investors/rules.ts` | #7 | E:investors → passa | Implementado e testado | No ar | P: 0 investidores |
| E2 | Dados bancários e identificação (CPF/CNPJ conferido) | `rules.ts` `normalizeCpfCnpj`, `bankFields` | #14, #20 | E:investidores-cronograma, CPF-API5 → passam | Implementado e testado | Não publicado (produção só confere tamanho) | Investidor antigo com CPF de dígito errado não poderá ser editado sem corrigir o CPF (P: 0 investidores hoje) |
| E3 | Contratos e cronogramas manuais | `buildInvestmentScheduleAction` e afins; 0020 | #14; **#20: principal ≤ investido** | E:investidores-cronograma, REG4 → passam; **antes: REG4 falhou** | Implementado e testado | Não publicado | Corrigido no #20 (seção 6, item 3) |
| E4 | PDF, versões, hash, vínculo com o contrato certo | `src/lib/investors/contract.ts`, `contract-pdf.ts`; 0016 | #8 | E:investor-contract (13 casos) → passa | Implementado e testado | No ar | O hash SHA-256 é gravado mas nunca reconferido; o documento assinado enviado não tem hash. P2 |
| E5 | Enviar, ver, baixar e substituir documentos | `uploadInvestmentDocumentAction`, `replaceInvestmentDocumentAction`; rota de download | #7 | E:investors → passa | Implementado e testado | No ar | Sem cota de armazenamento por tenant (P3) |
| E6 | Assinaturas e histórico de auditoria | `markContractSentAction`, assinado ligado à versão; `investment_revision` | #8, #14 | E:investor-contract, investidores-cronograma → passam | Implementado e testado | Parcial no ar (histórico do cronograma é do #14) | `investment_revision` e contratos podem ser alterados direto no banco (sem gatilho). P2 |
| E7 | Rendimento separado da devolução do principal | colunas `yield_cents`/`principal_cents`; categorias `INVESTOR_YIELD_PAYMENT`/`INVESTOR_PRINCIPAL_RETURN` | #14, #18 | U:payables; E:contas-a-pagar → passam | Implementado e testado | Não publicado | — |
| E8 | Entrada no capital só por ação explícita | `registerInvestmentEntryAction` (confirmação com os dados vistos) | #18 | E:contas-a-pagar → passa | Implementado e testado | Não publicado | — |
| E9 | Proteção contra entrada duplicada | índice único + travas da carteira e do contrato | #18 | E:contas-a-pagar (reenvio e simultâneo) → passa | Implementado e testado | Não publicado | — |
| E10 | Contas a Pagar: obrigações previstas, baixas parciais e totais | `src/lib/investors/payables.ts`, `src/app/contas-a-pagar/actions.ts`; 0022 | #18 | U:payables; E:contas-a-pagar 15/15 → passa | Implementado e testado | Não publicado | Edição de linha do cronograma e baixa da mesma linha ao mesmo tempo podem dar erro genérico (impasse do banco, sem corromper dados). P3 |
| E11 | Uma única saída de capital por baixa | índice único do movimento + gatilho adiado "movimento ligado" | #18 | E:contas-a-pagar → passa | Implementado e testado | Não publicado | — |
| E12 | Regras de contratos novos e antigos | `investment.capital_entry_rule` + gatilho (0023) | #19 | U:regra-entrada; E:regra-entrada 10/10 → passam | Implementado e testado | Não publicado | Um mesmo aporte comum pode ser indicado para vários contratos antigos, sem conferir valor (decisão sua). Contrato antigo pago com o capital inicial não tem aporte para indicar |
| E13 | Bloquear estornos, cancelamentos e alterações sem regra aprovada | gatilhos 0022/0023 (`investment_cash_guard` etc.) | #18, #19 | E:contas-a-pagar, regra-entrada (alterações direto no banco recusadas) → passam | Implementado e testado | Não publicado | O dono das tabelas pode desligar gatilhos (limite de qualquer banco). O estorno do movimento de entrada do investidor é barrado só no servidor (P2) |
| E14 | Período da taxa explícito e investimento cancelado só para consulta | `rules.ts`; tela | #7, #8 | E:investors, investor-contract → passam | Implementado e testado | No ar | — |
| E15 | Empresa contratante (rascunho × confirmada) | `saveContractorAction` | #8 | E:investor-contract → passa | Implementado e testado | No ar | Modelo de contrato sem revisão jurídica |

### F. Interface e usabilidade

| Req. | O que foi pedido | Onde está | PR / commit | Teste → resultado | Código atual | Produção | Pendências e riscos |
|---|---|---|---|---|---|---|---|
| F1 | Menu lateral e navegação (clique antes da hidratação) | `src/app/app-shell.tsx` | #5 | E:browser U1 → passa | Implementado e testado | No ar | — |
| F2 | Telas de clientes, operações, cobranças, capital, financeiro, relatórios, investidores, contratos e administração | `src/app/**` | vários | toda a regressão e2e usa as telas reais (HTML e navegador) | Implementado e testado | No ar (parte) / Não publicado (relatórios, contas a pagar, correção, renegociação) | — |
| F3 | Busca, filtros e mensagens de erro | idem | vários | E:clientes, cobrancas, financeiro, contas-a-pagar → passam | Implementado e testado | Parcial no ar | — |
| F4 | Desktop e celular, sem rolagem horizontal | CSS | #5 e seguintes | E:browser U2 (390 px) + telas de cada módulo em 390 px → passam | Implementado e testado | No ar (parte) | — |
| F5 | Sem erros de runtime | — | — | P: Vercel sem erros de runtime em 7 dias; regressão sem erro 500 inesperado | Implementado e testado | No ar | — |
| F6 | Banco fora do ar sem perder a sessão nem ir para /setup | `database-error-state.tsx` | #5 | E:browser U3 → passa | Implementado e testado | No ar | P: `/setup` sem login mostra só "CrediAI está conectado ao PostgreSQL" e não cria nada |
| F7 | Regressões visuais | — | — | Telas capturadas pelos testes de cada módulo; sem comparação pixel a pixel | **Não verificável** por completo | — | Comparação visual automática não existe |

### G. Segurança e infraestrutura

| Req. | O que foi pedido | Onde está | PR / commit | Teste → resultado | Código atual | Produção | Pendências e riscos |
|---|---|---|---|---|---|---|---|
| G1 | Autorização em todas as rotas e ações | guards em todas as 41 server actions e 3 rotas | — | revisão completa; P: todas as rotas protegidas redirecionam para `/login` sem sessão (`producao/rotas-sem-login.txt`) | Implementado e testado | **No ar (sem login)** | — |
| G2 | IDs e propriedade conferidos no servidor | "id E tenant" antes de usar | — | E:isolation, IC6, CP11, RE7 (ids forjados) → passam | Implementado e testado | No ar | — |
| G3 | Isolamento de documentos e arquivos | rotas de download conferem tenant | #7 | E:isolation, investors → passam | Implementado e testado | No ar | Hardening P3: `CSP: sandbox` nos downloads |
| G4 | Requisições duplicadas e concorrência | travas `FOR UPDATE`; idempotência nos módulos novos | — | E:FE9, CP6, RE6, CE3 → passam | **Parcial** | Parcial no ar | Ver D6 |
| G5 | Auditoria sem senhas, tokens ou dados bancários | `audit.ts`; `maskReference` | #5, #18 | E:investors (auditoria sem conteúdo sensível) → passa | **Parcial** | No ar (parte) | Na baixa (pendente), a referência do pagamento só mascara sequências de 5+ dígitos: CPF formatado ou chave Pix de e-mail na referência ficariam legíveis. P3 |
| G6 | Migrations aditivas e compatíveis | `drizzle/0018`–`0023` | #12–#19 | sequência aplicada em banco local com hash das tabelas antes/depois (seção 7) | Implementado e testado | Não publicado | — |
| G7 | Integridade dos dados existentes | — | — | P: consultas de integridade (seção 8.3), todas zeradas | Implementado e testado | **Verificado em produção (leitura)** | — |
| G8 | Coerência GitHub × Vercel × Neon × código | — | — | P: commit publicado = `main`; 17 migrations = 17 arquivos; schema idêntico (seção 7.1) | Verificado | **Verificado em produção** | Os hashes gravados das migrations 0002–0008 diferem dos arquivos atuais (foram aplicadas a partir de versões anteriores dos arquivos), mas o schema resultante é idêntico. Sem efeito: o drizzle compara pela data, não pelo hash |
| G9 | Cabeçalhos de segurança (anti-clickjacking) | **#20:** `next.config.ts` `headers()` | #20 `33cc029` | E:SEG1 → passa; **antes: falhou**; P: produção sem `X-Frame-Options` e sem `frame-ancestors` | Implementado e testado | **Falha no ar** | Corrigido no #20 |
| G10 | Limite de tentativas de login | padrão do Better Auth (memória por instância) | — | leitura | Implementado, não testado | No ar | Proteção fraca contra força bruta em serverless; mitigado pela senha mínima de 12 caracteres. P3 |
| G11 | Segredos fora de logs e relatórios | — | — | revisão; nenhum segredo neste relatório | Verificado | No ar | — |

### Requisitos extras encontrados nas fontes do projeto
| Req. | O que foi pedido | Onde está | Teste → resultado | Código | Produção | Pendências |
|---|---|---|---|---|---|---|
| X1 | Regra oficial de renovação (01/10): 6 pagamentos só de juros = 6 renovações, quitação só com valor integral | `rules.ts` `interestOnlyRenewal` | U:finance-rules I/J → passa | Implementado e testado | No ar | — |
| X2 | Renovação "preguiçosa" no vencimento (caso Alexandre, 06/10) | `operationLedger` (`DUE_DATE`) | U:finance-rules J2 → passa | Implementado e testado | No ar | — |
| X3 | "Próximas" cobranças = 1 a 7 dias | `compareCharges` | U:charges-order → passa | Implementado e testado | No ar | Oferecido mudar em 13/10; sem resposta |
| X4 | Quinzenal: dia 1 → par 1/16 (você escreveu 1/15) | `biweeklyDays` | U:Q1 → passa | Implementado como par 1/16 | Não publicado | **Confirmar** (seção 9.2) |
| X5 | Nenhuma operação financeira de teste em produção | — | P: consultas | Cumprido | — | — |
| X6 | Excluir cliente e operação sem pagamento | `archiveClientAction`, `cancelOperationAction` | E:financeiro → passa | Implementado e testado | No ar | — |
| X7 | Logs de banco sem expor `DATABASE_URL` | `src/lib/db/status-rules.ts` | U:database-status → passa | Implementado e testado | No ar | — |
| X8 | Cobrança automática da assinatura SaaS | — | — | **Não implementado** (não autorizado) | — | Aguarda sua decisão |
| X9 | Mora/juros por atraso | — | — | **Não implementado** (decisão de 06/10: sem mora) | — | Confirmar se continua assim |
| X10 | Renegociação gravada (H2) e correção de operação com pagamento (G2) | — | — | **Não implementado** | — | Aguardam decisões D-H/D-G |
| X11 | Correção/estorno de baixa, entrada ou aporte indicado; cancelar contrato com capital | gatilhos bloqueiam | E:contas-a-pagar, regra-entrada → bloqueio passa | **Não implementado (bloqueado de propósito)** | — | Aguarda regra sua |

---

## 5. Resultados dos testes (comandos e números reais)

Ambiente: container na nuvem, Node 22.22, PostgreSQL 16 local, Chromium do Playwright. Cada arquivo e2e roda num banco recém-criado com as migrations e os dados fictícios de `setup-db.sh`. Logs completos em `/mnt/project-files/auditoria-geral/testes/`.

### 5.1 `main` = produção (`5c55e47`)
| Verificação | Comando | Resultado |
|---|---|---|
| Unitários | `npm test` | **103/103** |
| Lint | `npm run lint` | sem erro |
| Tipos | `npx tsc --noEmit -p .` (depois do build) | sem erro |
| Build | `npm run build` | OK |
| Schema | `drizzle-kit check` | OK |
| E2E com BYPASSRLS (como a produção) | `run-all.sh crediai_bypass` (7 arquivos) | **61/62** |
| E2E sem BYPASSRLS (só RLS) | `run-all.sh crediai_app` | **61/62** |
| Navegador | `browser.e2e.mjs` (com BYPASSRLS) | **6/6** |

A única falha (A5, nos dois perfis) é do próprio teste: ele procurava "14/10/2026" na linha inteira da conta MASTER e hoje é 14/10/2026, a data de criação do tenant fictício. A tela está certa ("Vence em" = "—"). O teste foi ajustado no #20.

### 5.2 Topo da pilha com as correções (PR #20, `claude/project-thread-6z1878`)
| Verificação | Comando | Resultado |
|---|---|---|
| Unitários | `npm test` | **157/157** (149 anteriores + 8 da bateria de CPF/CNPJ) |
| Lint / Tipos / Build / Schema | idem | sem erro / sem erro / OK / OK |
| E2E com BYPASSRLS | `run-all.sh crediai_bypass` (18 arquivos) | **145/145** em 18 arquivos. O CP13 (contas a pagar) falhou na 1ª passada porque ainda esperava o valor antigo do contrato fictício (R$ 50.000, que o CP7 passou a usar como R$ 60.000). Na 2ª passada falhou porque o teste fictício da carteira vencia às 16:25 de hoje, uma data fixa no script de dados. Corrigi o teste e o script (vencimento agora relativo) e rodei de novo: 15/15. Logs anteriores em `testes/pilha-rodada1`. |
| E2E sem BYPASSRLS | `run-all.sh crediai_app` (18 arquivos) | **145/145** em 18 arquivos, já com o CP13 corrigido |

### 5.3 Testes novos desta auditoria, antes e depois das correções
| Arquivo | No código anterior (`73169de`) | Com as correções |
|---|---|---|
| `tests/cpf-cnpj-auditoria.test.mjs` (unitário) | **5/8** (falharam: malformado, CNPJ malformado, titular/Pix "abc") | **8/8** |
| `tests/e2e/cpf-auditoria.e2e.mjs` | **2/7** | **7/7** |
| `tests/e2e/regras-auditoria.e2e.mjs` | **1/5** | **5/5** |
| `tests/e2e/seguranca-auditoria.e2e.mjs` | **1/3** | **3/3** |

### 5.4 Não executados
- Testes com login na produção (dependem de você).
- Testes em preview da Vercel com banco (as previews não têm banco).
- Teste de carga.
- Comparação visual pixel a pixel.

---

## 6. Problemas encontrados e corrigidos (PR #20, draft)

Para cada um: reprodução, causa, correção, teste de regressão.

1. **Pagamento com data futura (P1).**
   - *Reprodução:* E:REG2 enviou pagamentos com data +1, +30 e +365 dias; o código anterior aceitou.
   - *Causa:* `registerPaymentAction` e `editPaymentAction` só conferiam formato e "não antes do empréstimo". O capital e o lucro somam todo pagamento, qualquer que seja a data.
   - *Correção:* data depois de hoje recusada nos dois caminhos (`src/app/actions.ts`), igual às demais entradas; os campos "Data do pagamento" da tela passaram a ter máximo = hoje.
   - *Testes antigos afetados:* três testes da pilha registravam pagamentos em datas que hoje são futuras (EO6 em 20/10; PQ3 em 06/11, 21/11 e 06/12; e CP7 dependia de principal acima do investido). Eles passavam justamente por causa dos defeitos 1 e 3. Foram ajustados para datas passadas e valores coerentes, sem perder o que verificavam (PQ3 agora também prova que o pagamento em 06/11 é recusado).
   - *Produção hoje:* 0 pagamentos com data futura gravados (P:).
2. **Empréstimo e correções conferiam só o saldo de hoje (P1).**
   - *Reprodução:* E:REG1 (aporte há 4 dias; empréstimo do mesmo valor datado há 6 dias foi aceito, deixando −R$ 5.000 no extrato) e E:REG3 (pagamento movido para depois de uma retirada foi aceito).
   - *Causa:* só `checkOutflow` (usado nas retiradas) olhava o extrato inteiro; empréstimo, correção de operação e correção de pagamento não usavam.
   - *Correção:* `negativeAfterChange` (`src/lib/finance/cashflow.ts`) recalcula o extrato com a mudança e recusa se algum saldo a partir da data ficar negativo.
   - *Produção hoje:* nenhum saldo negativo no extrato real de nenhum tenant (P:), então a regra não bloqueia nada que já existe.
3. **Principal do cronograma acima do valor investido (P1, só pilha).**
   - *Reprodução:* E:REG4 (contrato de R$ 20.000 com duas linhas de R$ 20.000 de principal: aceito).
   - *Correção:* `principalOverflow` em montar, incluir e editar linha (`src/app/investidores/actions.ts`). O rendimento continua livre.
4. **CPF/CNPJ malformado gravado como vazio (P2).**
   - *Reprodução:* U:CPF6, CNPJ1, CPF7 e E:CPF-API1/3/4/5 ("abc", "５２９…", "CPF", "<script>").
   - *Causa:* a função tirava tudo que não é dígito antes de validar; "abc" virava vazio, e vazio significa "sem CPF".
   - *Correção:* `malformedDocument` em `cpfProblem`, `cnpjProblem`, `cpfCnpjProblem` e `normalizeCpfCnpj`; o titular da conta passa o texto digitado para a validação.
5. **Sem cabeçalhos contra clickjacking (P2).**
   - *Reprodução:* E:SEG1; P: resposta da produção sem `X-Frame-Options`/`frame-ancestors`.
   - *Correção:* `headers()` em `next.config.ts` (`X-Frame-Options: SAMEORIGIN`, `frame-ancestors 'self'`, `Referrer-Policy`, `nosniff`, HSTS, `Permissions-Policy`).
6. **Conta desativada abria sessão (P3).**
   - *Reprodução:* E:SEG2 (login de conta desativada devolvia 200 e criava sessão).
   - *Correção:* gancho `session.create.before` em `src/lib/auth.ts`. Senha provisória continua entrando (E:SEG3).
7. **Teste A5 dependente da data (teste).** Ajustado em `tests/e2e/admin-audit.e2e.mjs`.

---

## 7. Migrations e recuperação

### 7.1 Produção × repositório
- **Registradas no Neon:** 17 (ids 1–17). Os hashes de 0001 e 0009–0017 batem com os arquivos. Os de 0002–0008 não batem: essas migrations foram aplicadas a partir de versões anteriores dos arquivos (antes do commit atual). O drizzle decide o que aplicar pela data, então isso não causa reaplicação.
- **Schema idêntico:** a impressão digital do schema `public` da produção (306 colunas, 104 constraints, 70 índices, 76 policies, 23 tabelas com RLS, 3 gatilhos, 2 funções, 12 enums) é **igual** à de um banco local criado do zero com 0001–0017. A tabela de exemplo `playing_with_neon` (10 linhas, criada pelo Neon) é a única diferença e foi excluída da comparação. Consulta: `producao/schema-fingerprint-agregado.sql`.

### 7.2 Migrations pendentes (0018–0023)
Todas são aditivas: nenhuma tem `UPDATE`, `DELETE`, `INSERT`, `DROP TABLE`, `DROP COLUMN` ou troca de tipo. A sequência inteira foi aplicada em banco local com dados fictícios de todos os tipos; as 23 tabelas que já existiam ficaram com contagem e hash iguais a cada passo (`/mnt/project-files/evolucao-modulos/testes/sequencia/resultado.txt`). Nesta auditoria a regressão completa aplicou de novo 0018–0023 em cada um dos 36 bancos descartáveis (18 arquivos × 2 perfis).

| Migration | PR | O que cria ou altera | Risco para dados | Antes (checar) | Depois (checar) |
|---|---|---|---|---|---|
| 0018 | #12 | 10 colunas vazias em `client`; índice único `(tenant_id, document)`; 2 CHECKs de formato | Falha se houver CPF repetido na mesma carteira (P: **0** hoje) | CPF repetido por carteira = 0 | 18 migrations; índice criado; hash dos clientes igual |
| 0019 | #13 | amplia o CHECK de modalidade para parcelado quinzenal | nenhum (só amplia) | operação quinzenal existente válida (P: 1) | 19; hash das operações igual |
| 0020 | #14 | colunas bancárias e de contrato em `investor`/`investment`; tabelas `investment_schedule_item`, `investment_revision` | nenhum | investidores/contratos (P: 0) | 20; 2 tabelas novas vazias |
| 0021 | #15 | tabela `loan_operation_revision` | nenhum | — | 21; tabela vazia |
| 0022 | #18 | tabelas `investment_capital_entry`, `investment_payment`; `source` e regras em `capital_movement`; gatilhos de só inclusão | regras recriadas em `capital_movement` só ampliam | hash de `capital_movement` | 22; hash igual; 0 movimentos INVESTOR |
| 0023 | #19 | `investment.capital_entry_rule` (sem backfill); tabela `investment_prior_contribution`; gatilhos | contratos existentes ficam "antigos" (P: 0 contratos hoje) | contratos = 0 | 23; contratos existentes com marca vazia |

**PR #20 não tem migration.**

### 7.3 Backup e recuperação (para cada migration)
- **Backup:** branch nova do Neon `backup-antes-00NN-AAAA-MM-DD` criada da produção logo antes, conferida por contagem e hash das tabelas principais. **Hoje não há vaga:** o projeto tem 10 branches (produção + 9 backups). É preciso o seu OK para apagar um backup antigo (sugestão: `backup-antes-0009-2026-10-05` e `backup-antes-0010-2026-10-05`, já superados pelos posteriores). Nesta auditoria nenhuma branch foi criada nem apagada.
- **Migration falhou:** roda numa transação única com a linha do drizzle; desfaz tudo sozinha.
- **Código com problema depois do deploy:** promover o deployment anterior na Vercel. As migrations são aditivas, então o código antigo funciona com o banco novo.
- **Dado errado:** restauração **seletiva** das linhas afetadas, copiadas da branch de backup, depois de comparar com o que mudou desde o backup. **Nunca** restaurar o backup inteiro por cima da produção, porque apagaria lançamentos feitos depois dele (Fernando e você). Restauração completa ou por ponto no tempo só como último recurso, com a lista do que se perderia e o seu OK.
- **Cuidado específico da 0023:** restaurar um contrato antigo direto pelo banco faria o gatilho marcá-lo como novo; a restauração seletiva precisa desligar a marcação só para essas linhas.

---

## 8. Estado real da produção (somente leitura)

### 8.1 Vercel
- Deploy de produção atual: `dpl_HDVbhoZMqWSmGXpxHzSaFuW9ugZE`, commit `5c55e47`, READY. Anterior (rollback): `dpl_4qTfHXx2Lij6igoNKhbsM1d3D499` (`4627296`).
- Erros de runtime nos últimos 7 dias: **nenhum**.
- `DATABASE_URL` só no ambiente Production (previews não tocam o banco).

### 8.2 Site sem login (14/10, `GET`)
`/login` 200; `/`, `/financeiro`, `/investidores`, `/admin`, `/admin/registros`, `/definir-senha`, `/documentos/x`, `/investidores/documentos/x` → 307 para `/login`; `/signup` → 307 para `/login`; `/setup` 200 (só informa que o banco está conectado); `/api/auth/get-session` → `null`. Cabeçalhos: HSTS presente (Vercel); `X-Frame-Options` e `frame-ancestors` ausentes (corrigido no #20).

### 8.3 Neon (consultas `SELECT`, 14/10)
| Item | Valor |
|---|---|
| PostgreSQL | 18, projeto `lucky-pond-11018021` |
| Migrations | 17 |
| Branches | 10 (produção + 9 backups, de `backup-antes-0009` a `backup-antes-0017`) |
| Papel do app | `neondb_owner` (BYPASSRLS) |
| Tenants | 3: MASTER (2 clientes, 2 operações, 4 pagamentos), Fernando (ACTIVE; 32 clientes, 33 operações, 79 pagamentos, 2 movimentos de capital), Robério (TRIALING até 14/10 16:24 UTC; nenhum dado) |
| Usuários | 1 SUPER_ADMIN, 2 TENANT_USER; nenhum com senha provisória pendente |
| Operações | 32 em aberto, 3 quitadas; 23 únicas mensais, 1 única quinzenal, 11 parceladas mensais |
| CPFs | 6 preenchidos, 6 válidos, 0 repetidos, 0 formatados; 0 CPFs de avalista |
| Integridade | 0 pagamentos/renovações/operações ligados a outro tenant; 0 pagamentos ≤ 0, futuros ou antes do empréstimo; 0 quitadas sem data; 0 em aberto com data de quitação; 0 operações com pagamentos acima do total; 0 juros ≠ juros simples; 0 movimentos de capital ≤ 0 ou futuros; 0 ciclos encerrados |
| Extrato do capital | nenhum saldo negativo em nenhuma data (menor saldo: Fernando R$ 1.736,00 em 13/10; MASTER R$ 500,00 em 10/09) |
| Auditoria administrativa | 10 registros; 7 revisões de pagamento |
| Investidores / contratos | 0 / 0 |

Nenhum dado pessoal (nomes, CPFs, telefones) foi copiado para este relatório.

---

## 9. Pendências que dependem de você

### 9.1 Ações
1. **Robério:** o período de teste termina **hoje às 13:24 (Brasília)**. Depois disso ele não entra mais. Ativar, prorrogar ou deixar bloquear.
2. **Publicação:** autorizar etapa por etapa (seção 10).
3. **Neon:** autorizar apagar um backup antigo para liberar a vaga do próximo backup.
4. **Validação com login** depois de cada publicação (eu não tenho acesso com login à produção).
5. **Revisão jurídica** do modelo de contrato de investimento.

### 9.2 Decisões de regra de negócio (as ações correspondentes continuam bloqueadas)
| # | Decisão | O que acontece hoje |
|---|---|---|
| 1 | **Zerar carteira com operações em aberto:** bloquear o reset enquanto houver operação em aberto, ou levar as abertas para o ciclo novo? | O reset é aceito; as operações em aberto ficam no ciclo encerrado e não recebem mais pagamento pela tela |
| 2 | **Aporte indicado para contrato antigo:** um mesmo aporte pode servir de origem para mais de um contrato? Exigir valor igual ou maior? | Aceita qualquer aporte comum do ciclo, sem conferir valor, para vários contratos |
| 3 | **Contrato antigo pago com o capital inicial:** como liberar a baixa sem aporte para indicar? | Fica sem caminho (só registrando a entrada, o que conta o dinheiro de novo) |
| 4 | **MASTER no módulo Investidores:** pode ver e editar investidores de todos os tenants? | Pode (desde o PR #7) |
| 5 | **Quinzenal com 1º vencimento no dia 1:** par 1/16 (como está) ou 1/15 (como você escreveu)? | 1/16 |
| 6 | **Renegociação gravada (H2), correção de operação com pagamento (G2), estornos de baixa/entrada e mora** | Não implementados; bloqueados |

---

## 10. Plano de correção priorizado e plano de publicação (preparatório, **não executado**)

### 10.1 Prioridades
- **P0 (segurança, acesso indevido, perda de dados):** nenhum encontrado. O isolamento entre tenants foi conferido em todas as ações e testado com ids forjados nos dois perfis.
- **P1 (regra financeira errada):** 1, 2 e 3 da seção 6 (**corrigidos no #20, draft**).
- **P2 (requisito incompleto):**
  - CPF/CNPJ malformado e cabeçalhos (corrigidos no #20);
  - idempotência em pagamento/aporte/retirada/novo empréstimo (D6; precisa de migration: proposta de PR próprio);
  - gatilho "só inclusão" em `payment_revision` e bloqueio no banco da correção de operação com pagamento (B8/B9; migration);
  - hash do documento assinado e reconferência do hash do PDF (E4);
  - decisões 1–3 da seção 9.2.
- **P3 (conveniência):** conta desativada no login (corrigido no #20); `CSP: sandbox` nos downloads; erro amigável no diário com centavos insuficientes; aporte antes do início do ciclo; período invertido no relatório; telefone fixo como chave Pix; cota de documentos; limite de login compartilhado; referência da baixa com dados legíveis na auditoria; RLS forçado nas tabelas novas.

### 10.2 Etapas de publicação
Regras para todas: **só com o seu OK por etapa**; ordem obrigatória; em cada etapa: (1) vaga no Neon com seu OK, (2) backup + conferência, (3) migration em transação única + conferência, (4) merge, (5) deploy automático, (6) conferências e logs, (7) validação com login (sua). A migration vem antes do merge porque o merge dispara o deploy e o código novo precisa das colunas novas.

| Etapa | Conteúdo | Migration | Testes antes | Conferências depois | Interromper / recuperar |
|---|---|---|---|---|---|
| 1 | #12 Clientes + **#20 (parte de CPF)** | 0018 | CPF repetido = 0 na hora | 18 migrations; índice; hash dos 34 clientes; busca; CPF inválido recusado | antes do merge: parar (migration inofensiva); depois: rollback na Vercel |
| 2 | #13 Quinzenal | 0019 | operação quinzenal existente válida | 19; hash das operações | idem |
| 3 | #14 Investidores (cronograma) | 0020 | investidores = 0 | 20; tabelas vazias; capital igual | idem |
| 4 | #15 Correção de operação | 0021 | — | 21; "Corrigir" só sem pagamento | idem |
| 5 | #16 Relatórios | — | — | números iguais ao dashboard | rollback |
| 6 | #17 Renegociação (simulação) | — | — | simular não grava nada | rollback |
| 7 | #18 + #19 Contas a Pagar com a regra da entrada | 0022 + 0023 (mesma janela, um deploy) | contratos = 0 | 23; 3 tabelas vazias; `capital_movement` com hash igual; 0 movimentos INVESTOR | rollback; gatilhos já protegem |
| 8 | **#20 Auditoria** (data futura, capital por data, principal ≤ investido, malformado, cabeçalhos, conta desativada) | — | regressão completa (feita) | pagamento futuro recusado; cabeçalhos presentes no `curl`; login normal de vocês dois | rollback |

**Alternativa para os P1 já no ar:** os itens 1 e 2 da seção 6 (pagamento futuro e capital por data) e os cabeçalhos também valem para a produção atual. Se você quiser, preparo um PR separado com só essas três correções sobre a `main`, para publicar antes da pilha, sem migration.

---

## 11. Links

- PRs da pilha: [#12](https://github.com/thaisfsm/crediai/pull/12) · [#13](https://github.com/thaisfsm/crediai/pull/13) · [#14](https://github.com/thaisfsm/crediai/pull/14) · [#15](https://github.com/thaisfsm/crediai/pull/15) · [#16](https://github.com/thaisfsm/crediai/pull/16) · [#17](https://github.com/thaisfsm/crediai/pull/17) · [#18](https://github.com/thaisfsm/crediai/pull/18) · [#19](https://github.com/thaisfsm/crediai/pull/19)
- PR desta auditoria: #20 (draft, branch `claude/project-thread-6z1878`, base `claude/evolucao-modulos-mfpu01-regra-entrada`)
- Commits das correções: `d18a9cb` (CPF/CNPJ), `7486338` (data futura, capital por data, principal), `33cc029` (cabeçalhos, conta desativada), `1420999`, `d568e4c` e `4357f0f` (testes e limite de data na tela)
- Evidências: `/mnt/project-files/auditoria-geral/` (`testes/main`, `testes/pilha`, `testes/antes-das-correcoes`, `testes/cpf`, `producao/`)

---

## 12. Confirmação final

- **Merge:** nenhum.
- **Deploy:** nenhum.
- **Migration em produção:** nenhuma (continuam 17).
- **Neon:** nenhuma branch criada ou apagada; só `SELECT`.
- **Dados reais:** nenhum usuário, senha, carteira, cliente, contrato, operação, pagamento ou dado financeiro alterado; nenhuma operação de teste em produção.
- **PRs:** todos continuam em draft, incluindo o novo #20.

---

## 13. Adendo (14/10/2026, tarde): busca global do topo e página `/setup`

Achados na navegação **com login** na produção (sessão MASTER já aberta no Chrome de Thaís, só leitura). Esta é a
primeira validação com login da seção 9 ("Publicados **e** validados em produção com login").

### 13.1 O que foi validado na produção com login (Claude in Chrome, só leitura, sem gravar nada)
| Tela | Resultado |
|---|---|
| Visão geral, Capital, Clientes, Operações, Pagamentos, Cobranças, Relatórios, Configurações, Financeiro, Investidores, `/admin` | Abrem sem erro no console; totais consistentes entre as telas (capital disponível R$ 1.800,00; emprestado R$ 11.000,00; a receber R$ 11.800,00; juros recebidos R$ 1.800,00 em 4 pagamentos). Juros e saldo das 2 operações recalculados à mão: corretos. |
| Simulador de Nova operação (preenchido e **não** enviado; página recarregada depois) | Único: R$ 1.000 a 10% → juros R$ 100, total R$ 1.100. Parcelado: 3 × R$ 400 → lucro R$ 200, 6,67% a.m., último vencimento 14/01/2027. Avisos "parcelas somam menos" e "maior que o capital disponível" aparecem; o servidor também recusa (`createOperationAction`, capital insuficiente). |
| Celular (390 px, iframe na mesma origem) | Nenhuma das 11 telas com rolagem horizontal; tabelas viram cartões. |
| **Busca do topo** | **Falha:** abre o campo, mas digitar e apertar Enter não faz nada (o `<input>` não tinha `onChange`/`onKeyDown`). |
| **`/setup` sem login** | Mostra "BANCO DE DADOS CONECTADO… PostgreSQL" a qualquer visitante. Não cria nada, mas expõe estado da infraestrutura. |
| Observações sem correção (decisão de design) | Selo "Prévia local" e painel "CrediAI Intelligence" com status fixos ("Processamento ativo", "agora") em produção; KPI do Admin "0 vencidos" junto de "Período de teste vencido" na lista de atenção (teste vencido conta como "em teste" por regra em `commercialGroup`). |

### 13.2 Correções (branch `claude/auditoria-busca-global-setup`, base `main` 5c55e47; enviada depois: PR [#21](https://github.com/thaisfsm/crediai/pull/21), draft, ver 13.8)
Commits locais `13872be` e `9fae773`. Patch: `crediai-busca-global-setup.patch`.

| Arquivo | Mudança |
|---|---|
| `src/lib/finance/search.ts` (novo) | `searchPortfolio`: clientes por nome/e-mail (sem acento, sem diferença de maiúsculas) e CPF/telefone por dígitos (mín. 3, aceita máscara dos dois lados); operações por código (com ou sem `#`) e nome do cliente; mín. 2 caracteres; até 8 resultados. Função pura, sem banco nem sessão. |
| `src/app/dashboard.tsx` | Campo ligado à busca (limite de 80 caracteres); lista de resultados clicável e navegável por Tab; Enter abre o 1º resultado; Esc fecha; "Nenhum cliente ou operação encontrado" anunciado (`role="status"`). Cliente abre a ficha em Clientes; operação abre Operações. Só roda com a busca aberta. |
| `src/app/portfolio-pages.tsx` | `ClientsPage` aceita `initialClientId` (abre a ficha do cliente escolhido na busca). |
| `src/app/globals.css` | Estilo da lista de resultados (foco do teclado mantido). |
| `src/app/setup/page.tsx` | Com banco no ar e `NODE_ENV=production`, `redirect("/")` **no servidor** (componente de servidor; nada é enviado ao navegador). Em desenvolvimento continua mostrando a confirmação e os comandos. Banco não configurado, fora do ar ou com erro: comportamento inalterado (testes DB1–DB5). |
| `tests/search.test.mjs` (novo) | 8 testes: acentos/maiúsculas, CPF e telefone por dígitos, código com/sem `#`, consulta curta e sem resultado, limite, busca pura (sem `@/lib/db`, `@/lib/auth`, `use server`, `fetch`), escopo da carteira da sessão, `/setup` redireciona no servidor. |

**Isolamento por tenant e MASTER:** a busca não cria endpoint nem consulta nova. Ela filtra só `portfolio.clients` e
`portfolio.operations`, que `page.tsx` carrega com `loadTenantPortfolio()` → `withTenantContext` (tenant da sessão,
filtro explícito `tenant_id` em clientes, operações e pagamentos). O MASTER, no `/`, vê só a própria carteira
(`ten_thais`); dados dos tenants continuam só em `/admin`. Portanto um tenant não acha dados de outro pela busca, e a
carteira do MASTER não se mistura com as dos tenants. Comprovado por leitura do código e pelo teste estrutural; **não**
comprovado por E2E (13.4).

**Relação com a pilha:** o PR #12 traz outra busca (`searchClientsAction`, só clientes, dentro da tela Clientes, no
servidor). As duas convivem; ao publicar a pilha, avaliar se a busca do topo passa a usar a regra de
`client-search.ts`. Conflito previsto ao juntar com a pilha: só `src/app/portfolio-pages.tsx` (linhas vizinhas em
`ClientsPage`, resolução trivial: manter as duas).

### 13.3 Testes executados nesta etapa (números reais)
| Verificação | Resultado | Como |
|---|---|---|
| Testes unitários da busca | **8/8 passam** | `node --experimental-strip-types --test tests/search.test.mjs` |
| `database-status`, `finance-rules`, `billing-rules` (regressão financeira e de `/setup`) | **28/28 passam** | idem |
| Typecheck do módulo novo | **passa** | `tsc --strict --noEmit src/lib/finance/search.ts` |
| Demais testes unitários (`admin-audit`, `charges-order`, `financeiro`, `investor-contract`, `investors`, `operations-order`, `rounding`, `wallet-chart`) | **não executados** | `ERR_MODULE_NOT_FOUND`: dependem de `node_modules` |
| Typecheck completo, lint, `next build` | **não executados** | sem `node_modules` |
| E2E (`isolation`, `browser`, `cobrancas`, `financeiro`, `investors`, `investor-contract`, `admin-audit`, `grafico-carteira`) | **não executados** | exigem `node_modules`, PostgreSQL local e o seed fictício (`ten_roberio`, `ten_fernando`, `ten_thais`…), que não está no repositório |
| Validação da busca corrigida no navegador | **não executada** | não há build da branch publicado em lugar nenhum (13.5) |

**Causa comprovada do bloqueio:** neste ambiente, `registry.npmjs.org` está na lista de acesso direto do proxy, mas
o container não tem DNS de saída (`Could not resolve host`), e pelo proxy a conexão é recusada (`403 CONNECT`, política
da organização). Tentado também um Vercel Sandbox descartável (rede liberada, 4 vCPU): ele sobe, mas não consegue
clonar o repositório privado sem credencial, e enviar o código por chamada de ferramenta (≈264 KB comprimidos) não é
viável com segurança. Sandbox desligado após 73 s, sem dado algum.

### 13.4 GitHub e preview
- **GitHub:** `git push` recusado pelo proxy da sessão: *"thaisfsm/crediai is not in this session's authorized repository
  set"* (403). Leitura funciona; escrita e API (`gh`) não. **PR não foi criado.**
- **Preview da Vercel:** não existe para esta branch. Observação: as variáveis `DATABASE_URL`, `BETTER_AUTH_SECRET` e
  `BETTER_AUTH_URL` estão só no ambiente **Production**; um preview sobe sem banco (cai em `/setup` "não configurado")
  e não serve para testar a busca com login.

### 13.5 Situação por item
| Item | Implementado | Testado | Validado no navegador | Publicado em produção |
|---|---|---|---|---|
| Busca global do topo | Sim (PR #21, draft) | Unitário, estrutural, E2E e navegador local (13.8) | Sim, no navegador local com dados fictícios; a falha original foi confirmada na produção | **Não** |
| `/setup` redireciona em produção | Sim (PR #21, draft) | Estrutural, DB1–DB5 e navegador local (13.8) | Sim, no navegador local com `next start`: 307 → `/`. O estado atual foi confirmado na produção | **Não** |

### 13.6 Para concluir (barreiras reais)
1. **Escrita no GitHub:** adicionar `thaisfsm/crediai` como repositório da sessão (fonte do projeto CrediAi_Oficial no
   Claude Code, com permissão de push; o app GitHub do Claude precisa ter acesso ao repositório). Com isso: push das
   duas branches, PR draft da correção (base `main`) e atualização deste relatório no PR #20.
2. **Ambiente com npm** (o mesmo da sessão que rodou as seções 5 e 6, com PostgreSQL local e seed fictício) para
   typecheck, lint, build, unitários e E2E completos; ou liberar `registry.npmjs.org` na rede desta sessão.
3. **Validar a busca no navegador:** depois do PR, num `pnpm build && pnpm start` local com o seed fictício, ou num
   preview com banco **descartável** (nunca o de produção). A decisão de dar banco ao Preview da Vercel é sua.

### 13.7 Confirmação desta etapa
Nenhum merge, deploy, migration, conta criada ou dado real alterado. Na produção: só navegação e leitura; os campos do
simulador foram preenchidos sem envio e descartados. Usuários reais (incluindo Fernando e Robério) não foram tocados.

### 13.8 Envio e validação completa (14/10/2026, 19h UTC, thread "Auditoria geral", com npm e Postgres descartável)
As barreiras 1 e 2 da seção 13.6 foram resolvidas assim.

**Os patches conferem.** Os sha256 são os informados: busca 35f54b8a…1722 e relatório 02d090c5…60be. Os dois
aplicam limpo com `git am`, a busca sobre `origin/main` 5c55e47 e o relatório sobre `claude/project-thread-6z1878`
98b1d27. Os patch-ids são idênticos aos dos commits originais `13872be`, `9fae773` e `98a84f5`. Só o SHA muda, porque
muda a data do commit. As correções não foram recriadas.

**PRs.**
- Correção: [#21](https://github.com/thaisfsm/crediai/pull/21), draft, base `main`, commits `c397945`, `88fdc76` e
  `474aa7e`.
- Este relatório: PR [#22](https://github.com/thaisfsm/crediai/pull/22), draft, branch `claude/auditoria-relatorio-busca-setup`, base `claude/project-thread-6z1878`.

**Defeito achado na validação e corrigido.** O commit novo é o `474aa7e` (só CSS). A regra `.search-popover button`,
feita para o ícone de 27×27, também valia para os resultados. Cada linha ficava com 27 px, e o detalhe ("Cliente" ou o
nome do cliente da operação) era cortado e sobreposto ao resultado seguinte. No celular, o painel ancorado à direita da
lupa saía pela esquerda da tela. As capturas de antes e de depois estão em
`/mnt/project-files/auditoria-busca-global-setup/telas/`.

| Verificação | Resultado real | Comando |
|---|---|---|
| Build, lint, typecheck completo, schema | sem erro, nas duas rodadas (antes e depois do `474aa7e`) | `npm run build`, `npm run lint`, `npx tsc --noEmit`, `drizzle-kit check` |
| Unitários | **111/111**, sendo 103 da main e 8 da busca; nas duas rodadas | `npm test` |
| E2E com BYPASSRLS (7 arquivos, banco novo a cada arquivo) | **61/62** | `run-all.sh crediai_bypass` |
| E2E sem BYPASSRLS (só RLS) | **61/62**, com `isolation` 7/7 | `run-all.sh crediai_app` |
| `browser.e2e.mjs` | **6/6**, nas duas rodadas | `node --test tests/e2e/browser.e2e.mjs` |
| Busca e `/setup` no navegador, desktop 1440 e celular 390 | **30/30**, depois do `474aa7e` | `navegador-busca-setup.mjs` |

A única falha de E2E é o **A5** de `admin-audit`, igual nos dois perfis. O teste procura "14/10/2026" na linha inteira
da conta MASTER, e hoje é 14/10/2026. Ele falha do mesmo jeito na main sem a busca (seção 5.1), e a correção do teste
está no PR #20 (`1420999`). Os E2E rodaram antes do `474aa7e`; depois dele, que só muda CSS, rodaram de novo o build,
o lint, os tipos, os unitários, o `browser.e2e` e a verificação no navegador.

**O que a verificação no navegador cobriu.** Login real como Fernando, com dados fictícios. Os casos:
- nome sem diferença de maiúsculas;
- CPF por dígitos e com máscara;
- telefone e e-mail;
- código da operação com e sem `#`;
- mensagem quando não há resultado (`role=status`);
- consulta de 1 letra, que não busca;
- limite de 80 caracteres;
- clique no cliente, que abre a ficha em Clientes;
- Enter, que abre o 1º resultado (uma operação abre Operações);
- Esc, que fecha e limpa;
- painel dentro da tela e linhas com título e detalhe inteiros;
- nenhuma rolagem horizontal;
- console sem erro.

O isolamento foi testado no navegador: Robério (outro tenant) e o MASTER, em `/`, não acham nenhum cliente ou operação
do Fernando, nem pelo nome, pelo CPF ou pelo código. `/setup` sem login, com o banco no ar e `next start`
(`NODE_ENV=production`), responde **307 → `/`** e termina em `/login`, sem mostrar o estado do banco.

**Ainda pendente.** Validação com login na produção depois de publicar, e publicação, as duas só com seu OK. Na
publicação, juntar com a pilha #12–#20 gera conflito trivial em `src/app/portfolio-pages.tsx`: manter as duas mudanças.

**Confirmação.** Nenhum merge, deploy ou migration. Nenhum dado real foi lido para teste ou alterado. Os PRs estão em
draft.

### 13.9 Pendências do #21 e do #22 resolvidas e integração com a pilha (14/10/2026, 20h UTC)
PRs, todos em draft:
- [#21](https://github.com/thaisfsm/crediai/pull/21): busca global do topo, CSS e `/setup`. Base `main`, ponta `24488b9`.
- [#22](https://github.com/thaisfsm/crediai/pull/22): este relatório. Base `claude/project-thread-6z1878`.
- [#23](https://github.com/thaisfsm/crediai/pull/23): integração, branch `claude/integracao-busca-sobre-pilha`. Base `claude/project-thread-6z1878` (#20, ponta `98b1d27`).

A dependência fica assim: #21 → **#23** ← #20. O #21 e o #22 ficam como estão.

**Conflito e resolução.** Juntar o #21 sobre o #20 deu conflito só em `src/app/portfolio-pages.tsx`, em linhas vizinhas:
- o lado #20 adiciona `function ClientSearch` (busca de clientes do #12, no servidor) logo antes de `ClientsPage`;
- o lado #21 muda a assinatura de `ClientsPage` para aceitar `initialClientId`.

A resolução mantém `ClientSearch` inteira e usa a assinatura do #21. As duas buscas aparecem e funcionam juntas na tela
Clientes (verificado no navegador, abaixo).

Commits da integração:
- `fa79f24`: `git merge --no-ff` do #21 (até `4e87e72`). O arquivo resolvido tem sha256 `aeb3fa6f…2991`, e o diff
  contra o #20 tem sha256 `154ba04e…0b81` (6 arquivos, +135/−6), igual ao conferido por você.
- `1bc4440`: junta a ponta atual do #21 (`24488b9`) mantendo `tests/e2e/admin-audit.e2e.mjs` como em `fa79f24`.
  `git diff fa79f24 --cached` saiu vazio, e a árvore é **idêntica** à de `fa79f24` (`788e62f8…`). Por isso os
  resultados de `fa79f24` valem para `1bc4440`. Agora o #21 inteiro é ancestral do #23, e um merge futuro do #21 não
  tira o ajuste do A5.

**A5: causa comprovada.** Não é regra financeira, fuso, ambiente nem integração. Em `/admin/registros?aba=tenants`, a
linha MASTER mostra "Conta da plataforma | — | Não se aplica | **—** | Criado em". O teste da main procura
"14/10/2026" na linha inteira, e o seed cria o tenant hoje. Então a data encontrada é a de **criação**, não um
vencimento, e o teste só falha quando roda em 14/10/2026.

Reprodução (`a5-reproducao.mjs`):
- com criação em 14/10, o teste antigo falha e o do #20 passa;
- com criação em 15/10, os dois passam;
- se "Vence em" aparecer preenchido na MASTER, o teste do #20 falha, ou seja, ainda detecta o defeito real.

O ajuste está no #20 (`1420999`) e chega ao #23 por ele. No #21, o ajuste que eu tinha copiado (`4e87e72`) foi
desfeito com um commit novo (`24488b9`), sem reescrever histórico. Nenhuma regra financeira mudou.

**Resultados.** Contagens em passou/falhou/ignorado. Servidor local `next start` (`NODE_ENV=production`) e Postgres
descartável com dados fictícios. Cada arquivo E2E roda num banco novo: migrations 0001–0017, seed e depois as
migrations novas.

| Commit | Verificação | `crediai_bypass` (BYPASSRLS) | `crediai_app` (só RLS) |
|---|---|---|---|
| #21 `24488b9` | build, typecheck, lint, `drizzle-kit check` | sem erro (independe do perfil) | — |
| #21 `24488b9` | unitários (`npm test`) | 111/0/0 (independe do perfil) | — |
| #21 `24488b9` | E2E, 7 arquivos, hoje | **61/1/0** (falha só A5) | **61/1/0** (falha só A5) |
| #21 `24488b9` | E2E, 7 arquivos, criação da MASTER simulada em 01/10/2026 | **62/0/0** | **62/0/0** |
| #21 `4e87e72` | E2E, 7 arquivos (com o ajuste do A5, antes de ele ser desfeito) | 62/0/0 | 62/0/0 |
| #21 `4e87e72` | `browser.e2e.mjs` | 6/0/0 | 6/0/0 |
| #21 `4e87e72` | busca e `/setup` no navegador | 30/0 (+2 n/a: não há `ClientSearch` sem o #12) | 30/0 (+2 n/a) |
| #23 `fa79f24` = `1bc4440` | build, typecheck, lint, `drizzle-kit check` | sem erro | — |
| #23 `fa79f24` = `1bc4440` | unitários | 165/0/0 | — |
| #23 `fa79f24` = `1bc4440` | E2E, 18 arquivos | **145/0/0** | **145/0/0** |
| #23 `fa79f24` = `1bc4440` | `browser.e2e.mjs` | 6/0/0 | 6/0/0 |
| #23 `fa79f24` = `1bc4440` | busca e `/setup` no navegador | **34/0** | **34/0** |

Sobre os commits do #21:
- Entre `4e87e72` e `24488b9` muda só o teste A5, e por isso o navegador e o `browser.e2e` do `4e87e72` valem para
  `24488b9`.
- Não existe `faketime` neste ambiente, e o app formata datas sempre no fuso de São Paulo, então mudar o fuso não serve.
  A "data simulada" foi a criação do tenant `ten_thais` em 2026-10-01 12:00 UTC, feita como superusuário, porque o RLS
  esconde a linha do dono. Cada um dos 14 bancos registrou `UPDATE 1`.
- Uma primeira tentativa avulsa da simulação, como dono, atingiu 0 linhas e foi descartada.

Comandos:
- `testes/validacao-completa.sh <tag>`;
- `testes/run-all.sh <perfil>`;
- `testes/run-all-simulada.sh` com `SIMULAR_CRIACAO`;
- `testes/navegador-run.sh <tag> <perfil>`;
- `testes/pr21-24488b9.sh`.

Logs:
- `/mnt/project-files/auditoria-geral/testes/pr21-final/`;
- `pr21-24488b9/`;
- `pr21-24488b9-simulada/`;
- `a5-pr21/`;
- `integracao/`.

**Navegador no #23.** Chromium com Playwright, desktop 1440×900 e celular 390×844. Login real como Fernando, Robério e
MASTER, só com dados fictícios. O roteiro está em `navegador-busca-setup.mjs`, as capturas em `testes/integracao/telas/`.
Itens verificados:
- **Busca do topo:** nome sem acento e sem maiúsculas, CPF por dígitos e com máscara, telefone, e-mail, código da
  operação com e sem `#`, e nome do cliente na operação.
- **Abrir resultados:** o cliente abre a ficha em Clientes; Enter na operação abre Operações.
- **Comportamento do campo:** Esc fecha e limpa; mensagem "Nenhum… encontrado"; 1 letra não busca; limite de 80
  caracteres; painel dentro da tela; linhas sem corte; sem rolagem horizontal; console sem erro.
- **Duas buscas juntas em Clientes:** a `ClientSearch` (#12) acha por CPF e abre a ficha; com texto nela, a busca do
  topo abre outro cliente.
- **Isolamento:** Robério e MASTER não acham nada do Fernando (nome, CPF, código).
- **`/setup` sem login:** responde **307 → `/`** e termina em `/login`.

**Previews da Vercel.** Todos READY, então o build na Vercel passou:
- #21: `dpl_F1a5WmiC…` (`474aa7e`), `dpl_9mAYxvtB…` (`4e87e72`) e `dpl_8QHZ2kxK…` (`24488b9`);
- #22: `dpl_9F759UpE…` (`5af9d32`);
- #23: `dpl_DjNNQWsf…` (`fa79f24`) e `dpl_HFWh2hYA…` (`1bc4440`).

Mesmo assim, o ambiente Preview **não tem `DATABASE_URL`**: as variáveis existem só em Production. O `/setup` do
preview do #21 mostra "Conecte o PostgreSQL gerenciado", conferido por você no Chrome e por mim via Vercel. Login, busca
e isolamento **não** foram validados em preview. O único check do GitHub nos PRs é o da Vercel; o repositório não tem
outra CI.

**Claude in Chrome.** Esta sessão não tem as ferramentas do Claude in Chrome. O navegador usado foi o Chromium da nuvem
contra o servidor local acima.

**Estado por item.**

| Item | Implementado | Teste automatizado | Navegador local | Preview (sem banco) | Produção |
|---|---|---|---|---|---|
| Busca global do topo | Sim (#21; #23 com a pilha) | unit 8/8 (inclui o escopo da carteira da sessão); isolamento no roteiro do navegador | Sim, desktop e celular, 2 perfis | build OK; sem login | **não publicado** |
| CSS da lista de resultados | Sim (`474aa7e`) | verificação de layout no roteiro | Sim | build OK | **não publicado** |
| `/setup` redireciona em produção | Sim | estrutural + DB1–DB5 | Sim (307 → `/`) | mostra "Conecte o PostgreSQL" (sem banco) | **não publicado** |
| Busca do topo + `ClientSearch` juntas | Sim (#23) | E2E 145/145 ×2 | Sim | build OK; sem login | **não publicado** |
| Teste A5 sem depender da data | Sim (#20, `1420999`) | 62/62 no #21 com data simulada; 145/145 no #23 | — | — | não se aplica (teste) |

**O que continua bloqueado, e por quê:**
1. **Publicação** (merge, deploy, migrations da pilha): depende do seu OK, etapa por etapa (seção 10).
2. **Validação com login em produção**: só depois de publicar, e com a sua sessão.
3. **Preview com banco**: exigiria dar ao Preview um banco **descartável**, nunca o de produção. A decisão é sua, e o
   Neon está no limite de 10 branches.

**Confirmação.** Nenhum merge, deploy, migration, variável de ambiente ou dado real foi alterado. Não houve force push.
Todos os PRs estão em draft.

## 14. Publicação em produção (15/10/2026)

Executado por Claude com a autorização de 14/10 20:09 e as instruções de 15/10. Evidências em `/mnt/project-files/publicacao-2026-10-15/` (`EVIDENCIAS-MIGRACOES.md`, `teste-pg18/`, `producao/`).

| Etapa | Estado | Evidência |
|---|---|---|
| Estado inicial | CONCLUÍDA | Produção `5c55e47` (`dpl_HDVbhoZMqWSmGXpxHzSaFuW9ugZE`), 17 migrações, PostgreSQL 18.6, esquema igual ao da 0017 |
| Causa da falha anterior | CONCLUÍDA (inferida) | Inserção sem `id` com a sequência atrasada (16) devolvia 17. Reproduzida no PostgreSQL 18.6 (cenário B) |
| Script v2 | CONCLUÍDA | Gerado dos arquivos oficiais (`gerar-script-v2.py`), ids 18–23 explícitos, `setval` 23, pré-condições e conferência do esquema dentro da transação |
| Teste do script em PostgreSQL 18.6 descartável | CONCLUÍDA | 39/39 verificações: sequência 17 e 16, segunda execução recusada, falha forçada no meio sem resto, cópia alterada desfeita pela conferência do esquema |
| Atomicidade no Neon | CONCLUÍDA | `run_sql_transaction`: mesmo `pg_backend_pid`, mesmo início de transação e `set_config` local visível entre comandos |
| Backup | CONCLUÍDA com limitação | Plano gratuito: 1 snapshot e 10 branches, ambos ocupados (`HTTP 422 snapshots limit exceeded`). Nenhum backup apagado. O snapshot `snap-restless-sound-b46p17x4` (14/10 20:12:46Z) tem os mesmos dados de antes da migração (md5 por tabela idêntico). Restaurá-lo, ou usar a restauração por instante (janela de 6 h), exige uma vaga de branch livre |
| Migrações 0018–0023 | CONCLUÍDA | Uma transação de 149 comandos. Registros 18–23 com hash e data do journal, sequência 23, esquema = referência do Drizzle (col 388, con 145, fn 12, idx 93, pol 102, rls 29, trg 18) |
| Preservação dos dados | CONCLUÍDA | 24 tabelas com md5 idêntico antes e depois. Tabelas novas vazias. Contrato existente com `capital_entry_rule` NULL (não classificado) |
| Testes da versão integrada (árvore `788e62f8`) | CONCLUÍDA | build, typecheck, lint e `drizzle-kit check` sem erro; unitários 165/165; E2E 145/145 com BYPASSRLS e 145/145 sem |
| Integração | CONCLUÍDA | `main` `5c55e47` → `9e4beca` (avanço rápido, sem force push). Merges `--no-ff` de #12, #13, #14, #15, #16, #17, #18, #19, #20 e #23 (que traz o #21). GitHub fechou #12–#21 e #23 como integrados às 13:07:53Z |
| Deploy | CONCLUÍDA | `dpl_DEZZkwindmbwV7Br8bkNxX17Uhvc`, commit `9e4beca`, READY, alias `crediai-sigma.vercel.app` |
| Produção sem login | CONCLUÍDA | `/` e as rotas protegidas redirecionam para `/login`; `/setup` 307; cadastro público recusado (`EMAIL_PASSWORD_SIGN_UP_DISABLED`); login inválido 401; cabeçalhos anti-clickjacking presentes; tela de login sem erros de console no desktop (1366) e no celular (390), sem rolagem lateral; nenhum erro nos logs do deploy |
| Isolamento (banco) | CONCLUÍDA | 0 pagamentos, operações, renovações ou investimentos com tenant diferente do registro pai |
| Produção com login (dashboard, busca, admin, isolamento na tela) | PENDENTE | Precisa da senha de cada conta. Não foi contornado. A mesma tela e o isolamento foram testados nos E2E (perfil igual ao da produção) |

Uso real durante a publicação: às 13:05–13:06 UTC o Fernando cadastrou um aporte e uma operação (com o código antigo, já sobre o esquema novo). Os registros que existiam antes continuam idênticos.
