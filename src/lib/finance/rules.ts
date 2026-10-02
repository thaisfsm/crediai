// Regras financeiras do CrediAI. Todo cálculo de operação e de pagamento passa por este arquivo.

export const CALCULATION_RULE = "RATE_PER_OPERATION_SINGLE_PAYMENT_V1";

export const calculationRuleLabels: Record<string, string> = {
  [CALCULATION_RULE]: "Taxa sobre o principal, pagamento único no vencimento",
  FIXED_MONTHLY_INSTALLMENTS_V1: "Parcelado: parcelas mensais fixas (PMT)",
};

export function calculateOperation({ principalCents, interestRateBps }: { principalCents: number; interestRateBps: number }) {
  const interestCents = Math.round((principalCents * interestRateBps) / 10_000);
  return { interestCents, totalCents: principalCents + interestCents, calculationRule: CALCULATION_RULE };
}

export type PaymentKind = "INTEREST" | "PARTIAL" | "SETTLEMENT" | "RENEWAL" | "INSTALLMENT";
export const paymentKindLabels: Record<PaymentKind, string> = {
  INTEREST: "Juros", PARTIAL: "Pagamento de principal", SETTLEMENT: "Quitação", RENEWAL: "Juros / Renovação", INSTALLMENT: "Parcela",
};

// ── Modalidade parcelada ──────────────────────────────────────────────────────────────────────────────────────────
// O usuário informa o valor presente (valor emprestado), o valor da parcela (PMT), o primeiro vencimento e o prazo em
// meses. Uma parcela por mês: quantidade de parcelas = prazo; total = PMT × parcelas; lucro = total − valor presente.
// A taxa mensal é a que iguala o valor presente às parcelas (tabela Price): VP = PMT × (1 − (1 + i)^−n) / i.
export const INSTALLMENT_RULE = "FIXED_MONTHLY_INSTALLMENTS_V1";

export function installmentRate({ presentValueCents, installmentCents, count }: { presentValueCents: number; installmentCents: number; count: number }) {
  const total = installmentCents * count;
  if (total <= presentValueCents) return 0;
  const presentValue = (rate: number) => installmentCents * (1 - (1 + rate) ** -count) / rate;
  // presentValue cai quando a taxa sobe: busca binária até a precisão de centésimo de ponto-base.
  let low = 1e-9, high = 10;
  for (let step = 0; step < 200; step += 1) {
    const middle = (low + high) / 2;
    if (presentValue(middle) > presentValueCents) low = middle; else high = middle;
  }
  return (low + high) / 2;
}

export function calculateInstallments({ presentValueCents, installmentCents, count }: { presentValueCents: number; installmentCents: number; count: number }) {
  const totalCents = installmentCents * count;
  const monthlyRate = installmentRate({ presentValueCents, installmentCents, count });
  return {
    interestCents: totalCents - presentValueCents, totalCents, calculationRule: INSTALLMENT_RULE,
    // Taxa mensal em pontos-base (1% = 100), arredondada; a taxa exata fica em monthlyRate.
    interestRateBps: Math.round(monthlyRate * 10_000), monthlyRate,
  };
}

// Vencimento da parcela k (1 = primeiro vencimento), mês a mês. Dia 31 em mês curto vira o último dia do mês.
export function installmentDueDate(firstDueDate: string, number: number) {
  const [year, month, day] = firstDueDate.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + number - 1, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

export type InstallmentState = "PAID" | "PARTIAL" | "OPEN";
// Parcelas cobertas pelo total pago, na ordem: o que foi pago quita a 1ª parcela, depois a 2ª, e assim por diante.
export function installmentSchedule({ firstDueDate, installmentCount, installmentCents, paidCents }: { firstDueDate: string; installmentCount: number; installmentCents: number; paidCents: number }) {
  return Array.from({ length: installmentCount }, (_, index) => {
    const paid = Math.min(Math.max(paidCents - index * installmentCents, 0), installmentCents);
    const state: InstallmentState = paid === installmentCents ? "PAID" : paid > 0 ? "PARTIAL" : "OPEN";
    return { number: index + 1, dueDate: installmentDueDate(firstDueDate, index + 1), amountCents: installmentCents, paidCents: paid, remainingCents: installmentCents - paid, state };
  });
}

// interestCents = juros contratados até agora: os do período original mais os de cada período renovado.
// proportional (parcelado): cada pagamento leva juros e principal na proporção do contrato, em vez de juros primeiro.
type AllocationOperation = { principalCents: number; interestCents: number; proportional?: boolean };
// renewal: pagamento só dos juros que renovou o período.
type AllocationPayment = { id: string; amountCents: number; paidAt: string; createdAt?: string; renewal?: boolean };

// RENOVAÇÃO — REGRA OFICIAL (modalidade pagamento único). Exemplo: R$ 1.000 a 30% ao mês, juros R$ 300, quitação R$ 1.300.
//  • Pagar R$ 1.300 quita: R$ 300 são juros (lucro) e R$ 1.000 voltam como principal.
//  • Pagar só os R$ 300 de juros NÃO é pagamento de principal: é "Juros / Renovação". Juros recebidos +300, principal em
//    aberto continua R$ 1.000, o vencimento avança um período e o valor para quitação continua R$ 1.300.
//  • Cada novo período gera de novo 30% sobre o PRINCIPAL EM ABERTO (R$ 1.000 → R$ 300). Nunca 30% de R$ 1.300 (= R$ 390)
//    nem de R$ 1.600 (= R$ 480): os juros já pagos são lucro recebido e não entram na base de cálculo.
export function renewalInterest({ principalRemainingCents, interestRateBps }: { principalRemainingCents: number; interestRateBps: number }) {
  return calculateOperation({ principalCents: principalRemainingCents, interestRateBps }).interestCents;
}

// Regra de apropriação (versão 1): cada pagamento quita primeiro os juros pendentes e depois o principal.
// Os pagamentos são aplicados em ordem de data (e de registro, no mesmo dia). Como os juros vêm sempre primeiro,
// os totais de juros e de principal recebidos não dependem dessa ordem, só da soma paga.
export function allocatePayments<T extends AllocationPayment>(operation: AllocationOperation, payments: T[]) {
  const ordered = [...payments].sort((a, b) => a.paidAt.localeCompare(b.paidAt) || (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  const totalCents = operation.principalCents + operation.interestCents;
  let interestPaidCents = 0;
  let principalPaidCents = 0;
  const items = ordered.map((payment) => {
    const interestLeft = Math.max(operation.interestCents - interestPaidCents, 0);
    const finishes = interestPaidCents + principalPaidCents + payment.amountCents >= totalCents;
    // Parcelado: juros na proporção do contrato (o último pagamento leva o que faltar). Pagamento único: juros primeiro.
    const interestPart = operation.proportional && totalCents > 0
      ? (finishes ? interestLeft : Math.min(interestLeft, Math.round((payment.amountCents * operation.interestCents) / totalCents)))
      : Math.min(payment.amountCents, interestLeft);
    const principalPart = payment.amountCents - interestPart;
    interestPaidCents += interestPart;
    principalPaidCents += principalPart;
    const kind: PaymentKind = interestPaidCents + principalPaidCents >= totalCents ? "SETTLEMENT"
      : operation.proportional ? "INSTALLMENT" : payment.renewal ? "RENEWAL" : principalPart === 0 ? "INTEREST" : "PARTIAL";
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
