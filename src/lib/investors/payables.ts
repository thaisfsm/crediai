// Contas a Pagar (Etapa C): regras puras (sem banco) das obrigações com investidores, das baixas e da entrada do
// dinheiro de um contrato no capital.
//
// As obrigações vêm só do cronograma do contrato (investment_schedule_item): cada linha gera até duas obrigações,
// rendimento e devolução de principal, com os valores DIGITADOS pelo usuário. Nada aqui calcula rendimento. Uma
// obrigação prevista não mexe no capital; só a baixa confirmada grava UMA saída em capital_movement.
import { formatDate, formatMoney, isIsoDate, parseMoneyToCents } from "../finance/format";

export const OBLIGATION_KINDS = { YIELD: "Rendimento", PRINCIPAL: "Devolução de principal" } as const;
export type ObligationKind = keyof typeof OBLIGATION_KINDS;
export const isObligationKind = (value: string): value is ObligationKind => Object.hasOwn(OBLIGATION_KINDS, value);

export const OBLIGATION_STATUS = { PREVISTA: "Prevista", PARCIAL: "Parcialmente paga", PAGA: "Paga", VENCIDA: "Vencida" } as const;
export type ObligationStatus = keyof typeof OBLIGATION_STATUS;
export const isObligationStatus = (value: string): value is ObligationStatus => Object.hasOwn(OBLIGATION_STATUS, value);

export const PAYMENT_METHODS = { PIX: "Pix", TRANSFER: "Transferência (TED/DOC)", CASH: "Dinheiro", OTHER: "Outro" } as const;
export type PaymentMethod = keyof typeof PAYMENT_METHODS;
export const isPaymentMethod = (value: string): value is PaymentMethod => Object.hasOwn(PAYMENT_METHODS, value);

// Categorias que estes lançamentos recebem em capital_movement (origem INVESTOR). Rendimento e principal ficam separados.
export const INVESTOR_CATEGORIES = {
  INVESTOR_CONTRIBUTION: "Entrada de investidor",
  INVESTOR_YIELD_PAYMENT: "Rendimento pago a investidor",
  INVESTOR_PRINCIPAL_RETURN: "Devolução de principal a investidor",
} as const;
export type InvestorCategory = keyof typeof INVESTOR_CATEGORIES;
export const isInvestorCategory = (value: string): value is InvestorCategory => Object.hasOwn(INVESTOR_CATEGORIES, value);
export const paymentCategory = (kind: ObligationKind): InvestorCategory => (kind === "YIELD" ? "INVESTOR_YIELD_PAYMENT" : "INVESTOR_PRINCIPAL_RETURN");

export const REFERENCE_MAX = 120;
export const PAYMENT_NOTES_MAX = 500;
const REQUEST_ID = /^[A-Za-z0-9-]{16,64}$/;

export type PayableInvestment = {
  id: string; investorId: string; investorName: string; contractNumber: string | null; status: string; startDate: string; amountCents: number;
};
export type PayableItem = { id: string; investmentId: string; number: number; dueDate: string; yieldCents: number; principalCents: number; description: string | null };
export type PayablePayment = {
  id: string; scheduleItemId: string; kind: ObligationKind; amountCents: number; paidOn: string; method: PaymentMethod; reference: string | null;
  notes: string | null; createdAt: string; createdBy: string | null; capitalMovementId: string;
};
export type Obligation = {
  key: string; scheduleItemId: string; investmentId: string; investorId: string; investorName: string; contractNumber: string | null; contractLabel: string;
  investmentStatus: string; startDate: string; number: number; dueDate: string; description: string | null; kind: ObligationKind;
  expectedCents: number; paidCents: number; balanceCents: number; status: ObligationStatus; payments: PayablePayment[];
};

export const contractLabel = (investment: Pick<PayableInvestment, "contractNumber" | "amountCents" | "startDate">) =>
  investment.contractNumber ? `Contrato ${investment.contractNumber}` : `Investimento de ${formatMoney(investment.amountCents)} (início ${formatDate(investment.startDate)})`;

