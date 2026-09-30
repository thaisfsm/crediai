// Consolida a carteira do tenant a partir das linhas do banco. Funções puras: sem acesso a banco.
import { addDays, daysBetween, formatDate, initialsOf, shortDate } from "./format";
import { allocatePayments, paymentKindLabels, type PaymentKind } from "./rules";

export type OperationStatus = "OPEN" | "PAID" | "CANCELED";

export type ClientRecord = { id: string; name: string; document: string | null; phone: string | null; notes: string | null; createdAt: string };
export type OperationRecord = {
  id: string; clientId: string; clientName: string; principalCents: number; interestRateBps: number; interestCents: number; totalCents: number;
  loanDate: string; dueDate: string; status: OperationStatus; settledAt: string | null; calculationRule: string; createdAt: string;
};
export type PaymentRecord = { id: string; operationId: string; clientName: string; amountCents: number; paidAt: string; notes: string | null; createdAt: string };
export type AllocatedPayment = PaymentRecord & { interestCents: number; principalCents: number; kind: PaymentKind };

export type OperationState = "ACTIVE" | "DUE_TODAY" | "OVERDUE" | "PAID" | "CANCELED";
export type OperationView = OperationRecord & {
  code: string; paidCents: number; interestPaidCents: number; principalPaidCents: number; interestRemainingCents: number; principalRemainingCents: number;
  balanceCents: number; state: OperationState; daysUntilDue: number; payments: AllocatedPayment[];
};

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

export function buildPortfolio({ initialCapitalCents, hasWallet, operations, payments, today }: {
  initialCapitalCents: number; hasWallet: boolean; operations: OperationRecord[]; payments: PaymentRecord[]; today: string;
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
    };
  });

  const live = views.filter((operation) => operation.status !== "CANCELED");
  const open = views.filter((operation) => operation.status === "OPEN");
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

  // Caixa: o capital sai quando a operação é criada e volta com cada pagamento recebido.
  const lentEverCents = sum(live.map((operation) => operation.principalCents));
  const receivedCents = sum(payments.map((payment) => payment.amountCents));
  const summary = {
    hasWallet,
    initialCapitalCents,
    availableCents: initialCapitalCents - lentEverCents + receivedCents,
    lentCents: sum(open.map((operation) => operation.principalCents)),
    receivableCents: sum(open.map((operation) => operation.balanceCents)),
    expectedInterestCents: sum(open.map((operation) => operation.interestCents)),
    pendingInterestCents: sum(open.map((operation) => operation.interestRemainingCents)),
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

  return { summary, operations: views, charges, upcoming, chart };
}

export type Portfolio = ReturnType<typeof buildPortfolio>;
