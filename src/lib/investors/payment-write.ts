import "server-only";
import { eq } from "drizzle-orm";
import { recordAdminAudit } from "@/lib/admin/audit";
import type { TenantTransaction } from "@/lib/auth/guards";
import { capitalMovements, investmentPayments, investmentScheduleItems, investments, tenants } from "@/lib/db/schema";
import { INVESTOR_CATEGORIES, OBLIGATION_KINDS, PAYMENT_METHODS, contractLabel, maskReference, paymentCategory, type PaymentFields } from "./payables";
import { randomUUID } from "node:crypto";

const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
async function tenantName(tx: TenantTransaction, tenantId: string) {
  const [row] = await tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId));
  return row?.name ?? null;
}

// Grava UMA baixa com a saída de capital ligada e a auditoria (sem conferências: quem chama já travou e conferiu tudo).
// Usada pela baixa de Contas a Pagar e pela liquidação antecipada do contrato.
export async function insertCapitalPayment({ tx, tenantId, session, payment, item, investment, investorName, balanceCents, cycleNumber, auditNote }: {
  tx: TenantTransaction; tenantId: string; session: { user: { id: string } } & Parameters<typeof recordAdminAudit>[1]; payment: PaymentFields; item: Pick<typeof investmentScheduleItems.$inferSelect, "id" | "number" | "dueDate">;
  investment: typeof investments.$inferSelect; investorName: string; balanceCents: number; cycleNumber: number; auditNote?: string;
}) {
  const label = contractLabel(investment);
  const category = paymentCategory(payment.kind);
  const movementId = id("cap");
  await tx.insert(capitalMovements).values({
    id: movementId, tenantId, kind: "WITHDRAWAL", category, source: "INVESTOR", amountCents: payment.amountCents, occurredAt: payment.paidOn, cycleNumber,
    description: `${INVESTOR_CATEGORIES[category]} · ${investorName} · ${label} · ${auditNote ?? `parcela ${item.number}`}`, notes: payment.notes, createdByUserId: session.user.id,
    idempotencyKey: `ivp-${payment.requestId}`,
  });
  const paymentId = id("ivp");
  await tx.insert(investmentPayments).values({
    id: paymentId, tenantId, investmentId: investment.id, scheduleItemId: item.id, kind: payment.kind, amountCents: payment.amountCents, paidOn: payment.paidOn,
    method: payment.method, reference: payment.reference, notes: payment.notes, capitalMovementId: movementId, idempotencyKey: payment.requestId, createdByUserId: session.user.id,
  });
  // Auditoria na mesma transação. Sem observações (texto livre) e com a referência mascarada (sem conta, chave ou
  // documento completos); nenhum dado bancário do investidor entra aqui.
  await recordAdminAudit(tx, session, {
    action: "INVESTMENT_PAYMENT_REGISTERED", entity: "investment_payment", entityId: paymentId, tenantId, tenantName: await tenantName(tx, tenantId),
    description: `${INVESTOR_CATEGORIES[category]}: baixa registrada para ${investorName}${auditNote ? ` (${auditNote.toLowerCase()})` : ""}`,
    after: {
      kind: OBLIGATION_KINDS[payment.kind], amountCents: payment.amountCents, paidOn: payment.paidOn, method: PAYMENT_METHODS[payment.method], reference: maskReference(payment.reference),
      notes: payment.notes ? "preenchidas" : null, investmentId: investment.id, investorId: investment.investorId, contract: label, scheduleItemId: item.id, installment: item.number,
      dueDate: item.dueDate, capitalMovementId: movementId, balanceAfterCents: balanceCents - payment.amountCents, cycleNumber,
    },
  });
  return movementId;
}

