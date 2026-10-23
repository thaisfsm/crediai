"use server";

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { recordAdminAudit } from "@/lib/admin/audit";
import { withTenantContext, type TenantTransaction } from "@/lib/auth/guards";
import { capitalMovements, investmentCapitalEntries, investmentPayments, investmentPriorContributions, investmentScheduleItems, investments, investors, tenants, wallets } from "@/lib/db/schema";
import { checkOutflow } from "@/lib/finance/cashflow";
import { cycleStartedOn, tenantCapital } from "@/lib/finance/finance-queries";
import { formatDate, formatMoney, todayIso } from "@/lib/finance/format";
import {
  INVESTOR_CATEGORIES, OBLIGATION_KINDS, PAYMENT_METHODS, checkCapitalEntry, checkPayment, checkPriorContribution, contractLabel, entryDateOf, entryDuplicateConflict, entryEvidence, isBeforeCycle, maskReference,
  parsePaymentFields, paymentCategory, type PaymentFields,
} from "@/lib/investors/payables";
import { loadEntryEvidence, priorContributionCandidates } from "@/lib/investors/payables-queries";
import type { ActionResult } from "../actions";

// Contas a Pagar. Tudo roda em withTenantContext: o tenant vem só da sessão e cada consulta filtra tenant_id além do RLS
// (a produção conecta com um papel que ignora RLS). O MASTER registra só na própria carteira; o contrato de outro tenant
// responde como inexistente. Cada ação é UMA transação: movimento de capital, vínculo e auditoria entram juntos ou nada entra.

const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
const field = (data: FormData, key: string, max: number) => String(data.get(key) ?? "").trim().slice(0, max);
const REQUEST_ID = /^[A-Za-z0-9-]{16,64}$/;
// Violação de regra do banco (gatilhos e índices únicos das migrações 0022 e 0023): nada fica gravado.
const dbRule = (error: unknown) => {
  const text = `${error instanceof Error ? error.message : ""} ${(error as { cause?: Error })?.cause?.message ?? ""}`;
  return /investment_capital_entry_|investment_payment_|investment_prior_contribution_|Baixa|Entrada do investimento|Aporte anterior|capital_movement_tenant_idempotency_unique/.test(text);
};

function refresh() {
  revalidatePath("/contas-a-pagar");
  revalidatePath("/financeiro");
  revalidatePath("/");
  revalidatePath("/investidores", "layout");
}

async function tenantName(tx: Parameters<Parameters<typeof withTenantContext>[0]>[0], tenantId: string) {
  const [row] = await tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId));
  return row?.name ?? null;
}