// Situação de uma obrigação. Saldo zero é paga; com saldo e vencimento antes de hoje é vencida (mesmo com pagamento
// parcial, continua em atraso); com algum pagamento é parcialmente paga; senão, prevista.
export function obligationStatus({ expectedCents, paidCents, dueDate }: { expectedCents: number; paidCents: number; dueDate: string }, today: string): ObligationStatus {
  if (paidCents >= expectedCents) return "PAGA";
  if (dueDate < today) return "VENCIDA";
  return paidCents > 0 ? "PARCIAL" : "PREVISTA";
}

// Monta as obrigações a partir do cronograma e das baixas. Contrato cancelado não gera obrigação em aberto (só mostra
// o que já foi pago nele). Uma obrigação por linha do cronograma e tipo: nunca duas para a mesma parcela e tipo.
export function buildObligations({ investments, items, payments, today }: { investments: PayableInvestment[]; items: PayableItem[]; payments: PayablePayment[]; today: string }): Obligation[] {
  const byId = new Map(investments.map((investment) => [investment.id, investment]));
  const paymentsOf = new Map<string, PayablePayment[]>();
  for (const payment of payments) {
    const key = `${payment.scheduleItemId}:${payment.kind}`;
    paymentsOf.set(key, [...(paymentsOf.get(key) ?? []), payment]);
  }
  const result: Obligation[] = [];
  for (const item of items) {
    const investment = byId.get(item.investmentId);
    if (!investment) continue;
    for (const kind of ["YIELD", "PRINCIPAL"] as const) {
      const expectedCents = kind === "YIELD" ? item.yieldCents : item.principalCents;
      if (expectedCents <= 0) continue;
      const key = `${item.id}:${kind}`;
      const list = [...(paymentsOf.get(key) ?? [])].sort((a, b) => a.paidOn.localeCompare(b.paidOn) || a.createdAt.localeCompare(b.createdAt));
      const paidCents = list.reduce((total, payment) => total + payment.amountCents, 0);
      if (investment.status === "CANCELED" && paidCents === 0) continue;
      result.push({
        key, scheduleItemId: item.id, investmentId: investment.id, investorId: investment.investorId, investorName: investment.investorName,
        contractNumber: investment.contractNumber, contractLabel: contractLabel(investment), investmentStatus: investment.status, startDate: investment.startDate,
        number: item.number, dueDate: item.dueDate, description: item.description, kind, expectedCents, paidCents,
        balanceCents: Math.max(expectedCents - paidCents, 0), status: obligationStatus({ expectedCents, paidCents, dueDate: item.dueDate }, today), payments: list,
      });
    }
  }
  return result.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.investorName.localeCompare(b.investorName, "pt-BR") || a.number - b.number || (a.kind === b.kind ? 0 : a.kind === "YIELD" ? -1 : 1));
}

// ── Filtros e totais da tela ─────────────────────────────────────────────────────────────────────────────────────────
export type PayablesFilters = { q: string; from: string | null; to: string | null; status: ObligationStatus | null; kind: ObligationKind | null };
const STATUS_SLUGS: Record<string, ObligationStatus> = { prevista: "PREVISTA", parcial: "PARCIAL", paga: "PAGA", vencida: "VENCIDA" };
const KIND_SLUGS: Record<string, ObligationKind> = { rendimento: "YIELD", principal: "PRINCIPAL" };
export const statusSlug = (status: ObligationStatus) => Object.keys(STATUS_SLUGS).find((slug) => STATUS_SLUGS[slug] === status) as string;
export const kindSlug = (kind: ObligationKind) => Object.keys(KIND_SLUGS).find((slug) => KIND_SLUGS[slug] === kind) as string;

// Filtros vindos do endereço (?q=&de=&ate=&situacao=&tipo=). Valores inválidos são ignorados em vez de dar erro.
export function parsePayablesFilters(search: { q?: string; de?: string; ate?: string; situacao?: string; tipo?: string }): PayablesFilters {
  let from = search.de && isIsoDate(search.de) ? search.de : null;
  let to = search.ate && isIsoDate(search.ate) ? search.ate : null;
  if (from && to && from > to) [from, to] = [to, from];
  return {
    q: (search.q ?? "").trim().slice(0, 80), from, to,
    status: search.situacao && Object.hasOwn(STATUS_SLUGS, search.situacao) ? STATUS_SLUGS[search.situacao] : null,
    kind: search.tipo && Object.hasOwn(KIND_SLUGS, search.tipo) ? KIND_SLUGS[search.tipo] : null,
  };
}

