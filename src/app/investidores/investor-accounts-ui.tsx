"use client";

import { useState, useTransition } from "react";
import { BANK_ACCOUNT_TYPES, PIX_KEY_TYPES, formatPixKey, type BankAccountType, type PixKeyType } from "@/lib/bank-account";
import { cnpjProblem, cpfProblem, formatDate, maskCnpj, maskCpf, onlyDigits, todayIso } from "@/lib/finance/format";
import type { BankAccountValues } from "@/lib/investors/bank-accounts";
import type { InvestorDetail } from "@/lib/investors/queries";
import { INVESTOR_DOCUMENT_KINDS, type InvestorDocumentKind } from "@/lib/investors/rules";
import { EmptyPanel, Feedback, MaskedInput, formatBytes, useFormAction } from "../portfolio-pages";
import { Icon } from "../ui-icon";
import { archiveInvestorBankAccountAction, removeInvestorDocumentAction, saveInvestorBankAccountAction, uploadInvestorDocumentAction } from "./actions";
import { loadInvestorBankAccountForEditAction } from "./read-actions";

type BankAccount = InvestorDetail["bankAccounts"][number];
type InvestorDocument = InvestorDetail["investorDocuments"][number];
const dateOf = (timestamp: string) => formatDate(todayIso(new Date(timestamp)));
const ACCEPT = ".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp";