// "Registrar a entrada deste investimento no capital": só com a confirmação explícita, no máximo uma vez por contrato.
// O valor e a data são os do contrato e precisam ser os mesmos que o usuário viu na confirmação.
export async function registerInvestmentEntryAction(data: FormData): Promise<ActionResult> {
  const investmentId = field(data, "investmentId", 80);
  const requestId = field(data, "requestId", 80);
  const shownAmount = Number(field(data, "amountCents", 20));
  const shownDate = field(data, "enteredOn", 10);
  if (!investmentId) return { ok: false, error: "Investimento inválido." };
  if (field(data, "confirm", 4) !== "1") return { ok: false, error: "Confirme o valor e a data antes de registrar a entrada." };
  if (!REQUEST_ID.test(requestId)) return { ok: false, error: "Formulário expirado. Recarregue a página e tente de novo." };
  try {
    const result = await withTenantContext(async (tx, { tenantId, session }): Promise<ActionResult> => {
      // Trava a carteira e o contrato: dois envios ao mesmo tempo esperam um pelo outro e o segundo encontra a entrada.
      const [wallet] = await tx.select().from(wallets).where(eq(wallets.tenantId, tenantId)).for("update");
      const [row] = await tx.select({ investment: investments, investorName: investors.name }).from(investments)
        .innerJoin(investors, and(eq(investors.id, investments.investorId), eq(investors.tenantId, investments.tenantId)))
        .where(and(eq(investments.id, investmentId), eq(investments.tenantId, tenantId))).for("update", { of: investments });
      if (!row) return { ok: false, error: "Investimento não encontrado nesta carteira." };
      const { investment } = row;
      const [repeated] = await tx.select().from(investmentCapitalEntries).where(and(eq(investmentCapitalEntries.tenantId, tenantId), eq(investmentCapitalEntries.idempotencyKey, requestId)));
      if (repeated) {
        return repeated.investmentId === investment.id
          ? { ok: true, message: "A entrada deste investimento já estava registrada. Nada foi lançado em dobro." }
          : { ok: false, error: "Este formulário já registrou outra entrada. Recarregue a página." };
      }
      const [existing] = await tx.select({ id: investmentCapitalEntries.id }).from(investmentCapitalEntries)
        .where(and(eq(investmentCapitalEntries.tenantId, tenantId), eq(investmentCapitalEntries.investmentId, investment.id)));
      const [declared] = await tx.select({ id: investmentPriorContributions.id }).from(investmentPriorContributions)
        .where(and(eq(investmentPriorContributions.tenantId, tenantId), eq(investmentPriorContributions.investmentId, investment.id)));
      const enteredOn = entryDateOf(investment);
      const startedOn = cycleStartedOn(wallet);
      const beforeCycle = isBeforeCycle(enteredOn, startedOn);
      const duplicateConflict = beforeCycle && wallet
        ? entryDuplicateConflict({ amountCents: investment.amountCents, initialCapitalCents: wallet.initialCapitalCents, contributions: await priorContributionCandidates(tx, tenantId, wallet.cycleNumber) })
        : null;
      const check = checkCapitalEntry({
        enteredOn, today: todayIso(), cycleStartedOn: cycleStartedOn(wallet), investmentStatus: investment.status, hasWallet: Boolean(wallet), alreadyRegistered: Boolean(existing),
        priorContributionDeclared: Boolean(declared), isRenewal: investment.renewedFromInvestmentId !== null,
        confirmedBeforeCycle: field(data, "confirmBeforeCycle", 4) === "1", duplicateConflict,
      });
      if (!check.ok) return check;
      if (shownAmount !== investment.amountCents || shownDate !== enteredOn) {
        return { ok: false, error: "Os dados do contrato mudaram desde que a confirmação foi aberta. Confira o valor e a data e confirme de novo. Nada foi registrado." };
      }
      const label = contractLabel(investment);
      const movementId = id("cap");
      await tx.insert(capitalMovements).values({
        id: movementId, tenantId, kind: "CONTRIBUTION", category: "INVESTOR_CONTRIBUTION", source: "INVESTOR", amountCents: investment.amountCents, occurredAt: enteredOn,
        cycleNumber: wallet!.cycleNumber, description: `Entrada do investimento · ${row.investorName} · ${label}`, createdByUserId: session.user.id, idempotencyKey: `ive-${requestId}`,
      });
      const entryId = id("ice");
      await tx.insert(investmentCapitalEntries).values({
        id: entryId, tenantId, investmentId: investment.id, capitalMovementId: movementId, amountCents: investment.amountCents, enteredOn, idempotencyKey: requestId, createdByUserId: session.user.id,
      });
      await recordAdminAudit(tx, session, {
        action: "INVESTMENT_CAPITAL_ENTRY_REGISTERED", entity: "capital_movement", entityId: movementId, tenantId, tenantName: await tenantName(tx, tenantId),
        description: `Entrada do investimento de ${row.investorName} registrada no capital${beforeCycle ? ` com confirmação do usuário (data anterior ao início do ciclo, ${formatDate(startedOn as string)})` : ""}`,
        after: { category: INVESTOR_CATEGORIES.INVESTOR_CONTRIBUTION, amountCents: investment.amountCents, occurredAt: enteredOn, investmentId: investment.id, investorId: investment.investorId, contract: label, capitalMovementId: movementId, entryId, cycleNumber: wallet!.cycleNumber, ...(beforeCycle ? { confirmedBeforeCycle: true, cycleStartedOn: startedOn } : {}) },
      });
      return { ok: true, message: `Entrada de ${formatMoney(investment.amountCents)} em ${formatDate(enteredOn)} registrada no capital.` };
    });
    if (result.ok) refresh();
    return result;
  } catch (error) {
    if (dbRule(error)) return { ok: false, error: "A entrada deste investimento já foi registrada ou não confere com o contrato. Nada foi lançado. Recarregue a página." };
    throw error;
  }
}

