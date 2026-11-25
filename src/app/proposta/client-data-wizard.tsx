"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { PROPOSAL_DOCUMENTS } from "@/lib/credit/documents";
import { CLIENT_DATA_STEPS, filledSteps, missingForSubmit, type ClientData, type ClientDataStepKey } from "@/lib/credit/client-data-steps";
import { guarantorPartLabels, referenceKey, referenceSlots } from "@/lib/finance/client-profile";
import { cnpjProblem, cpfProblem, formatCnpj, formatCpf, formatMoney, formatPhone, maskCnpj, maskCpf, maskPhone, todayIso } from "@/lib/finance/format";
import { MoneyInput } from "@/app/money-input";
import { DateField } from "@/app/date-field";
import { AddressFieldset, BankFieldset, MaskedInput, useCompanyNamePrefill } from "@/app/client-form-parts";

type Result = { ok: true; message: string } | { ok: false; error: string };
export type WizardProposal = {
  exists: boolean; name: string; cpf: string; phone: string; email: string; income: string; requested: string; termMonths: string;
  requestedCents: number | null; incomeCents: number | null;
  // Proposta cadastrada pelo dono: valor, prazo e CPF já combinados (só leitura no formulário).
  ownerProposal: boolean;
};
export type WizardActions = {
  saveProposal: (data: FormData) => Promise<Result>;
  saveStep: (step: ClientDataStepKey, data: FormData) => Promise<Result>;
  upload: (data: FormData) => Promise<Result>;
  submit: () => Promise<Result>;
};

// Foto de celular costuma passar de 4 MB (limite do envio). Imagens grandes são reduzidas no próprio aparelho antes de subir.
const UPLOAD_LIMIT = 4 * 1024 * 1024;
const SHRINK_ABOVE = 1.5 * 1024 * 1024;
async function shrinkImage(file: File): Promise<File> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size <= SHRINK_ABOVE) return file;
  try {
    const bitmap = await createImageBitmap(file);
    for (const [side, quality] of [[2000, 0.82], [1600, 0.72], [1200, 0.65]] as const) {
      const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (blob && blob.size <= UPLOAD_LIMIT - 64 * 1024) return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
    }
  } catch { /* navegador sem suporte: tenta enviar o original */ }
  return file;
}

const STEPS = [
  { key: "proposal", label: "Proposta" },
  ...CLIENT_DATA_STEPS.map((step) => ({ key: step.key, label: step.label })),
  { key: "documents", label: "Documentos" },
  { key: "review", label: "Revisar e enviar" },
] as const;
type StepKey = (typeof STEPS)[number]["key"];

