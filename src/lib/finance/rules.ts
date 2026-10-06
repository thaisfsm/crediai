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
  const interestCents = totalCents - presentValueCents;
  // Taxa do CrediAI: juros simples ao mês (juros totais / valor presente / meses). Ex.: 6.000 / 10.000 / 10 = 6%.
  const monthlyRate = simpleMonthlyRate({ principalCents: presentValueCents, interestCents: Math.max(interestCents, 0), months: count });
  return {
    interestCents, totalCents, calculationRule: INSTALLMENT_RULE,
    // Taxa simples mensal em pontos-base (1% = 100), arredondada; a exata fica em monthlyRate.
    interestRateBps: Math.round(monthlyRate * 10_000), monthlyRate,
    // Custo efetivo pela tabela Price (juros compostos sobre o saldo devedor), só informativo. Era a taxa exibida antes.
    priceRate: installmentRate({ presentValueCents, installmentCents, count }),
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

// ══ Calendário comercial (30/360) ═════════════════════════════════════════════════════════════════════════════════
// Convenção financeira do CrediAI: ano comercial = 360 dias, mês comercial = 30 dias, quinzena = 15 dias, dia = 1/360
// do ano. Ela vale para converter taxas entre períodos e para juros proporcionais a um prazo. Datas de vencimento e
// dias de atraso continuam sendo datas reais do calendário (o cliente paga num dia do calendário).
export const COMMERCIAL_YEAR_DAYS = 360;
export const COMMERCIAL_MONTH_DAYS = 30;
export const COMMERCIAL_FORTNIGHT_DAYS = 15;

// Dias comerciais entre duas datas (30E/360): cada mês conta 30 dias e o dia 31 conta como 30.
// dias = 360 × (a2 − a1) + 30 × (m2 − m1) + (min(d2, 30) − min(d1, 30)). Ex.: 01/03 → 01/04 = 30; 31/01 → 28/02 = 28.
export function commercialDaysBetween(fromIso: string, toIso: string) {
  const [y1, m1, d1] = fromIso.split("-").map(Number);
  const [y2, m2, d2] = toIso.split("-").map(Number);
  return COMMERCIAL_YEAR_DAYS * (y2 - y1) + COMMERCIAL_MONTH_DAYS * (m2 - m1) + (Math.min(d2, 30) - Math.min(d1, 30));
}

// Taxa de um prazo a partir da taxa mensal, em juros simples: taxa(dias) = taxa mensal × dias / 30.
// Ex.: 30% ao mês → 15% na quinzena, 1% ao dia, 360% ao ano.
export function rateForDays(monthlyRateBps: number, days: number) {
  return (monthlyRateBps * days) / COMMERCIAL_MONTH_DAYS;
}
// Taxa mensal equivalente (juros simples) de uma taxa de um prazo: taxa mensal = taxa do prazo × 30 / dias.
export function monthlyEquivalentRate(periodRateBps: number, periodDays: number) {
  return (periodRateBps * COMMERCIAL_MONTH_DAYS) / periodDays;
}
// Juros simples proporcionais: J = P × taxa mensal × dias / 30, arredondado ao centavo (meio centavo para cima).
export function proportionalInterest({ principalCents, monthlyRateBps, days }: { principalCents: number; monthlyRateBps: number; days: number }) {
  return Math.round((principalCents * monthlyRateBps * days) / (10_000 * COMMERCIAL_MONTH_DAYS));
}

// ══ Periodicidade do pagamento único ══════════════════════════════════════════════════════════════════════════════
// MONTHLY e BIWEEKLY: juros recorrentes. A cada período vencem juros = taxa do período × principal em aberto; o principal
// fica em aberto enquanto o cliente paga só os juros e a operação termina quando o principal é pago.
// DAILY: amortização. Total = principal × (1 + taxa do período), dividido em N pagamentos diários (principal e juros
// juntos); o último pagamento recebe o ajuste de centavos.
export type Frequency = "MONTHLY" | "BIWEEKLY" | "DAILY";
export const frequencyLabels: Record<Frequency, string> = { MONTHLY: "Mensal", BIWEEKLY: "Quinzenal", DAILY: "Diário" };
export const frequencyPeriodDays: Record<Frequency, number> = { MONTHLY: COMMERCIAL_MONTH_DAYS, BIWEEKLY: COMMERCIAL_FORTNIGHT_DAYS, DAILY: 1 };
export const DAILY_RULE = "DAILY_AMORTIZED_V1";
export const BIWEEKLY_RULE = "RATE_PER_FORTNIGHT_RECURRING_V1";
calculationRuleLabels[DAILY_RULE] = "Diário: total (principal + juros) dividido em pagamentos diários";
calculationRuleLabels[BIWEEKLY_RULE] = "Quinzenal: juros a cada quinzena sobre o principal em aberto";

const lastDayOfMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const isoOf = (year: number, month: number, day: number) => new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
function plusDays(iso: string, days: number) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
const calendarDaysBetween = (fromIso: string, toIso: string) => Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);

