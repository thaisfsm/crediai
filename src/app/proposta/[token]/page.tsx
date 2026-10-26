import { and, eq } from "drizzle-orm";
import { DatabaseErrorState, databaseGate } from "@/app/database-error-state";
import { currentApplicant, tenantOfLink, withLinkTenant } from "@/lib/credit/portal";
import { creditProposalDocuments, creditProposals } from "@/lib/db/schema";
import { PROPOSAL_PHASES } from "@/lib/credit/phases";
import { centsToInput } from "@/lib/finance/format";
import { PortalClient } from "./portal-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Enviar proposta", robots: { index: false, follow: false } };

export default async function ProposalPortalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const gate = await databaseGate();
  if (gate !== "ok") return <DatabaseErrorState kind={gate === "not_configured" ? "error" : gate} />;
  const link = await tenantOfLink(token);
  if (!link) return <main className="auth-page"><section className="auth-card"><h1>Link indisponível</h1><p>Este link de proposta não existe ou foi desativado. Peça um novo link a quem enviou.</p></section></main>;
  const applicant = await currentApplicant(token);
  if (!applicant) return <PortalClient token={token} tenantName={link.tenantName} applicant={null} proposal={null} />;
  const proposal = await withLinkTenant(token, async (tx, tenantId) => {
    const [row] = await tx.select().from(creditProposals).where(and(eq(creditProposals.tenantId, tenantId), eq(creditProposals.applicantId, applicant.id)));
    if (!row) return null;
    const docs = await tx.select({ kind: creditProposalDocuments.kind, fileName: creditProposalDocuments.fileName }).from(creditProposalDocuments).where(eq(creditProposalDocuments.proposalId, row.id));
    return {
      status: row.status, phaseLabel: PROPOSAL_PHASES.find((phase) => phase.key === row.phase)?.label ?? row.phase, decisionNote: row.decisionNote,
      values: { name: row.applicantName, cpf: row.cpf, phone: row.phone ?? "", requested: centsToInput(row.requestedCents), income: row.monthlyIncomeCents ? centsToInput(row.monthlyIncomeCents) : "", termMonths: String(row.termMonths) },
      documents: docs,
    };
  });
  return <PortalClient token={token} tenantName={link.tenantName} applicant={{ name: applicant.name, email: applicant.email }} proposal={proposal} />;
}
