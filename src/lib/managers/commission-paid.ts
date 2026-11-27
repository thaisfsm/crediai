// Controle CPG (Comissão Paga) por RECEBIMENTO de juros. Cada pagamento de cliente que trouxe juros gera a comissão dele
// (juros daquele recebimento × % do contrato). Um fechamento de comissão registra exatamente quais recebimentos pagou e quanto de
// cada um (linha PAID); um estorno devolve parte ou tudo de uma linha (REVERSAL). Assim:
//  - o mesmo recebimento nunca é pago duas vezes (pago líquido ≤ comissão do recebimento; o banco confere de novo);
//  - recebimentos novos do mesmo contrato geram comissão nova normalmente (o contrato nunca fica "travado");
//  - o pagamento pode ser parcial (sobra pendente só a diferença daquele recebimento).
// Módulo puro: sem banco, usado pela tela, pelo fechamento e pelos testes.
import { commissionOf } from "./commission";

export type ReceiptContract = {
  operationId: string; clientId: string; clientName: string; operationCode: string; loanDate: string; principalCents: number; interestRateBps: number;
  commissionBps: number; interestPaidCents: number;
};
export type ReceiptPayment = { id: string; paidAt: string; createdAt: string; interestCents: number };
// Um recebimento de juros com a comissão que ele gerou.
export type Receipt = Omit<ReceiptContract, "interestPaidCents"> & { paymentId: string; paidOn: string; createdAt: string; interestCents: number; commissionDueCents: number };

const byReceipt = (a: { paidOn: string; createdAt: string; paymentId: string }, b: { paidOn: string; createdAt: string; paymentId: string }) =>
  a.paidOn.localeCompare(b.paidOn) || a.createdAt.localeCompare(b.createdAt) || a.paymentId.localeCompare(b.paymentId);

// Recebimentos de juros de um contrato. A comissão de cada um é calculada pelo acumulado do contrato (arredondado), para que a soma dos
// recebimentos seja sempre a comissão do contrato inteiro: R$ 75,00 + R$ 36,75 a 50% = R$ 37,50 + R$ 18,38 = R$ 55,88 (e não 37,50 + 18,38
// arredondados em separado, que poderiam dar 1 centavo a mais ou a menos). Se a divisão por pagamento não fechar com o total de juros do
// extrato (não deveria), a diferença fica no recebimento mais recente: o total é sempre o da tela.
export function contractReceipts(contract: ReceiptContract, payments: ReceiptPayment[]): Receipt[] {
  const ordered = payments.filter((payment) => payment.interestCents > 0)
    .map((payment) => ({ paymentId: payment.id, paidOn: payment.paidAt, createdAt: payment.createdAt, interestCents: payment.interestCents }))
    .sort(byReceipt);
  const listed = ordered.reduce((total, item) => total + item.interestCents, 0);
  if (ordered.length > 0 && listed !== contract.interestPaidCents) ordered[ordered.length - 1].interestCents += contract.interestPaidCents - listed;
  const { interestPaidCents: _total, ...base } = contract;
  void _total;
  let cumulative = 0;
  return ordered.filter((item) => item.interestCents > 0).map((item) => {
    const before = commissionOf(cumulative, contract.commissionBps);
    cumulative += item.interestCents;
    return { ...base, ...item, commissionDueCents: commissionOf(cumulative, contract.commissionBps) - before };
  });
}

// Linha do controle CPG (gravada em account_manager_commission_paid).
export type CommissionPaidRow = {
  id: string; payoutId: string; kind: "PAID" | "REVERSAL"; reversesId: string | null; paymentId: string; operationId: string;
  clientId: string | null; clientName: string; operationCode: string | null; loanDate: string | null; principalCents: number; interestRateBps: number;
  commissionBps: number; receiptPaidOn: string; interestCents: number; commissionDueCents: number; commissionCents: number;
  source: "CLOSING" | "HISTORICAL"; reason: string | null; createdAt: string;
};

// Quanto de cada recebimento já foi pago (pagamentos − estornos).
export function netPaidByPayment(rows: Pick<CommissionPaidRow, "kind" | "paymentId" | "commissionCents">[]) {
  const net = new Map<string, number>();
  for (const row of rows) net.set(row.paymentId, (net.get(row.paymentId) ?? 0) + (row.kind === "PAID" ? row.commissionCents : -row.commissionCents));
  return net;
}
// Quanto de cada linha paga ainda pode ser estornado.
export function reversibleByRow(rows: Pick<CommissionPaidRow, "id" | "kind" | "reversesId" | "commissionCents">[]) {
  const left = new Map<string, number>();
  for (const row of rows) if (row.kind === "PAID") left.set(row.id, (left.get(row.id) ?? 0) + row.commissionCents);
  for (const row of rows) if (row.kind === "REVERSAL" && row.reversesId) left.set(row.reversesId, (left.get(row.reversesId) ?? 0) - row.commissionCents);
  return left;
}

