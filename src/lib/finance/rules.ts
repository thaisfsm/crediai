// Regras financeiras do CrediAI. Todo cálculo de operação e de pagamento passa por este arquivo.

export const CALCULATION_RULE = "RATE_PER_OPERATION_SINGLE_PAYMENT_V1";

export const calculationRuleLabels: Record<string, string> = {
  [CALCULATION_RULE]: "Taxa sobre o principal, pagamento único no vencimento",
};

export function calculateOperation({ principalCents, interestRateBps }: { principalCents: number; interestRateBps: number }) {
  const interestCents = Math.round((principalCents * interestRateBps) / 10_000);
  return { interestCents, totalCents: principalCents + interestCents, calculationRule: CALCULATION_RULE };
}

export type PaymentKind = "INTEREST" | "PARTIAL" | "SETTLEMENT";
export const paymentKindLabels: Record<PaymentKind, string> = { INTEREST: "Juros", PARTIAL: "Parcial", SETTLEMENT: "Quitação" };

type AllocationOperation = { principalCents: number; interestCents: number };
type AllocationPayment = { id: string; amountCents: number; paidAt: string; createdAt?: string };

// Regra de apropriação (versão 1): cada pagamento quita primeiro os juros pendentes e depois o principal.
// Os pagamentos são aplicados em ordem de data (e de registro, no mesmo dia). Como os juros vêm sempre primeiro,
// os totais de juros e de principal recebidos não dependem dessa ordem, só da soma paga.
export function allocatePayments<T extends AllocationPayment>(operation: AllocationOperation, payments: T[]) {
  const ordered = [...payments].sort((a, b) => a.paidAt.localeCompare(b.paidAt) || (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  const totalCents = operation.principalCents + operation.interestCents;
  let interestPaidCents = 0;
  let principalPaidCents = 0;
  const items = ordered.map((payment) => {
    const interestPart = Math.min(payment.amountCents, Math.max(operation.interestCents - interestPaidCents, 0));
    const principalPart = payment.amountCents - interestPart;
    interestPaidCents += interestPart;
    principalPaidCents += principalPart;
    const kind: PaymentKind = interestPaidCents + principalPaidCents >= totalCents ? "SETTLEMENT" : principalPart === 0 ? "INTEREST" : "PARTIAL";
    return { ...payment, interestCents: interestPart, principalCents: principalPart, kind };
  });
  const paidCents = interestPaidCents + principalPaidCents;
  return {
    items,
    paidCents,
    interestPaidCents,
    principalPaidCents,
    interestRemainingCents: Math.max(operation.interestCents - interestPaidCents, 0),
    principalRemainingCents: Math.max(operation.principalCents - principalPaidCents, 0),
    balanceCents: Math.max(totalCents - paidCents, 0),
  };
}

export type PaymentCheck = { ok: true; settles: boolean } | { ok: false; error: string };

// Um pagamento precisa ser positivo e não pode passar do saldo em aberto. Pagar exatamente o saldo quita a operação.
export function checkPayment({ amountCents, balanceCents, formatMoney }: { amountCents: number; balanceCents: number; formatMoney: (cents: number) => string }): PaymentCheck {
  if (balanceCents <= 0) return { ok: false, error: "Esta operação não tem saldo em aberto." };
  if (amountCents <= 0) return { ok: false, error: "Informe o valor recebido, por exemplo 300,00." };
  if (amountCents > balanceCents) return { ok: false, error: `O pagamento não pode ser maior que o saldo em aberto de ${formatMoney(balanceCents)}.` };
  return { ok: true, settles: amountCents === balanceCents };
}
