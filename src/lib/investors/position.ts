// Painel de um contrato de investimento (regras puras, sem banco). Tudo é somado dos registros: o valor do contrato,
// as linhas do cronograma digitadas pelo usuário e as baixas registradas. Nada é calculado por taxa, não há juros de
// atraso nem multa, e nenhuma obrigação vira paga porque a data passou: paga é só a que tem baixa. A data efetiva da
// baixa decide a quitação; a data de vencimento da linha decide o atraso.
import { formatDate, formatMoney } from "../finance/format";
import { lineKind, type LineKind } from "./rules";

export const LINE_STATUS = { PREVISTA: "Prevista", VENCIDA: "Vencida", PARCIAL: "Parcialmente paga", PAGA: "Paga", CANCELADA: "Cancelada", RENOVADA: "Principal renovado" } as const;
export type LineStatus = keyof typeof LINE_STATUS;

type Item = { id: string; number: number; dueDate: string; yieldCents: number; principalCents: number; description: string | null };
type Payment = { id: string; scheduleItemId: string; kind: "YIELD" | "PRINCIPAL"; amountCents: number; paidOn: string; method: string; reference: string | null; capitalMovementId: string | null };
type Investment = { amountCents: number; status: string; startDate: string; maturityDate: string | null };
// Contrato já renovado: o principal que faltava devolver passou para o contrato novo (não fica pendente aqui).
type Options = { renewed?: boolean };

export type ScheduleLine = Item & {
  kind: LineKind; totalCents: number; rolledOverCents: number; paidYieldCents: number; paidPrincipalCents: number; paidCents: number; balanceCents: number;
  status: LineStatus; lastPaidOn: string | null; payments: Payment[];
};

// Situação de uma linha: cancelada (contrato cancelado e nada pago nela), paga (saldo zero), vencida (saldo e vencimento
// antes de hoje, mesmo com pagamento parcial), parcialmente paga ou prevista.
export function lineStatus(line: { totalCents: number; paidCents: number; dueDate: string }, investmentStatus: string, today: string): LineStatus {
  if (line.paidCents >= line.totalCents) return "PAGA";
  if (investmentStatus === "CANCELED") return "CANCELADA";
  if (line.dueDate < today) return "VENCIDA";
  return line.paidCents > 0 ? "PARCIAL" : "PREVISTA";
}

export function scheduleLines(items: Item[], payments: Payment[], investmentStatus: string, today: string, { renewed = false }: Options = {}): ScheduleLine[] {
  return items.map((item) => {
    const own = payments.filter((payment) => payment.scheduleItemId === item.id).sort((a, b) => a.paidOn.localeCompare(b.paidOn));
    const paidYieldCents = own.filter((payment) => payment.kind === "YIELD").reduce((total, payment) => total + payment.amountCents, 0);
    const paidPrincipalCents = own.filter((payment) => payment.kind === "PRINCIPAL").reduce((total, payment) => total + payment.amountCents, 0);
    const totalCents = item.yieldCents + item.principalCents;
    const paidCents = paidYieldCents + paidPrincipalCents;
    // O saldo de cada parte é contado separado: um rendimento pago a mais nunca cobre principal (o banco também impede).
    const yieldBalance = Math.max(item.yieldCents - paidYieldCents, 0);
    const principalBalance = renewed ? 0 : Math.max(item.principalCents - paidPrincipalCents, 0);
    const rolledOverCents = renewed ? Math.max(item.principalCents - paidPrincipalCents, 0) : 0;
    const balanceCents = yieldBalance + principalBalance;
    const base = lineStatus({ totalCents, paidCents: totalCents - balanceCents - rolledOverCents, dueDate: item.dueDate }, investmentStatus, today);
    const status: LineStatus = rolledOverCents > 0 && balanceCents === 0 ? "RENOVADA" : base;
    return {
      ...item, kind: lineKind(item), totalCents, paidYieldCents, paidPrincipalCents, paidCents, balanceCents, rolledOverCents,
      status, lastPaidOn: own.at(-1)?.paidOn ?? null, payments: own,
    };
  });
}