// Formulário de uma conta: banco (código e/ou nome, agência, conta e dígitos) e/ou chave Pix. Só se exige o que se
// aplica; a regra é a mesma no servidor (src/lib/investors/bank-accounts.ts).
function BankAccountForm({ investorId, accountId, initial, locked, onDone, onCancel }: {
  investorId: string; accountId?: string; initial?: BankAccountValues; locked?: boolean; onDone: () => void; onCancel: () => void;
}) {
  const { pending, feedback, onSubmit } = useFormAction(saveInvestorBankAccountAction, onDone);
  const [pixType, setPixType] = useState<PixKeyType | "">((initial?.pixKeyType as PixKeyType | null) ?? "");
  const holderMask = (value: string) => (onlyDigits(value).length > 11 ? maskCnpj(value) : maskCpf(value));
  const pixPlaceholder = { CPF: "000.000.000-00", CNPJ: "00.000.000/0000-00", EMAIL: "nome@exemplo.com", PHONE: "(11) 98765-4321", RANDOM: "123e4567-e89b-12d3-a456-426614174000", "": "Escolha o tipo primeiro" }[pixType];
  return (
    <div className="schedule-form">
      <form className="form-grid" onSubmit={onSubmit} aria-label={accountId ? "Editar conta bancária" : "Nova conta bancária"}>
        <input type="hidden" name="investorId" value={investorId} />
        {accountId && <input type="hidden" name="accountId" value={accountId} />}
        <p className="capital-note field-wide">Informe a conta bancária (banco, agência e conta), a chave Pix ou os dois. Para usar só Pix, deixe os campos do banco em branco.{locked ? " Esta conta está ligada a um contrato: banco, agência, conta e chave Pix não mudam mais (cadastre outra conta se precisar)." : ""}</p>
        <label className="field"><span>Código do banco</span><input name="bankCode" inputMode="numeric" maxLength={3} placeholder="341" defaultValue={initial?.bankCode ?? ""} readOnly={locked} /></label>
        <label className="field"><span>Nome do banco</span><input name="bankName" maxLength={120} placeholder="Itaú" defaultValue={initial?.bankName ?? ""} readOnly={locked} /></label>
        <label className="field"><span>Agência (sem dígito)</span><input name="branch" inputMode="numeric" maxLength={5} placeholder="1234" defaultValue={initial?.branch ?? ""} readOnly={locked} /></label>
        <label className="field"><span>Dígito da agência</span><input name="branchDigit" maxLength={1} placeholder="Opcional" defaultValue={initial?.branchDigit ?? ""} readOnly={locked} /></label>
        <label className="field"><span>Conta (sem dígito)</span><input name="account" inputMode="numeric" maxLength={20} placeholder="12345" defaultValue={initial?.account ?? ""} readOnly={locked} /></label>
        <label className="field"><span>Dígito da conta</span><input name="accountDigit" maxLength={1} placeholder="6" defaultValue={initial?.accountDigit ?? ""} readOnly={locked} /></label>
        <label className="field"><span>Tipo de conta</span><select name="accountType" defaultValue={initial?.accountType ?? ""}><option value="">Não informado</option>{(Object.keys(BANK_ACCOUNT_TYPES) as BankAccountType[]).map((key) => <option key={key} value={key}>{BANK_ACCOUNT_TYPES[key]}</option>)}</select></label>
        <label className="field"><span>Titular</span><input name="holderName" maxLength={160} placeholder="Nome como está no banco" defaultValue={initial?.holderName ?? ""} /></label>
        <label className="field"><span>CPF/CNPJ do titular</span><MaskedInput name="holderDocument" mask={holderMask} initial={initial?.holderDocument ? holderMask(initial.holderDocument) : ""} validate={(value) => (onlyDigits(value).length > 11 ? cnpjProblem(value) : cpfProblem(value))} inputMode="numeric" placeholder="CPF ou CNPJ" maxLength={20} /></label>
        {locked ? <input type="hidden" name="pixKeyType" value={pixType} /> : null}
        <label className="field"><span>Tipo da chave Pix</span><select name={locked ? "pixKeyTypeView" : "pixKeyType"} value={pixType} disabled={locked} onChange={(event) => setPixType(event.target.value as PixKeyType | "")}><option value="">Sem chave Pix</option>{(Object.keys(PIX_KEY_TYPES) as PixKeyType[]).map((key) => <option key={key} value={key}>{PIX_KEY_TYPES[key]}</option>)}</select></label>
        <label className="field"><span>Chave Pix</span><input name="pixKey" maxLength={160} defaultValue={formatPixKey(initial?.pixKeyType ?? null, initial?.pixKey ?? null) ?? ""} placeholder={pixPlaceholder} disabled={!pixType} required={Boolean(pixType)} readOnly={locked} /></label>
        <label className="field field-wide"><span>Observações da conta</span><input name="notes" maxLength={500} placeholder="Opcional" defaultValue={initial?.notes ?? ""} /></label>
        <label className="check-field field-wide"><input type="checkbox" name="isPreferred" value="1" defaultChecked={initial?.isPreferred ?? false} /><span>Conta preferencial para os pagamentos (a primeira conta cadastrada já é a preferencial).</span></label>
        <div className="form-actions">
          <button type="button" className="outline-button" onClick={onCancel}>Cancelar</button>
          <button className="primary-button" disabled={pending}><Icon name="check" size={16} /> {pending ? "Salvando…" : accountId ? "Salvar conta" : "Cadastrar conta"}</button>
        </div>
      </form>
      <Feedback feedback={feedback} />
    </div>
  );
}

