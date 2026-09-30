// Regra de cálculo das operações. O CrediAI ainda não tem regra financeira oficial documentada;
// esta é a regra provisória que não assume periodicidade: a taxa informada incide uma única vez
// sobre o principal, com pagamento único no vencimento informado pelo usuário. Cada operação guarda
// o identificador da regra que calculou seus valores, para que regras futuras convivam com as antigas.
export const CALCULATION_RULE = "RATE_PER_OPERATION_SINGLE_PAYMENT_V1";

export const calculationRuleLabels: Record<string, string> = {
  [CALCULATION_RULE]: "Taxa sobre o principal, pagamento único no vencimento",
};

export function calculateOperation({ principalCents, interestRateBps }: { principalCents: number; interestRateBps: number }) {
  const interestCents = Math.round((principalCents * interestRateBps) / 10_000);
  return { interestCents, totalCents: principalCents + interestCents, calculationRule: CALCULATION_RULE };
}