// Painel do contrato. "Recebido" é a entrada registrada no capital (ou o aporte anterior indicado, em contrato antigo).
export function investmentPosition({ investment, lines, entryCents, priorContribution, today, renewedFrom = false, renewed = false }: {
  investment: Investment; lines: ScheduleLine[]; entryCents: number | null; priorContribution: boolean; today: string; renewedFrom?: boolean; renewed?: boolean;
}) {
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const canceled = investment.status === "CANCELED";
  const scheduledPrincipalCents = sum(lines.map((line) => line.principalCents));
  const returnedPrincipalCents = sum(lines.map((line) => line.paidPrincipalCents));
  const expectedYieldCents = sum(lines.map((line) => line.yieldCents));
  const paidYieldCents = sum(lines.map((line) => line.paidYieldCents));
  const open = lines.filter((line) => line.balanceCents > 0 && line.status !== "CANCELADA");
  const rolledOver = sum(lines.map((line) => line.rolledOverCents));
  return {
    principalContractedCents: investment.amountCents,
    // null = nada registrado; "prior" = entrou por um aporte anterior indicado (o valor do aporte pode ser outro).
    principalReceived: renewedFrom ? { kind: "renewal" as const, cents: investment.amountCents }
      : entryCents !== null ? { kind: "entry" as const, cents: entryCents } : priorContribution ? { kind: "prior" as const, cents: null } : null,
    principalReturnedCents: returnedPrincipalCents,
    // Contrato renovado: o que faltava devolver passou para a renovação (não é mais devido aqui).
    principalRolledOverCents: renewed ? Math.max(investment.amountCents - returnedPrincipalCents, 0) : 0,
    principalRemainingCents: renewed ? 0 : Math.max(investment.amountCents - returnedPrincipalCents, 0),
    principalScheduledCents: scheduledPrincipalCents,
    // Principal sem data de devolução no cronograma (não agendado).
    principalUnscheduledCents: renewed ? 0 : Math.max(investment.amountCents - scheduledPrincipalCents, 0),
    yieldExpectedCents: expectedYieldCents,
    yieldPaidCents: paidYieldCents,
    yieldPendingCents: canceled ? 0 : sum(lines.filter((line) => line.status !== "CANCELADA").map((line) => Math.max(line.yieldCents - line.paidYieldCents, 0))),
    obligationsTotalCents: expectedYieldCents + scheduledPrincipalCents - rolledOver,
    paidTotalCents: paidYieldCents + returnedPrincipalCents,
    nextDueDate: open.map((line) => line.dueDate).sort()[0] ?? null,
    pendingCount: open.length,
    overdueCount: open.filter((line) => line.dueDate < today).length,
  };
}
export type InvestmentPosition = ReturnType<typeof investmentPosition>;

// Divergências nos dados gravados (principalmente de contratos antigos). Só são apontadas: nada é corrigido sozinho.
export function investmentDivergences({ investment, lines, entryCents, renewed = false }: { investment: Investment; lines: ScheduleLine[]; entryCents: number | null; renewed?: boolean }) {
  const problems: string[] = [];
  const scheduledPrincipal = lines.reduce((total, line) => total + line.principalCents, 0);
  if (scheduledPrincipal > investment.amountCents) {
    problems.push(`A devolução de principal no cronograma soma ${formatMoney(scheduledPrincipal)}, mais que o valor do contrato (${formatMoney(investment.amountCents)}).`);
  }
  if (entryCents !== null && entryCents !== investment.amountCents) {
    problems.push(`A entrada registrada no capital (${formatMoney(entryCents)}) é diferente do valor do contrato (${formatMoney(investment.amountCents)}).`);
  }
  const beforeStart = lines.filter((line) => line.dueDate < investment.startDate);
  if (beforeStart.length) problems.push(`${beforeStart.length === 1 ? "1 linha do cronograma tem data" : `${beforeStart.length} linhas do cronograma têm data`} anterior ao início do contrato (${formatDate(investment.startDate)}).`);
  if (investment.maturityDate) {
    const afterMaturity = lines.filter((line) => line.dueDate > (investment.maturityDate as string));
    if (afterMaturity.length) problems.push(`${afterMaturity.length === 1 ? "1 linha do cronograma vence" : `${afterMaturity.length} linhas do cronograma vencem`} depois do vencimento do contrato (${formatDate(investment.maturityDate)}).`);
  }
  if (investment.status === "CLOSED" && lines.some((line) => line.balanceCents > 0)) problems.push(renewed ? "O contrato foi renovado, mas ainda tem rendimento sem baixa (pode ser pago normalmente)." : "O contrato está encerrado, mas o cronograma ainda tem valores sem baixa.");
  return problems;
}