// Grava a baixa histórica: só a baixa (sem saída de capital), com a mesma auditoria. Contrato renovado não recebe baixa de
// principal; a regra da entrada no capital não se aplica (o pagamento é anterior ao capital). O banco confere de novo.
async function registerHistoricalPayment({ tx, tenantId, session, payment, item, investment, investorName, balanceCents, cycleNumber }: {
  tx: TenantTransaction; tenantId: string; session: { user: { id: string } } & Parameters<typeof recordAdminAudit>[1]; payment: PaymentFields; item: typeof investmentScheduleItems.$inferSelect;
  investment: typeof investments.$inferSelect; investorName: string; balanceCents: number; cycleNumber: number;
}): Promise<ActionResult> {
  const [renewed] = await tx.select({ renewed: sql<boolean>`exists (select 1 from investment r where r.renewed_from_investment_id = ${investment.id} and r.tenant_id = ${tenantId})` }).from(investments).where(and(eq(investments.id, investment.id), eq(investments.tenantId, tenantId)));
  if (payment.kind === "PRINCIPAL" && renewed.renewed) return { ok: false, error: "Este contrato foi renovado: o principal que faltava devolver passou para a renovação. Registre a devolução no contrato novo. Nada foi registrado." };
  const label = contractLabel(investment);
  const paymentId = id("ivp");
  await tx.insert(investmentPayments).values({
    id: paymentId, tenantId, investmentId: investment.id, scheduleItemId: item.id, kind: payment.kind, amountCents: payment.amountCents, paidOn: payment.paidOn,
    method: payment.method, reference: payment.reference, notes: payment.notes, capitalMovementId: null, historical: true, idempotencyKey: payment.requestId, createdByUserId: session.user.id,
  });
  const remaining = balanceCents - payment.amountCents;
  await recordAdminAudit(tx, session, {
    action: "INVESTMENT_PAYMENT_REGISTERED", entity: "investment_payment", entityId: paymentId, tenantId, tenantName: await tenantName(tx, tenantId),
    description: `Baixa histórica registrada para ${investorName} (sem saída de capital)`,
    after: {
      historical: true, kind: OBLIGATION_KINDS[payment.kind], amountCents: payment.amountCents, paidOn: payment.paidOn, method: PAYMENT_METHODS[payment.method], reference: maskReference(payment.reference),
      notes: payment.notes ? "preenchidas" : null, investmentId: investment.id, investorId: investment.investorId, contract: label, scheduleItemId: item.id, installment: item.number,
      dueDate: item.dueDate, capitalMovementId: null, balanceAfterCents: remaining, cycleNumber,
    },
  });
  return { ok: true, message: `Pagamento histórico de ${formatMoney(payment.amountCents)} registrado em ${formatDate(payment.paidOn)} (${OBLIGATION_KINDS[payment.kind]}), sem mexer no capital. ${remaining > 0 ? `Saldo da obrigação: ${formatMoney(remaining)}.` : "Obrigação paga."}` };
}