// Mês seguinte mantendo o dia combinado (anchorDay). Em mês curto usa o último dia: 31/01 → 28/02 → 31/03.
export function nextMonthlyDue(currentIso: string, anchorDay = Number(currentIso.slice(8, 10))) {
  const [year, month] = currentIso.split("-").map(Number);
  const target = new Date(Date.UTC(year, month, 1));
  const targetYear = target.getUTCFullYear(), targetMonth = target.getUTCMonth() + 1;
  return isoOf(targetYear, targetMonth, Math.min(anchorDay, lastDayOfMonth(targetYear, targetMonth)));
}

// Quinzenal: dois vencimentos por mês, no dia do primeiro vencimento e 15 dias comerciais depois (ou antes).
// Primeiro vencimento dia 15 → dias 15 e 30 (em fevereiro, o último dia); dia 10 → dias 10 e 25; dia 20 → dias 5 e 20.
// Se o vencimento atual saiu desse par (data informada à mão), o próximo é 15 dias depois.
export function biweeklyDays(anchorDay: number) {
  const first = anchorDay > 15 ? anchorDay - 15 : anchorDay;
  return [first, first + 15] as const;
}
export function nextBiweeklyDue(currentIso: string, anchorDay: number) {
  const [year, month, day] = currentIso.split("-").map(Number);
  const [first, second] = biweeklyDays(anchorDay);
  const secondThisMonth = Math.min(second, lastDayOfMonth(year, month));
  if (day === first) return isoOf(year, month, secondThisMonth);
  if (day === secondThisMonth) {
    const target = new Date(Date.UTC(year, month, 1));
    return isoOf(target.getUTCFullYear(), target.getUTCMonth() + 1, first);
  }
  return plusDays(currentIso, COMMERCIAL_FORTNIGHT_DAYS);
}

// Função única de vencimentos: o próximo vencimento depois de currentIso, conforme a periodicidade.
// anchorDay é o dia do primeiro vencimento combinado (mensal e quinzenal mantêm esse dia).
export function nextDueDate(frequency: Frequency, currentIso: string, anchorDay = Number(currentIso.slice(8, 10))) {
  if (frequency === "DAILY") return plusDays(currentIso, 1);
  if (frequency === "BIWEEKLY") return nextBiweeklyDue(currentIso, anchorDay);
  // Mensal: se o vencimento atual é o fim de um mês curto (28/02 vindo de um dia 31), volta ao dia combinado.
  const day = Number(currentIso.slice(8, 10));
  const [year, month] = currentIso.split("-").map(Number);
  const anchor = day === lastDayOfMonth(year, month) && anchorDay > day ? anchorDay : day;
  return nextMonthlyDue(currentIso, anchor);
}
// Os próximos `count` vencimentos a partir do primeiro (inclusive).
export function dueDates(frequency: Frequency, firstDueIso: string, count: number) {
  const anchorDay = Number(firstDueIso.slice(8, 10));
  const dates = [firstDueIso];
  while (dates.length < count) dates.push(nextDueDate(frequency, dates[dates.length - 1], anchorDay));
  return dates;
}

