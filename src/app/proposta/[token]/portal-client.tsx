"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { formatMoney, formatRate } from "@/lib/finance/format";
import type { ClientData } from "@/lib/credit/client-data-steps";
import { ClientDataWizard } from "../client-data-wizard";
import { loginApplicantAction, logoutApplicantAction, registerApplicantAction, saveApplicantStepAction, saveProposalDraftAction, submitProposalAction, respondToOfferAction, uploadProposalDocumentAction } from "./actions";

type Result = { ok: true; message: string } | { ok: false; error: string };

type Offer = { cents: number; termMonths: number; rateBps: number; interestCents: number; totalCents: number; installmentCents: number; acceptedAt: string | null };
type Proposal = { offer: Offer | null; status: string; phaseLabel: string; decisionNote: string | null; values: { name: string; cpf: string; phone: string; email: string; requested: string; income: string; termMonths: string; requestedCents: number; incomeCents: number | null }; clientData: ClientData; documents: { kind: string; fileName: string }[] } | null;

export function PortalClient({ token, tenantName, applicant, proposal }: { token: string; tenantName: string; applicant: { name: string; email: string } | null; proposal: Proposal }) {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "register">("register");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<"accept" | "decline" | null>(null);

  async function run(task: () => Promise<Result>, after?: () => void) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await task();
      setMessage(result.ok ? { tone: "ok", text: result.message } : { tone: "error", text: result.error });
      if (result.ok) { after?.(); router.refresh(); }
    } catch {
      setMessage({ tone: "error", text: "Não foi possível concluir. Tente novamente." });
    } finally {
      setBusy(false);
    }
  }
  const submit = (action: (data: FormData) => Promise<Result>) => (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void run(() => action(data));
  };
  const note = message && <div className={message.tone === "error" ? "auth-error" : "auth-ok"} role={message.tone === "error" ? "alert" : "status"}>{message.text}</div>;
  const brand = <div className="auth-brand auth-brand-login"><Image src="/brand/crediai-logo-transparent.png" width={2172} height={724} alt="CrediAI" priority /></div>;

  if (!applicant) {
    return <main className="auth-page"><section className="auth-card auth-card-login">
      {brand}
      <div className="auth-kicker"><i /> PROPOSTA DE CRÉDITO</div>
      <h1>{mode === "register" ? "Crie sua conta" : "Entre na sua conta"}</h1>
      <p>Envie sua proposta para {tenantName}. Você cria um acesso, preenche os dados e anexa os documentos.</p>
      {mode === "register" ? (
        <form onSubmit={submit((data) => registerApplicantAction(token, data))}>
          <label>Nome completo<input name="name" required maxLength={120} autoComplete="name" /></label>
          <label>E-mail<input name="email" type="email" required maxLength={160} autoComplete="email" /></label>
          <label>Senha (mínimo 8 caracteres)<input name="password" type="password" required minLength={8} maxLength={128} autoComplete="new-password" /></label>
          {note}
          <button className="auth-submit auth-submit-login" disabled={busy}>{busy ? "Aguarde…" : "Criar conta"}<span>→</span></button>
        </form>
      ) : (
        <form onSubmit={submit((data) => loginApplicantAction(token, data))}>
          <label>E-mail<input name="email" type="email" required maxLength={160} autoComplete="email" /></label>
          <label>Senha<input name="password" type="password" required maxLength={128} autoComplete="current-password" /></label>
          {note}
          <button className="auth-submit auth-submit-login" disabled={busy}>{busy ? "Aguarde…" : "Entrar"}<span>→</span></button>
        </form>
      )}
      <p><button type="button" className="auth-link-button" onClick={() => { setMode(mode === "register" ? "login" : "register"); setMessage(null); }}>{mode === "register" ? "Já tenho conta. Entrar" : "Ainda não tenho conta. Criar"}</button></p>
    </section></main>;
  }

  const sent = proposal && proposal.status !== "DRAFT";
  const header = <>
    {brand}
    <div className="auth-kicker"><i /> PROPOSTA DE CRÉDITO · {tenantName}</div>
    <h1>Olá, {applicant.name.split(" ")[0]}</h1>
  </>;
  const logout = <p><button type="button" className="auth-link-button" onClick={() => void run(async () => { await logoutApplicantAction(); return { ok: true, message: "Você saiu." }; })}>Sair</button></p>;

  if (sent) {
    return <main className="auth-page"><section className="auth-card auth-card-login">
      {header}
      {proposal.status === "REJECTED"
        ? <div className="auth-error">Sua proposta não foi aprovada.{proposal.decisionNote ? ` Motivo: ${proposal.decisionNote}` : ""}</div>
        : <div className="auth-ok" role="status">Proposta enviada. Etapa atual: <strong>{proposal.phaseLabel}</strong>.</div>}
      {proposal.status === "OPEN" && proposal.offer && (
        <div className="proposal-offer" aria-label="Oferta aprovada">
          <h2>Sua oferta aprovada</h2>
          <dl>
            <dt>Valor</dt><dd>{formatMoney(proposal.offer.cents)}</dd>
            <dt>Prazo</dt><dd>{proposal.offer.termMonths} meses</dd>
            <dt>Taxa de juros</dt><dd>{formatRate(proposal.offer.rateBps)} ao mês</dd>
            <dt>Parcela mensal</dt><dd>{formatMoney(proposal.offer.installmentCents)}</dd>
            <dt>Total a pagar</dt><dd>{formatMoney(proposal.offer.totalCents)}</dd>
          </dl>
          {proposal.offer.acceptedAt ? (
            <div className="auth-ok" role="status">Oferta aceita em {new Date(proposal.offer.acceptedAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" })}. Entraremos em contato para os próximos passos.</div>
          ) : confirming ? (
            <div className="proposal-offer-actions">
              <strong>{confirming === "accept" ? "Confirmar o aceite desta oferta?" : "Confirmar que você recusa esta oferta?"}</strong>
              <button className="auth-submit auth-submit-login" disabled={busy} onClick={() => void run(() => respondToOfferAction(token, confirming), () => setConfirming(null))}>{busy ? "Aguarde…" : confirming === "accept" ? "Sim, aceitar" : "Sim, recusar"}</button>
              <button type="button" className="auth-link-button" disabled={busy} onClick={() => setConfirming(null)}>Voltar</button>
            </div>
          ) : (
            <div className="proposal-offer-actions">
              <button className="auth-submit auth-submit-login" onClick={() => setConfirming("accept")}>Aceitar oferta<span>→</span></button>
              <button type="button" className="auth-link-button" onClick={() => setConfirming("decline")}>Recusar oferta</button>
            </div>
          )}
        </div>
      )}
      <p>Acompanhe por aqui. Entraremos em contato pelo telefone ou e-mail informados.</p>
      {logout}
    </section></main>;
  }

  const v = proposal?.values;
  return <main className="auth-page"><section className="auth-card auth-card-login proposal-card">
    {header}
    <ClientDataWizard
      proposal={{ exists: Boolean(proposal), name: v?.name ?? applicant.name, cpf: v?.cpf ?? "", phone: v?.phone ?? "", email: v?.email ?? applicant.email, income: v?.income ?? "", requested: v?.requested ?? "", termMonths: v?.termMonths ?? "", requestedCents: v?.requestedCents ?? null, incomeCents: v?.incomeCents ?? null, ownerProposal: false }}
      clientData={proposal?.clientData ?? {}} documents={proposal?.documents ?? []}
      actions={{
        saveProposal: (data) => saveProposalDraftAction(token, data),
        saveStep: (step, data) => saveApplicantStepAction(token, step, data),
        upload: (data) => uploadProposalDocumentAction(token, data),
        submit: () => submitProposalAction(token),
      }}
      footer={<>{note}{logout}</>} />
  </section></main>;
}