// Baixa de uma obrigação (rendimento ou devolução de principal) de uma linha do cronograma. Pode ser parcial; nunca
// passa do saldo; a data fica entre o início do contrato e hoje; o capital não fica negativo em nenhuma data. Grava
// exatamente UMA saída de capital por baixa: o mesmo envio repetido (clique duplo, nova tentativa) é reconhecido pela chave.
export async function registerInvestmentPaymentAction(data: FormData): Promise<ActionResult> {
  const parsed = parsePaymentFields({
    scheduleItemId: field(data, "scheduleItemId", 80), kind: field(data, "kind", 20), amount: field(data, "amount", 40), paidOn: field(data, "paidOn", 10),
    method: field(data, "method", 20), reference: field(data, "reference", 400), notes: field(data, "notes", 1000), requestId: field(data, "requestId", 80),
  });
  if (!parsed.ok) return parsed;
  const payment = parsed.value;
  // Baixa histórica (migração 0033): pagamento de data anterior ao início do ciclo do capital. Registra a baixa na data
  // real, sem saída de capital (o capital começou depois; o dinheiro já saiu antes dele existir).
  const historical = field(data, "historical", 4) === "1";
  try {
    const result = await withTenantContext(async (tx, { tenantId, session }): Promise<ActionResult> => {
      // Trava a carteira: duas saídas simultâneas (baixas, Financeiro, operações) não usam o mesmo capital.
      const [wallet] = await tx.select().from(wallets).where(eq(wallets.tenantId, tenantId)).for("update");
      if (!wallet) return { ok: false, error: "Defina o capital inicial da carteira (tela Capital) antes de registrar pagamentos." };
      const [repeated] = await tx.select().from(investmentPayments).where(and(eq(investmentPayments.tenantId, tenantId), eq(investmentPayments.idempotencyKey, payment.requestId)));
      if (repeated) {
        const same = repeated.scheduleItemId === payment.scheduleItemId && repeated.kind === payment.kind && repeated.amountCents === payment.amountCents && repeated.paidOn === payment.paidOn;
        return same
          ? { ok: true, message: "Este pagamento já estava registrado. Nada foi lançado em dobro." }
          : { ok: false, error: "Este formulário já registrou um pagamento com outros dados. Confira a lista e, para uma nova baixa, abra o formulário de novo." };
      }
      // Trava a linha do cronograma (e o contrato): baixas simultâneas da mesma obrigação esperam uma pela outra.
      const [item] = await tx.select().from(investmentScheduleItems)
        .where(and(eq(investmentScheduleItems.id, payment.scheduleItemId), eq(investmentScheduleItems.tenantId, tenantId))).for("update");
      if (!item) return { ok: false, error: "Obrigação não encontrada nesta carteira." };
      const [row] = await tx.select({ investment: investments, investorName: investors.name }).from(investments)
        .innerJoin(investors, and(eq(investors.id, investments.investorId), eq(investors.tenantId, investments.tenantId)))
        .where(and(eq(investments.id, item.investmentId), eq(investments.tenantId, tenantId)));
      if (!row) return { ok: false, error: "Obrigação não encontrada nesta carteira." };
      const { investment } = row;
      const expectedCents = payment.kind === "YIELD" ? item.yieldCents : item.principalCents;
      if (expectedCents <= 0) return { ok: false, error: `Esta linha do cronograma não tem ${OBLIGATION_KINDS[payment.kind].toLowerCase()} previsto.` };
      const [{ paid }] = await tx.select({ paid: sql<string>`coalesce(sum(${investmentPayments.amountCents}), 0)` }).from(investmentPayments)
        .where(and(eq(investmentPayments.tenantId, tenantId), eq(investmentPayments.scheduleItemId, item.id), eq(investmentPayments.kind, payment.kind)));
      const balanceCents = expectedCents - Number(paid);
      const startedOn = cycleStartedOn(wallet);
      const beforeCycle = Boolean(startedOn && payment.paidOn < startedOn);
      if (beforeCycle && !historical) return { ok: false, error: `A data do pagamento (${formatDate(payment.paidOn)}) é anterior ao início do capital (${formatDate(startedOn as string)}). Confirme que é um pagamento histórico para registrar sem mexer no capital. Nada foi registrado.` };
      if (historical && !beforeCycle) return { ok: false, error: `Pagamento histórico só vale para datas anteriores ao início do capital (${startedOn ? formatDate(startedOn) : "—"}). Nesta data o pagamento sai do capital normalmente. Nada foi registrado.` };
      const check = checkPayment(payment, { today: todayIso(), startDate: investment.startDate, cycleStartedOn: historical ? null : startedOn, balanceCents, investmentStatus: investment.status });
      if (!check.ok) return check;
      if (historical) return registerHistoricalPayment({ tx, tenantId, session, payment, item, investment, investorName: row.investorName, balanceCents, cycleNumber: wallet.cycleNumber });
      // Mesma regra das saídas do Financeiro: o capital não pode ficar negativo hoje nem em nenhuma data a partir da baixa.
      const capital = await tenantCapital(tx, tenantId);
      const outflow = checkOutflow({ ledger: [...capital.capitalLedger].reverse(), amountCents: payment.amountCents, occurredAt: payment.paidOn, availableCents: capital.summary.availableCents });
      if (!outflow.ok) return outflow;
      // Regra da entrada (migração 0023): contrato novo só com a entrada registrada; contrato antigo com a entrada ou com
      // o aporte anterior indicado. O banco confere de novo no gatilho da baixa.
      // Renovação (migração 0024): contrato já renovado não recebe baixa de principal; a renovação usa a entrada do contrato
      // de origem. O banco confere as duas coisas de novo.
      const [chain] = await tx.select({
        renewed: sql<boolean>`exists (select 1 from investment r where r.renewed_from_investment_id = ${investment.id} and r.tenant_id = ${tenantId})`,
        originHasCapital: sql<boolean>`crediai_investment_has_capital(${tenantId}, ${investment.id})`,
      }).from(investments).where(and(eq(investments.id, investment.id), eq(investments.tenantId, tenantId)));
      if (payment.kind === "PRINCIPAL" && chain.renewed) return { ok: false, error: "Este contrato foi renovado: o principal que faltava devolver passou para a renovação. Registre a devolução no contrato novo. Nada foi registrado." };
      const evidence = await loadEntryEvidence(tx, tenantId, investment.id);
      const allowed = entryEvidence({ capitalEntryRule: investment.capitalEntryRule, hasEntry: evidence.entries.has(investment.id), hasPriorContribution: evidence.priors.has(investment.id),
        renewedFrom: investment.renewedFromInvestmentId, originHasCapital: chain.originHasCapital });
      if (!allowed.ok) return { ok: false, error: `${allowed.error} Nada foi registrado.` };
      const label = contractLabel(investment);
      const category = paymentCategory(payment.kind);
      const movementId = id("cap");
      await tx.insert(capitalMovements).values({
        id: movementId, tenantId, kind: "WITHDRAWAL", category, source: "INVESTOR", amountCents: payment.amountCents, occurredAt: payment.paidOn, cycleNumber: wallet.cycleNumber,
        description: `${INVESTOR_CATEGORIES[category]} · ${row.investorName} · ${label} · parcela ${item.number}`, notes: payment.notes, createdByUserId: session.user.id,
        idempotencyKey: `ivp-${payment.requestId}`,
      });
      const paymentId = id("ivp");
      await tx.insert(investmentPayments).values({
        id: paymentId, tenantId, investmentId: investment.id, scheduleItemId: item.id, kind: payment.kind, amountCents: payment.amountCents, paidOn: payment.paidOn,
        method: payment.method, reference: payment.reference, notes: payment.notes, capitalMovementId: movementId, idempotencyKey: payment.requestId, createdByUserId: session.user.id,
      });
      const remaining = balanceCents - payment.amountCents;
      // Auditoria na mesma transação. Sem observações (texto livre) e com a referência mascarada (sem conta, chave ou
      // documento completos); nenhum dado bancário do investidor entra aqui.
      await recordAdminAudit(tx, session, {
        action: "INVESTMENT_PAYMENT_REGISTERED", entity: "investment_payment", entityId: paymentId, tenantId, tenantName: await tenantName(tx, tenantId),
        description: `${INVESTOR_CATEGORIES[category]}: baixa registrada para ${row.investorName}`,
        after: {
          kind: OBLIGATION_KINDS[payment.kind], amountCents: payment.amountCents, paidOn: payment.paidOn, method: PAYMENT_METHODS[payment.method], reference: maskReference(payment.reference),
          notes: payment.notes ? "preenchidas" : null, investmentId: investment.id, investorId: investment.investorId, contract: label, scheduleItemId: item.id, installment: item.number,
          dueDate: item.dueDate, capitalMovementId: movementId, balanceAfterCents: remaining, cycleNumber: wallet.cycleNumber,
        },
      });
      return { ok: true, message: `Baixa de ${formatMoney(payment.amountCents)} registrada (${OBLIGATION_KINDS[payment.kind]}). ${remaining > 0 ? `Saldo da obrigação: ${formatMoney(remaining)}.` : "Obrigação paga."}` };
    });
    if (result.ok) refresh();
    return result;
  } catch (error) {
    if (dbRule(error)) return { ok: false, error: "O pagamento não confere com o saldo da obrigação ou já foi registrado. Nada foi lançado. Recarregue a página e confira." };
    throw error;
  }
}