export type ReceiptStatus = "PAID" | "PARTIAL" | "PENDING";
export type ReceiptWithStatus = Receipt & { paidCents: number; pendingCents: number; status: ReceiptStatus; payoutIds: string[] };
// Situação de cada recebimento: pago (CPG), parcial ou pendente. Pago a mais que o gerado (o pagamento do cliente foi corrigido depois)
// não vira pendente negativo: fica pago, com pendente zero.
export function receiptsWithStatus(receipts: Receipt[], rows: CommissionPaidRow[]): ReceiptWithStatus[] {
  const net = netPaidByPayment(rows);
  return receipts.map((receipt) => {
    const paidCents = Math.max(0, net.get(receipt.paymentId) ?? 0);
    const pendingCents = Math.max(0, receipt.commissionDueCents - paidCents);
    const payoutIds = [...new Set(rows.filter((row) => row.kind === "PAID" && row.paymentId === receipt.paymentId).map((row) => row.payoutId))];
    return { ...receipt, paidCents, pendingCents, status: pendingCents === 0 ? "PAID" : paidCents > 0 ? "PARTIAL" : "PENDING", payoutIds };
  });
}

// Contratos com o total de cada um (para a lista de pagos e pendentes).
export type ContractCommission = Omit<Receipt, "paymentId" | "paidOn" | "createdAt" | "interestCents" | "commissionDueCents"> & {
  interestCents: number; commissionDueCents: number; paidCents: number; pendingCents: number; status: ReceiptStatus; receipts: ReceiptWithStatus[];
};
export function contractsWithStatus(receipts: ReceiptWithStatus[]): ContractCommission[] {
  const byOperation = new Map<string, ReceiptWithStatus[]>();
  for (const receipt of receipts) byOperation.set(receipt.operationId, [...(byOperation.get(receipt.operationId) ?? []), receipt]);
  return [...byOperation.values()].map((own) => {
    const { paymentId: _p, paidOn: _d, createdAt: _c, interestCents: _i, commissionDueCents: _due, paidCents: _paid, pendingCents: _pending, status: _s, payoutIds: _ids, ...base } = own[0];
    void _p; void _d; void _c; void _i; void _due; void _paid; void _pending; void _s; void _ids;
    const sum = (pick: (receipt: ReceiptWithStatus) => number) => own.reduce((total, receipt) => total + pick(receipt), 0);
    const paidCents = sum((receipt) => receipt.paidCents), pendingCents = sum((receipt) => receipt.pendingCents);
    return { ...base, interestCents: sum((receipt) => receipt.interestCents), commissionDueCents: sum((receipt) => receipt.commissionDueCents), paidCents, pendingCents,
      status: pendingCents === 0 ? "PAID" : paidCents > 0 ? "PARTIAL" : "PENDING", receipts: own } as ContractCommission;
  }).sort((a, b) => a.clientName.localeCompare(b.clientName, "pt-BR") || a.loanDate.localeCompare(b.loanDate) || a.operationId.localeCompare(b.operationId));
}

// Fechamento novo: paga os recebimentos pendentes dos contratos escolhidos (todos, se nenhum foi escolhido), do mais antigo para o mais
// recente. Valor menor que o pendente = pagamento parcial: o último recebimento alcançado fica com a diferença pendente. Nunca paga
// mais que o pendente de cada recebimento.
export type PaymentAllocation = ReceiptWithStatus & { payCents: number };
export function allocatePayout(amountCents: number, receipts: ReceiptWithStatus[], operationIds: Set<string> | null):
  { ok: true; lines: PaymentAllocation[] } | { ok: false; availableCents: number } {
  const candidates = receipts.filter((receipt) => receipt.pendingCents > 0 && (!operationIds || operationIds.has(receipt.operationId))).sort(byReceipt);
  const availableCents = candidates.reduce((total, receipt) => total + receipt.pendingCents, 0);
  if (amountCents <= 0 || amountCents > availableCents) return { ok: false, availableCents };
  const lines: PaymentAllocation[] = [];
  let left = amountCents;
  for (const receipt of candidates) {
    if (left <= 0) break;
    const payCents = Math.min(left, receipt.pendingCents);
    lines.push({ ...receipt, payCents });
    left -= payCents;
  }
  return { ok: true, lines };
}
