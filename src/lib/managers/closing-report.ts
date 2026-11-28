// Relatório de cada fechamento de comissão do gerente (PDF): quais contratos entraram no fechamento e quanto de comissão cada um.
// Regra: comissão = juros efetivamente recebidos × % de comissão do contrato. As linhas vêm do que foi GRAVADO: o controle CPG (os
// recebimentos pagos no fechamento) ou o detalhamento por contrato (account_manager_payout_item). Nada é repartido nem estimado: um
// fechamento sem composição registrada aparece com uma linha só ("Composição não registrada") e o valor gravado.
import type { CommissionPaidRow } from "./commission-paid";

// Um contrato com a base da comissão até a data do fechamento.
export type ContractEarning = {
  operationId: string; clientId: string; clientName: string; operationCode: string; loanDate: string;
  principalCents: number; interestRateBps: number; commissionBps: number; interestReceivedCents: number;
};
// Uma linha do fechamento: o contrato e a comissão dele NESTE fechamento. Sem contrato (operationId nulo) só se nada explicar a diferença.
export type ClosingLine = Omit<ContractEarning, "operationId" | "clientId" | "operationCode" | "loanDate"> & {
  operationId: string | null; clientId: string | null; operationCode: string | null; loanDate: string | null; commissionCents: number;
};

export const UNASSIGNED_LABEL = "Composição não registrada (fechamento anterior ao controle por contrato)";

// Percentual efetivo de repasse = taxa de juros × % de comissão (30% × 45% = 13,5%), em pontos-base com casas decimais.
export const effectiveRateBps = (interestRateBps: number, commissionBps: number) => (interestRateBps * commissionBps) / 10000;

// Linhas de um fechamento a partir do controle CPG: os recebimentos pagos nele (linhas PAID), somados por contrato. Juros recebidos =
// juros dos recebimentos pagos neste fechamento; comissão = o que foi pago deles. Nada é repartido nem estimado.
export function linesFromCommissionPaid(rows: CommissionPaidRow[], payoutId: string): ClosingLine[] {
  const byOperation = new Map<string, ClosingLine>();
  for (const row of rows.filter((item) => item.payoutId === payoutId && item.kind === "PAID")) {
    const line = byOperation.get(row.operationId) ?? {
      operationId: row.operationId, clientId: row.clientId, clientName: row.clientName, operationCode: row.operationCode, loanDate: row.loanDate,
      principalCents: row.principalCents, interestRateBps: row.interestRateBps, commissionBps: row.commissionBps, interestReceivedCents: 0, commissionCents: 0,
    };
    line.interestReceivedCents += row.interestCents; line.commissionCents += row.commissionCents;
    byOperation.set(row.operationId, line);
  }
  return [...byOperation.values()].sort(compareLines);
}

// Fechamento sem composição registrada (nem detalhamento nem CPG): uma linha só com o valor gravado, sem atribuir a contratos.
export function unregisteredLine(amountCents: number): ClosingLine {
  return { operationId: null, clientId: null, clientName: UNASSIGNED_LABEL, operationCode: null, loanDate: null, principalCents: 0, interestRateBps: 0, commissionBps: 0, interestReceivedCents: 0, commissionCents: amountCents };
}

export const compareLines = (a: Pick<ClosingLine, "clientName" | "loanDate" | "operationCode" | "operationId">, b: Pick<ClosingLine, "clientName" | "loanDate" | "operationCode" | "operationId">) =>
  (a.operationId === null ? 1 : 0) - (b.operationId === null ? 1 : 0)
  || a.clientName.localeCompare(b.clientName, "pt-BR")
  || (a.loanDate ?? "").localeCompare(b.loanDate ?? "")
  || (a.operationCode ?? "").localeCompare(b.operationCode ?? "", "pt-BR", { numeric: true })
  || (a.operationId ?? "").localeCompare(b.operationId ?? "");