// ── Diário ──
// Juros do período = round(P × taxa); total = P + juros; pagamento = ⌊total / N⌋ centavos; o último pagamento é
// total − pagamento × (N − 1), então a soma é exatamente o total. Vencimentos: um por dia, do dia seguinte ao empréstimo
// até o N-ésimo dia (dias corridos, como o restante do sistema; finais de semana não são pulados).
// Ex.: R$ 10.000 a 30% em 30 dias → juros R$ 3.000, total R$ 13.000, 29 × R$ 433,33 + 1 × R$ 433,43.
export function calculateDaily({ principalCents, interestRateBps, days, loanDate }: { principalCents: number; interestRateBps: number; days: number; loanDate: string }) {
  const { interestCents, totalCents } = calculateOperation({ principalCents, interestRateBps });
  const installmentCents = Math.floor(totalCents / days);
  const lastInstallmentCents = totalCents - installmentCents * (days - 1);
  const firstDueDate = plusDays(loanDate, 1);
  return {
    interestCents, totalCents, calculationRule: DAILY_RULE, installmentCount: days, installmentCents, lastInstallmentCents,
    firstDueDate, lastDueDate: plusDays(loanDate, days),
    // Taxa ao dia e ao mês equivalentes (juros simples, mês comercial de 30 dias).
    dailyRateBps: interestRateBps / days, monthlyEquivalentBps: monthlyEquivalentRate(interestRateBps, days),
  };
}

// ── Parcelado: taxa simples ──
// Taxa simples mensal = juros totais / principal / número de meses. Ex.: R$ 6.000 / R$ 10.000 / 10 = 6% ao mês.
// A taxa da tabela Price (installmentRate) é outra coisa: juros compostos sobre o saldo que diminui a cada parcela.
export function simpleMonthlyRate({ principalCents, interestCents, months }: { principalCents: number; interestCents: number; months: number }) {
  if (principalCents <= 0 || months <= 0) return 0;
  return interestCents / principalCents / months;
}

// ══ Extrato da operação (ledger) ═════════════════════════════════════════════════════════════════════════════════
// Uma função só calcula, a partir dos dados gravados e dos pagamentos, tudo o que a tela, os cards e o servidor usam:
// quanto de cada pagamento foi juros e principal, o período atual, o próximo vencimento, o saldo e a situação.
export type LedgerRenewal = { paymentId: string; periodNumber: number; previousDueDate: string; newDueDate: string; principalBaseCents: number; interestCents: number };
export type LedgerTerms = {
  modality: "SINGLE" | "INSTALLMENT"; frequency: Frequency;
  principalCents: number; interestRateBps: number;
  // Recorrente: juros do primeiro período. Amortizado (parcelado ou diário): juros totais do contrato.
  interestCents: number;
  // Recorrente: primeiro vencimento combinado. Amortizado: primeira parcela, quantidade e valor (o último pode ter ajuste).
  firstDueDate: string;
  installmentCount: number | null; installmentCents: number | null;
  renewals: LedgerRenewal[];
};
export type LedgerPayment = { id: string; amountCents: number; paidAt: string; createdAt?: string };
export type LedgerPeriod = { number: number; dueDate: string; interestCents: number; principalBaseCents: number; openedOn: string | null; openedBy: "CONTRACT" | "PAYMENT" | "DUE_DATE"; paymentId: string | null };
export type ScheduleItem = { number: number; dueDate: string; amountCents: number; paidCents: number; remainingCents: number; state: InstallmentState };
export type LedgerItem<T> = T & { interestCents: number; principalCents: number; kind: PaymentKind; balanceBeforeCents: number; renewedPeriod: LedgerPeriod | null };
export type LedgerState = "ACTIVE" | "DUE_TODAY" | "OVERDUE" | "PAID";

