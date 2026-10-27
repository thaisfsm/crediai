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
  INTEREST: "Juros", PARTIAL: "Pagamento de principal", SETTLEMENT: "Quitação", RENEWAL: "Juros / Renovação", INSTALLMENT: "Parcela",
};

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
export type LedgerPayment = { id: string; amountCents: number; paidAt: string; createdAt?: string };
export type LedgerPeriod = { number: number; dueDate: string; interestCents: number; principalBaseCents: number; openedOn: string | null; openedBy: "CONTRACT" | "PAYMENT" | "DUE_DATE"; paymentId: string | null };
// number = número ATUAL entre as obrigações ativas (a parcela renegociada mantém o número original, que é o histórico);
// originalNumber = número no contrato original; deferredTo = número atual da obrigação para onde a parcela foi; deferredFrom =
// número original da parcela que originou esta obrigação do final; additionCents = acréscimo dessa obrigação.
export type ScheduleItem = { number: number; originalNumber: number; dueDate: string; amountCents: number; paidCents: number; remainingCents: number; state: InstallmentState; deferredTo: number | null; deferredFrom: number | null; additionCents: number };
export type LedgerItem<T> = T & { interestCents: number; principalCents: number; kind: PaymentKind; balanceBeforeCents: number; renewedPeriod: LedgerPeriod | null };
export type LedgerState = "ACTIVE" | "DUE_TODAY" | "OVERDUE" | "PAID";

const isAmortized = (terms: LedgerTerms) => terms.modality === "INSTALLMENT" || terms.frequency === "DAILY";

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
    amountDueCents: 0, nextItem: null,
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

// Parcelado e diário: os juros pagos acompanham a proporção do contrato sobre o TOTAL pago até cada pagamento
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
    const finishes = payment.amountCents >= balanceBeforeCents;
    const paidAfter = interestPaidCents + principalPaidCents + payment.amountCents;
    const interestPart = finishes ? interestLeft : Math.min(interestLeft, payment.amountCents, Math.max(interestAt(paidAfter) - interestPaidCents, 0));
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
    periods: [] as LedgerPeriod[], periodNumber: 1, periodInterestCents: terms.interestCents, renewalCount: 0, forgivenCents: 0,
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
    // Período sem juros (taxa 0%) não renova: vencido com principal em aberto, fica Em atraso.
    while (principalOpen > 0 && current().interestCents > 0 && periodInterestPaid >= current().interestCents && date >= current().dueDate) {
      const due = current().dueDate;
      open({ dueDate: nextDueDate(terms.frequency, due, anchorDay), interestCents: periodInterest(terms, principalOpen), principalBaseCents: principalOpen, openedOn: due, openedBy: "DUE_DATE", paymentId: null });
    }
  };
  const items: LedgerItem<T>[] = ordered.map((payment) => {
    renewOnDue(payment.paidAt);
    const interestLeft = Math.max(current().interestCents - periodInterestPaid, 0);
    const balanceBeforeCents = principalOpen + interestLeft;
    // Principal primeiro: o pagamento abate o principal em aberto e só o resto cobre os juros do período (lucro).
    const principalFirst = terms.paymentOrder === "PRINCIPAL_FIRST";
    const principalPart = principalFirst ? Math.min(payment.amountCents, principalOpen) : 0;
    const interestPart = Math.min(payment.amountCents - principalPart, interestLeft);
    const principalPartFinal = principalFirst ? principalPart : Math.min(payment.amountCents - interestPart, principalOpen);
    periodInterestPaid += interestPart;
    interestPaidCents += interestPart;
    principalOpen -= principalPartFinal;
    principalPaidCents += principalPartFinal;
    const settles = principalOpen === 0 && periodInterestPaid >= current().interestCents;
    const item: LedgerItem<T> = { ...payment, interestCents: interestPart, principalCents: principalPartFinal, kind: settles ? "SETTLEMENT" : principalPartFinal > 0 ? "PARTIAL" : "INTEREST", balanceBeforeCents, renewedPeriod: null };
    completedBy = !settles && principalPartFinal === 0 && interestPart > 0 && periodInterestPaid >= current().interestCents ? item : null;
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
    periods, periodNumber: period.number, periodInterestCents: period.interestCents, renewalCount: periods.length - 1, forgivenCents: 0,
    // Próximo valor a cobrar: os juros que faltam do período (ou o saldo, se só restar principal).
    amountDueCents: interestRemainingCents > 0 ? interestRemainingCents : balanceCents,
    ...stateFor(balanceCents, period.dueDate, asOf),
  };
}

// Pagamento somente de juros (regra central): só existe nos juros recorrentes (mensal e quinzenal), quando o valor é
// exatamente o que falta dos juros do período atual e ainda há principal em aberto. Quita os juros do período, mantém o
// principal, abre o período seguinte (vencimento por nextDueDate, ou a data informada) com juros sobre o principal.
export function interestOnlyRenewal(terms: LedgerTerms, ledger: Pick<OperationLedger, "interestRemainingCents" | "principalRemainingCents" | "nextDueDate">, amountCents: number) {
  if (isAmortized(terms) || terms.paymentOrder === "PRINCIPAL_FIRST" || ledger.principalRemainingCents <= 0 || ledger.interestRemainingCents <= 0 || amountCents !== ledger.interestRemainingCents) return null;
  const anchorDay = Number(terms.firstDueDate.slice(8, 10));
  return {
    previousDueDate: ledger.nextDueDate,
    defaultNewDueDate: nextDueDate(terms.frequency, ledger.nextDueDate, anchorDay),
    principalBaseCents: ledger.principalRemainingCents,
    nextInterestCents: periodInterest(terms, ledger.principalRemainingCents),
  };
}