function AccountRow({ account, investorId, onDone }: { account: BankAccount; investorId: string; onDone: () => void }) {
  const [editing, setEditing] = useState<BankAccountValues | null>(null);
  const [loading, startLoading] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const archive = useFormAction(archiveInvestorBankAccountAction, () => { setConfirming(false); onDone(); });
  // Os números completos só são buscados ao abrir a edição; a ficha mostra a conta mascarada.
  const openEdit = () => startLoading(async () => {
    const data = new FormData();
    data.set("accountId", account.id);
    const result = await loadInvestorBankAccountForEditAction(data);
    if (result.ok) { setError(null); setEditing(result.values); } else setError(result.error);
  });
  return (
    <li>
      <div>
        <strong>{account.label || "Conta"}{account.isPreferred && <span className="status-chip status-active inline-chip"><i />Preferencial</span>}{account.archivedAt && <span className="status-chip status-muted inline-chip"><i />Retirada</span>}</strong>
        <small>{[account.accountType && BANK_ACCOUNT_TYPES[account.accountType as BankAccountType], account.holderName && `Titular: ${account.holderName}`, account.holderDocument && `CPF/CNPJ ${account.holderDocument}`,
          account.linkedCount ? `usada em ${account.linkedCount} contrato${account.linkedCount === 1 ? "" : "s"}` : null, account.archivedAt && `retirada em ${dateOf(account.archivedAt)}`].filter(Boolean).join(" · ")}</small>
        {account.notes && <small className="preserve-lines">{account.notes}</small>}
      </div>
      {!account.archivedAt && (
        <form className="row-actions" onSubmit={archive.onSubmit}>
          <input type="hidden" name="investorId" value={investorId} /><input type="hidden" name="accountId" value={account.id} />
          <button type="button" className="outline-button" disabled={loading} onClick={() => (editing ? setEditing(null) : openEdit())}>{editing ? "Fechar" : loading ? "Abrindo…" : "Editar"}</button>
          {account.activeLinkedCount === 0 && (confirming
            ? <><button className="primary-button danger-button" disabled={archive.pending}>{archive.pending ? "Retirando…" : "Confirmar retirada"}</button><button type="button" className="text-link" onClick={() => setConfirming(false)}>Manter</button></>
            : <button type="button" className="outline-button" onClick={() => setConfirming(true)}>Retirar</button>)}
        </form>
      )}
      {error && <p className="form-feedback form-feedback-error" role="alert">{error}</p>}
      <Feedback feedback={archive.feedback} />
      {editing && <BankAccountForm investorId={investorId} accountId={account.id} initial={editing} locked={account.linkedCount > 0} onDone={() => { setEditing(null); onDone(); }} onCancel={() => setEditing(null)} />}
    </li>
  );
}

// Contas bancárias do investidor: várias, uma preferencial, mostradas mascaradas.
export function BankAccountsSection({ data, onDone }: { data: InvestorDetail; onDone: () => void }) {
  const [adding, setAdding] = useState(false);
  const active = data.bankAccounts.filter((account) => !account.archivedAt);
  const archived = data.bankAccounts.filter((account) => account.archivedAt);
  const { legacyBank } = data.investor;
  return (
    <section className="panel form-panel" aria-label="Contas bancárias do investidor">
      <div className="panel-header">
        <div><div className="panel-title-row"><h2>Contas bancárias e Pix</h2><span className="today-count">{active.length}</span></div><p>Contas para os pagamentos ao investidor. Os números aparecem mascarados; os completos só no formulário de edição.</p></div>
        <button type="button" className="primary-button" onClick={() => setAdding(!adding)}><Icon name={adding ? "close" : "plus"} size={16} /> {adding ? "Fechar" : "Nova conta"}</button>
      </div>
      {adding && <BankAccountForm investorId={data.investor.id} onDone={() => { setAdding(false); onDone(); }} onCancel={() => setAdding(false)} />}
      {legacyBank && (
        <p className="capital-note" role="note">Dados bancários do cadastro anterior (formato antigo, mantidos como estavam): {legacyBank.label || "—"}{legacyBank.holder ? ` · ${legacyBank.holder}` : ""}. Para escolher em um contrato, cadastre-os como uma conta.</p>
      )}
      {active.length === 0 ? <EmptyPanel icon="wallet" text="Nenhuma conta bancária cadastrada." /> : (
        <ul className="document-list">{active.map((account) => <AccountRow key={account.id} account={account} investorId={data.investor.id} onDone={onDone} />)}</ul>
      )}
      {archived.length > 0 && (
        <details className="document-history">
          <summary>{`Contas retiradas (${archived.length})`}</summary>
          <ul className="document-list">{archived.map((account) => <AccountRow key={account.id} account={account} investorId={data.investor.id} onDone={onDone} />)}</ul>
        </details>
      )}
    </section>
  );
}

