// Consolida a carteira do tenant a partir das linhas do banco. Funções puras: sem acesso a banco.
import { addDays, daysBetween, formatDate, initialsOf, shortDate, todayIso } from "./format";
import type { ClientProfile } from "./client-profile";
import { operationLedger, paymentKindLabels, type Frequency, type LedgerPeriod, type LedgerTerms, type PaymentKind, type ScheduleItem } from "./rules";

export type OperationStatus = "OPEN" | "PAID" | "CANCELED";

export type ClientRecord = ClientProfile & { id: string; name: string; document: string | null; phone: string | null; notes: string | null; archivedAt: string | null; createdAt: string };
export type OperationRecord = {
  id: string; clientId: string; clientName: string; principalCents: number; interestRateBps: number; interestCents: number; totalCents: number;
  loanDate: string; dueDate: string; status: OperationStatus; settledAt: string | null; calculationRule: string; createdAt: string;
  // Para operação excluída (CANCELED): quando foi excluída. Só ela usa este campo.
  updatedAt?: string;
  // Renovações por pagamento só dos juros. interestCents/totalCents acima são sempre os do período original.
  renewals?: RenewalRecord[];
  // Modalidade: pagamento único (padrão) ou parcelado com parcela fixa.
  modality?: OperationModality; installmentCount?: number | null; installmentCents?: number | null; firstDueDate?: string | null;
  // Periodicidade do pagamento único (mensal, quinzenal ou diário). Operações antigas: mensal.
  frequency?: Frequency;
};
export type OperationModality = "SINGLE" | "INSTALLMENT";
// Renovação de período: o pagamento que a gerou, o vencimento antes e depois e os juros do novo período.
export type RenewalRecord = { id: string; paymentId: string; periodNumber: number; previousDueDate: string; newDueDate: string; principalBaseCents: number; interestCents: number; createdAt: string };
// Correção feita em um pagamento: valores de antes e de depois.
export type PaymentRevisionRecord = { id: string; previousAmountCents: number; previousPaidAt: string; amountCents: number; paidAt: string; editedAt: string; editedBy: string | null };
export type PaymentRecord = { id: string; operationId: string; clientName: string; amountCents: number; paidAt: string; notes: string | null; createdAt: string; revisions?: PaymentRevisionRecord[] };
// renewedPeriod: o período que este pagamento renovou (pagamento somente de juros), com o novo vencimento.
export type AllocatedPayment = PaymentRecord & { interestCents: number; principalCents: number; kind: PaymentKind; renewedPeriod: LedgerPeriod | null };
export type CapitalMovementKind = "CONTRIBUTION" | "WITHDRAWAL" | "CONTRIBUTION_REVERSAL";
export type CapitalMovementRecord = { id: string; kind: CapitalMovementKind; amountCents: number; occurredAt: string; notes: string | null; reversedMovementId: string | null; createdAt: string };

// Extrato do capital: cada linha soma (+) ou tira (−) do capital disponível; o saldo final é o capital disponível atual.
export type CapitalLedgerKind = "INITIAL" | "CONTRIBUTION" | "CONTRIBUTION_REVERSAL" | "WITHDRAWAL" | "LOAN" | "LOAN_CANCELED" | "PAYMENT";
// reversible/reversed: só para aportes (botão "Estornar aporte" e marca de estornado).
export type CapitalLedgerEntry = { key: string; kind: CapitalLedgerKind; date: string; description: string; amountCents: number; balanceCents: number; movementId?: string; reversed?: boolean };
export const capitalLedgerLabels: Record<CapitalLedgerKind, string> = {
  INITIAL: "Capital inicial", CONTRIBUTION: "Aporte", CONTRIBUTION_REVERSAL: "Estorno de aporte", WITHDRAWAL: "Retirada",
  LOAN: "Capital utilizado em operação", LOAN_CANCELED: "Operação excluída", PAYMENT: "Valor recebido de operação",
};

