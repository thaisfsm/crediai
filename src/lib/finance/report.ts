// Relatório de rentabilidade com filtros (Etapa E): período e situação, por cliente e por operação. Regras puras, usadas
// na tela e nos testes; tudo vem das operações já calculadas pelo extrato (operationLedger), sem conta nova.
// Período (D-E2): juros e principal recebidos contam pela DATA DO PAGAMENTO; principal emprestado conta pela DATA DO
// EMPRÉSTIMO; saldo em aberto e juros previstos são sempre os de hoje. Ciclo atual por padrão; "Todos os ciclos" inclui os ciclos encerrados (D-E1).
import { addDays } from "./format";
import type { OperationView } from "./portfolio";

export const REPORT_STATUSES = { ALL: "Todas", OPEN: "Em aberto", OVERDUE: "Em atraso", PAID: "Quitadas" } as const;
export type ReportStatus = keyof typeof REPORT_STATUSES;
export const REPORT_PERIODS = { CYCLE: "Todo o período", THIS_MONTH: "Este mês", LAST_MONTH: "Mês passado", LAST_30: "Últimos 30 dias", CUSTOM: "Personalizado" } as const;
export type ReportPeriod = keyof typeof REPORT_PERIODS;
export const REPORT_SCOPES = { CURRENT: "Ciclo atual", ALL: "Todos os ciclos" } as const;
export type ReportScope = keyof typeof REPORT_SCOPES;
export type ReportFilters = { period: ReportPeriod; from: string; to: string; status: ReportStatus };

// Intervalo do período escolhido (datas inclusivas). null = sem limite (todo o ciclo).
export function periodRange(filters: Pick<ReportFilters, "period" | "from" | "to">, today: string): { from: string | null; to: string | null } {
  const month = today.slice(0, 7);
  if (filters.period === "THIS_MONTH") return { from: `${month}-01`, to: today };
  if (filters.period === "LAST_MONTH") {
    const lastDay = addDays(`${month}-01`, -1);
    return { from: `${lastDay.slice(0, 7)}-01`, to: lastDay };
  }
  if (filters.period === "LAST_30") return { from: addDays(today, -29), to: today };
  if (filters.period === "CUSTOM") return { from: filters.from || null, to: filters.to || null };
  return { from: null, to: null };
}

const matchesStatus = (operation: OperationView, status: ReportStatus) =>
  status === "ALL" || (status === "PAID" ? operation.status === "PAID" : status === "OVERDUE" ? operation.status === "OPEN" && operation.state === "OVERDUE" : operation.status === "OPEN");

export type ReportRow = {
  principalLentCents: number; principalReceivedCents: number; interestReceivedCents: number; receivedCents: number; paymentCount: number;
  interestRemainingCents: number; balanceCents: number; operationCount: number;
};
const emptyRow = (): ReportRow => ({ principalLentCents: 0, principalReceivedCents: 0, interestReceivedCents: 0, receivedCents: 0, paymentCount: 0, interestRemainingCents: 0, balanceCents: 0, operationCount: 0 });

// Números de uma operação no período. inPeriod = a operação foi feita no período ou recebeu pagamento nele.
export function operationInPeriod(operation: OperationView, range: { from: string | null; to: string | null }) {
  const inside = (date: string) => (range.from === null || date >= range.from) && (range.to === null || date <= range.to);
  const payments = operation.payments.filter((payment) => inside(payment.paidAt));
  const lent = inside(operation.loanDate);
  return {
    inPeriod: lent || payments.length > 0,
    row: {
      principalLentCents: lent ? operation.principalCents : 0,
      principalReceivedCents: payments.reduce((total, payment) => total + payment.principalCents, 0),
      interestReceivedCents: payments.reduce((total, payment) => total + payment.interestCents, 0),
      receivedCents: payments.reduce((total, payment) => total + payment.amountCents, 0),
      paymentCount: payments.length,
      interestRemainingCents: operation.interestRemainingCents,
      balanceCents: operation.balanceCents,
      operationCount: 1,
    } satisfies ReportRow,
  };
}

const add = (total: ReportRow, row: ReportRow): ReportRow => Object.fromEntries(Object.keys(total).map((key) => [key, total[key as keyof ReportRow] + row[key as keyof ReportRow]])) as ReportRow;

// Relatório por cliente: só operações da situação escolhida que tocam o período (sem período, todas as do ciclo).
// Operações excluídas nunca entram.
export function profitabilityReport(operations: OperationView[], filters: ReportFilters, today: string) {
  const range = periodRange(filters, today);
  const byClient = new Map<string, { clientId: string; clientName: string; totals: ReportRow; operations: { operation: OperationView; row: ReportRow }[] }>();
  let totals = emptyRow();
  for (const operation of operations) {
    if (operation.status === "CANCELED" || !matchesStatus(operation, filters.status)) continue;
    const { inPeriod, row } = operationInPeriod(operation, range);
    if (!inPeriod) continue;
    const entry = byClient.get(operation.clientId) ?? { clientId: operation.clientId, clientName: operation.clientName, totals: emptyRow(), operations: [] };
    entry.totals = add(entry.totals, row);
    entry.operations.push({ operation, row });
    byClient.set(operation.clientId, entry);
    totals = add(totals, row);
  }
  const clients = [...byClient.values()].sort((a, b) => b.totals.interestReceivedCents - a.totals.interestReceivedCents || a.clientName.localeCompare(b.clientName, "pt-BR"));
  return { range, clients, totals };
}
