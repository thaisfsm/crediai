"use server";

import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { recordAdminAudit } from "@/lib/admin/audit";
import { withTenantContext } from "@/lib/auth/guards";
import { investmentPayments, investmentRevisions, investmentScheduleItems, investments, investors, tenants, wallets } from "@/lib/db/schema";
import { checkOutflow } from "@/lib/finance/cashflow";
import { cycleStartedOn, tenantCapital } from "@/lib/finance/finance-queries";
import { formatDate, formatMoney, parseMoneyToCents, todayIso } from "@/lib/finance/format";
import { EARLY_SETTLEMENT_DESCRIPTION, PAYMENT_METHODS, PAYMENT_NOTES_MAX, REFERENCE_MAX, checkEarlySettlement, earlySettlementPlan, entryEvidence, isPaymentMethod, maskReference } from "@/lib/investors/payables";
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
  const method = field(data, "method", 20);
  const reference = field(data, "reference", 400) || null;
  const notes = field(data, "notes", 1000) || null;
  if (!investmentId) return { ok: false, error: "Investimento inválido." };
  if (field(data, "confirm", 4) !== "1") return { ok: false, error: "Confirme a liquidação antecipada: o contrato será encerrado e o valor sairá do capital." };
  if (!REQUEST_ID.test(requestId)) return { ok: false, error: "Formulário expirado. Recarregue a página e tente de novo." };
  if (yieldCents === null) return { ok: false, error: "Informe o rendimento final em reais (ou deixe zero)." };
  if (!isPaymentMethod(method)) return { ok: false, error: "Escolha a forma de pagamento." };
  if (reference && reference.length > REFERENCE_MAX) return { ok: false, error: `A referência pode ter no máximo ${REFERENCE_MAX} caracteres.` };
  if (notes && notes.length > PAYMENT_NOTES_MAX) return { ok: false, error: `A observação pode ter no máximo ${PAYMENT_NOTES_MAX} caracteres.` };
  try {
    const result = await withTenantContext(async (tx, { tenantId, session }): Promise<ActionResult> => {
      // Mesma ordem de travas da baixa: carteira, depois o contrato e as linhas do cronograma.
      const [wallet] = await tx.select().from(wallets).where(eq(wallets.tenantId, tenantId)).for("update");
      if (!wallet) return { ok: false, error: "Defina o capital inicial da carteira (tela Capital) antes de liquidar." };
      const [repeated] = await tx.select({ id: investmentPayments.id, investmentId: investmentPayments.investmentId }).from(investmentPayments)
        .where(and(eq(investmentPayments.tenantId, tenantId), inArray(investmentPayments.idempotencyKey, [`${requestId}-p`, `${requestId}-y`])));
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
      const payments = await tx.select({ scheduleItemId: investmentPayments.scheduleItemId, kind: investmentPayments.kind, amountCents: investmentPayments.amountCents }).from(investmentPayments)
        .where(and(eq(investmentPayments.tenantId, tenantId), eq(investmentPayments.investmentId, investment.id)));
      const plan = earlySettlementPlan({ amountCents: investment.amountCents, items, payments: payments.map((payment) => ({ ...payment, kind: payment.kind === "YIELD" ? "YIELD" as const : "PRINCIPAL" as const })), settledOn });
      const [chain] = await tx.select({
        renewed: sql<boolean>`exists (select 1 from investment r where r.renewed_from_investment_id = ${investment.id} and r.tenant_id = ${tenantId})`,
        originHasCapital: sql<boolean>`crediai_investment_has_capital(${tenantId}, ${investment.id})`,
      }).from(investments).where(and(eq(investments.id, investment.id), eq(investments.tenantId, tenantId)));
      const startedOn = cycleStartedOn(wallet);
      const check = checkEarlySettlement({ status: investment.status, renewed: chain.renewed, settledOn, today: todayIso(), startDate: investment.startDate, cycleStartedOn: startedOn, principalRemainingCents: plan.principalRemainingCents, yieldCents });
      if (!check.ok) return check;
      if (shownPrincipal !== plan.principalRemainingCents) return { ok: false, error: "O principal a devolver mudou desde que a confirmação foi aberta (houve uma baixa). Confira e confirme de novo. Nada foi registrado." };
      const evidence = await loadEntryEvidence(tx, tenantId, investment.id);
      const allowed = entryEvidence({ capitalEntryRule: investment.capitalEntryRule, hasEntry: evidence.entries.has(investment.id), hasPriorContribution: evidence.priors.has(investment.id),
        renewedFrom: investment.renewedFromInvestmentId, originHasCapital: chain.originHasCapital });
      if (!allowed.ok) return { ok: false, error: `${allowed.error} Nada foi registrado.` };
      const totalCents = plan.principalRemainingCents + yieldCents;
      // Mesma regra das baixas: o capital não fica negativo hoje nem em nenhuma data a partir da liquidação.
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
      const settlementItem = { id: itemId, tenantId, investmentId: investment.id, number, dueDate: settledOn, yieldCents, principalCents: plan.principalRemainingCents, description: EARLY_SETTLEMENT_DESCRIPTION, createdByUserId: session.user.id };
      await tx.insert(investmentScheduleItems).values(settlementItem);
      const kept = items.filter((item) => !plan.removeItemIds.includes(item.id)).map((item) => plan.trimItems.find((trim) => trim.id === item.id) ? { ...item, ...plan.trimItems.find((trim) => trim.id === item.id) } : item);
      const after = scheduleSummary([...kept, settlementItem]);
      const base = { paidOn: settledOn, method, reference, notes, scheduleItemId: itemId };
      if (plan.principalRemainingCents > 0) {
        await insertCapitalPayment({ tx, tenantId, session, payment: { ...base, kind: "PRINCIPAL", amountCents: plan.principalRemainingCents, requestId: `${requestId}-p` }, item: settlementItem, investment, investorName: row.investorName, balanceCents: plan.principalRemainingCents, cycleNumber: wallet.cycleNumber, auditNote: EARLY_SETTLEMENT_DESCRIPTION });
      }
      if (yieldCents > 0) {
        await insertCapitalPayment({ tx, tenantId, session, payment: { ...base, kind: "YIELD", amountCents: yieldCents, requestId: `${requestId}-y` }, item: settlementItem, investment, investorName: row.investorName, balanceCents: yieldCents, cycleNumber: wallet.cycleNumber, auditNote: EARLY_SETTLEMENT_DESCRIPTION });
      }
      await tx.update(investments).set({ status: "CLOSED", updatedAt: sql`now()` }).where(and(eq(investments.id, investment.id), eq(investments.tenantId, tenantId)));
      const summary = `${formatMoney(totalCents)} em ${formatDate(settledOn)}: principal ${formatMoney(plan.principalRemainingCents)} e rendimento final ${formatMoney(yieldCents)}`;
      await tx.insert(investmentRevisions).values([
        { id: id("ivr"), tenantId, investmentId: investment.id, kind: "SCHEDULE", description: "Cronograma encerrado na liquidação antecipada", changes: [{ field: "Cronograma", before, after }], changedByUserId: session.user.id },
        { id: id("ivr"), tenantId, investmentId: investment.id, kind: "CONTRACT", description: EARLY_SETTLEMENT_DESCRIPTION,
          changes: [{ field: "Liquidação antecipada", before: `${formatMoney(plan.openScheduleCents)} em aberto no cronograma (${plan.closedCount} ${plan.closedCount === 1 ? "parcela" : "parcelas"})`, after: summary }, { field: "Status", before: "Ativo", after: "Encerrado" }], changedByUserId: session.user.id },
      ]);
      await recordAdminAudit(tx, session, {
        action: "INVESTMENT_SETTLED_EARLY", entity: "investment", entityId: investment.id, tenantId, tenantName: await tenantName(tx, tenantId),
        description: `Contrato de ${row.investorName} liquidado antecipadamente (${summary})`,
        before: { status: investment.status, schedule: before, openScheduleCents: plan.openScheduleCents, principalPaidCents: plan.principalPaidCents },
        after: { status: "CLOSED", schedule: after, settledOn, principalCents: plan.principalRemainingCents, yieldCents, totalCents, method: PAYMENT_METHODS[method], reference: maskReference(reference), removedItems: plan.removeItemIds.length, trimmedItems: plan.trimItems.length, settlementItemId: itemId, cycleNumber: wallet.cycleNumber },
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