export type OperationState = "ACTIVE" | "DUE_TODAY" | "OVERDUE" | "PAID" | "CANCELED";
export type OperationView = Omit<OperationRecord, "renewals"> & {
  // Na visão, interestCents e totalCents são os contratados até agora (período original + renovações); os do
  // período original ficam em originalInterestCents e originalTotalCents.
  originalInterestCents: number; originalTotalCents: number; renewals: RenewalRecord[]; renewalCount: number;
  // Período atual (1 = original), seus juros e o primeiro vencimento combinado.
  periodNumber: number; periodInterestCents: number; originalDueDate: string;
  modality: OperationModality; frequency: Frequency;
  // Parcelado e diário: as parcelas com o que já foi pago em cada uma e a próxima em aberto (null quando tudo foi pago).
  installments: ScheduleItem[]; nextInstallment: ScheduleItem | null;
  // Mensal e quinzenal: os períodos (o 1º é o do contrato; os seguintes vieram de renovações).
  periods: LedgerPeriod[];
  // Próximo vencimento: no pagamento único é o vencimento do período atual; no parcelado/diário, o da próxima parcela.
  nextDueDate: string;
  // Próximo valor a cobrar (juros do período ou a próxima parcela) e os termos usados pelas prévias da tela.
  amountDueCents: number; ledgerTerms: LedgerTerms;
  code: string; paidCents: number; interestPaidCents: number; principalPaidCents: number; interestRemainingCents: number; principalRemainingCents: number;
  balanceCents: number; state: OperationState; daysUntilDue: number; payments: AllocatedPayment[];
  // Tempo da operação: do empréstimo até hoje (ou até a quitação) e em quantos meses diferentes houve pagamento.
  elapsedUntil: string; paymentMonths: number;
};

// Totais de um conjunto de operações (um cliente ou a carteira). Só usa pagamentos registrados:
// juros recebidos são juros realizados; juros restantes das operações em aberto ainda são só previstos.
export function summarizeOperations(operations: OperationView[]) {
  const sum = (pick: (operation: OperationView) => number) => operations.reduce((total, operation) => total + pick(operation), 0);
  const open = operations.filter((operation) => operation.status === "OPEN");
  return {
    operationCount: operations.length,
    openCount: open.length,
    paidCount: operations.filter((operation) => operation.status === "PAID").length,
    overdueCount: open.filter((operation) => operation.state === "OVERDUE").length,
    principalCents: sum((operation) => operation.principalCents),
    interestCents: sum((operation) => operation.interestCents),
    renewalCount: sum((operation) => operation.renewalCount),
    totalCents: sum((operation) => operation.totalCents),
    originalTotalCents: sum((operation) => operation.originalTotalCents),
    paidCents: sum((operation) => operation.paidCents),
    interestPaidCents: sum((operation) => operation.interestPaidCents),
    principalPaidCents: sum((operation) => operation.principalPaidCents),
    principalRemainingCents: sum((operation) => operation.principalRemainingCents),
    interestRemainingCents: sum((operation) => operation.interestRemainingCents),
    balanceCents: sum((operation) => operation.balanceCents),
    paymentCount: sum((operation) => operation.payments.length),
    firstLoanDate: operations.reduce<string | null>((first, operation) => (first === null || operation.loanDate < first ? operation.loanDate : first), null),
  };
}
export type OperationsSummary = ReturnType<typeof summarizeOperations>;

export type ChargeTone = "due" | "late" | "received";
export type ChargeItem = { key: string; operationId: string; clientName: string; initials: string; color: string; detail: string; amountCents: number; status: string; tone: ChargeTone };
export type ChargeFilter = "Hoje" | "Amanhã" | "Próximas" | "Em atraso" | "Histórico";
export type ChartPeriod = "7D" | "30D" | "90D";

const avatarColors = ["mint", "violet", "peach", "sky"];
function colorFor(value: string) {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return avatarColors[hash % avatarColors.length];
}

export function operationCode(id: string) {
  return `OP-${id.replace(/^op_/, "").slice(0, 6).toUpperCase()}`;
}

function relativeDue(days: number) {
  if (days === 0) return "Vence hoje";
  if (days === 1) return "Amanhã";
  if (days > 1) return `Em ${days} dias`;
  return days === -1 ? "Atrasado há 1 dia" : `Atrasado há ${-days} dias`;
}

function relativePaid(paidAt: string, today: string) {
  const days = daysBetween(paidAt, today);
  if (days === 0) return "Recebido hoje";
  if (days === 1) return "Recebido ontem";
  return `Recebido em ${shortDate(paidAt)}`;
}

