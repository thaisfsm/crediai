import "server-only";
import { and, eq, sql } from "drizzle-orm";
import type { TenantTransaction } from "@/lib/auth/guards";
import { recordAdminAudit, type AuditActor } from "@/lib/admin/audit";
import { creditProposals, tenants } from "@/lib/db/schema";
import { formatMoney } from "@/lib/finance/format";

type Proposal = typeof creditProposals.$inferSelect;
type Result = { ok: true; message: string } | { ok: false; error: string };

// Resposta do cliente à oferta aprovada (fase 7). Aceitar só registra data, hora e origem: não cria contrato nem mexe no capital.
// Recusar reprova a proposta com o motivo. Cada resposta vale uma vez e fica na auditoria.
export async function respondToOffer(tx: TenantTransaction, tenantId: string, proposal: Proposal, decision: "accept" | "decline", actor: AuditActor, via: "APPLICANT" | "OWNER"): Promise<Result> {
  if (proposal.status !== "OPEN" || proposal.phase !== "ACCEPTANCE" || proposal.offerCents === null || proposal.offerTermMonths === null || proposal.offerRateBps === null) return { ok: false, error: "Esta proposta não tem uma oferta disponível para resposta." };
  if (proposal.acceptedAt) return { ok: false, error: "Esta oferta já foi aceita." };
  const [tenant] = await tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId));
  const offer = { offerCents: proposal.offerCents, termMonths: proposal.offerTermMonths, rateBps: proposal.offerRateBps, via };
  const where = and(eq(creditProposals.id, proposal.id), eq(creditProposals.tenantId, tenantId));
  if (decision === "accept") {
    await tx.update(creditProposals).set({ acceptedAt: sql`now()`, acceptedVia: via }).where(where);
    await recordAdminAudit(tx, actor, { action: "CREDIT_PROPOSAL_ACCEPTED", entity: "wallet", entityId: proposal.id, tenantId, tenantName: tenant?.name ?? null, description: `Oferta de ${formatMoney(proposal.offerCents)} aceita por ${proposal.applicantName}.`, before: null, after: offer });
    return { ok: true, message: "Oferta aceita. Obrigado!" };
  }
  await tx.update(creditProposals).set({ status: "REJECTED", decisionNote: "Oferta recusada pelo cliente." }).where(where);
  await recordAdminAudit(tx, actor, { action: "CREDIT_PROPOSAL_DECLINED", entity: "wallet", entityId: proposal.id, tenantId, tenantName: tenant?.name ?? null, description: `Oferta de ${formatMoney(proposal.offerCents)} recusada por ${proposal.applicantName}.`, before: null, after: offer });
  return { ok: true, message: "Oferta recusada." };
}
