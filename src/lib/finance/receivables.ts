import { addDays } from "./format";
import type { OperationView } from "./portfolio";

// Contas a receber da carteira (Dashboard): quanto está em atraso, quanto vence hoje, quanto vence nos próximos 7 dias,
// quanto já entrou hoje e o total em aberto. Só lê as operações já calculadas (mesmo extrato da tela Cobranças); não grava
// nada e não cria valores. Parcelado e diário: cada parcela em aberto entra pela própria data (várias parcelas atrasadas
// somam). Pagamento único e juros recorrentes: o saldo da operação, na data do vencimento atual, igual à tela Cobranças.
export type ReceivableRow = { operationId: string; clientName: string; code: string; dueDate: string; amountCents: number; detail: string };
export type ReceivablesOverview = {
  today: string; upcomingUntil: string;
  overdueCents: number; overdueCount: number;
  dueTodayCents: number; dueTodayCount: number;
  upcomingCents: number; upcomingCount: number;
  receivedTodayCents: number; receivedTodayCount: number;
  totalCents: number; openCount: number;
  overdueList: ReceivableRow[]; todayList: ReceivableRow[];
};

export const RECEIVABLES_LIST_SIZE = 5;

// Valores em aberto de uma operação, cada um com a sua data de vencimento.
function openAmounts(operation: OperationView): { dueDate: string; amountCents: number; label: string }[] {
  if (operation.status !== "OPEN") return [];
  if (operation.installments.length > 0) {
    return operation.installments
      .filter((item) => item.remainingCents > 0 && (item.state === "OPEN" || item.state === "PARTIAL"))
      .map((item) => ({ dueDate: item.dueDate, amountCents: item.remainingCents, label: `Parcela ${item.number}/${operation.installmentTotal}` }));
  }
  if (!operation.nextOpenDueDate || operation.balanceCents <= 0) return [];
  return [{ dueDate: operation.nextOpenDueDate, amountCents: operation.balanceCents, label: operation.periodNumber > 1 ? `${operation.periodNumber}º período` : "Pagamento" }];
}

export function receivablesOverview(operations: OperationView[], today: string, receivableCents: number): ReceivablesOverview {
  const upcomingUntil = addDays(today, 7);
  const overdue: ReceivableRow[] = [], dueToday: ReceivableRow[] = [];
  let upcomingCents = 0, upcomingCount = 0, receivedTodayCents = 0, receivedTodayCount = 0;
  const overdueOps = new Set<string>(), todayOps = new Set<string>(), upcomingOps = new Set<string>();
  for (const operation of operations) {
    for (const payment of operation.payments) {
      if (payment.paidAt === today) { receivedTodayCents += payment.amountCents; receivedTodayCount += 1; }
    }
    // Uma linha por operação e situação: soma o que está em atraso (ou vence hoje) naquela operação.
    const late = { cents: 0, first: "", labels: [] as string[] }, now = { cents: 0, first: "", labels: [] as string[] };
    for (const item of openAmounts(operation)) {
      if (item.dueDate < today) { late.cents += item.amountCents; late.first ||= item.dueDate; late.labels.push(item.label); }
      else if (item.dueDate === today) { now.cents += item.amountCents; now.first ||= item.dueDate; now.labels.push(item.label); }
      else if (item.dueDate <= upcomingUntil) { upcomingCents += item.amountCents; upcomingOps.add(operation.id); }
    }
    const row = (bucket: typeof late): ReceivableRow => ({
      operationId: operation.id, clientName: operation.clientName, code: operation.code, dueDate: bucket.first, amountCents: bucket.cents,
      detail: `Op. #${operation.code} · ${bucket.labels.length > 2 ? `${bucket.labels.length} parcelas` : bucket.labels.join(" e ")}`,
    });
    if (late.cents > 0) { overdue.push(row(late)); overdueOps.add(operation.id); }
    if (now.cents > 0) { dueToday.push(row(now)); todayOps.add(operation.id); }
  }
  upcomingCount = upcomingOps.size;
  const sum = (rows: ReceivableRow[]) => rows.reduce((total, row) => total + row.amountCents, 0);
  const byDate = (a: ReceivableRow, b: ReceivableRow) => a.dueDate.localeCompare(b.dueDate) || a.clientName.localeCompare(b.clientName, "pt-BR") || a.operationId.localeCompare(b.operationId);
  overdue.sort(byDate); dueToday.sort(byDate);
  return {
    today, upcomingUntil,
    overdueCents: sum(overdue), overdueCount: overdue.length,
    dueTodayCents: sum(dueToday), dueTodayCount: dueToday.length,
    upcomingCents, upcomingCount,
    receivedTodayCents, receivedTodayCount,
    totalCents: receivableCents, openCount: operations.filter((operation) => operation.status === "OPEN").length,
    overdueList: overdue.slice(0, RECEIVABLES_LIST_SIZE), todayList: dueToday.slice(0, RECEIVABLES_LIST_SIZE),
  };
}