// Recebe só os dados do ciclo atual da carteira (operações, pagamentos e movimentos de capital); ciclos encerrados
// pelo "Zerar carteira" ficam no banco e não entram nos cards.
export function buildPortfolio({ initialCapitalCents, hasWallet, walletCreatedOn = null, cycleNumber = 1, capitalMovements = [], operations, payments, today }: {
  initialCapitalCents: number; hasWallet: boolean; walletCreatedOn?: string | null; cycleNumber?: number; capitalMovements?: CapitalMovementRecord[];
  operations: OperationRecord[]; payments: PaymentRecord[]; today: string;
}) {
  const paymentsByOperation = new Map<string, PaymentRecord[]>();
  for (const payment of payments) paymentsByOperation.set(payment.operationId, [...(paymentsByOperation.get(payment.operationId) ?? []), payment]);

  const views: OperationView[] = operations.map(({ renewals: renewalRows = [], ...operation }) => {
    const renewals = [...renewalRows].sort((a, b) => a.periodNumber - b.periodNumber);
    const modality: OperationModality = operation.modality ?? "SINGLE";
    const frequency: Frequency = operation.frequency ?? "MONTHLY";
    // Primeiro vencimento combinado. Operações antigas de pagamento único não o gravavam: é o vencimento antes da
    // primeira renovação registrada ou, sem renovação registrada, o vencimento gravado.
    const originalDueDate = operation.firstDueDate ?? renewals.find((renewal) => renewal.periodNumber === 2)?.previousDueDate ?? operation.dueDate;
    const ledgerTerms: LedgerTerms = {
      modality, frequency, principalCents: operation.principalCents, interestRateBps: operation.interestRateBps, interestCents: operation.interestCents,
      firstDueDate: originalDueDate, installmentCount: operation.installmentCount ?? null, installmentCents: operation.installmentCents ?? null, renewals,
    };
    // Toda a conta (juros/principal de cada pagamento, período, vencimento, saldo e situação) vem do extrato em rules.ts.
    const ledger = operationLedger(ledgerTerms, paymentsByOperation.get(operation.id) ?? [], today);
    const open = operation.status === "OPEN";
    const state: OperationState = operation.status === "PAID" ? "PAID" : operation.status === "CANCELED" ? "CANCELED" : ledger.state === "PAID" ? "ACTIVE" : ledger.state;
    const daysUntilDue = open ? ledger.daysUntilDue : daysBetween(today, ledger.nextDueDate);
    return {
      ...operation, code: operationCode(operation.id), state, daysUntilDue,
      interestCents: ledger.interestCents, totalCents: ledger.totalCents, originalInterestCents: operation.interestCents, originalTotalCents: operation.totalCents,
      renewals, renewalCount: ledger.renewalCount, periodNumber: ledger.periodNumber, modality, frequency, periods: ledger.periods,
      installments: ledger.schedule, nextInstallment: ledger.nextItem, nextDueDate: ledger.nextDueDate,
      periodInterestCents: ledger.periodInterestCents, originalDueDate, amountDueCents: open ? ledger.amountDueCents : 0, ledgerTerms,
      paidCents: ledger.paidCents, interestPaidCents: ledger.interestPaidCents, principalPaidCents: ledger.principalPaidCents,
      interestRemainingCents: open ? ledger.interestRemainingCents : 0,
      principalRemainingCents: open ? ledger.principalRemainingCents : 0,
      balanceCents: open ? ledger.balanceCents : 0,
      payments: [...ledger.items].reverse(),
      elapsedUntil: operation.status === "PAID" && operation.settledAt ? operation.settledAt : today,
      paymentMonths: new Set(ledger.items.map((payment) => payment.paidAt.slice(0, 7))).size,
    };
  });

  const live = views.filter((operation) => operation.status !== "CANCELED");
  const open = views.filter((operation) => operation.status === "OPEN");
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

  // Caixa: entra com o capital inicial e os aportes, sai com retiradas, estornos de aporte e o principal das operações,
  // e volta com cada pagamento recebido (principal e juros). Juros ainda não recebidos nunca entram no capital disponível.
  const movementTotal = (kind: CapitalMovementKind) => sum(capitalMovements.filter((movement) => movement.kind === kind).map((movement) => movement.amountCents));
  const contributionsCents = movementTotal("CONTRIBUTION") - movementTotal("CONTRIBUTION_REVERSAL");
  const withdrawalsCents = movementTotal("WITHDRAWAL");
  const usedCapitalCents = sum(live.map((operation) => operation.principalCents));
  const receivedCents = sum(payments.map((payment) => payment.amountCents));
  const summary = {
    hasWallet,
    cycleNumber,
    // Carteira nova ou ciclo recém-aberto: pede o capital inicial no dashboard e na tela Capital.
    needsInitialCapital: !hasWallet || (initialCapitalCents === 0 && operations.length === 0 && capitalMovements.length === 0),
    initialCapitalCents,
    contributionsCents,
    // Aportes lançados (brutos) e estornos de aporte, para mostrar separados na tela Capital.
    grossContributionsCents: movementTotal("CONTRIBUTION"),
    reversalsCents: movementTotal("CONTRIBUTION_REVERSAL"),
    withdrawalsCents,
    investedCents: initialCapitalCents + contributionsCents,
    usedCapitalCents,
    availableCents: initialCapitalCents + contributionsCents - withdrawalsCents - usedCapitalCents + receivedCents,
    // Principal que ainda não voltou: disponível + emprestado = capital aportado + juros recebidos.
    lentCents: sum(open.map((operation) => operation.principalRemainingCents)),
    receivableCents: sum(open.map((operation) => operation.balanceCents)),
    // Juros que ainda faltam receber nas operações em aberto (os já recebidos ficam em receivedInterestCents).
    expectedInterestCents: sum(open.map((operation) => operation.interestRemainingCents)),
    receivedInterestCents: sum(views.map((operation) => operation.interestPaidCents)),
    receivedPrincipalCents: sum(views.map((operation) => operation.principalPaidCents)),
    receivedCents,
    counts: {
      total: live.length,
      active: open.length,
      paid: views.filter((operation) => operation.status === "PAID").length,
      dueToday: open.filter((operation) => operation.daysUntilDue === 0).length,
      overdue: open.filter((operation) => operation.daysUntilDue < 0).length,
    },
  };

  const toCharge = (operation: OperationView): ChargeItem => ({
    key: operation.id, operationId: operation.id, clientName: operation.clientName, initials: initialsOf(operation.clientName), color: colorFor(operation.clientId),
    detail: operation.nextInstallment
      ? `Op. #${operation.code} · Parcela ${operation.nextInstallment.number}/${operation.installments.length} · Vence ${formatDate(operation.nextDueDate)}`
      : `Op. #${operation.code}${operation.periodNumber > 1 ? ` · ${operation.periodNumber}º período` : ""} · Vence ${formatDate(operation.nextDueDate)}`,
    amountCents: operation.nextInstallment ? operation.nextInstallment.remainingCents : operation.balanceCents,
    status: relativeDue(operation.daysUntilDue), tone: operation.daysUntilDue < 0 ? "late" : "due",
  });
  const byDue = [...open].sort((a, b) => a.nextDueDate.localeCompare(b.nextDueDate));
  const operationById = new Map(views.map((operation) => [operation.id, operation]));
  const allocated = views.flatMap((operation) => operation.payments);
  const history: ChargeItem[] = allocated.sort((a, b) => b.paidAt.localeCompare(a.paidAt) || b.createdAt.localeCompare(a.createdAt)).slice(0, 20).map((payment) => {
    const operation = operationById.get(payment.operationId);
    return {
      key: payment.id, operationId: payment.operationId, clientName: payment.clientName, initials: initialsOf(payment.clientName), color: colorFor(operation?.clientId ?? payment.clientName),
      detail: `Op. #${operationCode(payment.operationId)} · ${paymentKindLabels[payment.kind]} · Pago em ${formatDate(payment.paidAt)}`, amountCents: payment.amountCents,
      status: relativePaid(payment.paidAt, today), tone: "received",
    };
  });
  const charges: Record<ChargeFilter, ChargeItem[]> = {
    Hoje: byDue.filter((operation) => operation.daysUntilDue === 0).map(toCharge),
    Amanhã: byDue.filter((operation) => operation.daysUntilDue === 1).map(toCharge),
    Próximas: byDue.filter((operation) => operation.daysUntilDue >= 1 && operation.daysUntilDue <= 7).map(toCharge),
    "Em atraso": byDue.filter((operation) => operation.daysUntilDue < 0).map(toCharge),
    Histórico: history,
  };
  const upcoming = byDue.filter((operation) => operation.daysUntilDue >= 0).slice(0, 4);

  // Saldo a receber da carteira no fim de cada dia, usando só datas registradas.
  const receivableAt = (day: string) => sum(live.map((operation) => {
    if (operation.loanDate > day) return 0;
    if (operation.status === "PAID" && operation.settledAt && operation.settledAt <= day) return 0;
    const paid = sum(payments.filter((payment) => payment.operationId === operation.id && payment.paidAt <= day).map((payment) => payment.amountCents));
    // Os juros de um período renovado só passam a ser devidos a partir da renovação (pagamento ou vencimento).
    const renewed = sum(operation.periods.filter((period) => period.number > 1 && (period.openedOn ?? today) <= day).map((period) => period.interestCents));
    return Math.max(operation.originalTotalCents + renewed - paid, 0);
  }));
  const series = (spanDays: number, points: number) => {
    const days = Array.from({ length: points }, (_, index) => addDays(today, -Math.round(spanDays - (spanDays * index) / (points - 1))));
    return { labels: days.map(shortDate), values: days.map(receivableAt) };
  };
  const chart: Record<ChartPeriod, { labels: string[]; values: number[] }> = { "7D": series(6, 7), "30D": series(30, 7), "90D": series(90, 7) };

  const reversedIds = new Set(capitalMovements.map((movement) => movement.reversedMovementId).filter(Boolean));
  const movementDescription = (movement: CapitalMovementRecord) => movement.notes ?? (movement.kind === "WITHDRAWAL" ? "Retirada de capital" : movement.kind === "CONTRIBUTION" ? "Aporte de capital" : "Estorno de aporte");
  const canceled = views.filter((operation) => operation.status === "CANCELED");
  const movements: Omit<CapitalLedgerEntry, "balanceCents">[] = [
    ...capitalMovements.map((movement) => ({
      key: movement.id, kind: movement.kind, date: movement.occurredAt, description: movementDescription(movement), order: movement.createdAt,
      amountCents: movement.kind === "CONTRIBUTION" ? movement.amountCents : -movement.amountCents,
      ...(movement.kind === "CONTRIBUTION" ? { movementId: movement.id, reversed: reversedIds.has(movement.id) } : {}),
    })),
    // Operações excluídas continuam no extrato: a saída do capital e a devolução na exclusão se anulam.
    ...[...live, ...canceled].map((operation) => ({ key: operation.id, kind: "LOAN" as const, date: operation.loanDate, description: `${operation.clientName} · Op. #${operation.code}`, amountCents: -operation.principalCents, order: operation.createdAt })),
    ...canceled.map((operation) => {
      const canceledAt = operation.updatedAt ?? operation.createdAt;
      const canceledOn = todayIso(new Date(canceledAt));
      return { key: `${operation.id}-canceled`, kind: "LOAN_CANCELED" as const, date: canceledOn < operation.loanDate ? operation.loanDate : canceledOn, description: `${operation.clientName} · Op. #${operation.code}`, amountCents: operation.principalCents, order: canceledAt };
    }),
    ...payments.map((payment) => ({ key: payment.id, kind: "PAYMENT" as const, date: payment.paidAt, description: `${payment.clientName} · Op. #${operationCode(payment.operationId)}`, amountCents: payment.amountCents, order: payment.createdAt })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.order.localeCompare(b.order))
    .map(({ key, kind, date, description, amountCents, movementId, reversed }: Omit<CapitalLedgerEntry, "balanceCents"> & { order: string }) => ({ key, kind, date, description, amountCents, movementId, reversed }));
  // O capital inicial abre o extrato, mesmo que a carteira tenha sido configurada depois de operações retroativas.
  const initialEntry = hasWallet ? [{ key: "initial", kind: "INITIAL" as const, date: walletCreatedOn ?? today, description: cycleNumber > 1 ? `Capital inicial do ciclo ${cycleNumber}` : "Capital inicial da carteira", amountCents: initialCapitalCents }] : [];
  let running = 0;
  const capitalLedger: CapitalLedgerEntry[] = [...initialEntry, ...movements].map((entry) => {
    running += entry.amountCents;
    return { ...entry, balanceCents: running };
  });

  // Operações excluídas (CANCELED) não aparecem em nenhuma lista nem card; só no extrato do capital.
  return { summary, profitability: summarizeOperations(live), operations: live, charges, upcoming, chart, capitalLedger: capitalLedger.reverse() };
}

export type Portfolio = ReturnType<typeof buildPortfolio>;