function DocumentRow({ document, onDone }: { document: InvestorDocument; onDone: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const remove = useFormAction(removeInvestorDocumentAction, () => { setConfirming(false); onDone(); });
  return (
    <li>
      <div><strong>{INVESTOR_DOCUMENT_KINDS[document.kind]}{document.label ? ` · ${document.label}` : ""}</strong>
        <small>{document.fileName} · {formatBytes(document.sizeBytes)} · enviado em {dateOf(document.createdAt)}{document.uploadedBy ? ` por ${document.uploadedBy}` : ""}{document.removedAt ? ` · retirado em ${dateOf(document.removedAt)}` : ""}</small></div>
      <form className="row-actions" onSubmit={remove.onSubmit}>
        <input type="hidden" name="documentId" value={document.id} />
        <a className="outline-button" href={`/investidores/documentos-investidor/${document.id}`} target="_blank" rel="noreferrer">Visualizar</a>
        <a className="outline-button" href={`/investidores/documentos-investidor/${document.id}?baixar=1`} download={document.fileName}>Baixar</a>
        {!document.removedAt && (confirming
          ? <><button className="primary-button danger-button" disabled={remove.pending}>{remove.pending ? "Retirando…" : "Confirmar retirada"}</button><button type="button" className="text-link" onClick={() => setConfirming(false)}>Manter</button></>
          : <button type="button" className="outline-button" onClick={() => setConfirming(true)}>Retirar</button>)}
      </form>
      <Feedback feedback={remove.feedback} />
    </li>
  );
}

// Documentos do próprio investidor (identidade, comprovantes, contrato social). Retirar não apaga: fica no histórico.
export function InvestorDocumentsSection({ data, onDone }: { data: InvestorDetail; onDone: () => void }) {
  const [resetKey, setResetKey] = useState(0);
  const upload = useFormAction(uploadInvestorDocumentAction, () => { setResetKey((key) => key + 1); onDone(); });
  const current = data.investorDocuments.filter((document) => !document.removedAt);
  const removed = data.investorDocuments.filter((document) => document.removedAt);
  return (
    <section className="panel form-panel" aria-label="Documentos do investidor">
      <div className="panel-header"><div><div className="panel-title-row"><h2>Documentos do investidor</h2><span className="today-count">{current.length}</span></div><p>Identificação, comprovante de endereço, contrato social e comprovantes bancários. PDF, JPG, PNG ou WEBP de até 5 MB.</p></div></div>
      {current.length > 0 && <ul className="document-list">{current.map((document) => <DocumentRow key={document.id} document={document} onDone={onDone} />)}</ul>}
      <form className="form-grid document-upload" onSubmit={upload.onSubmit} key={resetKey} aria-label="Enviar documento do investidor">
        <input type="hidden" name="investorId" value={data.investor.id} />
        <label className="field"><span>Tipo</span><select name="kind" required defaultValue=""><option value="" disabled>Escolha o tipo</option>{(Object.keys(INVESTOR_DOCUMENT_KINDS) as InvestorDocumentKind[]).map((kind) => <option key={kind} value={kind}>{INVESTOR_DOCUMENT_KINDS[kind]}</option>)}</select></label>
        <label className="field"><span>Descrição (opcional)</span><input name="label" maxLength={120} placeholder="Ex.: RG frente e verso" /></label>
        <label className="field"><span>Arquivo</span><input name="file" type="file" accept={ACCEPT} required /></label>
        <div className="form-actions"><button className="primary-button" disabled={upload.pending}><Icon name="plus" size={16} /> {upload.pending ? "Enviando…" : "Enviar documento"}</button></div>
      </form>
      <Feedback feedback={upload.feedback} />
      {removed.length > 0 && (
        <details className="document-history">
          <summary>{`Documentos retirados (${removed.length})`}</summary>
          <ul className="document-list">{removed.map((document) => <DocumentRow key={document.id} document={document} onDone={onDone} />)}</ul>
        </details>
      )}
    </section>
  );
}