const fold = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const inPeriod = (date: string, filters: Pick<PayablesFilters, "from" | "to">) => (!filters.from || date >= filters.from) && (!filters.to || date <= filters.to);

// Busca por investidor (ou identificação do contrato), tipo, situação e período do vencimento.
export function filterObligations(obligations: Obligation[], filters: PayablesFilters) {
  const q = fold(filters.q);
  return obligations.filter((obligation) => (!q || fold(obligation.investorName).includes(q) || fold(obligation.contractNumber ?? "").includes(q))
    && (!filters.kind || obligation.kind === filters.kind) && (!filters.status || obligation.status === filters.status) && inPeriod(obligation.dueDate, filters));
}

// Seções da tela: vencidas, vencem hoje, próximas (com saldo) e pagas.
export function payablesSections(obligations: Obligation[], today: string) {
  const open = obligations.filter((obligation) => obligation.balanceCents > 0);
  return {
    overdue: open.filter((obligation) => obligation.dueDate < today),
    dueToday: open.filter((obligation) => obligation.dueDate === today),
    upcoming: open.filter((obligation) => obligation.dueDate > today),
    paid: obligations.filter((obligation) => obligation.balanceCents === 0).sort((a, b) => (b.payments.at(-1)?.paidOn ?? b.dueDate).localeCompare(a.payments.at(-1)?.paidOn ?? a.dueDate)),
  };
}

// Totais: saldo que vence hoje, saldo vencido e o que foi pago (baixas com data no período; sem período, todo o
// histórico). Todos derivados das obrigações e baixas: nada é guardado em separado.
export function payablesTotals(obligations: Obligation[], filters: Pick<PayablesFilters, "from" | "to">, today: string) {
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const open = obligations.filter((obligation) => obligation.balanceCents > 0);
  const paidPayments = obligations.flatMap((obligation) => obligation.payments).filter((payment) => inPeriod(payment.paidOn, filters));
  return {
    dueTodayCents: sum(open.filter((obligation) => obligation.dueDate === today).map((obligation) => obligation.balanceCents)),
    overdueCents: sum(open.filter((obligation) => obligation.dueDate < today).map((obligation) => obligation.balanceCents)),
    openCents: sum(open.map((obligation) => obligation.balanceCents)),
    paidCents: sum(paidPayments.map((payment) => payment.amountCents)),
    paidYieldCents: sum(obligations.filter((obligation) => obligation.kind === "YIELD").flatMap((obligation) => obligation.payments).filter((payment) => inPeriod(payment.paidOn, filters)).map((payment) => payment.amountCents)),
    paidCount: paidPayments.length,
  };
}

// ── Baixa ────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type PaymentInput = { scheduleItemId: string; kind: string; amount: string; paidOn: string; method: string; reference: string; notes: string; requestId: string };
export type PaymentFields = { scheduleItemId: string; kind: ObligationKind; amountCents: number; paidOn: string; method: PaymentMethod; reference: string | null; notes: string | null; requestId: string };

// Confere o formulário da baixa antes de qualquer acesso ao banco.
export function parsePaymentFields(input: PaymentInput): { ok: true; value: PaymentFields } | { ok: false; error: string } {
  if (!input.scheduleItemId) return { ok: false, error: "Obrigação inválida. Recarregue a página e tente de novo." };
  if (!isObligationKind(input.kind)) return { ok: false, error: "Escolha o tipo da obrigação: rendimento ou devolução de principal." };
  const raw = input.amount.trim();
  if (raw.startsWith("-")) return { ok: false, error: "Informe o valor sem sinal de menos." };
  const amountCents = parseMoneyToCents(raw);
  if (amountCents === null) return { ok: false, error: "Informe o valor pago em reais, por exemplo 1.500,00." };
  if (amountCents <= 0) return { ok: false, error: "O valor pago precisa ser maior que zero." };
  if (!isIsoDate(input.paidOn)) return { ok: false, error: "Informe a data efetiva do pagamento." };
  if (!isPaymentMethod(input.method)) return { ok: false, error: "Escolha a forma de pagamento." };
  const reference = input.reference.trim().replace(/\s+/g, " ");
  if (reference.length > REFERENCE_MAX) return { ok: false, error: `A referência pode ter até ${REFERENCE_MAX} caracteres.` };
  const notes = input.notes.trim();
  if (notes.length > PAYMENT_NOTES_MAX) return { ok: false, error: `As observações podem ter até ${PAYMENT_NOTES_MAX} caracteres.` };
  if (!REQUEST_ID.test(input.requestId)) return { ok: false, error: "Formulário expirado. Recarregue a página e tente de novo." };
  return { ok: true, value: { scheduleItemId: input.scheduleItemId, kind: input.kind, amountCents, paidOn: input.paidOn, method: input.method, reference: reference || null, notes: notes || null, requestId: input.requestId } };
}

