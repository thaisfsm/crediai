// Consolida a carteira do tenant a partir das linhas do banco. Funções puras: sem acesso a banco.
import { addDays, daysBetween, formatDate, initialsOf, shortDate, todayIso } from "./format";
import { allocatePayments, paymentKindLabels, type PaymentKind } from "./rules";

export type OperationStatus = "OPEN" | "PAID" | "CANCELED";

export type ClientRecord = { id: string; name: string; document: string | null; phone: string | null; notes: string | null; archivedAt: string | null; createdAt: string };
export type OperationRecord = {
  id: string; clientId: string; clientName: string; principalCents: number; interestRateBps: number; interestCents: number; totalCents: number;
  loanDate: string; dueDate: string; status: OperationStatus; settledAt: string | null; calculationRule: string; createdAt: string;
  // Para operação excluída (CANCELED): quando foi excluída. Só ela usa este campo.
  updatedAt?: string;
};
export type PaymentRecord = { id: string; operationId: string; clientName: string; amountCents: number; paidAt: string; notes: string | null; createdAt: string };
export type AllocatedPayment = PaymentRecord & { interestCents: number; principalCents: number; kind: PaymentKind };
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
export type OperationView = OperationRecord & {
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
    overdueCount: open.filter((operation) => operation.daysUntilDue < 0).length,
    principalCents: sum((operation) => operation.principalCents),
    interestCents: sum((operation) => operation.interestCents),
    totalCents: sum((operation) => operation.totalCents),
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

  const views: OperationView[] = operations.map((operation) => {
    // Juros primeiro, depois principal: a divisão de cada pagamento vem da regra central em rules.ts.
    const allocation = allocatePayments(operation, paymentsByOperation.get(operation.id) ?? []);
    const daysUntilDue = daysBetween(today, operation.dueDate);
    const state: OperationState = operation.status === "PAID" ? "PAID"
      : operation.status === "CANCELED" ? "CANCELED"
      : daysUntilDue < 0 ? "OVERDUE" : daysUntilDue === 0 ? "DUE_TODAY" : "ACTIVE";
    return {
      ...operation, code: operationCode(operation.id), state, daysUntilDue,
      paidCents: allocation.paidCents, interestPaidCents: allocation.interestPaidCents, principalPaidCents: allocation.principalPaidCents,
      interestRemainingCents: operation.status === "OPEN" ? allocation.interestRemainingCents : 0,
      principalRemainingCents: operation.status === "OPEN" ? allocation.principalRemainingCents : 0,
      balanceCents: operation.status === "OPEN" ? allocation.balanceCents : 0,
      payments: [...allocation.items].reverse(),
      elapsedUntil: operation.status === "PAID" && operation.settledAt ? operation.settledAt : today,
      paymentMonths: new Set(allocation.items.map((payment) => payment.paidAt.slice(0, 7))).size,
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
    detail: `Op. #${operation.code} · Vence ${formatDate(operation.dueDate)}`, amountCents: operation.balanceCents,
    status: relativeDue(operation.daysUntilDue), tone: operation.daysUntilDue < 0 ? "late" : "due",
  });
  const byDue = [...open].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
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
    return Math.max(operation.totalCents - paid, 0);
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
