// Edição segura de operação (Etapa G, parte 1): o que mudou, campo a campo, para a comparação antes/depois na tela e
// para o histórico (loan_operation_revision). Regras puras, usadas no servidor e nos testes.
// Só operações em aberto, do ciclo atual, SEM pagamentos e SEM renovações podem ser editadas (decisão D-G1, opção a):
// assim nenhum valor já recebido muda de classificação. Modalidade e periodicidade não mudam na edição.
import { formatDate, formatMoney, formatRate } from "./format";
import { BIWEEKLY_FIXED_RULE, BIWEEKLY_RULE, DAILY_RULE, calculationRuleLabels } from "./rules";

const ruleLabels: Record<string, string> = {
  ...calculationRuleLabels,
  [BIWEEKLY_RULE]: "Taxa por quinzena sobre o principal",
  [BIWEEKLY_FIXED_RULE]: "Valor fixo de juros por quinzena",
  [DAILY_RULE]: "Diário: total dividido em um pagamento por dia",
};

export type OperationEditSnapshot = {
  clientId: string; clientName: string; principalCents: number; interestRateBps: number; interestCents: number; totalCents: number;
  loanDate: string; dueDate: string; firstDueDate: string | null; installmentCount: number | null; installmentCents: number | null;
  calculationRule: string; modality: string; frequency: string;
};
export type OperationChange = { field: string; before: string | null; after: string | null };

const money = (cents: number | null) => (cents === null ? null : formatMoney(cents));
const day = (iso: string | null) => (iso ? formatDate(iso) : null);

const fields: [string, (value: OperationEditSnapshot) => string | null][] = [
  ["Cliente", (value) => value.clientName],
  ["Valor emprestado", (value) => money(value.principalCents)],
  ["Taxa de juros", (value) => formatRate(value.interestRateBps)],
  ["Juros", (value) => money(value.interestCents)],
  ["Total a receber", (value) => money(value.totalCents)],
  ["Data do empréstimo", (value) => day(value.loanDate)],
  ["Primeiro vencimento", (value) => day(value.firstDueDate ?? value.dueDate)],
  ["Último vencimento", (value) => day(value.dueDate)],
  ["Quantidade de parcelas", (value) => (value.installmentCount === null ? null : String(value.installmentCount))],
  ["Valor da parcela", (value) => money(value.installmentCents)],
  ["Forma de cálculo", (value) => ruleLabels[value.calculationRule] ?? value.calculationRule],
];

export function operationChanges(before: OperationEditSnapshot, after: OperationEditSnapshot): OperationChange[] {
  return fields.flatMap(([field, show]) => {
    const was = show(before);
    const now = show(after);
    return was === now ? [] : [{ field, before: was, after: now }];
  });
}

// Motivo da correção: obrigatório, fica no histórico.
export function editReason(value: string): { ok: true; value: string } | { ok: false; error: string } {
  const reason = value.trim().replace(/\s+/g, " ");
  if (reason.length < 3) return { ok: false, error: "Informe o motivo da correção (por exemplo: valor digitado errado)." };
  return { ok: true, value: reason.slice(0, 300) };
}