// Confere a baixa contra a obrigação (já travada no banco): contrato não cancelado, data entre o início do contrato e
// hoje (e dentro do ciclo atual da carteira) e valor até o saldo da obrigação.
export function checkPayment(payment: Pick<PaymentFields, "amountCents" | "paidOn">, context: { today: string; startDate: string; cycleStartedOn: string | null; balanceCents: number; investmentStatus: string }):
  { ok: true } | { ok: false; error: string } {
  if (context.investmentStatus === "CANCELED") return { ok: false, error: "Este contrato está cancelado: não recebe baixa. Nada foi registrado." };
  if (payment.paidOn > context.today) return { ok: false, error: "A data do pagamento não pode ser depois de hoje." };
  if (payment.paidOn < context.startDate) return { ok: false, error: `A data do pagamento não pode ser anterior ao início do contrato (${formatDate(context.startDate)}).` };
  if (context.cycleStartedOn && payment.paidOn < context.cycleStartedOn) return { ok: false, error: `A data do pagamento não pode ser anterior ao início do ciclo atual da carteira (${formatDate(context.cycleStartedOn)}).` };
  if (context.balanceCents <= 0) return { ok: false, error: "Esta obrigação já está paga. Nada foi registrado." };
  if (payment.amountCents > context.balanceCents) return { ok: false, error: `O valor de ${formatMoney(payment.amountCents)} é maior que o saldo da obrigação (${formatMoney(context.balanceCents)}). Nada foi registrado.` };
  return { ok: true };
}

// ── Entrada do contrato no capital ───────────────────────────────────────────────────────────────────────────────────
// Data da entrada: a data em que o dinheiro foi investido; sem ela, a data de início do contrato.
export const entryDateOf = (investment: { investedOn: string | null; startDate: string }) => investment.investedOn ?? investment.startDate;

export function checkCapitalEntry({ enteredOn, today, cycleStartedOn, investmentStatus, hasWallet, alreadyRegistered }: {
  enteredOn: string; today: string; cycleStartedOn: string | null; investmentStatus: string; hasWallet: boolean; alreadyRegistered: boolean;
}): { ok: true } | { ok: false; error: string } {
  if (alreadyRegistered) return { ok: false, error: "A entrada deste investimento já foi registrada no capital. Nada foi lançado em dobro." };
  if (investmentStatus === "CANCELED") return { ok: false, error: "Este contrato está cancelado: a entrada não pode ser registrada." };
  if (!hasWallet) return { ok: false, error: "Defina o capital inicial da carteira (tela Capital) antes de registrar a entrada." };
  if (enteredOn > today) return { ok: false, error: `A data do investimento (${formatDate(enteredOn)}) ainda não chegou. Registre a entrada a partir dessa data.` };
  if (cycleStartedOn && enteredOn < cycleStartedOn) {
    return { ok: false, error: `A data do investimento (${formatDate(enteredOn)}) é anterior ao início do ciclo atual da carteira (${formatDate(cycleStartedOn)}). Nada foi registrado: confira a data no contrato.` };
  }
  return { ok: true };
}

// Referência para a auditoria: sequências longas de dígitos (conta, chave, documento) ficam só com os 4 últimos.
export const maskReference = (reference: string | null) => (reference ? reference.replace(/\d{5,}/g, (digits) => `•••${digits.slice(-4)}`) : null);