// Formulário público em etapas, com os campos do cadastro de Clientes. Cada etapa é salva no servidor ao tocar em
// "Salvar e continuar": o cliente pode parar e voltar depois pelo mesmo link. Pensado primeiro para o celular.
export function ClientDataWizard({ proposal, clientData, documents, actions, footer }: { proposal: WizardProposal; clientData: ClientData; documents: { kind: string; fileName: string }[]; actions: WizardActions; footer?: ReactNode }) {
  const router = useRouter();
  const filled = filledSteps(clientData);
  const have = new Set(documents.map((doc) => doc.kind));
  const allDocs = PROPOSAL_DOCUMENTS.every((doc) => have.has(doc.kind));
  const firstOpen = (): StepKey => {
    if (!proposal.exists || !proposal.incomeCents) return "proposal";
    const step = CLIENT_DATA_STEPS.find((item) => !filled.includes(item.key));
    if (step) return step.key;
    return allDocs ? "review" : "documents";
  };
  const [step, setStep] = useState<StepKey>(firstOpen);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const index = STEPS.findIndex((item) => item.key === step);
  const go = (key: StepKey) => { setStep(key); setMessage(null); if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" }); };
  const next = () => go(STEPS[Math.min(index + 1, STEPS.length - 1)].key);

  async function run(task: () => Promise<Result>, after?: () => void) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await task();
      if (result.ok) { router.refresh(); if (after) after(); setMessage({ tone: "ok", text: result.message }); }
      else setMessage({ tone: "error", text: result.error });
    } catch {
      setMessage({ tone: "error", text: "Não foi possível salvar. Verifique a internet e tente de novo." });
    } finally {
      setBusy(false);
    }
  }
  const onSubmit = (save: (data: FormData) => Promise<Result>) => (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void run(() => save(data), next);
  };
  const note = message && <div className={message.tone === "error" ? "auth-error" : "auth-ok"} role={message.tone === "error" ? "alert" : "status"}>{message.text}</div>;
  const v = clientData;
  const company = useCompanyNamePrefill();
  const missing = missingForSubmit(clientData, { applicantName: proposal.name, cpf: proposal.cpf, phone: proposal.phone || null, monthlyIncomeCents: proposal.incomeCents });
  const stepDone = (key: StepKey) => key === "proposal" ? proposal.exists && Boolean(proposal.incomeCents) : key === "documents" ? allDocs : key === "review" ? false : filled.includes(key as ClientDataStepKey);
  const saveButton = <button className="auth-submit auth-submit-login" disabled={busy}>{busy ? "Salvando…" : "Salvar e continuar"}<span>→</span></button>;
  const back = index > 0 && <button type="button" className="auth-link-button" disabled={busy} onClick={() => go(STEPS[index - 1].key)}>← Voltar</button>;

  let body: ReactNode = null;
  if (step === "proposal") {
    body = (
      <form onSubmit={onSubmit(actions.saveProposal)} key="proposal">
        <label>Nome completo *<input name="name" required maxLength={120} defaultValue={proposal.name} autoComplete="name" /></label>
        {proposal.ownerProposal
          ? <label>CPF<input value={maskCpf(proposal.cpf)} readOnly aria-readonly="true" /><small>O CPF vem da proposta e não pode ser trocado por aqui.</small></label>
          : <label>CPF *<input name="cpf" inputMode="numeric" required maxLength={14} defaultValue={proposal.cpf ? maskCpf(proposal.cpf) : ""} onChange={(event) => { event.currentTarget.value = maskCpf(event.currentTarget.value); }} /></label>}
        <label>Telefone com DDD *<input name="phone" inputMode="tel" required maxLength={16} autoComplete="tel" defaultValue={proposal.phone ? maskPhone(proposal.phone) : ""} onChange={(event) => { event.currentTarget.value = maskPhone(event.currentTarget.value); }} /></label>
        <label>Renda mensal (R$) *<MoneyInput name="income" required defaultValue={proposal.income} /></label>
        {proposal.ownerProposal ? (
          <p className="proposal-summary">Crédito combinado: <strong>{proposal.requestedCents ? formatMoney(proposal.requestedCents) : "—"}</strong> em <strong>{proposal.termMonths} {proposal.termMonths === "1" ? "mês" : "meses"}</strong>.</p>
        ) : <>
          <label>Valor que você precisa (R$) *<MoneyInput name="requested" required defaultValue={proposal.requested} /></label>
          <label>Prazo desejado (meses) *<input name="termMonths" inputMode="numeric" required maxLength={3} defaultValue={proposal.termMonths} /></label>
        </>}
        {saveButton}
      </form>
    );
  } else if (step === "personal") {
    body = (
      <form onSubmit={onSubmit((data) => actions.saveStep("personal", data))} key="personal">
        <DateField label="Data de nascimento *" name="birthDate" min="1900-01-01" max={todayIso()} defaultValue={v.birthDate ?? ""} required className="field" />
        <label>WhatsApp<MaskedInput name="whatsapp" mask={maskPhone} initial={formatPhone(v.whatsapp ?? null) ?? (proposal.phone ? maskPhone(proposal.phone) : "")} inputMode="tel" placeholder="(11) 98765-4321" maxLength={40} /></label>
        <label>E-mail<input name="email" type="email" maxLength={160} defaultValue={v.email ?? proposal.email} placeholder="nome@exemplo.com" autoComplete="email" /></label>
        <label>Instagram<input name="instagram" maxLength={200} defaultValue={v.instagram ?? ""} placeholder="@usuario ou instagram.com/usuario" /></label>
        <label>Facebook<input name="facebook" maxLength={200} defaultValue={v.facebook ?? ""} placeholder="@usuario ou facebook.com/usuario" /></label>
        <label>TikTok<input name="tiktok" maxLength={200} defaultValue={v.tiktok ?? ""} placeholder="@usuario ou tiktok.com/@usuario" /></label>
        {saveButton}
      </form>
    );
  } else if (step === "home") {
    body = (
      <form onSubmit={onSubmit((data) => actions.saveStep("home", data))} key="home">
        <AddressFieldset legend="Endereço residencial (obrigatório, menos o complemento)" nameOf={(part) => `residential${part}`} initialOf={(part) => v[`residential${part}`] ?? ""} />
        {saveButton}
      </form>
    );
  } else if (step === "work") {
    body = (
      <form onSubmit={onSubmit((data) => actions.saveStep("work", data))} onInput={company.onInput} key="work">
        <p className="proposal-summary">Se você trabalha registrado ou tem empresa, preencha. Se não, toque em Salvar e continuar.</p>
        <label>CNPJ da empresa<MaskedInput name="businessCnpj" mask={maskCnpj} initial={formatCnpj(v.businessCnpj ?? null) ?? ""} validate={cnpjProblem} inputMode="numeric" placeholder="00.000.000/0000-00" maxLength={20} /></label>
        <label>Nome da empresa<input name="businessCompanyName" maxLength={160} defaultValue={v.businessCompanyName ?? ""} placeholder="Onde você trabalha" /></label>
        <DateField label="Data de admissão" name="businessAdmissionDate" min="1900-01-01" max={todayIso()} defaultValue={v.businessAdmissionDate ?? ""} className="field" />
        {company.notice && <p className="proposal-summary" role="status">{company.notice}</p>}
        <AddressFieldset legend="Endereço comercial" nameOf={(part) => `business${part}`} initialOf={(part) => v[`business${part}`] ?? ""} />
        {saveButton}
      </form>
    );
  } else if (step === "bank") {
    body = (
      <form onSubmit={onSubmit((data) => actions.saveStep("bank", data))} key="bank">
        <p className="proposal-summary">Conta onde você quer receber o crédito. Opcional.</p>
        <BankFieldset initial={v} />
        {saveButton}
      </form>
    );
  } else if (step === "references") {
    body = (
      <form onSubmit={onSubmit((data) => actions.saveStep("references", data))} key="references">
        {referenceSlots.map((slot) => (
          <fieldset className="form-section" key={slot}>
            <legend>Referência pessoal {slot}</legend>
            <div className="form-grid">
              <label className="field field-wide">Nome<input name={referenceKey(slot, "Name")} maxLength={160} defaultValue={v[referenceKey(slot, "Name")] ?? ""} /></label>
              <label className="field">Telefone<MaskedInput name={referenceKey(slot, "Phone")} mask={maskPhone} initial={formatPhone(v[referenceKey(slot, "Phone")] ?? null) ?? ""} inputMode="tel" placeholder="(11) 98765-4321" maxLength={40} /></label>
              <label className="field">Grau de parentesco<input name={referenceKey(slot, "Relationship")} placeholder="Irmão, vizinho, colega…" maxLength={160} defaultValue={v[referenceKey(slot, "Relationship")] ?? ""} /></label>
            </div>
          </fieldset>
        ))}
        <fieldset className="form-section">
          <legend>Avalista (se houver)</legend>
          <div className="form-grid">
            <label className="field field-wide">{guarantorPartLabels.Name}<input name="guarantorName" maxLength={160} defaultValue={v.guarantorName ?? ""} /></label>
            <label className="field">{guarantorPartLabels.Document}<MaskedInput name="guarantorDocument" mask={maskCpf} initial={formatCpf(v.guarantorDocument ?? null) ?? ""} validate={cpfProblem} inputMode="numeric" placeholder="000.000.000-00" maxLength={40} /></label>
            <label className="field">{guarantorPartLabels.Phone}<MaskedInput name="guarantorPhone" mask={maskPhone} initial={formatPhone(v.guarantorPhone ?? null) ?? ""} inputMode="tel" placeholder="(11) 98765-4321" maxLength={40} /></label>
            <label className="field field-wide">{guarantorPartLabels.Notes}<input name="guarantorNotes" placeholder="Opcional" maxLength={500} defaultValue={v.guarantorNotes ?? ""} /></label>
          </div>
        </fieldset>
        {saveButton}
      </form>
    );
  } else if (step === "documents") {
    body = <>
      <p className="proposal-summary">PDF ou foto, até 4 MB cada. Fotos grandes do celular são reduzidas antes de enviar.</p>
      <ul className="proposal-docs">{PROPOSAL_DOCUMENTS.map((doc) => (
        <li key={doc.kind}>
          <span>{have.has(doc.kind) ? "✓" : "○"} {doc.label}{have.has(doc.kind) ? ` (${documents.find((item) => item.kind === doc.kind)?.fileName})` : ""}</span>
          <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" aria-label={doc.label} disabled={busy} onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (!file) return;
            void run(async () => {
              const ready = await shrinkImage(file);
              if (ready.size > UPLOAD_LIMIT) return { ok: false, error: `"${doc.label}": o arquivo tem mais de 4 MB. Tire uma foto do documento ou envie um PDF menor.` };
              const data = new FormData();
              data.set("kind", doc.kind);
              data.set("file", ready);
              try {
                const result = await actions.upload(data);
                return result.ok ? { ok: true, message: `${doc.label}: recebido.` } : result;
              } catch {
                return { ok: false, error: `Não foi possível enviar "${doc.label}". Verifique a internet e tente de novo; se continuar, tire uma foto do documento.` };
              }
            });
          }} />
        </li>
      ))}</ul>
      <button type="button" className="auth-submit auth-submit-login" disabled={busy} onClick={next}>{allDocs ? "Continuar" : `Faltam ${PROPOSAL_DOCUMENTS.filter((doc) => !have.has(doc.kind)).length} documento(s). Ver o resumo`}<span>→</span></button>
    </>;
  } else {
    const missingDocs = PROPOSAL_DOCUMENTS.filter((doc) => !have.has(doc.kind));
    const ready = missing.length === 0 && missingDocs.length === 0;
    body = <>
      <ul className="proposal-checklist" aria-label="Resumo do preenchimento">
        {STEPS.filter((item) => item.key !== "review").map((item) => (
          <li key={item.key}><button type="button" className="auth-link-button" onClick={() => go(item.key)}>{stepDone(item.key) ? "✓" : "○"} {item.label}</button></li>
        ))}
      </ul>
      {missing.length > 0 && <p className="auth-error" role="status">Faltam campos obrigatórios: {missing.join(", ")}.</p>}
      {missingDocs.length > 0 && <p className="auth-error" role="status">Sua proposta ainda NÃO foi enviada. Faltam {missingDocs.length} documento(s).</p>}
      <button type="button" className="auth-submit auth-submit-login" disabled={busy || !ready} onClick={() => void run(actions.submit)}>{busy ? "Aguarde…" : ready ? "Enviar proposta" : "Complete o que falta para enviar"}<span>→</span></button>
    </>;
  }

  return <div className="proposal-wizard">
    <nav className="proposal-steps" aria-label="Etapas do formulário">
      <ol>{STEPS.map((item, position) => (
        <li key={item.key}>
          <button type="button" aria-current={item.key === step ? "step" : undefined} disabled={busy || (!proposal.exists && item.key !== "proposal")} onClick={() => go(item.key)}
            className={`${item.key === step ? "is-current" : ""} ${stepDone(item.key) ? "is-done" : ""}`} title={item.label} aria-label={`Etapa ${position + 1}: ${item.label}${stepDone(item.key) ? " (preenchida)" : ""}`}>
            <span>{stepDone(item.key) ? "✓" : position + 1}</span>
          </button>
        </li>
      ))}</ol>
    </nav>
    <h2>Etapa {index + 1} de {STEPS.length}: {STEPS[index].label}</h2>
    {body}
    {note}
    <p className="proposal-nav">{back}{proposal.exists && step !== "review" && step !== "proposal" && <button type="button" className="auth-link-button" disabled={busy} onClick={() => go("review")}>Ver resumo e enviar</button>}</p>
    <p className="proposal-summary">Os campos com * são obrigatórios. Tudo o que você salva fica guardado: pode parar e continuar depois pelo mesmo link.</p>
    {footer}
  </div>;
}