const isAmortized = (terms: LedgerTerms) => terms.modality === "INSTALLMENT" || terms.frequency === "DAILY";

// Parcelas do contrato amortizado: todas iguais; no diário a última leva o ajuste para fechar o total.
export function amortizedSchedule(terms: Pick<LedgerTerms, "frequency" | "firstDueDate" | "installmentCount" | "installmentCents" | "principalCents" | "interestCents" | "modality">, paidCents: number): ScheduleItem[] {
  const count = terms.installmentCount ?? 0, base = terms.installmentCents ?? 0;
  const totalCents = terms.principalCents + terms.interestCents;
  const frequency: Frequency = terms.modality === "INSTALLMENT" ? "MONTHLY" : terms.frequency;
  const dates = dueDates(frequency, terms.firstDueDate, count);
  let covered = 0;
  return dates.map((dueDate, index) => {
    const amountCents = index === count - 1 ? totalCents - base * (count - 1) : base;
    const paid = Math.min(Math.max(paidCents - covered, 0), amountCents);
    covered += amountCents;
    const state: InstallmentState = paid === amountCents ? "PAID" : paid > 0 ? "PARTIAL" : "OPEN";
    return { number: index + 1, dueDate, amountCents, paidCents: paid, remainingCents: amountCents - paid, state };
  });
}

const byDate = <T extends LedgerPayment>(a: T, b: T) => a.paidAt.localeCompare(b.paidAt) || (a.createdAt ?? "").localeCompare(b.createdAt ?? "");

// asOf = hoje (fuso de Brasília). Os pagamentos podem vir em qualquer ordem; são aplicados por data e registro.
export function operationLedger<T extends LedgerPayment>(terms: LedgerTerms, payments: T[], asOf: string) {
  const ordered = [...payments].sort(byDate);
  return isAmortized(terms) ? amortizedLedger(terms, ordered, asOf) : recurringLedger(terms, ordered, asOf);
}
export type OperationLedger<T extends LedgerPayment = LedgerPayment> = ReturnType<typeof operationLedger<T>>;

function stateFor(balanceCents: number, nextDue: string | null, asOf: string): { state: LedgerState; daysUntilDue: number } {
  if (balanceCents <= 0 || !nextDue) return { state: "PAID", daysUntilDue: 0 };
  const daysUntilDue = calendarDaysBetween(asOf, nextDue);
  return { state: daysUntilDue < 0 ? "OVERDUE" : daysUntilDue === 0 ? "DUE_TODAY" : "ACTIVE", daysUntilDue };
}

