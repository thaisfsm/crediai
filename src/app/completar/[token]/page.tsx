import { eq } from "drizzle-orm";
import { DatabaseErrorState, databaseGate } from "@/app/database-error-state";
import { fillLinkTenantName, withConfirmedFillProposal } from "@/lib/credit/fill-link";
import { creditProposalDocuments } from "@/lib/db/schema";
import { centsToInput } from "@/lib/finance/format";
import { FillClient } from "./fill-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Completar proposta", robots: { index: false, follow: false } };

// Link individual de uma proposta do dono: sem a confirmação do CPF neste navegador, a tela não mostra nenhum dado da proposta.
export default async function FillProposalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const gate = await databaseGate();
  if (gate !== "ok") return <DatabaseErrorState kind={gate === "not_configured" ? "error" : gate} />;
  const tenantName = await fillLinkTenantName(token);
  if (!tenantName) return <main className="auth-page"><section className="auth-card"><h1>Link indisponível</h1><p>Este link não existe, venceu ou foi desativado. Peça um novo link a quem enviou.</p></section></main>;
  const proposal = await withConfirmedFillProposal(token, async (tx, _tenantId, row) => {
    const docs = await tx.select({ kind: creditProposalDocuments.kind, fileName: creditProposalDocuments.fileName }).from(creditProposalDocuments).where(eq(creditProposalDocuments.proposalId, row.id));
    return {
      submittedAt: row.clientDataSubmittedAt?.toISOString() ?? null,
      values: { name: row.applicantName, cpf: row.cpf, phone: row.phone ?? "", email: row.email ?? "", requested: centsToInput(row.requestedCents), income: row.monthlyIncomeCents ? centsToInput(row.monthlyIncomeCents) : "", termMonths: String(row.termMonths), requestedCents: row.requestedCents, incomeCents: row.monthlyIncomeCents },
      clientData: row.clientData ?? {},
      documents: docs,
    };
  });
  return <FillClient token={token} tenantName={tenantName} proposal={proposal} />;
}
