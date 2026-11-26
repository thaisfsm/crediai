// Relatório de cada fechamento de comissão do gerente (PDF): quais contratos entraram no fechamento e quanto de comissão cada um.
// A regra de cálculo NÃO muda: comissão de um contrato = juros efetivamente recebidos × % de comissão (commissionOf). Aqui só se reparte
// o valor que foi fechado entre os contratos que tinham comissão a pagar, em centavos exatos: a soma das linhas é SEMPRE o valor
// gravado no fechamento. Fechamentos feitos a partir desta versão guardam as linhas (account_manager_payout_item, imutável); os
// anteriores são reconstituídos com os recebimentos registrados até a data deles, sempre fechando no valor gravado.
import { commissionOf } from "./commission";

// Um contrato com a base da comissão até a data do fechamento.
export type ContractEarning = {
  operationId: string; clientId: string; clientName: string; operationCode: string; loanDate: string;
  principalCents: number; interestRateBps: number; commissionBps: number; interestReceivedCents: number;
};
// Uma linha do fechamento: o contrato e a comissão dele NESTE fechamento. Sem contrato (operationId nulo) só se nada explicar a diferença.
export type ClosingLine = Omit<ContractEarning, "operationId" | "clientId" | "operationCode" | "loanDate"> & {
  operationId: string | null; clientId: string | null; operationCode: string | null; loanDate: string | null; commissionCents: number;
};

export const UNASSIGNED_LABEL = "Comissão sem contrato identificado";

// Percentual efetivo de repasse = taxa de juros × % de comissão (30% × 45% = 13,5%), em pontos-base com casas decimais.
export const effectiveRateBps = (interestRateBps: number, commissionBps: number) => (interestRateBps * commissionBps) / 10000;

// Reparte `amountCents` proporcionalmente aos pesos, em centavos exatos (maiores restos), com BigInt para não perder precisão.
function proportional(amountCents: number, weights: number[]) {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0 || amountCents <= 0) return weights.map(() => 0);
  const big = weights.map((weight) => (BigInt(amountCents) * BigInt(weight)));
  const shares = big.map((value) => Number(value / BigInt(total)));
  const remainders = big.map((value, index) => ({ index, rest: Number(value % BigInt(total)) }));
  let missing = amountCents - shares.reduce((sum, share) => sum + share, 0);
  for (const { index } of remainders.sort((a, b) => b.rest - a.rest || a.index - b.index)) {
    if (missing <= 0) break;
    shares[index] += 1; missing -= 1;
  }
  return shares;
}

// Reparte o valor fechado entre os contratos com comissão ainda não paga (gerada − já atribuída a fechamentos anteriores).
// `priorityClientIds` (os clientes marcados na conferência) recebem primeiro; o que passar deles vai para os demais.
// Se o valor passar de tudo o que havia a pagar só por arredondamento (centavos), a sobra vai para os maiores contratos; se for mais
// que isso, fica numa linha "sem contrato identificado" (o total nunca deixa de bater com o valor gravado).
export function allocateClosing(amountCents: number, contracts: ContractEarning[], alreadyPaid: Map<string, number>, priorityClientIds?: Set<string> | null): ClosingLine[] {
  const rows = contracts.map((contract) => ({
    contract, available: Math.max(0, commissionOf(contract.interestReceivedCents, contract.commissionBps) - (alreadyPaid.get(contract.operationId) ?? 0)),
  }));
  const shares = new Map<string, number>();
  let remaining = amountCents;
  const groups = priorityClientIds && priorityClientIds.size > 0
    ? [rows.filter((row) => priorityClientIds.has(row.contract.clientId)), rows.filter((row) => !priorityClientIds.has(row.contract.clientId))]
    : [rows];
  for (const group of groups) {
    if (remaining <= 0) break;
    const available = group.reduce((sum, row) => sum + row.available, 0);
    if (available <= 0) continue;
    const parts = remaining >= available ? group.map((row) => row.available) : proportional(remaining, group.map((row) => row.available));
    group.forEach((row, index) => { if (parts[index] > 0) shares.set(row.contract.operationId, (shares.get(row.contract.operationId) ?? 0) + parts[index]); });
    remaining -= parts.reduce((sum, part) => sum + part, 0);
  }
  // Sobra de arredondamento: a conta do saldo arredonda por cliente e aqui é por contrato (no máximo 1 centavo por contrato).
  const earners = rows.filter((row) => commissionOf(row.contract.interestReceivedCents, row.contract.commissionBps) > 0)
    .sort((a, b) => b.available - a.available || a.contract.operationId.localeCompare(b.contract.operationId));
  if (remaining > 0 && remaining <= earners.length) {
    for (const row of earners.slice(0, remaining)) shares.set(row.contract.operationId, (shares.get(row.contract.operationId) ?? 0) + 1);
    remaining = 0;
  }
  const lines: ClosingLine[] = rows.filter((row) => (shares.get(row.contract.operationId) ?? 0) > 0)
    .map((row) => ({ ...row.contract, commissionCents: shares.get(row.contract.operationId) ?? 0 }))
    .sort(compareLines);
  if (remaining > 0) {
    lines.push({ operationId: null, clientId: null, clientName: UNASSIGNED_LABEL, operationCode: null, loanDate: null, principalCents: 0, interestRateBps: 0, commissionBps: 0, interestReceivedCents: 0, commissionCents: remaining });
  }
  return lines;
}

export const compareLines = (a: Pick<ClosingLine, "clientName" | "loanDate" | "operationCode" | "operationId">, b: Pick<ClosingLine, "clientName" | "loanDate" | "operationCode" | "operationId">) =>
  (a.operationId === null ? 1 : 0) - (b.operationId === null ? 1 : 0)
  || a.clientName.localeCompare(b.clientName, "pt-BR")
  || (a.loanDate ?? "").localeCompare(b.loanDate ?? "")
  || (a.operationCode ?? "").localeCompare(b.operationCode ?? "", "pt-BR", { numeric: true })
  || (a.operationId ?? "").localeCompare(b.operationId ?? "");

// Soma o que cada contrato recebeu num fechamento (para o próximo fechamento não atribuir de novo a mesma comissão).
export function addPaid(paid: Map<string, number>, lines: Pick<ClosingLine, "operationId" | "commissionCents">[]) {
  for (const line of lines) if (line.operationId) paid.set(line.operationId, (paid.get(line.operationId) ?? 0) + line.commissionCents);
  return paid;
}

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
export type ClosingReportInput = {
  tenantName: string; managerName: string;
  payout: { id: string; paidOn: string; createdAt: string; amountCents: number; debitCents: number; creditCents: number; notes: string | null };
  period: NonNullable<ReturnType<typeof referencePeriod>>;
  lines: ClosingLine[]; adjustments: ClosingAdjustment[]; source: "SNAPSHOT" | "RECONSTRUCTED"; generatedAt: Date;
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
  return {
    ...input, groups,
    totals: {
      commissionCents: input.payout.amountCents, debitCents, creditCents, finalCents: input.payout.amountCents - debitCents + creditCents,
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
