"use server";

import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { recordAdminAudit } from "@/lib/admin/audit";
import { withTenantContext } from "@/lib/auth/guards";
import { capitalMovements, investmentPayments, investmentRevisions, investmentScheduleItems, investments, investors, tenants, wallets } from "@/lib/db/schema";
import { checkOutflow } from "@/lib/finance/cashflow";
import { cycleStartedOn, tenantCapital } from "@/lib/finance/finance-queries";
import { formatDate, formatMoney, parseMoneyToCents, todayIso } from "@/lib/finance/format";
import { EARLY_SETTLEMENT_DESCRIPTION, EARLY_SETTLEMENT_FEE_DESCRIPTION, PAYMENT_METHODS, PAYMENT_NOTES_MAX, PRORATA_NOTE, REFERENCE_MAX, SETTLEMENT_KINDS, checkEarlySettlement, checkSettlementTerms, contractLabel, earlySettlementPlan, entryEvidence, isPaymentMethod, isSettlementKind, maskReference, proRataYield, settlementTotals } from "@/lib/investors/payables";
import { loadEntryEvidence } from "@/lib/investors/payables-queries";
import { insertCapitalPayment } from "@/lib/investors/payment-write";
import { scheduleSummary } from "@/lib/investors/rules";
import type { ActionResult } from "../actions";

// Liquidação antecipada do contrato de investidor (fora de Contas a Pagar, que só registra e nunca altera nem apaga).
// Tudo em withTenantContext: só a carteira da sessão (o dinheiro sai do capital dela); o MASTER não liquida contrato de
// outra carteira. tenant_id explícito em cada consulta (a produção conecta com um papel que ignora RLS).

const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
const field = (data: FormData, key: string, max: number) => String(data.get(key) ?? "").trim().slice(0, max);
const REQUEST_ID = /^[A-Za-z0-9-]{16,64}$/;
const dbRule = (error: unknown) => {
  const text = `${error instanceof Error ? error.message : ""} ${(error as { cause?: Error })?.cause?.message ?? ""}`;
  return /investment_payment_|investment_schedule_item_|Baixa|Esta linha do cronograma|capital_movement_tenant_idempotency_unique/.test(text);
};
async function tenantName(tx: Parameters<Parameters<typeof withTenantContext>[0]>[0], tenantId: string) {
  const [row] = await tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId));
  return row?.name ?? null;
}
function refresh() {
  revalidatePath("/contas-a-pagar");
  revalidatePath("/financeiro");
  revalidatePath("/");
  revalidatePath("/investidores", "layout");
}

