// Regras financeiras do CrediAI. Todo cálculo de operação e de pagamento passa por este arquivo.

export const CALCULATION_RULE = "RATE_PER_OPERATION_SINGLE_PAYMENT_V1";

export const calculationRuleLabels: Record<string, string> = {
  [CALCULATION_RULE]: "Taxa sobre o principal, pagamento único no vencimento",
  FIXED_MONTHLY_INSTALLMENTS_V1: "Parcelado: parcelas mensais fixas, juros simples",
  FIXED_BIWEEKLY_INSTALLMENTS_V1: "Parcelado: parcelas quinzenais fixas, juros simples",
};

export function calculateOperation({ principalCents, interestRateBps }: { principalCents: number; interestRateBps: number }) {
  const interestCents = simpleInterest({ principalCents, rateBps: interestRateBps });
  return { interestCents, totalCents: principalCents + interestCents, calculationRule: CALCULATION_RULE };
}

export type PaymentKind = "INTEREST" | "PARTIAL" | "SETTLEMENT" | "RENEWAL" | "INSTALLMENT";
export const paymentKindLabels: Record<PaymentKind, string> = {
  INTEREST: "Pagamento de juros", PARTIAL: "Amortização do principal", SETTLEMENT: "Quitação", RENEWAL: "Juros / Renovação", INSTALLMENT: "Parcela",
};
// Rótulo do histórico: o tipo do pagamento e, quando ele cobriu juros e principal ao mesmo tempo, as duas partes.
export function paymentLabel(item: { kind: PaymentKind; interestCents: number; principalCents: number; mode?: PaymentMode | null }) {
  if (item.mode === "EARLY_SETTLEMENT") return "Liquidação antecipada";
  if (item.mode === "INTEREST_ONLY_RENEWAL" && item.kind !== "SETTLEMENT") return "Juros / Renovação";
  if (item.kind === "PARTIAL" && item.interestCents > 0) return "Juros + amortização do principal";
  return paymentKindLabels[item.kind];
}

// ══ Modalidade do pagamento (escolhida na tela, validada e gravada pelo servidor) ═══════════════════════════════════
//  • INTEREST_ONLY_RENEWAL: só os juros pendentes, com renovação. Tudo é juros, o principal não muda e abre o próximo
//    período. Vale em qualquer contrato recorrente (juros primeiro ou principal primeiro): a escolha prevalece.
//  • MANUAL: valor livre, dividido pela ordem de apropriação do contrato (gravada junto, para não mudar depois).
//  • PRINCIPAL_AMORTIZATION: abate só o principal (até o principal em aberto). Os juros pendentes continuam pendentes.
//  • FULL_SETTLEMENT: exatamente o saldo total (principal em aberto + juros pendentes). Quita.
//  • EARLY_SETTLEMENT: liquidação antecipada pelo valor negociado (ação própria, settledLedger).
export const PAYMENT_MODES = ["INTEREST_ONLY_RENEWAL", "MANUAL", "PRINCIPAL_AMORTIZATION", "FULL_SETTLEMENT", "EARLY_SETTLEMENT"] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];
export type AllocationOrder = "INTEREST_FIRST" | "PRINCIPAL_FIRST";
export const paymentModeLabels: Record<PaymentMode, string> = {
  INTEREST_ONLY_RENEWAL: "Só os juros e renovar", MANUAL: "Pagamento manual", PRINCIPAL_AMORTIZATION: "Amortizar principal",
  FULL_SETTLEMENT: "Saldo total", EARLY_SETTLEMENT: "Liquidação antecipada",
};
export const isPaymentMode = (value: unknown): value is PaymentMode => typeof value === "string" && (PAYMENT_MODES as readonly string[]).includes(value);
export const isAllocationOrder = (value: unknown): value is AllocationOrder => value === "INTEREST_FIRST" || value === "PRINCIPAL_FIRST";

// ══ Regra matemática oficial: JUROS SIMPLES ═══════════════════════════════════════════════════════════════════════
// Todas as operações do CrediAI usam juros simples:  J = P × i × n  e  M = P + J
//   P = principal, i = taxa simples do período, n = quantidade de períodos, J = juros, M = montante.
// Os juros incidem só sobre o principal, nunca sobre juros (não há capitalização composta). Ex.: R$ 8.000 a 30% ao mês
// por 2 períodos sem amortização = 8.000 × 0,30 × 2 = R$ 4.800. Não existe tabela Price em nenhum cálculo do sistema.
export function simpleInterest({ principalCents, rateBps, periods = 1 }: { principalCents: number; rateBps: number; periods?: number }) {
  return Math.round((principalCents * rateBps * periods) / 10_000);
}

// ── Modalidade parcelada ──────────────────────────────────────────────────────────────────────────────────────────
// O usuário informa o valor emprestado (principal), o valor de cada parcela, o primeiro vencimento, a quantidade de
// parcelas e a periodicidade (mensal ou quinzenal). Total = parcela × parcelas; juros = total − principal.
// Taxa contratada = juros simples por período = juros ÷ principal ÷ parcelas. Ex. mensal: 6.000 ÷ 10.000 ÷ 10 = 6% ao
// mês, e de volta J = 10.000 × 0,06 × 10 = 6.000, M = 16.000 = 10 × 1.600. Ex. quinzenal: R$ 600 em 3 × R$ 300 →
// juros 300, 300 ÷ 600 ÷ 3 = 16,67% por quinzena. Cada parcela leva juros e principal na mesma proporção.
export const INSTALLMENT_RULE = "FIXED_MONTHLY_INSTALLMENTS_V1";
export const BIWEEKLY_INSTALLMENT_RULE = "FIXED_BIWEEKLY_INSTALLMENTS_V1";
export type InstallmentFrequency = "MONTHLY" | "BIWEEKLY";

export function calculateInstallments({ principalCents, installmentCents, count, frequency = "MONTHLY" }: { principalCents: number; installmentCents: number; count: number; frequency?: InstallmentFrequency }) {
  const totalCents = installmentCents * count;
  const interestCents = totalCents - principalCents;
  // Taxa simples por período (ao mês no mensal, por quinzena no quinzenal). "monthlyRate" mantém o nome antigo.
  const monthlyRate = simpleMonthlyRate({ principalCents, interestCents: Math.max(interestCents, 0), months: count });
  return {
    interestCents, totalCents, calculationRule: frequency === "BIWEEKLY" ? BIWEEKLY_INSTALLMENT_RULE : INSTALLMENT_RULE,
    // Taxa simples do período em pontos-base (1% = 100), arredondada; a exata fica em monthlyRate (no quinzenal, é a
    // taxa por quinzena; a mensal equivalente, só para exibição, é monthlyEquivalentRate(taxa, 15)).
    interestRateBps: Math.round(monthlyRate * 10_000), monthlyRate,
  };
}