// Parcelado e diário: cada pagamento leva juros e principal na proporção do contrato (o que zera o saldo leva o resto
// dos juros). As parcelas são cobertas em ordem pelo total pago; a situação vem da primeira parcela não paga.
function amortizedLedger<T extends LedgerPayment>(terms: LedgerTerms, ordered: T[], asOf: string) {
  const totalCents = terms.principalCents + terms.interestCents;
  let interestPaidCents = 0, principalPaidCents = 0;
  const items: LedgerItem<T>[] = ordered.map((payment) => {
    const balanceBeforeCents = Math.max(totalCents - interestPaidCents - principalPaidCents, 0);
    const interestLeft = Math.max(terms.interestCents - interestPaidCents, 0);
    const finishes = payment.amountCents >= balanceBeforeCents;
    const interestPart = finishes ? interestLeft : Math.min(interestLeft, Math.round((payment.amountCents * terms.interestCents) / Math.max(totalCents, 1)));
    const principalPart = payment.amountCents - interestPart;
    interestPaidCents += interestPart;
    principalPaidCents += principalPart;
    return { ...payment, interestCents: interestPart, principalCents: principalPart, kind: finishes ? "SETTLEMENT" : "INSTALLMENT", balanceBeforeCents, renewedPeriod: null };
  });
  const paidCents = interestPaidCents + principalPaidCents;
  const schedule = amortizedSchedule(terms, paidCents);
  const nextItem = schedule.find((item) => item.state !== "PAID") ?? null;
  const balanceCents = Math.max(totalCents - paidCents, 0);
  const nextDue = nextItem?.dueDate ?? schedule.at(-1)?.dueDate ?? terms.firstDueDate;
  return {
    items, paidCents, interestPaidCents, principalPaidCents,
    interestCents: terms.interestCents, totalCents,
    interestRemainingCents: Math.max(terms.interestCents - interestPaidCents, 0),
    principalRemainingCents: Math.max(terms.principalCents - principalPaidCents, 0),
    balanceCents, schedule, nextItem, nextDueDate: nextDue,
    periods: [] as LedgerPeriod[], periodNumber: 1, periodInterestCents: terms.interestCents, renewalCount: 0,
    // Próximo valor a cobrar: o que falta da próxima parcela.
    amountDueCents: nextItem?.remainingCents ?? 0,
    ...stateFor(balanceCents, nextItem?.dueDate ?? null, asOf),
  };
}