// Liquidação antecipada do contrato de investidor: a carteira devolve agora o principal que falta e um rendimento final
// negociado, e o contrato fica encerrado. Só a própria carteira (o dinheiro sai do capital dela), só com confirmação e
// com o principal que o usuário viu. Uma transação: cronograma, baixas (com a saída de capital de cada uma), status,
// histórico e auditoria entram juntos ou nada entra. Baixas já feitas não mudam; linhas sem baixa saem do cronograma
// (o histórico do contrato e a auditoria guardam como era); a linha com baixa parcial fica só com o que já foi pago.
export async function settleInvestmentEarlyAction(data: FormData): Promise<ActionResult> {
  const investmentId = field(data, "investmentId", 80);
  const requestId = field(data, "requestId", 80);
  const settledOn = field(data, "settledOn", 10);
  const shownPrincipal = Number(field(data, "principalCents", 20));
  const yieldText = field(data, "yieldAmount", 40);
  const yieldCents = yieldText ? parseMoneyToCents(yieldText) : 0;
  const kind = field(data, "settlementKind", 20);
  const feeText = field(data, "feeAmount", 40);
  const feeCents = feeText ? parseMoneyToCents(feeText) : 0;
  const shownProRata = Number(field(data, "proRataCents", 20));
  const allowAbove = field(data, "allowAbove", 4) === "1";
  const method = field(data, "method", 20);
  const reference = field(data, "reference", 400) || null;
  const notes = field(data, "notes", 1000) || null;
  if (!investmentId) return { ok: false, error: "Investimento inválido." };
  if (field(data, "confirm", 4) !== "1") return { ok: false, error: "Confirme a liquidação antecipada: o contrato será encerrado e o valor sairá do capital." };
  if (!REQUEST_ID.test(requestId)) return { ok: false, error: "Formulário expirado. Recarregue a página e tente de novo." };
  if (yieldCents === null) return { ok: false, error: "Informe o rendimento final em reais (ou deixe zero)." };
  if (!isSettlementKind(kind)) return { ok: false, error: "Escolha o tipo da liquidação: por decisão da empresa ou resgate solicitado pelo investidor." };
  if (!isPaymentMethod(method)) return { ok: false, error: "Escolha a forma de pagamento." };
  if (reference && reference.length > REFERENCE_MAX) return { ok: false, error: `A referência pode ter no máximo ${REFERENCE_MAX} caracteres.` };
  if (notes && notes.length > PAYMENT_NOTES_MAX) return { ok: false, error: `A observação pode ter no máximo ${PAYMENT_NOTES_MAX} caracteres.` };
  try {
    const result = await withTenantContext(async (tx, { tenantId, session }): Promise<ActionResult> => {
      // Mesma ordem de travas da baixa: carteira, depois o contrato e as linhas do cronograma.
      const [wallet] = await tx.select().from(wallets).where(eq(wallets.tenantId, tenantId)).for("update");
      if (!wallet) return { ok: false, error: "Defina o capital inicial da carteira (tela Capital) antes de liquidar." };
      const [repeated] = await tx.select({ id: investmentPayments.id, investmentId: investmentPayments.investmentId }).from(investmentPayments)
        .where(and(eq(investmentPayments.tenantId, tenantId), inArray(investmentPayments.idempotencyKey, [`${requestId}-p`, `${requestId}-y`, `${requestId}-r`])));
      if (repeated) {
        return repeated.investmentId === investmentId
          ? { ok: true, message: "Esta liquidação já estava registrada. Nada foi lançado em dobro." }
          : { ok: false, error: "Este formulário já registrou outra liquidação. Recarregue a página." };
      }
      const [row] = await tx.select({ investment: investments, investorName: investors.name }).from(investments)
        .innerJoin(investors, and(eq(investors.id, investments.investorId), eq(investors.tenantId, investments.tenantId)))
        .where(and(eq(investments.id, investmentId), eq(investments.tenantId, tenantId))).for("no key update", { of: investments });
      if (!row) return { ok: false, error: "Investimento não encontrado nesta carteira." };
      const { investment } = row;
      const items = await tx.select().from(investmentScheduleItems)
        .where(and(eq(investmentScheduleItems.investmentId, investment.id), eq(investmentScheduleItems.tenantId, tenantId)))
        .orderBy(asc(investmentScheduleItems.dueDate), asc(investmentScheduleItems.number)).for("update");
      const payments = await tx.select({ scheduleItemId: investmentPayments.scheduleItemId, kind: investmentPayments.kind, amountCents: investmentPayments.amountCents, paidOn: investmentPayments.paidOn }).from(investmentPayments)
        .where(and(eq(investmentPayments.tenantId, tenantId), eq(investmentPayments.investmentId, investment.id)));
      const typed = payments.map((payment) => ({ ...payment, kind: payment.kind === "YIELD" ? "YIELD" as const : "PRINCIPAL" as const }));
      const plan = earlySettlementPlan({ amountCents: investment.amountCents, items, payments: typed, settledOn });
      // Pro-rata sempre recalculado aqui, com o contrato travado (o valor da tela só serve para conferir o que foi visto).
      const proRata = proRataYield({ items, payments: typed, startDate: investment.startDate, settledOn });
      const [chain] = await tx.select({
        renewed: sql<boolean>`exists (select 1 from investment r where r.renewed_from_investment_id = ${investment.id} and r.tenant_id = ${tenantId})`,
        originHasCapital: sql<boolean>`crediai_investment_has_capital(${tenantId}, ${investment.id})`,
      }).from(investments).where(and(eq(investments.id, investment.id), eq(investments.tenantId, tenantId)));
      const startedOn = cycleStartedOn(wallet);
      const check = checkEarlySettlement({ status: investment.status, renewed: chain.renewed, settledOn, today: todayIso(), startDate: investment.startDate, cycleStartedOn: startedOn, principalRemainingCents: plan.principalRemainingCents, yieldCents });
      if (!check.ok) return check;
      const totals = settlementTotals({ principalCents: plan.principalRemainingCents, yieldCents, proRataCents: proRata.cents, feeCents: feeCents ?? -1 });
      const lastPaidOn = payments.map((payment) => payment.paidOn).sort().at(-1) ?? null;
      const terms = checkSettlementTerms({ kind, feeCents, grossCents: totals.grossCents, yieldCents, overdueYieldCents: plan.overdueYieldCents, allowAbove, settledOn, lastPaidOn });
      if (!terms.ok) return terms;
      if (shownProRata !== proRata.cents) return { ok: false, error: "O rendimento pro-rata mudou desde que a confirmação foi aberta. Confira e confirme de novo. Nada foi registrado." };
      if (shownPrincipal !== plan.principalRemainingCents) return { ok: false, error: "O principal a devolver mudou desde que a confirmação foi aberta (houve uma baixa). Confira e confirme de novo. Nada foi registrado." };
      const evidence = await loadEntryEvidence(tx, tenantId, investment.id);
      const allowed = entryEvidence({ capitalEntryRule: investment.capitalEntryRule, hasEntry: evidence.entries.has(investment.id), hasPriorContribution: evidence.priors.has(investment.id),
        renewedFrom: investment.renewedFromInvestmentId, originHasCapital: chain.originHasCapital });
      if (!allowed.ok) return { ok: false, error: `${allowed.error} Nada foi registrado.` };
      const totalCents = totals.netCents;
      const yieldTotalCents = yieldCents + proRata.cents;
      // Mesma regra das baixas: o capital não fica negativo hoje nem em nenhuma data a partir da liquidação. Conta o
      // valor líquido: a taxa retida entra no capital na mesma data, antes das saídas.
      const capital = await tenantCapital(tx, tenantId);
      const outflow = checkOutflow({ ledger: [...capital.capitalLedger].reverse(), amountCents: totalCents, occurredAt: settledOn, availableCents: capital.summary.availableCents });
      if (!outflow.ok) return outflow;
      // Cronograma: tira as linhas sem baixa, reduz a linha com baixa parcial ao que já foi pago e acrescenta a linha da
      // liquidação. O gatilho do banco impede reduzir abaixo do pago.
      const before = scheduleSummary(items);
      if (plan.removeItemIds.length) await tx.delete(investmentScheduleItems).where(and(eq(investmentScheduleItems.tenantId, tenantId), inArray(investmentScheduleItems.id, plan.removeItemIds)));
      for (const trim of plan.trimItems) {
        await tx.update(investmentScheduleItems).set({ yieldCents: trim.yieldCents, principalCents: trim.principalCents, updatedAt: sql`now()` })
          .where(and(eq(investmentScheduleItems.id, trim.id), eq(investmentScheduleItems.tenantId, tenantId)));
      }
      const number = items.reduce((highest, item) => Math.max(highest, item.number), 0) + 1;
      const itemId = id("isi");
      const settlementItem = { id: itemId, tenantId, investmentId: investment.id, number, dueDate: settledOn, yieldCents: yieldTotalCents, principalCents: plan.principalRemainingCents, description: EARLY_SETTLEMENT_DESCRIPTION, createdByUserId: session.user.id };
      await tx.insert(investmentScheduleItems).values(settlementItem);
      const kept = items.filter((item) => !plan.removeItemIds.includes(item.id)).map((item) => plan.trimItems.find((trim) => trim.id === item.id) ? { ...item, ...plan.trimItems.find((trim) => trim.id === item.id) } : item);
      const after = scheduleSummary([...kept, settlementItem]);
      const base = { paidOn: settledOn, method, reference, notes, scheduleItemId: itemId };
      // Taxa de resgate: não é principal nem rendimento. O principal e os rendimentos saem inteiros (a obrigação do
      // contrato fica quitada) e a taxa retida entra no capital como "Outras entradas", com descrição própria e chave
      // contra envio repetido: o saldo muda só pelo valor líquido pago ao investidor.
      let feeMovementId: string | null = null;
      if (totals.feeCents > 0) {
        feeMovementId = id("cap");
        await tx.insert(capitalMovements).values({
          id: feeMovementId, tenantId, kind: "OTHER_INCOME", category: "OTHER_INCOME", source: "FINANCE", amountCents: totals.feeCents, occurredAt: settledOn, cycleNumber: wallet.cycleNumber,
          description: `${EARLY_SETTLEMENT_FEE_DESCRIPTION} · ${row.investorName} · ${contractLabel(investment)}`, notes: null, createdByUserId: session.user.id, idempotencyKey: `ivf-${requestId}`,
        });
      }
      if (plan.principalRemainingCents > 0) {
        await insertCapitalPayment({ tx, tenantId, session, payment: { ...base, kind: "PRINCIPAL", amountCents: plan.principalRemainingCents, requestId: `${requestId}-p` }, item: settlementItem, investment, investorName: row.investorName, balanceCents: plan.principalRemainingCents, cycleNumber: wallet.cycleNumber, auditNote: EARLY_SETTLEMENT_DESCRIPTION });
      }
      if (yieldCents > 0) {
        await insertCapitalPayment({ tx, tenantId, session, payment: { ...base, kind: "YIELD", amountCents: yieldCents, requestId: `${requestId}-y` }, item: settlementItem, investment, investorName: row.investorName, balanceCents: yieldTotalCents, cycleNumber: wallet.cycleNumber, auditNote: EARLY_SETTLEMENT_DESCRIPTION });
      }
      if (proRata.cents > 0) {
        await insertCapitalPayment({ tx, tenantId, session, payment: { ...base, kind: "YIELD", amountCents: proRata.cents, requestId: `${requestId}-r` }, item: settlementItem, investment, investorName: row.investorName, balanceCents: proRata.cents, cycleNumber: wallet.cycleNumber, auditNote: PRORATA_NOTE });
      }
      await tx.update(investments).set({ status: "CLOSED", updatedAt: sql`now()` }).where(and(eq(investments.id, investment.id), eq(investments.tenantId, tenantId)));
      const feeText = totals.feeCents > 0 ? `, taxa de liquidação antecipada ${formatMoney(totals.feeCents)} retida` : "";
      const summary = `${formatMoney(totalCents)} líquidos em ${formatDate(settledOn)} (${SETTLEMENT_KINDS[kind].toLowerCase()}): principal ${formatMoney(plan.principalRemainingCents)}, rendimento final ${formatMoney(yieldCents)}, pro-rata ${formatMoney(proRata.cents)}${feeText}; bruto ${formatMoney(totals.grossCents)}`;
      const memory = {
        settlementKind: kind, settlementKindLabel: SETTLEMENT_KINDS[kind], principalInvestedCents: investment.amountCents, principalPaidBeforeCents: plan.principalPaidCents,
        principalCents: plan.principalRemainingCents, yieldsPaidBeforeCents: payments.filter((payment) => payment.kind === "YIELD").reduce((total, payment) => total + payment.amountCents, 0),
        overdueYieldCents: plan.overdueYieldCents, yieldCents, proRataCents: proRata.cents, proRataFormula: proRata.formula, proRataPeriodStart: proRata.periodStart, proRataNextDueDate: proRata.nextDueDate,
        proRataDays: proRata.elapsedDays, proRataPeriodDays: proRata.periodDays, proRataBaseYieldCents: proRata.baseYieldCents, proRataPaidOnNextCents: proRata.paidOnNextCents,
        grossCents: totals.grossCents, feeCents: totals.feeCents, netCents: totals.netCents, capitalOutCents: totals.grossCents, capitalFeeInCents: totals.feeCents, capitalNetChangeCents: -totals.netCents, feeMovementId,
      };
      await tx.insert(investmentRevisions).values([
        { id: id("ivr"), tenantId, investmentId: investment.id, kind: "SCHEDULE", description: "Cronograma encerrado na liquidação antecipada", changes: [{ field: "Cronograma", before, after }], changedByUserId: session.user.id },
        { id: id("ivr"), tenantId, investmentId: investment.id, kind: "CONTRACT", description: EARLY_SETTLEMENT_DESCRIPTION,
          changes: [{ field: "Liquidação antecipada", before: `${formatMoney(plan.openScheduleCents)} em aberto no cronograma (${plan.closedCount} ${plan.closedCount === 1 ? "parcela" : "parcelas"})`, after: summary }, { field: "Tipo", before: null, after: SETTLEMENT_KINDS[kind] },
            { field: "Rendimento pro-rata temporis", before: null, after: `${formatMoney(proRata.cents)}: ${proRata.formula}` },
            { field: EARLY_SETTLEMENT_FEE_DESCRIPTION, before: null, after: totals.feeCents > 0 ? `${formatMoney(totals.feeCents)} retida (entrada no capital, não é principal nem rendimento)` : "Sem taxa" },
            { field: "Valor líquido pago", before: null, after: `${formatMoney(totals.grossCents)} bruto − ${formatMoney(totals.feeCents)} de taxa = ${formatMoney(totals.netCents)}` },
            { field: "Status", before: "Ativo", after: "Encerrado" }], changedByUserId: session.user.id },
      ]);
      await recordAdminAudit(tx, session, {
        action: "INVESTMENT_SETTLED_EARLY", entity: "investment", entityId: investment.id, tenantId, tenantName: await tenantName(tx, tenantId),
        description: `Contrato de ${row.investorName} liquidado antecipadamente (${summary})`,
        before: { status: investment.status, schedule: before, openScheduleCents: plan.openScheduleCents, principalPaidCents: plan.principalPaidCents },
        after: { status: "CLOSED", schedule: after, settledOn, ...memory, totalCents, method: PAYMENT_METHODS[method], reference: maskReference(reference), removedItems: plan.removeItemIds.length, trimmedItems: plan.trimItems.length, settlementItemId: itemId, cycleNumber: wallet.cycleNumber },
      });
      return { ok: true, message: `Contrato liquidado: ${summary}. As parcelas futuras foram encerradas e o contrato ficou encerrado.` };
    });
    if (result.ok) refresh();
    return result;
  } catch (error) {
    if (dbRule(error)) return { ok: false, error: "A liquidação não confere com o cronograma ou já foi registrada. Nada foi lançado. Recarregue a página e confira." };
    throw error;
  }
}