// Fechamentos de um gerente em ordem (data do fechamento, depois a hora em que foi registrado): o período de referência de cada um vai
// do dia seguinte ao fechamento anterior até a data dele; o primeiro cobre tudo desde o início.
export type PayoutKey = { id: string; paidOn: string; createdAt: string };
export const sortPayouts = <T extends PayoutKey>(payouts: T[]) => [...payouts].sort((a, b) => a.paidOn.localeCompare(b.paidOn) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
export function referencePeriod(payouts: PayoutKey[], payoutId: string) {
  const ordered = sortPayouts(payouts);
  const index = ordered.findIndex((payout) => payout.id === payoutId);
  if (index < 0) return null;
  const previous = index > 0 ? ordered[index - 1] : null;
  const start = previous ? nextDay(previous.paidOn) : null;
  // Dois fechamentos no mesmo dia: o período do segundo é o próprio dia.
  return { sequence: index + 1, total: ordered.length, start: start && start > ordered[index].paidOn ? ordered[index].paidOn : start, end: ordered[index].paidOn, previousPaidOn: previous?.paidOn ?? null };
}
const nextDay = (iso: string) => { const date = new Date(`${iso}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 1); return date.toISOString().slice(0, 10); };

// Documento do relatório (o que o PDF desenha). Confere que a soma das linhas é o valor fechado e que o valor final é o gravado.
export type ClosingAdjustment = { kind: "DEBIT" | "CREDIT"; description: string; amountCents: number; entryDate: string };
// Estorno de comissão ligado ao fechamento (parte ou tudo de um recebimento pago nele voltou a ficar pendente).
export type ClosingReversal = { clientName: string; operationCode: string | null; receiptPaidOn: string; amountCents: number; reason: string; createdAt: string };
export type ClosingSource = "SNAPSHOT" | "CPG" | "UNREGISTERED";
export type ClosingReportInput = {
  tenantName: string; managerName: string;
  payout: { id: string; paidOn: string; createdAt: string; amountCents: number; debitCents: number; creditCents: number; notes: string | null };
  period: NonNullable<ReturnType<typeof referencePeriod>>;
  lines: ClosingLine[]; adjustments: ClosingAdjustment[]; source: ClosingSource; generatedAt: Date;
  reversals?: ClosingReversal[];
  // Composição registrada depois do fechamento (reconstrução histórica confirmada): quando, por quem e por quê.
  historical?: { recordedAt: string; reason: string } | null;
};
export type ClientGroup = { clientName: string; lines: ClosingLine[]; commissionCents: number };
export function buildClosingReport(input: ClosingReportInput) {
  const linesCents = input.lines.reduce((sum, line) => sum + line.commissionCents, 0);
  if (linesCents !== input.payout.amountCents) throw new Error(`Relatório do fechamento ${input.payout.id}: linhas somam ${linesCents} e o fechamento ${input.payout.amountCents}.`);
  const debitCents = input.adjustments.filter((item) => item.kind === "DEBIT").reduce((sum, item) => sum + item.amountCents, 0);
  const creditCents = input.adjustments.filter((item) => item.kind === "CREDIT").reduce((sum, item) => sum + item.amountCents, 0);
  if (debitCents !== input.payout.debitCents || creditCents !== input.payout.creditCents) throw new Error(`Relatório do fechamento ${input.payout.id}: lançamentos não batem com os totais gravados.`);
  const groups: ClientGroup[] = [];
  for (const line of [...input.lines].sort(compareLines)) {
    const key = line.operationId === null ? UNASSIGNED_LABEL : `${line.clientId}`;
    let group = groups.find((item) => (item.lines[0].operationId === null ? UNASSIGNED_LABEL : `${item.lines[0].clientId}`) === key);
    if (!group) { group = { clientName: line.clientName, lines: [], commissionCents: 0 }; groups.push(group); }
    group.lines.push(line); group.commissionCents += line.commissionCents;
  }
  const reversedCents = (input.reversals ?? []).reduce((sum, item) => sum + item.amountCents, 0);
  return {
    ...input, reversals: input.reversals ?? [], historical: input.historical ?? null, groups,
    totals: {
      commissionCents: input.payout.amountCents, reversedCents, debitCents, creditCents, finalCents: input.payout.amountCents - debitCents + creditCents,
      clients: groups.filter((group) => group.lines[0].operationId !== null).length, contracts: input.lines.filter((line) => line.operationId !== null).length,
    },
  };
}
export type ClosingReport = ReturnType<typeof buildClosingReport>;

const pad = (value: number) => String(value).padStart(2, "0");
// Nome do arquivo: fechamento-comissao-<gerente>-<data>.pdf (sem acentos nem espaços).
export function closingFileName(managerName: string, paidOn: string, sequence: number) {
  const slug = managerName.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "gerente";
  return `fechamento-comissao-${slug}-${paidOn}-${pad(sequence)}.pdf`;
}
