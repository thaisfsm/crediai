"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { maskCpf } from "@/lib/finance/format";
import type { ClientData } from "@/lib/credit/client-data-steps";
import { ClientDataWizard } from "@/app/proposta/client-data-wizard";
import { confirmFillCpfAction, leaveFillAction, saveFillProposalAction, saveFillStepAction, submitFillAction, uploadFillDocumentAction } from "./actions";

type Values = { name: string; cpf: string; phone: string; email: string; requested: string; income: string; termMonths: string; requestedCents: number; incomeCents: number | null };
type Proposal = { submittedAt: string | null; values: Values; clientData: ClientData; documents: { kind: string; fileName: string }[] } | null;

export function FillClient({ token, tenantName, proposal }: { token: string; tenantName: string; proposal: Proposal }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const brand = <div className="auth-brand auth-brand-login"><Image src="/brand/crediai-logo-transparent.png" width={2172} height={724} alt="CrediAI" priority /></div>;
  const kicker = <div className="auth-kicker"><i /> PROPOSTA DE CRÉDITO · {tenantName}</div>;
  const leave = <p><button type="button" className="auth-link-button" onClick={() => void leaveFillAction().then(() => router.refresh())}>Sair</button></p>;

  if (!proposal) {
    const confirm = (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      if (busy) return;
      setBusy(true); setMessage(null);
      void confirmFillCpfAction(token, data).then((result) => { if (result.ok) router.refresh(); else setMessage(result.error); })
        .catch(() => setMessage("Não foi possível confirmar. Tente novamente.")).finally(() => setBusy(false));
    };
    return <main className="auth-page"><section className="auth-card auth-card-login">
      {brand}{kicker}
      <h1>Complete sua proposta</h1>
      <p>Para proteger seus dados, confirme o CPF informado na proposta. Depois você preenche o cadastro em etapas e anexa os documentos.</p>
      <form onSubmit={confirm}>
        <label>Seu CPF<input name="cpf" inputMode="numeric" required maxLength={14} autoComplete="off" onChange={(event) => { event.currentTarget.value = maskCpf(event.currentTarget.value); }} /></label>
        {message && <div className="auth-error" role="alert">{message}</div>}
        <button className="auth-submit auth-submit-login" disabled={busy}>{busy ? "Aguarde…" : "Continuar"}<span>→</span></button>
      </form>
    </section></main>;
  }

  const header = <>{brand}{kicker}<h1>Olá, {proposal.values.name.split(" ")[0]}</h1></>;
  if (proposal.submittedAt) {
    return <main className="auth-page"><section className="auth-card auth-card-login">
      {header}
      <div className="auth-ok" role="status">Cadastro enviado em {new Date(proposal.submittedAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" })}. Obrigado! Entraremos em contato pelos dados informados.</div>
      {leave}
    </section></main>;
  }
  const v = proposal.values;
  return <main className="auth-page"><section className="auth-card auth-card-login proposal-card">
    {header}
    <ClientDataWizard
      proposal={{ exists: true, name: v.name, cpf: v.cpf, phone: v.phone, email: v.email, income: v.income, requested: v.requested, termMonths: v.termMonths, requestedCents: v.requestedCents, incomeCents: v.incomeCents, ownerProposal: true }}
      clientData={proposal.clientData} documents={proposal.documents}
      actions={{
        saveProposal: (data) => saveFillProposalAction(token, data),
        saveStep: (step, data) => saveFillStepAction(token, step, data),
        upload: (data) => uploadFillDocumentAction(token, data),
        submit: () => submitFillAction(token),
      }}
      footer={leave} />
  </section></main>;
}