// Contrato antigo (cadastrado antes da regra da entrada, migração 0023): o usuário indica o aporte comum pelo qual o
// dinheiro do contrato já entrou no capital. Não lança nada no capital (o dinheiro já está lá); só liga o contrato ao
// aporte, com confirmação explícita e auditoria. No máximo uma vez por contrato e nunca junto com a entrada.
export async function declarePriorContributionAction(data: FormData): Promise<ActionResult> {
  const investmentId = field(data, "investmentId", 80);
  const movementId = field(data, "movementId", 80);
  const requestId = field(data, "requestId", 80);
  if (!investmentId) return { ok: false, error: "Investimento inválido." };
  if (!movementId) return { ok: false, error: "Escolha o aporte pelo qual o dinheiro deste contrato entrou no capital." };
  if (field(data, "confirm", 4) !== "1") return { ok: false, error: "Confirme que o dinheiro deste contrato entrou no capital por esse aporte." };
  if (!REQUEST_ID.test(requestId)) return { ok: false, error: "Formulário expirado. Recarregue a página e tente de novo." };
  try {
    const result = await withTenantContext(async (tx, { tenantId, session }): Promise<ActionResult> => {
      // Mesma ordem de travas da entrada (carteira, depois contrato): indicação e entrada simultâneas esperam uma pela outra.
      const [wallet] = await tx.select().from(wallets).where(eq(wallets.tenantId, tenantId)).for("update");
      if (!wallet) return { ok: false, error: "Defina o capital inicial da carteira (tela Capital) antes." };
      const [row] = await tx.select({ investment: investments, investorName: investors.name }).from(investments)
        .innerJoin(investors, and(eq(investors.id, investments.investorId), eq(investors.tenantId, investments.tenantId)))
        .where(and(eq(investments.id, investmentId), eq(investments.tenantId, tenantId))).for("update", { of: investments });
      if (!row) return { ok: false, error: "Investimento não encontrado nesta carteira." };
      const { investment } = row;
      const [repeated] = await tx.select().from(investmentPriorContributions).where(and(eq(investmentPriorContributions.tenantId, tenantId), eq(investmentPriorContributions.idempotencyKey, requestId)));
      if (repeated) {
        return repeated.investmentId === investment.id && repeated.capitalMovementId === movementId
          ? { ok: true, message: "O aporte anterior deste contrato já estava indicado. Nada foi alterado." }
          : { ok: false, error: "Este formulário já foi usado. Recarregue a página." };
      }
      const [entry] = await tx.select({ id: investmentCapitalEntries.id }).from(investmentCapitalEntries)
        .where(and(eq(investmentCapitalEntries.tenantId, tenantId), eq(investmentCapitalEntries.investmentId, investment.id)));
      const [declared] = await tx.select({ id: investmentPriorContributions.id }).from(investmentPriorContributions)
        .where(and(eq(investmentPriorContributions.tenantId, tenantId), eq(investmentPriorContributions.investmentId, investment.id)));
      const [movement] = await tx.select().from(capitalMovements)
        .where(and(eq(capitalMovements.id, movementId), eq(capitalMovements.tenantId, tenantId))).for("update");
      const [reversal] = movement ? await tx.select({ id: capitalMovements.id }).from(capitalMovements)
        .where(and(eq(capitalMovements.tenantId, tenantId), eq(capitalMovements.reversedMovementId, movement.id))) : [];
      const check = checkPriorContribution({
        investment: { capitalEntryRule: investment.capitalEntryRule, hasEntry: Boolean(entry), status: investment.status }, alreadyDeclared: Boolean(declared),
        movement: movement ? { id: movement.id, kind: movement.kind, source: movement.source, occurredAt: movement.occurredAt, amountCents: movement.amountCents, reversed: Boolean(reversal), cycleNumber: movement.cycleNumber } : null,
        currentCycle: wallet.cycleNumber, today: todayIso(),
      });
      if (!check.ok) return check;
      const priorId = id("ipc");
      await tx.insert(investmentPriorContributions).values({ id: priorId, tenantId, investmentId: investment.id, capitalMovementId: movement!.id, idempotencyKey: requestId, createdByUserId: session.user.id });
      const label = contractLabel(investment);
      await recordAdminAudit(tx, session, {
        action: "INVESTMENT_PRIOR_CONTRIBUTION_DECLARED", entity: "investment", entityId: investment.id, tenantId, tenantName: await tenantName(tx, tenantId),
        description: `Aporte anterior indicado para o investimento de ${row.investorName}`,
        after: {
          investmentId: investment.id, investorId: investment.investorId, contract: label, investmentAmountCents: investment.amountCents, capitalMovementId: movement!.id,
          contributionAmountCents: movement!.amountCents, contributionDate: movement!.occurredAt, priorContributionId: priorId, cycleNumber: wallet.cycleNumber,
        },
      });
      return { ok: true, message: `Aporte de ${formatMoney(movement!.amountCents)} em ${formatDate(movement!.occurredAt)} indicado como a entrada do dinheiro deste contrato. As baixas já podem ser registradas.` };
    });
    if (result.ok) refresh();
    return result;
  } catch (error) {
    if (dbRule(error)) return { ok: false, error: "O aporte não pôde ser indicado (já indicado, entrada já registrada ou aporte inválido). Nada foi registrado. Recarregue a página." };
    throw error;
  }
}