// Mensal e quinzenal (juros recorrentes). Regras:
//  1. Período k vence em dueDate_k e cobra juros_k = taxa do período × principal em aberto no início do período.
//  2. Cada pagamento quita primeiro os juros do período atual e depois o principal (regra de apropriação existente).
//  3. Renovação: com os juros do período quitados e principal em aberto, abre-se o período seguinte — na hora, quando
//     o pagamento foi registrado como "somente juros" (linha em loan_renewal, com o vencimento escolhido), ou no
//     vencimento do período, quando os juros foram pagos e nada mais (ex.: pagamento registrado antes de existir a
//     renovação, como o do Alexandre). O próximo vencimento vem de nextDueDate e os juros, do principal em aberto.
//  4. Quitação: principal em aberto zerado com os juros do período pagos.
// Não há juros sobre juros, nem juros de atraso: um período vencido sem os juros pagos fica Em atraso e só renova
// quando os juros dele forem pagos.
function recurringLedger<T extends LedgerPayment>(terms: LedgerTerms, ordered: T[], asOf: string) {
  const anchorDay = Number(terms.firstDueDate.slice(8, 10));
  const rows = new Map(terms.renewals.map((row) => [row.paymentId, row]));
  const periods: LedgerPeriod[] = [{ number: 1, dueDate: terms.firstDueDate, interestCents: terms.interestCents, principalBaseCents: terms.principalCents, openedOn: null, openedBy: "CONTRACT", paymentId: null }];
  let principalOpen = terms.principalCents, periodInterestPaid = 0, interestPaidCents = 0, principalPaidCents = 0;
  // Pagamento só de juros que completou os juros do período atual (vira "Juros / Renovação" se o período renovar).
  let completedBy: LedgerItem<T> | null = null;
  const current = () => periods[periods.length - 1];
  const open = (period: Omit<LedgerPeriod, "number">) => {
    periods.push({ number: periods.length + 1, ...period });
    periodInterestPaid = 0;
    if (completedBy) { completedBy.kind = "RENEWAL"; completedBy.renewedPeriod = current(); }
    completedBy = null;
  };
  // Renovação no vencimento: juros do período pagos, principal em aberto e a data chegou.
  const renewOnDue = (date: string) => {
    while (principalOpen > 0 && periodInterestPaid >= current().interestCents && date >= current().dueDate) {
      const due = current().dueDate;
      open({ dueDate: nextDueDate(terms.frequency, due, anchorDay), interestCents: renewalInterest({ principalRemainingCents: principalOpen, interestRateBps: terms.interestRateBps }), principalBaseCents: principalOpen, openedOn: due, openedBy: "DUE_DATE", paymentId: null });
    }
  };
  const items: LedgerItem<T>[] = ordered.map((payment) => {
    renewOnDue(payment.paidAt);
    const interestLeft = Math.max(current().interestCents - periodInterestPaid, 0);
    const balanceBeforeCents = principalOpen + interestLeft;
    const interestPart = Math.min(payment.amountCents, interestLeft);
    const principalPart = Math.min(payment.amountCents - interestPart, principalOpen);
    periodInterestPaid += interestPart;
    interestPaidCents += interestPart;
    principalOpen -= principalPart;
    principalPaidCents += principalPart;
    const settles = principalOpen === 0 && periodInterestPaid >= current().interestCents;
    const item: LedgerItem<T> = { ...payment, interestCents: interestPart, principalCents: principalPart, kind: settles ? "SETTLEMENT" : principalPart > 0 ? "PARTIAL" : "INTEREST", balanceBeforeCents, renewedPeriod: null };
    completedBy = !settles && principalPart === 0 && interestPart > 0 && periodInterestPaid >= current().interestCents ? item : null;
    const row = rows.get(payment.id);
    if (row && principalOpen > 0 && periodInterestPaid >= current().interestCents) {
      completedBy = item;
      open({ dueDate: row.newDueDate, interestCents: row.interestCents, principalBaseCents: row.principalBaseCents, openedOn: payment.paidAt, openedBy: "PAYMENT", paymentId: payment.id });
    }
    return item;
  });
  renewOnDue(asOf);
  const period = current();
  const interestCents = periods.reduce((total, item) => total + item.interestCents, 0);
  const interestRemainingCents = principalOpen > 0 || periodInterestPaid < period.interestCents ? Math.max(period.interestCents - periodInterestPaid, 0) : 0;
  const balanceCents = principalOpen + interestRemainingCents;
  return {
    items, paidCents: interestPaidCents + principalPaidCents, interestPaidCents, principalPaidCents,
    interestCents, totalCents: terms.principalCents + interestCents,
    interestRemainingCents, principalRemainingCents: principalOpen, balanceCents,
    schedule: [] as ScheduleItem[], nextItem: null as ScheduleItem | null, nextDueDate: period.dueDate,
    periods, periodNumber: period.number, periodInterestCents: period.interestCents, renewalCount: periods.length - 1,
    // Próximo valor a cobrar: os juros que faltam do período (ou o saldo, se só restar principal).
    amountDueCents: interestRemainingCents > 0 ? interestRemainingCents : balanceCents,
    ...stateFor(balanceCents, period.dueDate, asOf),
  };
}

// Pagamento somente de juros (regra central): só existe nos juros recorrentes (mensal e quinzenal), quando o valor é
// exatamente o que falta dos juros do período atual e ainda há principal em aberto. Quita os juros do período, mantém o
// principal, abre o período seguinte (vencimento por nextDueDate, ou a data informada) com juros sobre o principal.
export function interestOnlyRenewal(terms: LedgerTerms, ledger: Pick<OperationLedger, "interestRemainingCents" | "principalRemainingCents" | "nextDueDate">, amountCents: number) {
  if (isAmortized(terms) || ledger.principalRemainingCents <= 0 || ledger.interestRemainingCents <= 0 || amountCents !== ledger.interestRemainingCents) return null;
  const anchorDay = Number(terms.firstDueDate.slice(8, 10));
  return {
    previousDueDate: ledger.nextDueDate,
    defaultNewDueDate: nextDueDate(terms.frequency, ledger.nextDueDate, anchorDay),
    principalBaseCents: ledger.principalRemainingCents,
    nextInterestCents: renewalInterest({ principalRemainingCents: ledger.principalRemainingCents, interestRateBps: terms.interestRateBps }),
  };
}