// Vencimento da parcela k (1 = primeiro vencimento), pela função única de vencimentos (dueDates): mês a mês no mensal e
// pelos pares fixos de dias do quinzenal (dia X e X + 15, a mesma regra do pagamento único quinzenal).
export function installmentDueDate(firstDueDate: string, number: number, frequency: InstallmentFrequency = "MONTHLY") {
  return dueDates(frequency, firstDueDate, number)[number - 1];
}

export type InstallmentState = "PAID" | "PARTIAL" | "OPEN" | "CLOSED" | "DEFERRED";
// RENOVAÇÃO — REGRA OFICIAL (modalidade pagamento único). Exemplo: R$ 1.000 a 30% ao mês, juros R$ 300, quitação R$ 1.300.
//  • Pagar R$ 1.300 quita: R$ 300 são juros (lucro) e R$ 1.000 voltam como principal.
//  • Pagar só os R$ 300 de juros NÃO é pagamento de principal: é "Juros / Renovação". Juros recebidos +300, principal em
//    aberto continua R$ 1.000, o vencimento avança um período e o valor para quitação continua R$ 1.300.
//  • Cada novo período gera de novo 30% sobre o PRINCIPAL EM ABERTO (R$ 1.000 → R$ 300). Nunca 30% de R$ 1.300 (= R$ 390)
//    nem de R$ 1.600 (= R$ 480): os juros já pagos são lucro recebido e não entram na base de cálculo.
export function renewalInterest({ principalRemainingCents, interestRateBps }: { principalRemainingCents: number; interestRateBps: number }) {
  return calculateOperation({ principalCents: principalRemainingCents, interestRateBps }).interestCents;
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
export const BIWEEKLY_FIXED_RULE = "FIXED_INTEREST_PER_FORTNIGHT_V1";
calculationRuleLabels[DAILY_RULE] = "Diário: total (principal + juros) dividido em pagamentos diários";
calculationRuleLabels[BIWEEKLY_RULE] = "Quinzenal: juros a cada quinzena sobre o principal em aberto";
calculationRuleLabels[BIWEEKLY_FIXED_RULE] = "Quinzenal: valor fixo de juros por quinzena";

// Como os juros do período foram combinados: pela taxa (padrão) ou por um valor fixo em reais (quinzenal).
export type InterestMode = "RATE" | "FIXED";
export const interestModeOf = (calculationRule: string): InterestMode => (calculationRule === BIWEEKLY_FIXED_RULE ? "FIXED" : "RATE");

// Valor fixo de juros por período (ex.: R$ 1.200 por quinzena sobre R$ 8.000). A taxa equivalente, juros / principal,
// é gravada só para exibição (1.200 / 8.000 = 15%); o usuário não precisa calculá-la.
export function calculateFixedInterest({ principalCents, interestCents }: { principalCents: number; interestCents: number }) {
  return { interestCents, totalCents: principalCents + interestCents, interestRateBps: Math.round((interestCents * 10_000) / principalCents), calculationRule: BIWEEKLY_FIXED_RULE };
}

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
// total − pagamento × (N − 1), então a soma é exatamente o total. Vencimentos: um por dia corrido (sábado e domingo
// incluídos), do primeiro vencimento informado (padrão: dia seguinte ao empréstimo) até o N-ésimo dia.
// Ex.: R$ 10.000 a 30% em 30 dias → juros R$ 3.000, total R$ 13.000, 29 × R$ 433,33 + 1 × R$ 433,43.
export function calculateDaily({ principalCents, interestRateBps, days, loanDate, firstDueDate = plusDays(loanDate, 1) }: { principalCents: number; interestRateBps: number; days: number; loanDate: string; firstDueDate?: string }) {
  const { interestCents, totalCents } = calculateOperation({ principalCents, interestRateBps });
  const installmentCents = Math.floor(totalCents / days);
  const lastInstallmentCents = totalCents - installmentCents * (days - 1);
  return {
    interestCents, totalCents, calculationRule: DAILY_RULE, installmentCount: days, installmentCents, lastInstallmentCents,
    firstDueDate, lastDueDate: plusDays(firstDueDate, days - 1),
    // Taxa ao dia e ao mês equivalentes (juros simples, mês comercial de 30 dias).
    dailyRateBps: interestRateBps / days, monthlyEquivalentBps: monthlyEquivalentRate(interestRateBps, days),
  };
}

// ── Parcelado: taxa simples ──
// Taxa simples mensal = juros totais / principal / número de meses. Ex.: R$ 6.000 / R$ 10.000 / 10 = 6% ao mês.
export function simpleMonthlyRate({ principalCents, interestCents, months }: { principalCents: number; interestCents: number; months: number }) {
  if (principalCents <= 0 || months <= 0) return 0;
  return interestCents / principalCents / months;
}

// ══ Extrato da operação (ledger) ═════════════════════════════════════════════════════════════════════════════════
// Uma função só calcula, a partir dos dados gravados e dos pagamentos, tudo o que a tela, os cards e o servidor usam:
// quanto de cada pagamento foi juros e principal, o período atual, o próximo vencimento, o saldo e a situação.
export type LedgerRenewal = { paymentId: string; periodNumber: number; previousDueDate: string; newDueDate: string; principalBaseCents: number; interestCents: number };
// Parcela renegociada para o final (installment_deferral): a original fica no histórico e nasce uma obrigação no fim do cronograma.
export type LedgerDeferral = { originalNumber: number; additionCents: number; newDueDate: string; newAmountCents: number };
export type LedgerTerms = {
  modality: "SINGLE" | "INSTALLMENT"; frequency: Frequency;
  principalCents: number; interestRateBps: number;
  // Juros recorrentes: pela taxa ou valor fixo por período (padrão: taxa).
  interestMode?: InterestMode;
  // Recorrente: juros do primeiro período. Amortizado (parcelado ou diário): juros totais do contrato.
  interestCents: number;
  // Recorrente: primeiro vencimento combinado. Amortizado: primeira parcela, quantidade e valor (o último pode ter ajuste).
  firstDueDate: string;
  installmentCount: number | null; installmentCents: number | null;
  renewals: LedgerRenewal[];
  // Liquidação antecipada: o pagamento final negociado. Ele quita o principal em aberto primeiro; o que sobrar é juros e os
  // juros/parcelas que faltavam são perdoados (não são lucro nem dívida). Os demais pagamentos seguem a regra normal.
  settlementPaymentId?: string | null;
  // Juros recorrentes: INTEREST_FIRST (padrão, contratos antigos) cobre os juros do período e depois o principal; PRINCIPAL_FIRST
  // (contratos novos) abate o principal primeiro e só o que sobra conta como juros recebidos (lucro).
  paymentOrder?: "INTEREST_FIRST" | "PRINCIPAL_FIRST";
  // Parcelado: parcelas jogadas para o final. interestCents continua sendo o do contrato original; o acréscimo entra só no extrato.
  deferrals?: LedgerDeferral[];
  // Parcelado: vencimentos combinados (um por parcela) quando diferem da regra mensal/quinzenal; sem eles, pela regra.
  customDueDates?: string[] | null;
};
// mode/allocationOrder: gravados no pagamento (migration 0054). Ausentes (null) = pagamento antigo, pela regra de antes.
// period (migration 0055): no "Receber juros e renovar", o número do período cujos juros este recebimento paga. null = sem
// período escolhido (pagamentos antigos e as demais modalidades), que seguem do período mais antigo para o atual.
export type LedgerPayment = { id: string; amountCents: number; paidAt: string; createdAt?: string; mode?: PaymentMode | null; allocationOrder?: AllocationOrder | null; period?: number | null };
// interestPaidCents: quanto dos juros deste período já foi pago (cada período é acompanhado separadamente).
export type LedgerPeriod = { number: number; dueDate: string; interestCents: number; principalBaseCents: number; openedOn: string | null; openedBy: "CONTRACT" | "PAYMENT" | "DUE_DATE"; paymentId: string | null; interestPaidCents?: number;
  // Período aberto no vencimento com juros anteriores ainda sem pagar (juros contínuos): não conta como renovação.
  withArrears?: boolean };
// Juros pendentes de um período (composição mostrada na prévia, do mais antigo para o atual).
export type PendingPeriod = { number: number; dueDate: string; interestCents: number; paidCents: number; remainingCents: number };
// Situação de cada período de juros (lista "Períodos de juros" da operação):
//  • PAID_RENEWED: juros do período pagos e o período seguinte já aberto (renovado);
//  • PAID: juros pagos, período atual (renova no vencimento);
//  • OVERDUE: venceu e os juros (ou parte deles) não foram pagos;
//  • DUE_TODAY: vence hoje, juros em aberto;
//  • UPCOMING: ainda não venceu, juros em aberto.
export type PeriodStatus = "PAID_RENEWED" | "PAID" | "OVERDUE" | "DUE_TODAY" | "UPCOMING";
export const periodStatusLabels: Record<PeriodStatus, string> = {
  PAID_RENEWED: "Pago e renovado", PAID: "Pago", OVERDUE: "Vencido", DUE_TODAY: "Vence hoje", UPCOMING: "A vencer",
};
// paymentIds: pagamentos que pagaram juros deste período (rastreabilidade).
// locked: há juros de um período anterior ainda sem pagar; este fica bloqueado para "Receber juros e renovar" até lá.
export type PeriodView = PendingPeriod & { status: PeriodStatus; openedBy: LedgerPeriod["openedBy"]; paymentIds: string[]; locked: boolean };
// number = número ATUAL entre as obrigações ativas (a parcela renegociada mantém o número original, que é o histórico);
// originalNumber = número no contrato original; deferredTo = número atual da obrigação para onde a parcela foi; deferredFrom =
// número original da parcela que originou esta obrigação do final; additionCents = acréscimo dessa obrigação.
export type ScheduleItem = { number: number; originalNumber: number; dueDate: string; amountCents: number; paidCents: number; remainingCents: number; state: InstallmentState; deferredTo: number | null; deferredFrom: number | null; additionCents: number };
export type LedgerItem<T> = T & { interestCents: number; principalCents: number; kind: PaymentKind; balanceBeforeCents: number; renewedPeriod: LedgerPeriod | null };
export type LedgerState = "ACTIVE" | "DUE_TODAY" | "OVERDUE" | "PAID";

const isAmortized = (terms: LedgerTerms) => terms.modality === "INSTALLMENT" || terms.frequency === "DAILY";

// Sequência dos períodos de juros (regra da Thaís, 14/11/2026), em todos os contratos com renovação de juros: o período
// seguinte só nasce quando os juros dos períodos anteriores estão integralmente pagos (na hora, por "Receber juros e
// renovar", ou no vencimento, se já estavam pagos). Enquanto houver juros vencidos sem pagar, nenhum período novo é gerado
// nem liberado para renovação: o saldo é o principal em aberto + os juros já gerados e exigíveis, sem juros futuros.
// A regra anterior ("juros contínuos", 04/11 a 14/11) abria períodos no vencimento mesmo com juros atrasados; um período
// assim só continua existindo se um recebimento já gravado o pagou (histórico preservado). A amortização não muda.

// Juros de um novo período sobre o principal em aberto, sem juros sobre juros:
//  • taxa: principal em aberto × taxa do período;
//  • valor fixo: o valor fixo, proporcional ao principal que ainda está em aberto (principal cheio → o valor combinado;
//    metade do principal pago → metade do valor). Mesma ideia da taxa, sem arredondar a taxa.
export function periodInterest(terms: Pick<LedgerTerms, "interestMode" | "principalCents" | "interestCents" | "interestRateBps">, principalOpenCents: number) {
  if (terms.interestMode === "FIXED") return Math.round((principalOpenCents * terms.interestCents) / terms.principalCents);
  return renewalInterest({ principalRemainingCents: principalOpenCents, interestRateBps: terms.interestRateBps });
}

// Parcelas do contrato amortizado: todas iguais; no diário a última leva o ajuste para fechar o total.
export function amortizedSchedule(terms: Pick<LedgerTerms, "frequency" | "firstDueDate" | "installmentCount" | "installmentCents" | "principalCents" | "interestCents" | "modality" | "deferrals" | "customDueDates">, paidCents: number): ScheduleItem[] {
  const count = terms.installmentCount ?? 0, base = terms.installmentCents ?? 0;
  const totalCents = terms.principalCents + terms.interestCents;
  // Parcelado: mensal ou quinzenal (operações antigas são todas mensais); diário: um vencimento por dia.
  const frequency: Frequency = terms.modality === "INSTALLMENT" ? (terms.frequency === "BIWEEKLY" ? "BIWEEKLY" : "MONTHLY") : terms.frequency;
  const custom = terms.modality === "INSTALLMENT" && terms.customDueDates?.length === count ? terms.customDueDates : null;
  const dates = custom ?? dueDates(frequency, terms.firstDueDate, count);
  const original = dates.map((dueDate, index) => ({ originalNumber: index + 1, dueDate, amountCents: index === count - 1 ? totalCents - base * (count - 1) : base }));
  // Parcelas renegociadas para o final, na ordem em que foram feitas (cada nova data vem depois da anterior).
  const deferrals = [...(terms.deferrals ?? [])].filter((item) => original.some((entry) => entry.originalNumber === item.originalNumber))
    .sort((a, b) => a.newDueDate.localeCompare(b.newDueDate) || a.originalNumber - b.originalNumber);
  const deferred = new Set(deferrals.map((item) => item.originalNumber));
  // Obrigações ativas, em ordem: as parcelas que continuam e, no fim, as obrigações criadas pela renegociação.
  const active = [
    ...original.filter((entry) => !deferred.has(entry.originalNumber)).map((entry) => ({ ...entry, deferredFrom: null as number | null, additionCents: 0 })),
    ...deferrals.map((item) => ({ originalNumber: item.originalNumber, dueDate: item.newDueDate, amountCents: item.newAmountCents, deferredFrom: item.originalNumber as number | null, additionCents: item.additionCents })),
  ];
  let covered = 0;
  const current = active.map((entry, index): ScheduleItem => {
    const paid = Math.min(Math.max(paidCents - covered, 0), entry.amountCents);
    covered += entry.amountCents;
    const state: InstallmentState = paid === entry.amountCents ? "PAID" : paid > 0 ? "PARTIAL" : "OPEN";
    return { number: index + 1, originalNumber: entry.originalNumber, dueDate: entry.dueDate, amountCents: entry.amountCents, paidCents: paid, remainingCents: entry.amountCents - paid, state, deferredTo: null, deferredFrom: entry.deferredFrom, additionCents: entry.additionCents };
  });
  if (deferrals.length === 0) return current;
  // Tabela completa: cada parcela original na sua posição (a renegociada fica como histórico, sem valor a cobrar) e, depois,
  // as obrigações criadas no final.
  const keepers = current.filter((item) => item.deferredFrom === null);
  const targets = current.filter((item) => item.deferredFrom !== null);
  return [
    ...original.map((entry): ScheduleItem => {
      const moved = targets.find((item) => item.deferredFrom === entry.originalNumber);
      if (moved) return { number: entry.originalNumber, originalNumber: entry.originalNumber, dueDate: entry.dueDate, amountCents: entry.amountCents, paidCents: 0, remainingCents: 0, state: "DEFERRED", deferredTo: moved.number, deferredFrom: null, additionCents: moved.additionCents };
      return keepers.find((item) => item.originalNumber === entry.originalNumber) as ScheduleItem;
    }),
    ...targets,
  ];
}

// Data da obrigação que uma parcela renegociada passa a ter: o período seguinte ao último vencimento ativo do cronograma,
// pela periodicidade do contrato e mantendo o dia combinado.
export function deferralDueDate(terms: Pick<LedgerTerms, "frequency" | "firstDueDate" | "modality">, schedule: ScheduleItem[]) {
  const frequency: Frequency = terms.frequency === "BIWEEKLY" ? "BIWEEKLY" : "MONTHLY";
  const last = schedule.filter((item) => item.state !== "DEFERRED").reduce((date, item) => (item.dueDate > date ? item.dueDate : date), "");
  return nextDueDate(frequency, last, Number(terms.firstDueDate.slice(8, 10)));
}

// Elegível para "Jogar para o final": parcela em aberto (vencida ou a vencer), sem nenhum pagamento, que ainda não foi
// renegociada nem é uma obrigação criada por renegociação. Só empréstimo parcelado em aberto, sem liquidação antecipada.
export function deferralEligibility(operation: { status: string; modality: "SINGLE" | "INSTALLMENT"; settlementPaymentId?: string | null }, item: ScheduleItem | undefined) {
  if (operation.modality !== "INSTALLMENT" || operation.status !== "OPEN" || operation.settlementPaymentId) return { ok: false as const, error: "Só empréstimos parcelados em aberto têm parcelas para renegociar." };
  if (!item) return { ok: false as const, error: "Parcela não encontrada neste contrato." };
  if (item.state === "DEFERRED") return { ok: false as const, error: "Esta parcela já foi renegociada para o final." };
  if (item.deferredFrom !== null) return { ok: false as const, error: "Esta é a obrigação criada por uma renegociação; ela não pode ser jogada para o final de novo." };
  if (item.state !== "OPEN") return { ok: false as const, error: item.state === "PAID" ? "Esta parcela já foi paga." : "Esta parcela já tem pagamento parcial e não pode ser renegociada." };
  return { ok: true as const };
}

const byDate = <T extends LedgerPayment>(a: T, b: T) => a.paidAt.localeCompare(b.paidAt) || (a.createdAt ?? "").localeCompare(b.createdAt ?? "");

// asOf = hoje (fuso de Brasília). Os pagamentos podem vir em qualquer ordem; são aplicados por data e registro.
export function operationLedger<T extends LedgerPayment>(terms: LedgerTerms, payments: T[], asOf: string) {
  const ordered = [...payments].sort(byDate);
  const base = (list: T[], date: string) => (isAmortized(terms) ? amortizedLedger(terms, list, date) : recurringLedger(terms, list, date));
  const settlement = terms.settlementPaymentId ? ordered.find((payment) => payment.id === terms.settlementPaymentId) : undefined;
  if (!settlement) return base(ordered, asOf);
  return settledLedger(base, settlement, ordered.filter((payment) => payment !== settlement));
}

// Liquidação antecipada: o extrato dos pagamentos anteriores é calculado pela regra normal até a data da liquidação. O
// pagamento negociado vai primeiro para o principal em aberto e o resto é juros; o que o contrato ainda cobraria além disso
// é perdoado (forgivenCents). Saldo, juros e parcelas em aberto zeram; nada dos pagamentos anteriores é reescrito.
function settledLedger<T extends LedgerPayment>(base: (list: T[], date: string) => ReturnType<typeof amortizedLedger<T>> | ReturnType<typeof recurringLedger<T>>, settlement: T, others: T[]) {
  const prior = base(others, settlement.paidAt);
  const principalPart = Math.min(settlement.amountCents, prior.principalRemainingCents);
  const interestPart = settlement.amountCents - principalPart;
  const item: LedgerItem<T> = { ...settlement, interestCents: interestPart, principalCents: principalPart, kind: "SETTLEMENT", balanceBeforeCents: prior.balanceCents, renewedPeriod: null };
  const interestPaidCents = prior.interestPaidCents + interestPart, principalPaidCents = prior.principalPaidCents + principalPart;
  return {
    ...prior,
    items: [...prior.items, item],
    paidCents: prior.paidCents + settlement.amountCents, interestPaidCents, principalPaidCents,
    interestRemainingCents: 0, principalRemainingCents: Math.max(prior.principalRemainingCents - principalPart, 0), balanceCents: 0,
    amountDueCents: 0, nextItem: null, pendingPeriods: [] as PendingPeriod[], periodViews: prior.periodViews,
    // Parcelas que faltavam ficam encerradas na liquidação: sem valor em aberto e sem data de cobrança.
    schedule: prior.schedule.map((entry) => (entry.state === "PAID" || entry.state === "DEFERRED" ? entry : { ...entry, state: "CLOSED" as const, remainingCents: 0 })),
    forgivenCents: Math.max(prior.balanceCents - settlement.amountCents, 0),
    state: "PAID" as LedgerState, daysUntilDue: 0,
  };
}
export type OperationLedger<T extends LedgerPayment = LedgerPayment> = ReturnType<typeof operationLedger<T>>;

function stateFor(balanceCents: number, nextDue: string | null, asOf: string): { state: LedgerState; daysUntilDue: number } {
  if (balanceCents <= 0 || !nextDue) return { state: "PAID", daysUntilDue: 0 };
  const daysUntilDue = calendarDaysBetween(asOf, nextDue);
  return { state: daysUntilDue < 0 ? "OVERDUE" : daysUntilDue === 0 ? "DUE_TODAY" : "ACTIVE", daysUntilDue };
}

// Parcelado (regra de 05/11/2026): o recebimento amortiza primeiro o principal em aberto; só depois de todo o principal
// quitado o que entra conta como juros recebidos (lucro). Vale para os pagamentos gravados com a ordem PRINCIPAL_FIRST
// (todo pagamento novo do parcelado) e, nos pagamentos anteriores à 0054 (sem ordem gravada), quando o contrato é de
// principal primeiro. Os pagamentos antigos gravados como juros primeiro (ou sem ordem num contrato antigo) continuam
// pela proporção abaixo até serem corrigidos com autorização: nada já registrado muda de divisão sozinho.
const principalFirstInstallment = (terms: LedgerTerms, payment: LedgerPayment) =>
  terms.modality === "INSTALLMENT" && (payment.allocationOrder ?? terms.paymentOrder) === "PRINCIPAL_FIRST";
// Ordem gravada nos pagamentos novos: parcelado sempre principal primeiro; as demais modalidades, a ordem do contrato.
export const allocationOrderFor = (terms: Pick<LedgerTerms, "modality" | "paymentOrder">): AllocationOrder =>
  terms.modality === "INSTALLMENT" ? "PRINCIPAL_FIRST" : terms.paymentOrder ?? "INTEREST_FIRST";

// Diário (e pagamentos antigos do parcelado, acima): os juros pagos acompanham a proporção do contrato sobre o TOTAL pago até cada pagamento
// (juros acumulados = arredondamento de total pago × juros / total do contrato), e cada pagamento leva a diferença.
// Assim o arredondamento nunca se acumula de um pagamento para o outro (no máximo meio centavo de diferença em
// relação à proporção exata, em qualquer momento), e o pagamento que zera o saldo leva o resto exato dos juros.
// As parcelas são cobertas em ordem pelo total pago; a situação vem da primeira parcela não paga.
export function amortizedInterestPaid(paidCents: number, terms: Pick<LedgerTerms, "principalCents" | "interestCents">) {
  const totalCents = terms.principalCents + terms.interestCents;
  if (paidCents >= totalCents) return terms.interestCents;
  return Math.min(terms.interestCents, Math.round((paidCents * terms.interestCents) / Math.max(totalCents, 1)));
}

function amortizedLedger<T extends LedgerPayment>(contract: LedgerTerms, ordered: T[], asOf: string) {
  // O acréscimo das parcelas renegociadas é juros do contrato (só vira recebido quando pago, pela mesma proporção).
  const additionsCents = (contract.deferrals ?? []).reduce((total, item) => total + item.additionCents, 0);
  const terms: LedgerTerms = additionsCents > 0 ? { ...contract, interestCents: contract.interestCents + additionsCents } : contract;
  const totalCents = terms.principalCents + terms.interestCents;
  // Juros acumulados após pagar `paid`: a proporção do contrato ORIGINAL até o total original e, daí em diante, só o acréscimo
  // das parcelas renegociadas (que fica no fim). Assim os pagamentos já feitos nunca mudam de divisão quando há renegociação.
  const originalTotalCents = contract.principalCents + contract.interestCents;
  const interestAt = (paid: number) => paid >= totalCents ? terms.interestCents
    : Math.min(terms.interestCents, paid <= originalTotalCents ? amortizedInterestPaid(paid, contract) : contract.interestCents + (paid - originalTotalCents));
  let interestPaidCents = 0, principalPaidCents = 0;
  const items: LedgerItem<T>[] = ordered.map((payment) => {
    const balanceBeforeCents = Math.max(totalCents - interestPaidCents - principalPaidCents, 0);
    const interestLeft = Math.max(terms.interestCents - interestPaidCents, 0);
    const principalLeft = Math.max(terms.principalCents - principalPaidCents, 0);
    const finishes = payment.amountCents >= balanceBeforeCents;
    const paidAfter = interestPaidCents + principalPaidCents + payment.amountCents;
    // Nunca amortiza mais principal do que o que está em aberto: o que passar dele é juros (no máximo os juros que faltam).
    const atLeastInterest = Math.max(payment.amountCents - principalLeft, 0);
    const interestPart = finishes ? interestLeft
      : principalFirstInstallment(contract, payment) ? Math.min(interestLeft, atLeastInterest)
      : Math.min(interestLeft, payment.amountCents, Math.max(interestAt(paidAfter) - interestPaidCents, atLeastInterest));
    const principalPart = payment.amountCents - interestPart;
    interestPaidCents += interestPart;
    principalPaidCents += principalPart;
    return { ...payment, interestCents: interestPart, principalCents: principalPart, kind: finishes ? "SETTLEMENT" : "INSTALLMENT", balanceBeforeCents, renewedPeriod: null };
  });
  const paidCents = interestPaidCents + principalPaidCents;
  const schedule = amortizedSchedule(contract, paidCents);
  const nextItem = schedule.find((item) => item.state !== "PAID" && item.state !== "DEFERRED") ?? null;
  const balanceCents = Math.max(totalCents - paidCents, 0);
  const nextDue = nextItem?.dueDate ?? schedule.at(-1)?.dueDate ?? terms.firstDueDate;
  return {
    items, paidCents, interestPaidCents, principalPaidCents,
    interestCents: terms.interestCents, totalCents,
    interestRemainingCents: Math.max(terms.interestCents - interestPaidCents, 0),
    principalRemainingCents: Math.max(terms.principalCents - principalPaidCents, 0),
    balanceCents, schedule, nextItem, nextDueDate: nextDue,
    periods: [] as LedgerPeriod[], periodNumber: 1, periodInterestCents: terms.interestCents, periodDueDate: nextDue, renewalCount: 0, forgivenCents: 0,
    pendingPeriods: [] as PendingPeriod[], periodViews: [] as PeriodView[],
    // Próximo valor a cobrar: o que falta da próxima parcela.
    amountDueCents: nextItem?.remainingCents ?? 0,
    ...stateFor(balanceCents, nextItem?.dueDate ?? null, asOf),
  };
}

// Mensal e quinzenal (juros recorrentes). Regras:
//  1. Período k vence em dueDate_k e cobra juros_k = taxa do período × principal em aberto no início do período (juros
//     simples: nunca sobre juros pendentes, nunca capitalizados). Cada período guarda quanto dos seus juros foi pago.
//  2. Divisão de cada pagamento, pela modalidade gravada nele:
//     • "Só os juros e renovar" (ou pagamento antigo com linha em loan_renewal): juros pendentes, do período mais antigo
//       para o atual; o principal não muda.
//     • Amortizar principal: só principal.
//     • Manual / saldo total / antigos sem modalidade: a ordem de apropriação gravada no pagamento (ou a do contrato,
//       nos antigos). Juros primeiro: juros pendentes e depois principal. Principal primeiro: principal e depois juros.
//  3. Renovação: com os juros pendentes quitados e principal em aberto, abre-se o período seguinte — na hora, quando o
//     pagamento foi "Só os juros e renovar" (linha em loan_renewal, com o vencimento escolhido), ou no vencimento.
//  4. Juros contínuos (contratos de principal primeiro, os criados desde 26/10): enquanto houver principal em aberto, cada
//     vencimento ultrapassado abre o período seguinte mesmo com juros anteriores sem pagar (ficam pendentes, um a um).
//     Contratos antigos (juros primeiro): um período vencido sem os juros pagos fica Em atraso e só renova quando os
//     juros dele forem pagos (regra de sempre, preservada para não mudar o histórico deles).
//  5. Quitação: principal em aberto e juros pendentes zerados.
// Não há multa, juros de mora nem juros sobre juros.
function recurringLedger<T extends LedgerPayment>(terms: LedgerTerms, ordered: T[], asOf: string) {
  const anchorDay = Number(terms.firstDueDate.slice(8, 10));
  const rows = new Map(terms.renewals.map((row) => [row.paymentId, row]));
  const periods: LedgerPeriod[] = [{ number: 1, dueDate: terms.firstDueDate, interestCents: terms.interestCents, principalBaseCents: terms.principalCents, openedOn: null, openedBy: "CONTRACT", paymentId: null, interestPaidCents: 0 }];
  let principalOpen = terms.principalCents, interestPaidCents = 0, principalPaidCents = 0;
  // Pagamento só de juros que completou os juros pendentes (vira "Juros / Renovação" se o período renovar).
  let completedBy: LedgerItem<T> | null = null;
  const current = () => periods[periods.length - 1];
  const left = (period: LedgerPeriod) => Math.max(period.interestCents - (period.interestPaidCents ?? 0), 0);
  const pending = () => periods.reduce((total, period) => total + left(period), 0);
  // Pagamentos que pagaram juros de cada período (rastreabilidade na lista de períodos).
  const paidBy = new Map<number, string[]>();
  const credit = (period: LedgerPeriod, part: number, paymentId: string) => {
    if (part <= 0) return;
    period.interestPaidCents = (period.interestPaidCents ?? 0) + part;
    paidBy.set(period.number, [...(paidBy.get(period.number) ?? []), paymentId]);
  };
  // Aberto no vencimento com juros anteriores sem pagar = em atraso (não é renovação). Aberto por pagamento = renovação.
  const open = (period: Omit<LedgerPeriod, "number" | "interestPaidCents">) => {
    periods.push({ number: periods.length + 1, ...period, interestPaidCents: 0, ...(period.openedBy === "DUE_DATE" && pending() > 0 ? { withArrears: true } : {}) });
    if (completedBy) { completedBy.kind = "RENEWAL"; completedBy.renewedPeriod = current(); }
    completedBy = null;
  };
  // Juros pendentes, do período mais antigo para o atual.
  const payInterest = (amount: number, paymentId: string) => {
    let rest = amount;
    for (const period of periods) {
      const part = Math.min(rest, left(period));
      credit(period, part, paymentId);
      rest -= part;
    }
    return amount - rest;
  };
  // Próximo período pelo calendário do contrato, com juros sobre o principal em aberto (sem juros sobre juros).
  const openNext = () => {
    const due = current().dueDate;
    open({ dueDate: nextDueDate(terms.frequency, due, anchorDay), interestCents: periodInterest(terms, principalOpen), principalBaseCents: principalOpen, openedOn: due, openedBy: "DUE_DATE", paymentId: null });
  };
  // Renovação no vencimento: só quando os juros de todos os períodos já gerados estão pagos e a data chegou. Com juros
  // vencidos sem pagar, o período seguinte não nasce (fica bloqueado até a quitação desses juros).
  const renewOnDue = (date: string) => {
    // Período sem juros (taxa 0%) não renova: vencido com principal em aberto, fica Em atraso.
    while (principalOpen > 0 && current().interestCents > 0 && left(current()) === 0 && pending() === 0 && date >= current().dueDate) openNext();
  };
  const items: LedgerItem<T>[] = ordered.map((payment) => {
    renewOnDue(payment.paidAt);
    // Histórico: recebimento já gravado pela regra anterior (juros contínuos, 04/11 a 14/11/2026) para um período aberto
    // com juros anteriores ainda pendentes. Esse período continua existindo para o pagamento registrado não mudar de divisão.
    if (payment.period != null && payment.mode === "INTEREST_ONLY_RENEWAL") {
      while (principalOpen > 0 && current().interestCents > 0 && current().number < payment.period && payment.paidAt > current().dueDate) openNext();
    }
    const balanceBeforeCents = principalOpen + pending();
    const row = rows.get(payment.id);
    const mode = payment.mode ?? null;
    const order: AllocationOrder = payment.allocationOrder ?? terms.paymentOrder ?? "INTEREST_FIRST";
    // A modalidade escolhida prevalece sobre a ordem do contrato: só juros nunca abate principal; amortização só principal.
    const interestOnly = mode === "INTEREST_ONLY_RENEWAL" || (mode === null && row !== undefined);
    const principalFirst = !interestOnly && (mode === "PRINCIPAL_AMORTIZATION" || order === "PRINCIPAL_FIRST");
    // "Receber juros e renovar" de um período escolhido: paga só os juros daquele período; os demais não mudam.
    const target = interestOnly && payment.period != null ? periods.find((item) => item.number === payment.period) : undefined;
    let principalPart = principalFirst ? Math.min(payment.amountCents, principalOpen) : 0;
    let interestPart: number;
    if (target) {
      interestPart = Math.min(payment.amountCents, left(target));
      credit(target, interestPart, payment.id);
    } else interestPart = payInterest(payment.amountCents - principalPart, payment.id);
    if (!principalFirst) principalPart = Math.min(payment.amountCents - interestPart, principalOpen);
    interestPaidCents += interestPart;
    principalOpen -= principalPart;
    principalPaidCents += principalPart;
    const settles = principalOpen === 0 && pending() === 0;
    const item: LedgerItem<T> = { ...payment, interestCents: interestPart, principalCents: principalPart, kind: settles ? "SETTLEMENT" : principalPart > 0 ? "PARTIAL" : "INTEREST", balanceBeforeCents, renewedPeriod: null };
    completedBy = !settles && principalPart === 0 && interestPart > 0 && pending() === 0 ? item : null;
    // Renovação na hora: sem período escolhido, quando os juros pendentes zeraram; com período escolhido, quando ele é o
    // período atual e ficou pago (os períodos anteriores ainda pendentes continuam pendentes, cada um com a sua situação).
    const renewsNow = target ? target === current() && left(target) === 0 : pending() === 0;
    if (row && principalOpen > 0 && renewsNow) {
      completedBy = item;
      open({ dueDate: row.newDueDate, interestCents: row.interestCents, principalBaseCents: row.principalBaseCents, openedOn: payment.paidAt, openedBy: "PAYMENT", paymentId: payment.id });
    } else if (target && target !== current() && left(target) === 0) {
      // Período anterior pago depois do vencimento: o seguinte já existia; este fica pago e renovado.
      item.kind = settles ? "SETTLEMENT" : "RENEWAL";
      item.renewedPeriod = periods[target.number] ?? null;
      completedBy = null;
    }
    return item;
  });
  renewOnDue(asOf);
  const period = current();
  const interestCents = periods.reduce((total, item) => total + item.interestCents, 0);
  const interestRemainingCents = pending();
  const balanceCents = principalOpen + interestRemainingCents;
  const pendingPeriods: PendingPeriod[] = periods.filter((item) => left(item) > 0)
    .map((item) => ({ number: item.number, dueDate: item.dueDate, interestCents: item.interestCents, paidCents: item.interestPaidCents ?? 0, remainingCents: left(item) }));
  // Cada período com a sua situação (pago, pago e renovado, vencido, vence hoje, a vencer).
  const firstPending = periods.find((item) => left(item) > 0)?.number ?? null;
  const periodViews: PeriodView[] = periods.map((item, index) => {
    const remainingCents = left(item);
    const locked = remainingCents > 0 && firstPending !== null && item.number > firstPending;
    const status: PeriodStatus = remainingCents === 0 ? (index < periods.length - 1 ? "PAID_RENEWED" : "PAID")
      : item.dueDate < asOf ? "OVERDUE" : item.dueDate === asOf ? "DUE_TODAY" : "UPCOMING";
    return { number: item.number, dueDate: item.dueDate, interestCents: item.interestCents, paidCents: item.interestPaidCents ?? 0, remainingCents, status, openedBy: item.openedBy, paymentIds: paidBy.get(item.number) ?? [], locked };
  });
  // Vencimento a cobrar: o do período pendente mais antigo (em atraso, se já passou); sem pendência, o do período atual.
  const dueDate = pendingPeriods[0]?.dueDate ?? period.dueDate;
  return {
    items, paidCents: interestPaidCents + principalPaidCents, interestPaidCents, principalPaidCents,
    interestCents, totalCents: terms.principalCents + interestCents,
    interestRemainingCents, principalRemainingCents: principalOpen, balanceCents,
    schedule: [] as ScheduleItem[], nextItem: null as ScheduleItem | null, nextDueDate: dueDate,
    periods, periodNumber: period.number, periodInterestCents: period.interestCents, periodDueDate: period.dueDate,
    // Renovações: períodos com juros pagos que já têm o período seguinte aberto (na hora, no vencimento ou pagos depois do
    // vencimento). Período vencido sem pagamento não conta como renovado.
    renewalCount: periodViews.filter((item) => item.status === "PAID_RENEWED" && item.interestCents > 0).length, forgivenCents: 0,
    pendingPeriods, periodViews,
    // Próximo valor a cobrar: os juros pendentes (ou o saldo, se só restar principal).
    amountDueCents: interestRemainingCents > 0 ? interestRemainingCents : balanceCents,
    ...stateFor(balanceCents, dueDate, asOf),
  };
}

// Pagamento somente de juros (regra central): só existe nos juros recorrentes (mensal e quinzenal), quando o valor é
// exatamente o total dos juros pendentes e ainda há principal em aberto. Quita os juros, mantém o principal e abre o
// período seguinte ao atual (vencimento por nextDueDate, ou a data informada) com juros sobre o principal em aberto.
// explicit = o usuário escolheu "Só os juros e renovar" (vale em qualquer ordem de apropriação). Sem a escolha, só os
// contratos antigos (juros primeiro) renovam pelo valor — comportamento de antes, para quem não envia a modalidade.
export function interestOnlyRenewal(terms: LedgerTerms, ledger: Pick<OperationLedger, "interestRemainingCents" | "principalRemainingCents" | "nextDueDate"> & { periodDueDate?: string }, amountCents: number, explicit = false) {
  if (isAmortized(terms) || (terms.paymentOrder === "PRINCIPAL_FIRST" && !explicit) || ledger.principalRemainingCents <= 0 || ledger.interestRemainingCents <= 0 || amountCents !== ledger.interestRemainingCents) return null;
  const anchorDay = Number(terms.firstDueDate.slice(8, 10));
  const previousDueDate = ledger.periodDueDate ?? ledger.nextDueDate;
  return {
    previousDueDate,
    defaultNewDueDate: nextDueDate(terms.frequency, previousDueDate, anchorDay),
    principalBaseCents: ledger.principalRemainingCents,
    nextInterestCents: periodInterest(terms, ledger.principalRemainingCents),
  };
}

const formatDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
// period: "Receber juros e renovar" de um período escolhido na lista (só com INTEREST_ONLY_RENEWAL).
export type PaymentPlanInput = { mode: PaymentMode; amountCents: number; paidAt: string; newDueDate?: string | null; expectedPeriod?: number | null; period?: number | null };
export type PaymentRenewalPlan = { periodNumber: number; previousDueDate: string; newDueDate: string; principalBaseCents: number; interestCents: number };
// Plano de um pagamento: a MESMA função monta a prévia da tela e o que o servidor grava. Recebe os termos do contrato, os
// pagamentos já gravados e a modalidade escolhida; valida a combinação, recalcula a divisão (nada vem do navegador além
// do valor, da data e da modalidade) e devolve o extrato depois do pagamento. O servidor grava exatamente isto.
export function planPayment<T extends LedgerPayment>(terms: LedgerTerms, previous: T[], input: PaymentPlanInput, asOf: string, paymentId = "preview", formatMoney: (cents: number) => string = (cents) => (cents / 100).toFixed(2)) {
  const fail = (error: string) => ({ ok: false as const, error });
  const { mode, amountCents, paidAt } = input;
  if (!Number.isInteger(amountCents) || amountCents <= 0) return fail("Informe o valor recebido, por exemplo 300,00.");
  if (mode === "EARLY_SETTLEMENT") return fail("A liquidação antecipada tem formulário próprio, com confirmação.");
  const recurring = !isAmortized(terms);
  const latest = previous.every((payment) => payment.paidAt <= paidAt);
  const before = operationLedger(terms, previous, paidAt);
  if (before.balanceCents <= 0) return fail("Esta operação não tem saldo em aberto.");
  let renewal: PaymentRenewalPlan | null = null;
  const period = input.period ?? null;
  if (period !== null && (mode !== "INTEREST_ONLY_RENEWAL" || !Number.isInteger(period) || period < 1)) return fail("Período inválido.");
  if (mode === "INTEREST_ONLY_RENEWAL" && period !== null) {
    // Recebimento dos juros de UM período escolhido: exatamente os juros que faltam daquele período, 100% juros. Se ele é
    // o período atual, renova na hora (abre o seguinte pelo calendário do contrato); se é um período anterior, o seguinte
    // já existe e ele passa a "Pago e renovado". Os outros períodos não mudam.
    if (!recurring) return fail("\"Receber juros e renovar\" existe só no pagamento único mensal ou quinzenal.");
    if (before.principalRemainingCents <= 0) return fail("Não há principal em aberto: não há período para renovar. Use \"Saldo total\".");
    if (!latest) return fail("O recebimento de juros vale só para o pagamento mais recente: há pagamento registrado depois desta data.");
    const target = before.periodViews.find((item) => item.number === period);
    if (!target) return fail(`Na data do recebimento (${formatDate(paidAt)}), o ${period}º período ainda não tinha começado. Confira a data.`);
    if (target.remainingCents <= 0) return fail(`Os juros do ${period}º período já estão pagos. Atualize a tela e confira antes de registrar de novo.`);
    // Sequência: com juros de um período anterior sem pagar, este período fica bloqueado (receba o mais antigo primeiro).
    const older = before.pendingPeriods.find((item) => item.number < period);
    if (older) return fail(`O ${period}º período está bloqueado: receba antes os juros do ${older.number}º período (vencimento ${formatDate(older.dueDate)}, ${formatMoney(older.remainingCents)}).`);
    if (amountCents !== target.remainingCents) return fail(`O ${period}º período tem ${formatMoney(target.remainingCents)} de juros a receber. Para outro valor, use "Pagamento manual".`);
    if (period === before.periodNumber) {
      const anchorDay = Number(terms.firstDueDate.slice(8, 10));
      const newDueDate = input.newDueDate || nextDueDate(terms.frequency, target.dueDate, anchorDay);
      if (newDueDate <= target.dueDate) return fail(`O novo vencimento precisa ser depois do vencimento atual (${formatDate(target.dueDate)}).`);
      renewal = { periodNumber: period + 1, previousDueDate: target.dueDate, newDueDate, principalBaseCents: before.principalRemainingCents, interestCents: periodInterest(terms, before.principalRemainingCents) };
    } else if (input.newDueDate) return fail("O novo vencimento só se escolhe ao renovar o período atual.");
  } else if (mode === "INTEREST_ONLY_RENEWAL") {
    if (!recurring) return fail("\"Só os juros e renovar\" existe só no pagamento único mensal ou quinzenal.");
    if (before.principalRemainingCents <= 0) return fail("Não há principal em aberto: não há período para renovar. Use \"Saldo total\".");
    if (before.interestRemainingCents <= 0) return fail("Os juros deste período já estão pagos. Aguarde o próximo período ou use outra modalidade.");
    if (before.pendingPeriods.length > 1) return fail(`Há ${before.pendingPeriods.length} períodos com juros a receber. Escolha na lista qual período está recebendo: cada um é recebido separadamente.`);
    if (!latest) return fail("\"Só os juros e renovar\" vale só para o pagamento mais recente: há pagamento registrado depois desta data.");
    if (input.expectedPeriod != null && input.expectedPeriod !== before.periodNumber) return fail("Este período já foi renovado por outro pagamento. Atualize a tela e confira antes de registrar de novo.");
    if (amountCents !== before.interestRemainingCents) {
      const many = before.pendingPeriods.length > 1 ? ` (${before.pendingPeriods.length} períodos pendentes)` : "";
      return fail(`"Só os juros e renovar" recebe exatamente os juros pendentes: ${formatMoney(before.interestRemainingCents)}${many}. Para outro valor, use "Pagamento manual".`);
    }
    const base = interestOnlyRenewal(terms, before, amountCents, true);
    if (!base) return fail("Esta operação não pode renovar agora.");
    const newDueDate = input.newDueDate || base.defaultNewDueDate;
    if (newDueDate <= base.previousDueDate) return fail(`O novo vencimento precisa ser depois do vencimento atual (${formatDate(base.previousDueDate)}).`);
    renewal = { periodNumber: before.periodNumber + 1, previousDueDate: base.previousDueDate, newDueDate, principalBaseCents: base.principalBaseCents, interestCents: base.nextInterestCents };
  } else if (input.newDueDate) {
    return fail("Novo vencimento só vale para \"Só os juros e renovar\".");
  }
  if (mode === "PRINCIPAL_AMORTIZATION") {
    if (!recurring) return fail("No parcelado e no diário, use \"Pagamento manual\" ou \"Saldo total\".");
    if (before.principalRemainingCents <= 0) return fail("Não há principal em aberto para amortizar.");
    if (amountCents > before.principalRemainingCents) return fail(`A amortização não pode passar do principal em aberto (${formatMoney(before.principalRemainingCents)}).`);
  }
  if (mode === "FULL_SETTLEMENT") {
    if (!latest) return fail("O saldo total vale só para o pagamento mais recente: há pagamento registrado depois desta data.");
    if (amountCents !== before.balanceCents) return fail(`O saldo total nesta data é ${formatMoney(before.balanceCents)}.`);
  }
  const payment = { id: paymentId, amountCents, paidAt, createdAt: "9999-12-31T23:59:59.999Z", mode, allocationOrder: allocationOrderFor(terms), period } as LedgerPayment as T;
  const list = [...previous, payment];
  const planned: LedgerTerms = renewal ? { ...terms, renewals: [...terms.renewals, { paymentId, ...renewal }] } : terms;
  const after = operationLedger(planned, list, asOf);
  const item = after.items.find((entry) => entry.id === paymentId);
  if (!item) return fail("Pagamento inválido.");
  const check = checkPayment({ amountCents, balanceCents: item.balanceBeforeCents, formatMoney });
  if (!check.ok) return check;
  const sum = list.reduce((total, entry) => total + entry.amountCents, 0);
  if (after.paidCents !== sum) return fail("Com esta data, os pagamentos registrados depois dela passariam do saldo da operação. Confira a data do pagamento.");
  if (mode === "INTEREST_ONLY_RENEWAL" && (item.principalCents !== 0 || item.interestCents !== amountCents)) return fail("Pagamento de juros inconsistente com o contrato.");
  if (period !== null) {
    // Só o período escolhido muda: os juros pagos dos demais períodos (na data do recebimento) continuam iguais.
    const check = operationLedger(planned, list, paidAt);
    const changed = before.periodViews.some((entry) => entry.number !== period && check.periodViews.find((other) => other.number === entry.number)?.paidCents !== entry.paidCents);
    if (changed || check.periodViews.find((entry) => entry.number === period)?.remainingCents !== 0) return fail("Este recebimento mudaria outros períodos. Atualize a tela e confira.");
  }
  return {
    ok: true as const, mode, allocationOrder: allocationOrderFor(terms), renewal, before, after, item, period,
    settles: after.balanceCents === 0,
    // Resumo da prévia (o mesmo que o servidor grava).
    interestCents: item.interestCents, principalCents: item.principalCents,
    principalBeforeCents: before.principalRemainingCents, principalAfterCents: before.principalRemainingCents - item.principalCents,
    interestPendingBeforeCents: before.interestRemainingCents, interestPendingAfterCents: Math.max(before.interestRemainingCents - item.interestCents, 0),
    pendingPeriods: before.pendingPeriods,
    nextDueDate: renewal ? renewal.newDueDate : after.nextDueDate,
    nextInterestCents: renewal ? renewal.interestCents : after.periodInterestCents,
  };
}
export type PaymentPlan = Extract<ReturnType<typeof planPayment>, { ok: true }>;
