"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { PROPOSAL_DOCUMENTS } from "@/lib/credit/documents";
import { maskCpf, maskPhone } from "@/lib/finance/format";
import { MoneyInput } from "@/app/money-input";
import { loginApplicantAction, logoutApplicantAction, registerApplicantAction, saveProposalDraftAction, submitProposalAction, uploadProposalDocumentAction } from "./actions";

type Result = { ok: true; message: string } | { ok: false; error: string };
type Proposal = { status: string; phaseLabel: string; decisionNote: string | null; values: { name: string; cpf: string; phone: string; requested: string; income: string; termMonths: string }; documents: { kind: string; fileName: string }[] } | null;

export function PortalClient({ token, tenantName, applicant, proposal }: { token: string; tenantName: string; applicant: { name: string; email: string } | null; proposal: Proposal }) {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "register">("register");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

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
  const have = new Set(proposal?.documents.map((doc) => doc.kind));
  const allDocs = PROPOSAL_DOCUMENTS.every((doc) => have.has(doc.kind));
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
      <p>Acompanhe por aqui. Entraremos em contato pelo telefone ou e-mail informados.</p>
      {logout}
    </section></main>;
  }

  const v = proposal?.values;
  return <main className="auth-page"><section className="auth-card auth-card-login proposal-card">
    {header}
    <p>Passo 1 de 3: seus dados e o crédito que você precisa.</p>
    <form onSubmit={submit((data) => saveProposalDraftAction(token, data))}>
      <label>Nome completo<input name="name" required maxLength={120} defaultValue={v?.name ?? applicant.name} /></label>
      <label>CPF<input name="cpf" inputMode="numeric" required maxLength={14} defaultValue={v ? maskCpf(v.cpf) : ""} onChange={(event) => { event.currentTarget.value = maskCpf(event.currentTarget.value); }} /></label>
      <label>Telefone com DDD<input name="phone" inputMode="tel" required maxLength={16} defaultValue={v ? maskPhone(v.phone) : ""} onChange={(event) => { event.currentTarget.value = maskPhone(event.currentTarget.value); }} /></label>
      <label>Renda mensal (R$)<MoneyInput name="income" required defaultValue={v?.income ?? ""} /></label>
      <label>Valor que você precisa (R$)<MoneyInput name="requested" required defaultValue={v?.requested ?? ""} /></label>
      <label>Prazo desejado (meses)<input name="termMonths" inputMode="numeric" required maxLength={3} defaultValue={v?.termMonths ?? ""} /></label>
      <button className="auth-submit auth-submit-login" disabled={busy}>{busy ? "Aguarde…" : proposal ? "Salvar alterações" : "Salvar e continuar"}<span>→</span></button>
    </form>
    {proposal && <>
      <h2>Passo 2 de 3: documentos (PDF ou imagem, até 4 MB cada)</h2>
      <ul className="proposal-docs">{PROPOSAL_DOCUMENTS.map((doc) => (
        <li key={doc.kind}>
          <span>{have.has(doc.kind) ? "✓" : "○"} {doc.label}</span>
          <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" aria-label={doc.label} disabled={busy} onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (!file) return;
            const data = new FormData();
            data.set("kind", doc.kind);
            data.set("file", file);
            void run(() => uploadProposalDocumentAction(token, data));
          }} />
        </li>
      ))}</ul>
      <h2>Passo 3 de 3: enviar</h2>
      <button className="auth-submit auth-submit-login" disabled={busy || !allDocs} onClick={() => void run(() => submitProposalAction(token))}>{allDocs ? "Enviar proposta" : "Envie os 4 documentos para continuar"}<span>→</span></button>
    </>}
    {note}
    {logout}
  </section></main>;
}
