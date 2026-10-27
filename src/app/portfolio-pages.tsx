"use client";

import { Fragment, useEffect, useRef, useState, useTransition, type FormEvent, type InputHTMLAttributes, type ReactNode } from "react";
import { transferOperationAction } from "./gerentes/actions";
import { registerOfferAcceptanceAction, saveProposalOfferAction, saveProposalReviewAction, manageProposalLinkAction, createCreditProposalAction, moveCreditProposalAction, rejectCreditProposalAction, saveCreditPolicyAction, confirmOperationPixAction, cancelOperationAction, deferInstallmentAction, loadAllCyclesReportAction, previewOperationEditAction, searchClientsAction, lookupRegisteredPersonAction, updateOperationAction, createClientAction, createOperationAction, approveOperationRequestAction, rejectOperationRequestAction, deleteClientAction, deleteClientDocumentAction, editPaymentAction, registerContributionAction, registerPaymentAction, registerWithdrawalAction, settleOperationEarlyAction, resetWalletAction, reverseContributionAction, saveWalletAction, updateClientAction, uploadClientDocumentAction, type ActionResult, type OperationEditPreview } from "./actions";
import { BankNameInput } from "./bank-name-input";
import { Icon, type IconName } from "./ui-icon";
import { BANK_ACCOUNT_TYPES, PIX_KEY_TYPES, bankSummary, formatPixKey, type BankValues, type PixKeyType } from "@/lib/bank-account";
import type { ClientSearchResult } from "@/lib/finance/client-search";
import { addDays, centsToInput, cnpjProblem, cpfProblem, formatCnpj, maskCnpj, formatCpf, formatDate, formatElapsed, todayIso, formatMoney, formatPhone, formatRate, maskCpf, maskPhone, onlyDigits, parseMoneyToCents, parseLoanRateToBps } from "@/lib/finance/format";
import { capitalLedgerLabels, type ChargeFilter, type OperationsSummary, type OperationView } from "@/lib/finance/portfolio";
import { INVESTOR_CATEGORIES, isInvestorCategory } from "@/lib/investors/payables";
import type { TenantPortfolio } from "@/lib/finance/queries";
import { clientProfitHistory } from "@/lib/finance/client-profit";
import { REPORT_PERIODS, REPORT_SCOPES, REPORT_STATUSES, profitabilityReport, type ReportFilters, type ReportPeriod, type ReportScope, type ReportStatus } from "@/lib/finance/report";
import { addressKey, addressKinds, addressPartLabels, addressParts, brazilianStates, formatAddress, guarantorPartLabels, maskCep, referenceKey, referenceSlots, type AddressKind, type AddressPart } from "@/lib/finance/client-profile";
import { calculateDaily, calculateFixedInterest, calculateInstallments, calculateOperation, checkPayment, deferralDueDate, deferralEligibility, dueDates, frequencyLabels, interestOnlyRenewal, monthlyEquivalentRate, operationLedger, paymentKindLabels, simpleMonthlyRate, type Frequency, type InstallmentFrequency } from "@/lib/finance/rules";
import { MoneyInput } from "./money-input";
import { PROPOSAL_PHASES } from "@/lib/credit/phases";
import { PROPOSAL_DOCUMENTS } from "@/lib/credit/documents";
import { impliedRateBps, offerSummary } from "@/lib/credit/engine";
import { capacityIndicator, reviewOf } from "@/lib/credit/reviews";
import { DateField } from "./date-field";
import { SOCIAL_NETWORKS, socialHref, socialLabel, whatsappHref, type SocialNetwork } from "@/lib/contacts";

export function useFormAction(action: (data: FormData) => Promise<ActionResult>, onDone?: (message: string) => void, resetOnSuccess = true) {
  // O estado "enviando" é próprio (não de uma transição do React): termina assim que a ação responde, mesmo que a tela
  // ainda esteja sendo atualizada em seguida, e nunca deixa o botão preso em "Salvando…".
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setFeedback(null);
    setPending(true);
    void (async () => {
      try {
        const result = await action(data);
        if (result.ok) {
          if (resetOnSuccess) form.reset();
          setFeedback({ tone: "ok", text: result.message });
          onDone?.(result.message);
        } else {
          setFeedback({ tone: "error", text: result.error });
        }
      } catch {
        setFeedback({ tone: "error", text: "Não foi possível salvar. Tente novamente." });
      } finally {
        setPending(false);
      }
    })();
  };
  return { pending, feedback, onSubmit };
}

export function Feedback({ feedback }: { feedback: { tone: "ok" | "error"; text: string } | null }) {
  if (!feedback) return null;
  return <p className={`form-feedback ${feedback.tone === "error" ? "form-feedback-error" : ""}`} role={feedback.tone === "error" ? "alert" : "status"}>{feedback.text}</p>;
}

export function PageHeading({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children?: ReactNode }) {
  return (
    <section className="page-heading">
      <div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>
      {children && <div className="heading-actions">{children}</div>}
    </section>
  );
}

export function EmptyPanel({ icon, text, action }: { icon: IconName; text: string; action?: ReactNode }) {
  return <div className="empty-panel"><span className="coming-icon"><Icon name={icon} size={22} /></span><p>{text}</p>{action}</div>;
}

// Confirmação de ações que não se desfazem com um clique (exclusões e estornos). Sem "action", só informa e fecha.
function ConfirmDialog({ title, children, confirmLabel, action, fields, onClose, onDone }: {
  title: string; children: ReactNode; confirmLabel?: string; action?: (data: FormData) => Promise<ActionResult>;
  fields?: Record<string, string>; onClose: () => void; onDone: () => void;
}) {
  const { pending, feedback, onSubmit } = useFormAction(action ?? (async () => ({ ok: true, message: "" })), () => { onDone(); onClose(); });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="payment-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="panel form-panel payment-panel confirm-panel" role="alertdialog" aria-modal="true" aria-label={title}>
        <div className="panel-header"><div><h2>{title}</h2></div><button type="button" className="more-button" aria-label="Fechar" onClick={onClose}><Icon name="close" size={18} /></button></div>
        <div className="confirm-body">{children}</div>
        <form className="confirm-actions" onSubmit={onSubmit}>
          {Object.entries(fields ?? {}).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
          <button type="button" className="outline-button" onClick={onClose}>{action ? "Cancelar" : "Entendi"}</button>
          {action && <button className="primary-button danger-button" disabled={pending}>{pending ? "Aguarde…" : confirmLabel}</button>}
        </form>
        <Feedback feedback={feedback} />
      </section>
    </div>
  );
}

const stateLabels: Record<OperationView["state"], { label: string; tone: string }> = {
  ACTIVE: { label: "Ativa", tone: "status-active" },
  DUE_TODAY: { label: "Vence hoje", tone: "status-due" },
  OVERDUE: { label: "Em atraso", tone: "status-late" },
  PAID: { label: "Quitada", tone: "status-paid" },
  CANCELED: { label: "Cancelada", tone: "status-muted" },
  RENEGOTIATED: { label: "Renegociada", tone: "status-muted" },
};

function StatusChip({ state, daysUntilDue }: { state: OperationView["state"]; daysUntilDue: number }) {
  const { label, tone } = stateLabels[state];
  const suffix = state === "OVERDUE" ? ` · ${-daysUntilDue} dia${daysUntilDue === -1 ? "" : "s"}` : "";
  return <span className={`status-chip ${tone}`}><i />{label}{suffix}</span>;
}

// Tempo da operação: do empréstimo até hoje; para operação quitada, do empréstimo até a quitação.
function operationAge(operation: OperationView) {
  const elapsed = formatElapsed(operation.loanDate, operation.elapsedUntil);
  if (operation.status === "PAID") return elapsed === "hoje" ? "quitada no mesmo dia" : `durou ${elapsed}`;
  return elapsed === "hoje" ? "desde hoje" : `há ${elapsed}`;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const percent = (fraction: number) => `${(fraction * 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;

// Taxa como a operação foi combinada, sempre juros simples. Parcelado: juros totais ÷ principal ÷ meses, calculada dos
// valores contratados (as operações parceladas antigas têm outra taxa gravada, que não é usada em nenhum cálculo).
function rateLabel(operation: OperationView) {
  if (operation.modality === "INSTALLMENT") {
    return `${percent(simpleMonthlyRate({ principalCents: operation.principalCents, interestCents: operation.originalInterestCents, months: operation.installmentCount ?? operation.installmentTotal }))} ${operation.frequency === "BIWEEKLY" ? "por quinzena" : "ao mês"}`;
  }
  if (operation.frequency === "DAILY") return `${formatRate(operation.interestRateBps)} em ${operation.installments.length} dias`;
  if (operation.ledgerTerms.interestMode === "FIXED") return `${formatMoney(operation.periodInterestCents)} por quinzena (≈ ${formatRate(operation.interestRateBps)})`;
  return `${formatRate(operation.interestRateBps)} ${operation.frequency === "BIWEEKLY" ? "por quinzena" : "ao mês"}`;
}
const amortized = (operation: OperationView) => operation.modality === "INSTALLMENT" || operation.frequency === "DAILY";
function modalityLabel(operation: OperationView) {
  if (operation.modality === "INSTALLMENT") return `Parcelado${operation.frequency === "BIWEEKLY" ? " quinzenal" : ""} em ${operation.installmentCount ?? operation.installmentTotal}x de ${formatMoney(operation.installmentCents ?? 0)}`;
  if (operation.frequency === "DAILY") return `Pagamento único · Diário · ${operation.installments.length} pagamentos`;
  return `Pagamento único · ${frequencyLabels[operation.frequency]}`;
}

export function WalletSetup({ onSaved, cycleNumber = 1 }: { onSaved: () => void; cycleNumber?: number }) {
  const { pending, feedback, onSubmit } = useFormAction(saveWalletAction, onSaved);
  return (
    <section className="panel form-panel wallet-setup" aria-label="Configurar carteira">
      <div className="panel-header"><div><h2>{cycleNumber > 1 ? `Novo ciclo da carteira (ciclo ${cycleNumber})` : "Configure sua carteira"}</h2><p>{cycleNumber > 1 ? "A carteira foi zerada. Informe o capital inicial deste novo ciclo; os clientes cadastrados continuam disponíveis." : "Informe o capital inicial para o CrediAI calcular o capital disponível conforme as suas operações."}</p></div></div>
      <form className="form-grid form-grid-inline" onSubmit={onSubmit}>
        <label className="field"><span>Capital inicial (R$)</span><MoneyInput name="initialCapital" inputMode="decimal" placeholder="20.000,00" required /></label>
        <button className="primary-button" disabled={pending}><Icon name="check" size={16} /> {pending ? "Salvando…" : "Salvar capital inicial"}</button>
      </form>
      <Feedback feedback={feedback} />
    </section>
  );
}

export function SettingsPage({ portfolio, onChanged }: { portfolio: TenantPortfolio; onChanged: () => void }) {
  const { pending, feedback, onSubmit } = useFormAction(saveWalletAction, onChanged);
  const { summary } = portfolio;
  return (
    <div className="workspace-page">
      <PageHeading eyebrow="CREDIAI · CONFIGURAÇÕES" title="Configurações" description="Dados da sua carteira. Somente você vê estas informações." />
      <section className="panel form-panel">
        <div className="panel-header"><div><h2>Capital inicial da carteira</h2><p>{summary.hasWallet ? `Atual: ${formatMoney(summary.initialCapitalCents)}` : "Ainda não informado."} O capital disponível é recalculado a partir deste valor.</p></div></div>
        <form className="form-grid form-grid-inline" onSubmit={onSubmit}>
          <label className="field"><span>Capital inicial (R$)</span><MoneyInput name="initialCapital" inputMode="decimal" placeholder="20.000,00" defaultValue={summary.hasWallet ? (summary.initialCapitalCents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 }) : ""} required /></label>
          <button className="primary-button" disabled={pending}><Icon name="check" size={16} /> {pending ? "Salvando…" : "Salvar"}</button>
        </form>
        <Feedback feedback={feedback} />
      </section>
      <section className="panel form-panel">
        <div className="panel-header"><div><h2>Como a carteira é calculada</h2><p>Regra de cálculo em uso nesta etapa.</p></div></div>
        <ul className="rule-list">
          <li><strong>Pagamento único mensal ou quinzenal:</strong> juros = taxa do período × principal em aberto (ex.: R$ 1.000 a 30% ao mês = R$ 300; R$ 8.000 a 15% por quinzena = R$ 1.200). O quinzenal tem dois vencimentos por mês (ex.: dias 15 e 30) e os juros podem ser informados pela taxa ou por um valor fixo em reais; com principal parcialmente pago, o valor fixo fica proporcional ao principal em aberto.</li>
          <li><strong>Renovação:</strong> pagar só os juros do período, com principal em aberto, é &quot;Pagamento somente de juros / Renovação de período&quot;. O principal não diminui, o vencimento avança um período (ou para a data informada) e o novo período tem juros sobre o principal em aberto, sem juros sobre juros. Se os juros do período foram pagos e o vencimento chegou, o período também renova: a operação fica Ativa, não Em atraso. A operação só é quitada quando principal + juros do período são pagos.</li>
          <li><strong>Pagamento único diário:</strong> total = principal + taxa do período, dividido em um pagamento por dia corrido, sábados e domingos incluídos, a partir do primeiro vencimento informado (ex.: R$ 10.000 a 30% em 30 dias = 29 × R$ 433,33 + R$ 433,43). Cada pagamento leva principal e juros.</li>
          <li><strong>Parcelado:</strong> parcelas fixas mensais. A taxa mostrada é a taxa simples ao mês (juros ÷ valor emprestado ÷ meses).</li>
          <li><strong>Calendário comercial:</strong> mês de 30 dias, quinzena de 15 e ano de 360 para converter taxas entre períodos. Vencimentos e dias de atraso usam as datas reais.</li>
          <li><strong>Pagamentos:</strong> a operação aceita vários pagamentos. Cada valor recebido quita primeiro os juros pendentes e depois o principal. Pagar o saldo inteiro quita a operação; valores acima do saldo são bloqueados.</li>
          <li><strong>Capital disponível:</strong> capital inicial + aportes + outras entradas − retiradas e saídas − estornos de aporte − principal emprestado + pagamentos recebidos. Juros ainda não recebidos não contam. Aportes e estornos ficam em Capital; entradas e saídas com categoria (salário, despesas, impostos) ficam no Financeiro. Nenhuma saída nem redução do capital inicial pode deixar o saldo negativo.</li>
          <li><strong>Exclusões:</strong> operação sem pagamento pode ser excluída e devolve o principal ao capital; com pagamento fica bloqueada. Cliente sem operações é excluído; com histórico é arquivado.</li>
          <li><strong>Em atraso:</strong> juros do período (ou a parcela) não pagos depois do vencimento. Principal em aberto com os juros em dia não é atraso. Multa e juros de mora ainda não são aplicados.</li>
          <li><strong>Zerar carteira:</strong> encerra o ciclo atual e abre um novo com capital inicial R$ 0,00. Operações, pagamentos e movimentos de capital do ciclo encerrado ficam guardados e saem dos cards; os clientes continuam cadastrados.</li>
        </ul>
      </section>
      <ResetWalletPanel portfolio={portfolio} onChanged={onChanged} />
    </div>
  );
}

const RESET_CONFIRMATION = "ZERAR CARTEIRA";

// "Zerar carteira" em duas etapas: primeiro explica o que acontece, depois exige digitar ZERAR CARTEIRA.
function ResetWalletDialog({ portfolio, onClose, onChanged }: { portfolio: TenantPortfolio; onClose: () => void; onChanged: () => void }) {
  const [step, setStep] = useState<1 | 2>(1);
  const [typed, setTyped] = useState("");
  const { pending, feedback, onSubmit } = useFormAction(resetWalletAction, () => { onChanged(); onClose(); });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const { summary, profitability } = portfolio;
  const movementCount = portfolio.capitalLedger.filter((entry) => entry.kind === "CONTRIBUTION" || entry.kind === "WITHDRAWAL" || entry.kind === "CONTRIBUTION_REVERSAL" || entry.kind === "OTHER_INCOME").length;
  return (
    <div className="payment-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="panel form-panel payment-panel confirm-panel" role="alertdialog" aria-modal="true" aria-label="Zerar carteira?">
        <div className="panel-header"><div><h2>Zerar carteira?</h2><p>Etapa {step} de 2</p></div><button type="button" className="more-button" aria-label="Fechar" onClick={onClose}><Icon name="close" size={18} /></button></div>
        {step === 1 ? (
          <>
            <div className="confirm-body">
              <p>Esta ação removerá as operações e os dados financeiros da carteira atual. Os clientes cadastrados serão mantidos.</p>
              <dl className="payment-summary">
                <div><dt>Operações</dt><dd>{profitability.operationCount}</dd></div>
                <div><dt>Pagamentos</dt><dd>{profitability.paymentCount}</dd></div>
                <div><dt>Aportes, retiradas, saídas e estornos</dt><dd>{movementCount}</dd></div>
                <div><dt>Capital inicial</dt><dd>{formatMoney(summary.initialCapitalCents)}</dd></div>
                <div><dt>Capital disponível</dt><dd>{formatMoney(summary.availableCents)}</dd></div>
                <div><dt>Clientes (mantidos)</dt><dd>{portfolio.clients.length}</dd></div>
              </dl>
              <p>Nada é apagado do banco: o ciclo {summary.cycleNumber} fica guardado e aparece em &quot;Ciclos anteriores&quot;. A carteira recomeça no ciclo {summary.cycleNumber + 1} com capital inicial, capital disponível, operações, pagamentos e juros zerados. Usuários, plano e configurações não mudam.</p>
            </div>
            <div className="confirm-actions">
              <button type="button" className="outline-button" onClick={onClose}>Cancelar</button>
              <button type="button" className="primary-button danger-button" onClick={() => setStep(2)}>Continuar</button>
            </div>
          </>
        ) : (
          <form onSubmit={onSubmit}>
            <div className="confirm-body">
              <p>Para confirmar, digite <strong>{RESET_CONFIRMATION}</strong> abaixo.</p>
              <label className="field"><span>Confirmação</span><input name="confirmation" autoComplete="off" value={typed} onChange={(event) => setTyped(event.target.value)} placeholder={RESET_CONFIRMATION} autoFocus /></label>
            </div>
            <div className="confirm-actions">
              <button type="button" className="outline-button" onClick={onClose}>Cancelar</button>
              <button className="primary-button danger-button" disabled={pending || typed !== RESET_CONFIRMATION}>{pending ? "Aguarde…" : "Zerar carteira"}</button>
            </div>
          </form>
        )}
        <Feedback feedback={feedback} />
      </section>
    </div>
  );
}

function ResetWalletPanel({ portfolio, onChanged }: { portfolio: TenantPortfolio; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const { summary, closedCycles } = portfolio;
  return (
    <>
      <section className="panel form-panel" aria-label="Zerar carteira">
        <div className="panel-header">
          <div><h2>Zerar carteira</h2><p>Recomeça a carteira em um novo ciclo financeiro (ciclo atual: {summary.cycleNumber}). Os clientes continuam cadastrados. Pede duas confirmações.</p></div>
          <button className="outline-button danger-outline" disabled={!summary.hasWallet} onClick={() => setOpen(true)}>Zerar carteira</button>
        </div>
        {closedCycles.length > 0 && (
          <div className="table-scroll"><table className="data-table" aria-label="Ciclos anteriores">
            <thead><tr><th>Ciclos anteriores</th><th>Início</th><th>Encerrado em</th><th>Capital inicial</th><th>Operações</th><th>Pagamentos</th><th>Recebido</th></tr></thead>
            <tbody>{closedCycles.map((cycle) => (
              <tr key={cycle.cycleNumber}><td><strong>Ciclo {cycle.cycleNumber}</strong></td><td>{formatDate(cycle.startedOn)}</td><td>{formatDate(cycle.closedOn)}</td><td>{formatMoney(cycle.initialCapitalCents)}</td><td>{cycle.operationCount}</td><td>{cycle.paymentCount}</td><td>{formatMoney(cycle.receivedCents)}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      {open && <ResetWalletDialog portfolio={portfolio} onClose={() => setOpen(false)} onChanged={onChanged} />}
    </>
  );
}

type ClientRow = TenantPortfolio["clients"][number];

// Campo com máscara (CPF, telefone, CEP) que guarda o valor digitado já formatado. Com "validate", a mensagem aparece
// enquanto o usuário digita e o navegador não envia o formulário com o valor inválido (o servidor confere de novo).
// Um valor antigo, reenviado sem alteração, não é bloqueado na tela (o servidor mantém o cadastro antigo como está).
export function MaskedInput({ name, mask, initial, validate, ...props }: { name: string; mask: (value: string) => string; initial: string; validate?: (value: string) => string | null } & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "defaultValue">) {
  const [value, setValue] = useState(initial);
  const problem = validate && value !== initial ? validate(value) : null;
  return (
    <>
      <input name={name} value={value} aria-invalid={problem ? true : undefined}
        ref={(input) => { input?.setCustomValidity(problem ?? ""); }}
        onChange={(event) => setValue(mask(event.target.value))} {...props} />
      {problem && <small className="field-error" role="alert">{problem}</small>}
    </>
  );
}

// Dados bancários e chave Pix (opcionais), iguais para clientes e investidores. Regras em src/lib/bank-account.ts.
export function BankFieldset({ initial, legend = "Dados bancários e Pix" }: { initial?: Partial<BankValues> | null; legend?: string }) {
  const [pixType, setPixType] = useState<PixKeyType | "">((initial?.pixKeyType as PixKeyType | null) ?? "");
  const holderMask = (value: string) => (onlyDigits(value).length > 11 ? maskCnpj(value) : maskCpf(value));
  const pixInitial = formatPixKey(initial?.pixKeyType ?? null, initial?.pixKey ?? null) ?? "";
  const pixPlaceholder = { CPF: "000.000.000-00", CNPJ: "00.000.000/0000-00", EMAIL: "nome@exemplo.com", PHONE: "(11) 98765-4321", RANDOM: "123e4567-e89b-12d3-a456-426614174000", "": "Escolha o tipo primeiro" }[pixType];
  return (
    <fieldset className="form-section field-wide">
      <legend>{legend}</legend>
      <div className="form-grid">
        <label className="field field-wide"><span>Titular da conta</span><input name="bankHolderName" maxLength={160} defaultValue={initial?.bankHolderName ?? ""} placeholder="Nome como está no banco" /></label>
        <label className="field"><span>CPF/CNPJ do titular</span><MaskedInput name="bankHolderDocument" mask={holderMask} initial={initial?.bankHolderDocument ? holderMask(initial.bankHolderDocument) : ""} validate={(value) => (onlyDigits(value).length > 11 ? cnpjProblem(value) : cpfProblem(value))} inputMode="numeric" placeholder="CPF ou CNPJ" maxLength={20} /></label>
        <label className="field"><span>Banco</span><BankNameInput name="bankName" maxLength={120} defaultValue={initial?.bankName ?? ""} placeholder="Nome ou código, ex.: 341 Itaú" /></label>
        <label className="field"><span>Agência</span><input name="bankBranch" maxLength={20} defaultValue={initial?.bankBranch ?? ""} inputMode="numeric" placeholder="1234" /></label>
        <label className="field"><span>Conta</span><input name="bankAccount" maxLength={30} defaultValue={initial?.bankAccount ?? ""} inputMode="numeric" placeholder="12345-6" /></label>
        <label className="field"><span>Tipo de conta</span><select name="bankAccountType" defaultValue={initial?.bankAccountType ?? ""}><option value="">Não informado</option>{Object.entries(BANK_ACCOUNT_TYPES).filter(([key]) => key === "CHECKING" || key === "SAVINGS" || key === initial?.bankAccountType).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label className="field"><span>Tipo da chave Pix</span><select name="pixKeyType" value={pixType} onChange={(event) => setPixType(event.target.value as PixKeyType | "")}><option value="">Sem chave Pix</option>{Object.entries(PIX_KEY_TYPES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label className="field"><span>Chave Pix</span><input name="pixKey" maxLength={160} defaultValue={pixInitial} placeholder={pixPlaceholder} disabled={!pixType} required={Boolean(pixType)} /></label>
      </div>
    </fieldset>
  );
}

// Dados bancários na ficha (cliente ou investidor).
export function BankSummaryRows({ values }: { values: BankValues }) {
  const summary = bankSummary(values);
  return (
    <>
      <div><dt>Conta bancária</dt><dd>{summary.account ?? "Não informada"}</dd></div>
      <div><dt>Titular da conta</dt><dd>{summary.holder ?? "—"}</dd></div>
      <div><dt>Chave Pix</dt><dd>{summary.pix ?? "Não informada"}</dd></div>
    </>
  );
}

type CepLookup = { street: string; district: string; city: string; state: string };
// Consulta o CEP no ViaCEP e, se ele não responder, na BrasilAPI (base dos Correios). null = CEP não encontrado.
async function lookupCep(cep: string): Promise<CepLookup | null> {
  try {
    const response = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
    if (response.ok) {
      const data = await response.json();
      if (data.erro) return null;
      return { street: data.logradouro ?? "", district: data.bairro ?? "", city: data.localidade ?? "", state: data.uf ?? "" };
    }
  } catch {}
  const response = await fetch(`https://brasilapi.com.br/api/cep/v1/${cep}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("cep");
  const data = await response.json();
  return { street: data.street ?? "", district: data.neighborhood ?? "", city: data.city ?? "", state: data.state ?? "" };
}

// Endereço com preenchimento pelo CEP. Os campos preenchidos continuam editáveis para correção manual.
function AddressFields({ kind, client }: { kind: AddressKind; client: ClientRow | null }) {
  return <AddressFieldset legend={addressKinds[kind]} nameOf={(part) => addressKey(kind, part)} initialOf={(part) => client?.[addressKey(kind, part)] ?? ""} />;
}

// Mesmos campos de endereço (com CEP) para outros cadastros: investidor e empresa contratante dos contratos de investimento.
export function AddressFieldset({ legend, nameOf, initialOf }: { legend: string; nameOf: (part: AddressPart) => string; initialOf: (part: AddressPart) => string }) {
  const initial = initialOf;
  const [values, setValues] = useState(() => Object.fromEntries(addressParts.map((part) => [part, part === "Cep" ? maskCep(initial(part)) : initial(part)])) as Record<AddressPart, string>);
  const [lookup, setLookup] = useState<{ tone: "ok" | "error" | "busy"; text: string } | null>(null);
  const set = (part: AddressPart, value: string) => setValues((current) => ({ ...current, [part]: value }));
  const searchCep = async (masked: string) => {
    const cep = onlyDigits(masked);
    if (cep.length !== 8) return;
    setLookup({ tone: "busy", text: "Buscando o endereço pelo CEP…" });
    try {
      const found = await lookupCep(cep);
      if (!found) return setLookup({ tone: "error", text: "CEP não encontrado. Preencha o endereço manualmente." });
      setValues((current) => ({ ...current, Street: found.street || current.Street, District: found.district || current.District, City: found.city || current.City, State: found.state || current.State }));
      setLookup({ tone: "ok", text: "Endereço preenchido pelo CEP. Confira, complete o número e corrija se precisar." });
    } catch {
      setLookup({ tone: "error", text: "Não foi possível consultar o CEP agora. Preencha o endereço manualmente." });
    }
  };
  const field = (part: AddressPart, props: InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label key={part} className={`field${part === "Street" ? " field-wide" : ""}`}><span>{addressPartLabels[part]}</span>
      <input name={nameOf(part)} value={values[part]} onChange={(event) => set(part, event.target.value)} maxLength={160} {...props} /></label>
  );
  return (
    <fieldset className="form-section field-wide">
      <legend>{legend}</legend>
      <div className="form-grid">
        <label className="field"><span>CEP</span><input name={nameOf("Cep")} inputMode="numeric" placeholder="00000-000" value={values.Cep}
          onChange={(event) => { const masked = maskCep(event.target.value); set("Cep", masked); if (onlyDigits(masked).length === 8) void searchCep(masked); }} /></label>
        {field("Street", { placeholder: "Rua, avenida…" })}
        {field("Number", { placeholder: "123" })}
        {field("Complement", { placeholder: "Apto, sala (opcional)" })}
        {field("District")}
        {field("City")}
        <label className="field"><span>Estado</span><select name={nameOf("State")} value={values.State} onChange={(event) => set("State", event.target.value)}>
          <option value="">UF</option>{brazilianStates.map((state) => <option key={state} value={state}>{state}</option>)}</select></label>
        {lookup && <p className={`form-feedback field-wide ${lookup.tone === "error" ? "form-feedback-warning" : ""}`} role="status">{lookup.text}</p>}
      </div>
    </fieldset>
  );
}

// Preenchimento pelo CPF: ao completar um CPF válido, procura o CPF nos cadastros da própria carteira (cliente e investidor)
// e preenche só os campos ainda vazios do formulário, sem apagar o que a pessoa já digitou. Não consulta serviço externo.
// No formulário de cliente um CPF já cliente só avisa (CPF é único por carteira); o mesmo vale para o de investidor.
function setEmptyField(form: HTMLFormElement, name: string, value: string, replaceable?: string): boolean {
  const element = form.elements.namedItem(name);
  if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement)) return false;
  // Só campo vazio, ou o que ainda tem exatamente o valor que o preenchimento automático anterior pôs (o usuário não mexeu).
  // O CEP tem máscara: compara só os dígitos.
  const same = (a: string, b: string) => a === b || (name.endsWith("Cep") && onlyDigits(a) === onlyDigits(b));
  if (element.value && !(replaceable !== undefined && same(element.value, replaceable))) return false;
  if (same(element.value, value) && element.value) return true;
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  return true;
}
export function usePersonPrefill(target: "client" | "investor") {
  const [notice, setNotice] = useState<string | null>(null);
  const last = useRef("");
  const onInput = (event: FormEvent<HTMLFormElement>) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.name !== "document") return;
    const form = event.currentTarget;
    const digits = onlyDigits(input.value);
    last.current = digits;
    if (digits.length !== 11) return setNotice(null);
    void lookupRegisteredPersonAction(digits).then((result) => {
      if (last.current !== digits || !result.ok) return;
      const sameKind = result.people.find((person) => person.source === target);
      const other = result.people.find((person) => person.source !== target);
      if (sameKind) return setNotice(`Este CPF já está cadastrado como ${target === "client" ? "cliente" : "investidor"}: ${sameKind.name}. Use o cadastro existente.`);
      if (!other) return setNotice(null);
      const addressName = (part: string) => (target === "client" ? `residential${part}` : `address${part}`);
      for (const [key, value] of Object.entries(other.values)) {
        if (["name", "phone", "whatsapp", "email", "instagram", "facebook"].includes(key)) setEmptyField(form, key, value);
        else if (key !== "Cep") setEmptyField(form, addressName(key), value);
      }
      if (other.values.Cep) setEmptyField(form, addressName("Cep"), other.values.Cep);
      setNotice(`Campos vazios preenchidos com o cadastro de ${other.source === "client" ? "cliente" : "investidor"} ${other.name}. Confira antes de gravar.`);
    }).catch(() => undefined);
  };
  return { notice, onInput };
}

// Nome da empresa pelo CNPJ: consulta a base pública da BrasilAPI (dado público da Receita) quando o CNPJ digitado é válido
// e preenche só os campos vazios: "Nome da empresa" e o endereço comercial. Falha ou CNPJ não encontrado: avisa e deixa digitar à mão.
export function useCompanyNamePrefill() {
  const [notice, setNotice] = useState<string | null>(null);
  const last = useRef("");
  // Valor que o preenchimento automático pôs em cada campo: um segundo CNPJ pode trocá-lo, desde que o usuário não tenha editado.
  const filled = useRef<Record<string, string>>({});
  const onInput = (event: FormEvent<HTMLFormElement>) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.name !== "businessCnpj") return;
    const form = event.currentTarget;
    const digits = onlyDigits(input.value);
    last.current = digits;
    if (digits.length !== 14 || cnpjProblem(digits)) return setNotice(null);
    setNotice("Buscando o nome da empresa pelo CNPJ…");
    void fetch(`https://brasilapi.com.br/api/cnpj/v1/${digits}`).then(async (response) => {
      if (last.current !== digits) return;
      if (response.status === 404) return setNotice("CNPJ não encontrado na base pública. Digite o nome da empresa.");
      if (!response.ok) throw new Error("cnpj");
      const data = await response.json() as { razao_social?: string; nome_fantasia?: string; cep?: string; descricao_tipo_de_logradouro?: string; logradouro?: string; numero?: string; complemento?: string; bairro?: string; municipio?: string; uf?: string };
      const name = String(data.razao_social || data.nome_fantasia || "").trim();
      if (!name) return setNotice("A base pública não trouxe o nome. Digite o nome da empresa.");
      const fill = (field: string, value: string) => {
        if (setEmptyField(form, field, value, filled.current[field])) filled.current[field] = value;
        else delete filled.current[field];
      };
      fill("businessCompanyName", name.slice(0, 160));
      // Endereço comercial pelos dados da empresa; só campos vazios. O CEP vai por último: ele dispara a busca de CEP padrão.
      const text = (value?: string) => String(value ?? "").trim();
      const street = [text(data.descricao_tipo_de_logradouro), text(data.logradouro)].filter(Boolean).join(" ");
      const address: Record<string, string> = { Street: street, Number: text(data.numero) === "S/N" ? "" : text(data.numero), Complement: text(data.complemento), District: text(data.bairro), City: text(data.municipio), State: text(data.uf), Cep: onlyDigits(text(data.cep)) };
      for (const part of ["Street", "Number", "Complement", "District", "City", "State", "Cep"]) if (address[part] || filled.current[`business${part}`]) fill(`business${part}`, address[part].slice(0, 160));
      setNotice(`Nome da empresa e endereço comercial preenchidos pela base pública (${name}). Confira antes de gravar.`);
    }).catch(() => { if (last.current === digits) setNotice("Não foi possível consultar o CNPJ agora. Digite o nome da empresa."); });
  };
  return { notice, onInput };
}

export type ManagerRegistration = { submit: (data: FormData) => Promise<ActionResult>; required: Record<string, string> };

// Formulário de cadastro e edição. CPF e telefone recebem máscara enquanto o usuário digita; o servidor grava só os dígitos.
// Cliente existente: abre em modo de visualização (campos realmente bloqueados) e "Editar" libera os campos. Ao salvar volta
// para a visualização com os dados novos; "Cancelar" descarta o que foi digitado. `onMode` troca o modo a partir do pai.
function ClientForm({ editing, readOnly = false, onChanged, onCancel, onEdit, onSaved, notice = null, manager }: { editing: ClientRow | null; readOnly?: boolean; onChanged: () => void; onCancel: () => void; onEdit?: () => void; onSaved?: (message: string) => void; notice?: string | null; manager?: ManagerRegistration }) {
  // Troca a chave dos campos depois de cadastrar, para limpar também os campos com máscara e o endereço.
  const [resetKey, setResetKey] = useState(0);
  const [docRows, setDocRows] = useState(1);
  const [saved, setSaved] = useState(false);
  const afterSave = (message: string) => {
    onChanged();
    // Edição: volta já para a visualização (sem temporizador, que fechava a tela se o usuário clicasse em Editar de novo).
    if (editing) { onSaved?.(message); return; }
    setSaved(true);
    setResetKey((key) => key + 1); setDocRows(1); setTimeout(() => setSaved(false), 2500);
  };
  // No cadastro novo os documentos já podem ser escolhidos aqui: o cliente é gravado primeiro e cada arquivo vai em seguida,
  // um por envio (limite de 5 MB por arquivo). Se um arquivo falhar, o cliente fica salvo e o aviso diz qual anexar depois.
  const createWithDocuments = async (data: FormData): Promise<ActionResult> => {
    const documents = data.getAll("docLabel").map((label, index) => ({ label: String(label).trim(), file: data.getAll("docFile")[index] }))
      .filter((entry): entry is { label: string; file: File } => entry.file instanceof File && entry.file.size > 0);
    if (data.getAll("docLabel").some((label, index) => !String(label).trim() && data.getAll("docFile")[index] instanceof File && (data.getAll("docFile")[index] as File).size > 0)) {
      return { ok: false, error: "Informe o que é cada documento escolhido (por exemplo RG ou comprovante de residência)." };
    }
    data.delete("docLabel");
    data.delete("docFile");
    const created = await createClientAction(data);
    if (!created.ok || !created.clientId || documents.length === 0) return created;
    const failed: string[] = [];
    for (const entry of documents) {
      const upload = new FormData();
      upload.set("clientId", created.clientId);
      upload.set("label", entry.label);
      upload.set("file", entry.file);
      const result = await uploadClientDocumentAction(upload).catch((): ActionResult => ({ ok: false, error: "Falha no envio." }));
      if (!result.ok) failed.push(`${entry.label} (${result.error})`);
    }
    if (failed.length > 0) return { ok: true, message: `${created.message} Mas não foi possível anexar: ${failed.join("; ")}. Anexe na página do cliente.` };
    return { ok: true, message: `${created.message} ${documents.length === 1 ? "1 documento anexado." : `${documents.length} documentos anexados.`}` };
  };
  const { pending, feedback, onSubmit } = useFormAction(manager ? manager.submit : editing ? updateClientAction : createWithDocuments, afterSave, !editing);
  // Gerente de contas: os campos obrigatórios ganham "required" e um asterisco; o servidor confere de novo.
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!manager) return;
    for (const name of Object.keys(manager.required)) {
      const control = formRef.current?.querySelector<HTMLElement>(`[name="${name}"]`);
      if (!control) continue;
      control.setAttribute("required", "");
      control.closest("label")?.classList.add("is-required");
    }
  }, [manager, resetKey]);
  const prefill = usePersonPrefill("client");
  const company = useCompanyNamePrefill();
  return (
    <section className="panel form-panel" aria-label={editing ? "Editar cliente" : manager ? "Cadastro de cliente indicado" : "Novo cliente"}>
      <div className="panel-header"><div><h2>{editing ? `${readOnly ? "Cadastro de" : "Editar"} ${editing.name}` : manager ? "Cadastrar cliente indicado por você" : "Novo cliente"}</h2><p>{readOnly ? "Clique em Editar para alterar os dados." : manager ? "Os campos com * são obrigatórios: sem eles o cadastro não é gravado. O cliente fica ligado a você." : "Somente o nome é obrigatório."}</p></div></div>
      <form className="form-grid" ref={formRef} onSubmit={onSubmit} onInput={(event) => { if (manager) return; if (!editing) prefill.onInput(event); company.onInput(event); }} key={resetKey}>
        {editing && <input type="hidden" name="clientId" value={editing.id} />}
        <fieldset className="client-fields" disabled={readOnly}>
        {!editing && prefill.notice && <p className="form-feedback" style={{ gridColumn: "1 / -1" }} role="status">{prefill.notice}</p>}
        <label className="field field-wide"><span>Nome completo</span><input name="name" placeholder="Nome completo" maxLength={120} defaultValue={editing?.name ?? ""} required /></label>
        <label className="field"><span>CPF</span><MaskedInput name="document" mask={maskCpf} initial={editing ? formatCpf(editing.document) ?? "" : ""} validate={cpfProblem} inputMode="numeric" placeholder="000.000.000-00" maxLength={40} /></label>
        <label className="field"><span>Telefone</span><MaskedInput name="phone" mask={maskPhone} initial={editing ? formatPhone(editing.phone) ?? "" : ""} inputMode="tel" placeholder="(11) 98765-4321" maxLength={40} /></label>
        <label className="field"><span>WhatsApp</span><MaskedInput name="whatsapp" mask={maskPhone} initial={formatPhone(editing?.whatsapp ?? null) ?? ""} inputMode="tel" placeholder="(11) 98765-4321" maxLength={40} /></label>
        <label className="field"><span>E-mail</span><input name="email" type="email" maxLength={160} defaultValue={editing?.email ?? ""} placeholder="nome@exemplo.com" /></label>
        <label className="field"><span>Instagram</span><input name="instagram" maxLength={200} defaultValue={editing?.instagram ?? ""} placeholder="@usuario ou instagram.com/usuario" /></label>
        <label className="field"><span>Facebook</span><input name="facebook" maxLength={200} defaultValue={editing?.facebook ?? ""} placeholder="@usuario ou facebook.com/usuario" /></label>
        <AddressFields kind="residential" client={editing} />
        <fieldset className="form-section field-wide">
          <legend>Empresa</legend>
          <div className="form-grid">
            <label className="field"><span>CNPJ da empresa</span><MaskedInput name="businessCnpj" mask={maskCnpj} initial={formatCnpj(editing?.businessCnpj ?? null) ?? ""} validate={cnpjProblem} inputMode="numeric" placeholder="00.000.000/0000-00" maxLength={20} /></label>
            <label className="field field-wide"><span>Nome da empresa</span><input name="businessCompanyName" maxLength={160} defaultValue={editing?.businessCompanyName ?? ""} placeholder="Onde o cliente trabalha" /></label>
            <DateField label="Data de admissão" name="businessAdmissionDate" min="1900-01-01" max={todayIso()} defaultValue={editing?.businessAdmissionDate ?? ""} className="field" />
            {company.notice && <p className="form-feedback field-wide" role="status">{company.notice}</p>}
          </div>
        </fieldset>
        <AddressFields kind="business" client={editing} />
        {!manager && <BankFieldset initial={editing} />}
        <fieldset className="form-section field-wide">
          <legend>Referências pessoais</legend>
          <div className="form-grid">
            {referenceSlots.map((slot) => (
              <div key={slot} className="form-grid field-wide reference-row" aria-label={`Referência ${slot}`}>
                <label className="field"><span>Referência {slot}: nome</span><input name={referenceKey(slot, "Name")} maxLength={160} defaultValue={editing?.[referenceKey(slot, "Name")] ?? ""} /></label>
                <label className="field"><span>Referência {slot}: telefone</span><MaskedInput name={referenceKey(slot, "Phone")} mask={maskPhone} initial={formatPhone(editing?.[referenceKey(slot, "Phone")] ?? null) ?? ""} inputMode="tel" placeholder="(11) 98765-4321" maxLength={40} /></label>
                <label className="field"><span>Referência {slot}: grau de parentesco</span><input name={referenceKey(slot, "Relationship")} placeholder="Irmão, vizinho, colega…" maxLength={160} defaultValue={editing?.[referenceKey(slot, "Relationship")] ?? ""} /></label>
              </div>
            ))}
          </div>
        </fieldset>
        <fieldset className="form-section field-wide">
          <legend>Avalista</legend>
          <div className="form-grid">
            <label className="field field-wide"><span>{guarantorPartLabels.Name}</span><input name="guarantorName" maxLength={160} defaultValue={editing?.guarantorName ?? ""} /></label>
            <label className="field"><span>{guarantorPartLabels.Document}</span><MaskedInput name="guarantorDocument" mask={maskCpf} initial={formatCpf(editing?.guarantorDocument ?? null) ?? ""} validate={cpfProblem} inputMode="numeric" placeholder="000.000.000-00" maxLength={40} /></label>
            <label className="field"><span>{guarantorPartLabels.Phone}</span><MaskedInput name="guarantorPhone" mask={maskPhone} initial={formatPhone(editing?.guarantorPhone ?? null) ?? ""} inputMode="tel" placeholder="(11) 98765-4321" maxLength={40} /></label>
            <label className="field field-wide"><span>{guarantorPartLabels.Notes}</span><input name="guarantorNotes" placeholder="Opcional" maxLength={500} defaultValue={editing?.guarantorNotes ?? ""} /></label>
            <p className="capital-note field-wide">O avalista fica no cadastro do cliente e aparece em todas as operações dele.</p>
          </div>
        </fieldset>
        {!editing && !manager && (
          <fieldset className="form-section field-wide">
            <legend>Documentos (opcional)</legend>
            <div className="form-grid">
              {Array.from({ length: docRows }, (_, index) => (
                <div key={index} className="form-grid field-wide reference-row" aria-label={`Documento ${index + 1}`}>
                  <label className="field"><span>Documento {index + 1}</span><input name="docLabel" placeholder="RG, comprovante de residência…" maxLength={120} /></label>
                  <label className="field"><span>Arquivo {index + 1}</span><input name="docFile" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp" /></label>
                </div>
              ))}
              <p className="capital-note field-wide">PDF, JPG, PNG ou WEBP de até 5 MB cada. Os arquivos são anexados assim que o cliente for cadastrado.</p>
              <div className="form-actions field-wide"><button type="button" className="outline-button" onClick={() => setDocRows((rows) => Math.min(rows + 1, 6))} disabled={docRows >= 6}><Icon name="plus" size={16} /> Adicionar outro documento</button></div>
            </div>
          </fieldset>
        )}
          <fieldset className="form-section field-wide">
            <legend>Observações e risco</legend>
            <div className="form-grid">
              <label className="field field-wide"><span>Observações</span><textarea name="notes" rows={4} maxLength={2000} placeholder="Escreva o que desejar sobre o cliente (opcional)" defaultValue={editing?.notes ?? ""} /></label>
              {!manager && <><label className="check-field field-wide"><input type="checkbox" name="onlineCasinoBettor" defaultChecked={editing?.onlineCasinoBettor ?? false} /><span>Apostadora de cassino online</span></label>
              <p className="capital-note field-wide">Marcação interna: quando houver score de concessão de crédito, ela vai tirar muitos pontos do cliente. Por enquanto só fica registrada no cadastro.</p></>}
            </div>
          </fieldset>
        </fieldset>
        <div className="form-actions">
          {readOnly && <>
            <button type="button" className="outline-button" onClick={onCancel}>Fechar</button>
            <button type="button" className="primary-button" onClick={onEdit}><Icon name="check" size={16} /> Editar</button>
          </>}
          {editing && !readOnly && <button type="button" className="outline-button" onClick={onCancel}>Cancelar</button>}
          {!readOnly && <button className="primary-button" disabled={pending}><Icon name={editing || saved ? "check" : "plus"} size={16} /> {pending ? "Salvando…" : saved ? "Salvo" : editing ? "Salvar alterações" : manager ? "Cadastrar cliente" : "Cadastrar cliente"}</button>}
        </div>
      </form>
      <Feedback feedback={feedback ?? (notice ? { tone: "ok", text: notice } : null)} />
    </section>
  );
}

function DeleteClientDialog({ client, onClose, onChanged }: { client: ClientRow; onClose: () => void; onChanged: () => void }) {
  if (client.openOperationCount > 0) {
    return (
      <ConfirmDialog title={`Excluir ${client.name}`} onClose={onClose} onDone={onChanged}>
        <p><strong>{client.name}</strong> tem {client.openOperationCount} operaç{client.openOperationCount === 1 ? "ão" : "ões"} em aberto e não pode ser excluído agora.</p>
        <p>Registre a quitação ou exclua a operação em Operações antes.</p>
      </ConfirmDialog>
    );
  }
  return (
    <ConfirmDialog title={`Excluir ${client.name}`} confirmLabel={client.hasHistory ? "Arquivar cliente" : "Excluir definitivamente"} action={deleteClientAction} fields={{ clientId: client.id }} onClose={onClose} onDone={onChanged}>
      {client.hasHistory ? (
        <><p><strong>{client.name}</strong> tem histórico de operações, então será <strong>arquivado</strong>, não apagado.</p>
          <p>Ele sai da lista de clientes e do cadastro de novas operações. As operações e pagamentos já registrados continuam no histórico e nos cálculos.</p></>
      ) : (
        <><p><strong>{client.name}</strong> não tem nenhuma operação. O cadastro será <strong>excluído definitivamente</strong>.</p><p>Essa ação não pode ser desfeita.</p></>
      )}
    </ConfirmDialog>
  );
}

function clientSituation(profile: OperationsSummary) {
  if (profile.operationCount === 0) return { label: "Sem operações", tone: "status-muted" };
  if (profile.overdueCount > 0) return { label: "Em atraso", tone: "status-late" };
  if (profile.openCount > 0) return { label: "Em aberto", tone: "status-active" };
  return { label: "Quitado", tone: "status-paid" };
}

// Rentabilidade de um conjunto de operações. Juros recebidos = lucro realizado; juros a receber = lucro só previsto.
// Na página do cliente os nomes seguem o vocabulário da operação (emprestado originalmente, principal em aberto, quitação).
function ProfitabilitySummary({ profile, client = false, children }: { profile: OperationsSummary; client?: boolean; children?: ReactNode }) {
  return (
    <dl className="payment-summary">
      <div><dt>{client ? "Valor originalmente emprestado" : "Principal emprestado"}</dt><dd>{formatMoney(profile.principalCents)}</dd></div>
      <div><dt>Juros contratados</dt><dd>{formatMoney(profile.interestCents)}</dd></div>
      <div><dt>Total originalmente previsto</dt><dd>{formatMoney(profile.originalTotalCents)}</dd></div>
      <div><dt>Total recebido</dt><dd>{formatMoney(profile.paidCents)}</dd></div>
      <div><dt>Juros recebidos (lucro realizado)</dt><dd>{formatMoney(profile.interestPaidCents)}</dd></div>
      <div><dt>Principal recuperado</dt><dd>{formatMoney(profile.principalPaidCents)}</dd></div>
      <div><dt>{client ? "Principal em aberto" : "Saldo de principal"}</dt><dd>{formatMoney(profile.principalRemainingCents)}</dd></div>
      <div><dt>Saldo de juros (lucro previsto)</dt><dd>{formatMoney(profile.interestRemainingCents)}</dd></div>
      <div className="payment-balance"><dt>{client ? "Valor atual para quitação" : "Saldo total"}</dt><dd>{formatMoney(profile.balanceCents)}</dd></div>
      {children}
    </dl>
  );
}

// Destaque no topo do detalhe da operação: quanto já se lucrou (juros recebidos) com a pessoa, em todos os contratos e
// ciclos, e quanto deste contrato. Mesma conta da ficha do cliente (clientProfitHistory).
function OperationProfitHero({ operation }: { operation: OperationView }) {
  const [operations, setOperations] = useState<OperationView[] | null>(null);
  const version = `${operation.id}:${operation.payments.length}:${operation.paidCents}`;
  useEffect(() => {
    let active = true;
    loadAllCyclesReportAction().then((result) => { if (active && result.ok) setOperations(result.operations); }).catch(() => undefined);
    return () => { active = false; };
  }, [version]);
  const history = operations ? clientProfitHistory(operations, operation.clientId) : null;
  const total = history ? history.interestReceivedCents : operation.interestPaidCents;
  return (
    <div className="profit-hero" aria-label={`Lucro com ${operation.clientName}`}>
      <div><span>Lucro com {operation.clientName}</span><strong>{formatMoney(total)}</strong></div>
      <small>{history
        ? `Juros já recebidos em ${history.operationCount === 1 ? "1 contrato" : `${history.operationCount} contratos`}. Neste contrato: ${formatMoney(operation.interestPaidCents)}.${history.paidCount > 0 ? ` Contratos quitados deram ${formatMoney(history.paidContractsProfitCents)}.` : ""}`
        : `Neste contrato: ${formatMoney(operation.interestPaidCents)} de juros recebidos. Carregando o total da pessoa…`}</small>
    </div>
  );
}

function OperationDetailsButton({ operation, today, onChanged, readOnly = false }: { operation: OperationView; today: string; onChanged: () => void; readOnly?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="outline-button" onClick={() => setOpen(true)}>Detalhes</button>
      {open && <PaymentPanel operation={operation} today={today} onClose={() => setOpen(false)} onChanged={onChanged} readOnly={readOnly} />}
    </>
  );
}

// Frases de uma operação, como o cliente e a carteira enxergam: quanto emprestou, quanto já recebeu e quanto falta.
function operationPhrases(operation: OperationView) {
  const phrases = [`Emprestou ${formatMoney(operation.principalCents)} para ${operation.clientName} em ${formatDate(operation.loanDate)}.`];
  if (amortized(operation)) {
    phrases.push(`${modalityLabel(operation)} (taxa de ${rateLabel(operation)}, lucro previsto de ${formatMoney(operation.interestCents)}).`,
      `${operation.installments.filter((item) => item.state === "PAID").length} de ${plural(operation.installmentTotal, "parcela paga", "parcelas pagas")}.`);
  } else {
    phrases.push(`${modalityLabel(operation)}. Juros por período: ${formatMoney(operation.periodInterestCents)} (${rateLabel(operation)} sobre ${formatMoney(operation.principalRemainingCents || operation.principalCents)}).`);
  }
  phrases.push(`Já recebeu ${formatMoney(operation.interestPaidCents)} de juros (lucro realizado).`);
  const elapsed = formatElapsed(operation.loanDate, operation.elapsedUntil);
  if (operation.renegotiatedFrom.length > 0) {
    phrases.push(`Contrato de renegociação: veio ${operation.renegotiatedFrom.length === 1 ? "da operação" : "das operações"} ${operation.renegotiatedFrom.map((from) => `#${from.code} (principal ${formatMoney(from.principalCents)}, juros em aberto ${formatMoney(from.interestCents)})`).join(", ")}.`);
  }
  if (operation.status === "RENEGOTIATED") {
    phrases.push(`Operação renegociada${operation.renegotiatedOn ? ` em ${formatDate(operation.renegotiatedOn)}` : ""}: o saldo em aberto foi levado para o contrato #${operation.renegotiatedIntoCode ?? ""}.`);
  } else if (operation.status === "PAID") {
    phrases.push(`Operação quitada${operation.settledAt ? ` em ${formatDate(operation.settledAt)}` : ""}, depois de ${elapsed === "hoje" ? "menos de um dia" : elapsed}.`);
  } else {
    phrases.push(elapsed === "hoje" ? "Operação ativa desde hoje." : `Operação ativa há ${elapsed}.`);
  }
  if (operation.renewalCount > 0) phrases.push(`${plural(operation.renewalCount, "período renovado", "períodos renovados")}.`);
  if (operation.status === "OPEN") {
    phrases.push(`Principal em aberto: ${formatMoney(operation.principalRemainingCents)}.`, `Valor para quitação: ${formatMoney(operation.balanceCents)}.`);
    phrases.push(`Próximo vencimento: ${formatDate(operation.nextDueDate)}${operation.daysUntilDue < 0 ? ` (em atraso há ${plural(-operation.daysUntilDue, "dia", "dias")})` : ""}.`);
  }
  return phrases;
}

export const formatBytes = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(Math.round(bytes / 1024), 1)} KB` : `${(bytes / 1024 / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`);

// Documentos anexados ao cadastro do cliente (PDF ou imagem, até 5 MB). Cada arquivo fica ligado a este cliente.
function ClientDocuments({ client, onChanged }: { client: ClientRow; onChanged: () => void }) {
  const [deleting, setDeleting] = useState<ClientRow["documents"][number] | null>(null);
  const { pending, feedback, onSubmit } = useFormAction(uploadClientDocumentAction, onChanged);
  return (
    <section className="panel form-panel" aria-label={`Documentos de ${client.name}`}>
      <div className="panel-header"><div><div className="panel-title-row"><h2>Documentos</h2><span className="today-count">{client.documents.length}</span></div><p>RG, CPF, comprovante de residência, contrato… PDF, JPG, JPEG ou PNG de até 5 MB, guardados no cadastro de {client.name}.</p></div></div>
      {client.documents.length > 0 && (
        <ul className="document-list">{client.documents.map((document) => (
          <li key={document.id}>
            <div><strong>{document.label}</strong><small>{document.fileName} · {formatBytes(document.sizeBytes)} · enviado em {formatDate(todayIso(new Date(document.createdAt)))}</small></div>
            <span className="row-actions">
              <a className="outline-button" href={`/documentos/${document.id}`} target="_blank" rel="noreferrer">Abrir</a>
              <button type="button" className="outline-button danger-outline" onClick={() => setDeleting(document)}>Excluir</button>
            </span>
          </li>
        ))}</ul>
      )}
      <form className="form-grid" onSubmit={onSubmit} aria-label="Anexar documento">
        <input type="hidden" name="clientId" value={client.id} />
        <label className="field"><span>Documento</span><input name="label" placeholder="RG, comprovante de residência…" maxLength={120} required /></label>
        <label className="field"><span>Arquivo</span><input name="file" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp" required /></label>
        <div className="form-actions"><button className="primary-button" disabled={pending}><Icon name="plus" size={16} /> {pending ? "Enviando…" : "Anexar documento"}</button></div>
      </form>
      <Feedback feedback={feedback} />
      {deleting && (
        <ConfirmDialog title={`Excluir ${deleting.label}`} confirmLabel="Excluir documento" action={deleteClientDocumentAction} fields={{ documentId: deleting.id }} onClose={() => setDeleting(null)} onDone={onChanged}>
          <p>O arquivo <strong>{deleting.fileName}</strong> será removido do cadastro de {client.name}. Essa ação não pode ser desfeita.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

// Dados do cadastro completo: endereços, referências e avalista.
function ClientProfilePanel({ client, readOnly = false }: { client: ClientRow; readOnly?: boolean }) {
  const references = referenceSlots.map((slot) => ({
    slot, name: client[referenceKey(slot, "Name")], phone: formatPhone(client[referenceKey(slot, "Phone")]), relationship: client[referenceKey(slot, "Relationship")],
  }));
  const guarantor = [client.guarantorName, formatCpf(client.guarantorDocument) && `CPF ${formatCpf(client.guarantorDocument)}`, formatPhone(client.guarantorPhone), client.guarantorNotes].filter(Boolean).join(" · ");
  return (
    <section className="panel form-panel" aria-label={`Cadastro de ${client.name}`}>
      <div className="panel-header"><div><h2>Cadastro</h2><p>{readOnly ? "Dados de contato do cliente que você indicou." : "Use \"Editar\" na lista de clientes para alterar estes dados."}</p></div></div>
      <dl className="payment-summary profile-summary">
        <div><dt>CPF</dt><dd>{formatCpf(client.document) ?? "—"}</dd></div>
        <div><dt>Telefone</dt><dd>{formatPhone(client.phone) ?? "—"}</dd></div>
        <div><dt>WhatsApp</dt><dd>{client.whatsapp ? (whatsappHref(client.whatsapp) ? <a className="text-link inline-link" href={whatsappHref(client.whatsapp) ?? undefined} target="_blank" rel="noreferrer noopener">{formatPhone(client.whatsapp)}</a> : formatPhone(client.whatsapp)) : "—"}</dd></div>
        <div><dt>E-mail</dt><dd>{client.email ? <a className="text-link inline-link" href={`mailto:${client.email}`}>{client.email}</a> : "—"}</dd></div>
        {(Object.keys(SOCIAL_NETWORKS) as SocialNetwork[]).map((network) => {
          const href = socialHref(network, client[network]);
          return <div key={network}><dt>{SOCIAL_NETWORKS[network]}</dt><dd>{!client[network] ? "—" : href ? <a className="text-link inline-link" href={href} target="_blank" rel="noreferrer noopener">{socialLabel(client[network])}</a> : client[network]}</dd></div>;
        })}
        {(Object.keys(addressKinds) as AddressKind[]).map((kind) => <div key={kind}><dt>{addressKinds[kind]}</dt><dd>{formatAddress(client, kind) ?? "Não informado"}</dd></div>)}
        <div><dt>Empresa</dt><dd>{[client.businessCompanyName, client.businessCnpj && `CNPJ ${formatCnpj(client.businessCnpj)}`, client.businessAdmissionDate && `admitido em ${formatDate(client.businessAdmissionDate)}`].filter(Boolean).join(" · ") || "Não informada"}</dd></div>
        {!readOnly && <BankSummaryRows values={client} />}
        {references.map((reference) => (
          <div key={reference.slot}><dt>Referência {reference.slot}</dt><dd>{reference.name ? [reference.name, reference.relationship, reference.phone].filter(Boolean).join(" · ") : "Não informada"}</dd></div>
        ))}
        <div><dt>Avalista</dt><dd>{guarantor || "Não informado"}</dd></div>
        {client.onlineCasinoBettor && <div><dt>Risco</dt><dd><span className="status-chip status-late"><i />Apostadora de cassino online</span></dd></div>}
        {client.notes && <div><dt>Observações</dt><dd>{client.notes}</dd></div>}
      </dl>
    </section>
  );
}

// Lucro do cliente em todos os ciclos: ajuda a decidir uma renovação ou novo empréstimo (o lucro já recebido amortece o risco).
function ClientProfitPanel({ client, portfolio }: { client: ClientRow; portfolio: TenantPortfolio }) {
  const [loaded, setLoaded] = useState<{ operations: OperationView[] } | { error: string } | null>(null);
  // Recarrega quando algo muda na carteira (pagamento, nova operação); a lista dos ciclos encerrados não muda.
  const version = portfolio.payments.length + portfolio.operations.length;
  useEffect(() => {
    let active = true;
    loadAllCyclesReportAction()
      .then((result) => { if (active) setLoaded(result.ok ? { operations: result.operations } : { error: result.error }); })
      .catch(() => { if (active) setLoaded({ error: "Não foi possível carregar o histórico de lucro agora." }); });
    return () => { active = false; };
  }, [client.id, version]);
  const history = loaded && "operations" in loaded ? clientProfitHistory(loaded.operations, client.id) : null;
  return (
    <section className="panel table-panel" aria-label={`Lucro histórico de ${client.name}`}>
      <div className="panel-header"><div><h2>Lucro com este cliente</h2><p>Juros efetivamente recebidos em todos os contratos e ciclos da carteira. Serve de apoio para decidir uma renovação.</p></div></div>
      {!loaded ? <EmptyPanel icon="chart" text="Carregando o histórico de lucro…" /> : !history ? <EmptyPanel icon="chart" text={"error" in loaded ? loaded.error : ""} /> : history.operationCount === 0 ? <EmptyPanel icon="chart" text="Este cliente ainda não tem contratos." /> : (
        <>
          <div className="profit-hero" aria-label={`Lucro com ${client.name}`}>
            <div><span>Lucro com {client.name}</span><strong>{formatMoney(history.interestReceivedCents)}</strong></div>
            <small>Só juros já recebidos, somando todos os contratos e ciclos.{history.paidCount > 0 ? ` Contratos quitados deram ${formatMoney(history.paidContractsProfitCents)}.` : ""}</small>
          </div>
          <dl className="payment-summary client-highlights">
            <div><dt>Contratos quitados</dt><dd>{history.paidCount}</dd><small>{history.paidCount > 0 ? `Lucro deles: ${formatMoney(history.paidContractsProfitCents)}` : "Nenhum ainda"}</small></div>
            <div><dt>Contratos em aberto</dt><dd>{history.openCount}</dd></div>
            <div><dt>Total emprestado</dt><dd>{formatMoney(history.principalLentCents)}</dd></div>
            <div><dt>Principal em aberto hoje</dt><dd>{formatMoney(history.principalOpenCents)}</dd></div>
            <div><dt>Principal em risco após o lucro</dt><dd>{formatMoney(history.exposureAfterProfitCents)}</dd><small>{history.coveragePercent === null ? "Sem principal em aberto" : `O lucro recebido cobre ${history.coveragePercent}% do principal em aberto`}</small></div>
          </dl>
          <div className="table-scroll"><table className="data-table">
            <thead><tr><th>Operação</th><th>Data</th><th>Situação</th><th>Principal</th><th>Total recebido</th><th>Lucro (juros recebidos)</th></tr></thead>
            <tbody>{history.rows.map((row) => (
              <tr key={row.id}>
                <td><strong>#{row.code}</strong>{row.cycleNumber !== null && row.cycleNumber !== portfolio.summary.cycleNumber && <small>Ciclo {row.cycleNumber}</small>}</td>
                <td>{formatDate(row.loanDate)}</td><td>{row.status === "PAID" ? "Quitado" : row.status === "RENEGOTIATED" ? "Renegociado" : "Em aberto"}</td>
                <td>{formatMoney(row.principalCents)}</td><td>{formatMoney(row.receivedCents)}</td><td><strong>{formatMoney(row.interestReceivedCents)}</strong></td>
              </tr>
            ))}</tbody>
          </table></div>
        </>
      )}
    </section>
  );
}

// Página do cliente: cadastro, documentos, resumo financeiro e cada operação separada. Valores só do ciclo atual da carteira.
function ClientDetail({ client, portfolio, onBack, onChanged, readOnly = false }: { client: ClientRow; portfolio: TenantPortfolio; onBack: () => void; onChanged: () => void; readOnly?: boolean }) {
  const profile = client.profile;
  const operations = portfolio.operations.filter((operation) => operation.clientId === client.id);
  const open = operations.filter((operation) => operation.status === "OPEN");
  const nextDue = open.reduce<string | null>((first, operation) => (first === null || operation.nextDueDate < first ? operation.nextDueDate : first), null);
  // Juros por período das operações de pagamento único em aberto (no parcelado o lucro vem dentro das parcelas).
  const recurring = open.filter((operation) => !amortized(operation));
  const periodInterestCents = recurring.reduce((total, operation) => total + operation.periodInterestCents, 0);
  const rates = [...new Set(recurring.map(rateLabel))];
  const situation = clientSituation(profile);
  // Rentabilidade realizada: juros recebidos sobre o principal emprestado.
  const profitability = profile.principalCents > 0 ? `${((profile.interestPaidCents / profile.principalCents) * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%` : "—";
  return (
    <div className="workspace-page">
      <PageHeading eyebrow="CREDIAI · CLIENTES" title={client.name} description={[formatCpf(client.document) && `CPF ${formatCpf(client.document)}`, formatPhone(client.phone), client.notes].filter(Boolean).join(" · ") || "Cliente da carteira."}>
        <button className="outline-button" onClick={onBack}><Icon name="arrow" size={15} /> Voltar para clientes</button>
      </PageHeading>
      <ClientProfitPanel client={client} portfolio={portfolio} />
      <section className="panel form-panel" aria-label={`Resumo de ${client.name}`}>
        <div className="panel-header"><div>
          <div className="panel-title-row"><h2>Resumo do cliente</h2><span className={`status-chip ${situation.tone}`}><i />{situation.label}</span></div>
          <p>{profile.operationCount === 0 ? "Nenhuma operação no ciclo atual da carteira."
            : `Emprestou ${formatMoney(profile.principalCents)} para ${client.name} e já recebeu ${formatMoney(profile.interestPaidCents)} de juros.${profile.principalRemainingCents > 0 ? ` Ainda faltam ${formatMoney(profile.principalRemainingCents)} de principal para recuperar.` : " Todo o principal foi recuperado."}`}</p>
        </div></div>
        <dl className="payment-summary client-highlights">
          <div className="payment-balance"><dt>Lucro realizado</dt><dd>{formatMoney(profile.interestPaidCents)}</dd><small>Só juros efetivamente recebidos</small></div>
          <div><dt>Principal emprestado</dt><dd>{formatMoney(profile.principalCents)}</dd></div>
          <div><dt>Principal recebido</dt><dd>{formatMoney(profile.principalPaidCents)}</dd></div>
          <div><dt>Juros por período</dt><dd>{periodInterestCents > 0 ? `${formatMoney(periodInterestCents)}${rates.length === 1 ? ` (${rates[0]})` : ""}` : "—"}</dd></div>
          <div><dt>Próximo vencimento</dt><dd>{nextDue ? formatDate(nextDue) : "—"}</dd></div>
          <div><dt>Status</dt><dd>{situation.label}</dd></div>
        </dl>
        <ProfitabilitySummary profile={profile} client>
          <div><dt>Total de pagamentos</dt><dd>{formatMoney(profile.paidCents)} em {plural(profile.paymentCount, "pagamento", "pagamentos")}</dd></div>
          <div><dt>Períodos renovados</dt><dd>{profile.renewalCount}</dd></div>
          <div><dt>Rentabilidade (juros recebidos ÷ emprestado)</dt><dd>{profitability}</dd></div>
          <div><dt>Data de início</dt><dd>{profile.firstLoanDate ? formatDate(profile.firstLoanDate) : "—"}</dd></div>
          <div><dt>Tempo de operação</dt><dd>{profile.firstLoanDate ? formatElapsed(profile.firstLoanDate, portfolio.today) : "—"}</dd></div>
          <div><dt>Operações ativas</dt><dd>{profile.openCount}</dd></div>
          <div><dt>Operações quitadas</dt><dd>{profile.paidCount}</dd></div>
          <div><dt>Pagamentos realizados</dt><dd>{profile.paymentCount}</dd></div>
        </ProfitabilitySummary>
      </section>
      {operations.length > 0 && (
        <section className="panel form-panel" aria-label={`Cada operação de ${client.name}`}>
          <div className="panel-header"><div><h2>Cada operação</h2><p>Situação de cada empréstimo, separadamente.</p></div></div>
          <div className="operation-stories">{operations.map((operation) => (
            <article key={operation.id} className="operation-story" aria-label={`Operação #${operation.code}`}>
              <header><strong>#{operation.code}</strong><StatusChip state={operation.state} daysUntilDue={operation.daysUntilDue} /></header>
              <ul>{operationPhrases(operation).map((phrase) => <li key={phrase}>{phrase}</li>)}</ul>
            </article>
          ))}</div>
        </section>
      )}
      <section className="panel table-panel" aria-label={`Operações de ${client.name}`}>
        <div className="panel-header"><div><div className="panel-title-row"><h2>Operações</h2><span className="today-count">{operations.length}</span></div><p>Cada operação separadamente. &quot;Detalhes&quot; abre o histórico de pagamentos.</p></div></div>
        {operations.length === 0 ? <EmptyPanel icon="wallet" text="Nenhuma operação para este cliente no ciclo atual." /> : (
          <div className="table-scroll"><table className="data-table fit-table">
            <thead><tr><th>Operação</th><th>Principal e juros</th><th>Total original</th><th>Recebido</th><th>Saldo</th><th>A cobrar no vencimento</th><th>Vencimento e situação</th><th /></tr></thead>
            <tbody>{operations.map((operation) => (
              <tr key={operation.id}>
                <td data-label="Operação"><strong>#{operation.code}</strong><small>Emprestado em {formatDate(operation.loanDate)} · {operationAge(operation)}</small></td>
                <td data-label="Principal e juros">{formatMoney(operation.principalCents)}<small>juros {formatMoney(operation.interestCents)}{operation.renewalCount > 0 && ` · ${plural(operation.renewalCount, "renovação", "renovações")}`}</small></td>
                <td data-label="Total original">{formatMoney(operation.originalTotalCents)}</td>
                <td data-label="Recebido">{formatMoney(operation.paidCents)}<small>juros {formatMoney(operation.interestPaidCents)} · principal {formatMoney(operation.principalPaidCents)}</small><small>{plural(operation.payments.length, "pagamento", "pagamentos")}</small></td>
                <td data-label="Saldo"><strong>{formatMoney(operation.balanceCents)}</strong></td>
                <AmountToCollectCell operation={operation} />
                <td data-label="Vencimento e situação">{formatDate(operation.nextDueDate)}{operation.nextInstallment && <small>Parcela {operation.nextInstallment.number}/{operation.installmentTotal}</small>}{operation.renewalCount > 0 && <small>{plural(operation.renewalCount, "renovação", "renovações")}</small>}<div className="fit-status"><StatusChip state={operation.state} daysUntilDue={operation.daysUntilDue} /></div></td>
                <td className="actions-cell"><OperationDetailsButton operation={operation} today={portfolio.today} onChanged={onChanged} readOnly={readOnly} /></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      <ClientProfilePanel client={client} readOnly={readOnly} />
      {!readOnly && <ClientDocuments client={client} onChanged={onChanged} />}
    </div>
  );
}

// Busca rápida: o servidor procura na carteira da sessão por nome (sem acentos, partes do nome), CPF ou telefone,
// formatados ou não. Fica no topo da tela Clientes; "Abrir" leva direto à ficha do cliente.
function ClientSearch({ onOpen, onEdit, onDelete }: { onOpen: (id: string) => void; onEdit: (id: string) => void; onDelete: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<{ query: string; results: ClientSearchResult[]; error?: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const trimmed = query.trim();
  useEffect(() => {
    if (!trimmed) return;
    const timer = setTimeout(() => startTransition(async () => {
      try {
        const result = await searchClientsAction(trimmed);
        setState(result.ok ? { query: trimmed, results: result.results } : { query: trimmed, results: [], error: result.error });
      } catch {
        setState({ query: trimmed, results: [], error: "Não foi possível buscar agora. Tente novamente." });
      }
    }), 250);
    return () => clearTimeout(timer);
  }, [trimmed]);
  const shown = trimmed && state?.query === trimmed ? state : null;
  const tooShort = trimmed !== "" && !/\p{L}/u.test(trimmed) && onlyDigits(trimmed).length < 3;
  return (
    <section className="panel table-panel" aria-label="Buscar cliente">
      <div className="client-search" role="search">
        <label className="client-search-box">
          <span className="search-icon"><Icon name="search" size={16} /></span>
          <input type="search" aria-label="Buscar cliente por nome, CPF, telefone ou e-mail" placeholder="Buscar por nome, CPF, telefone ou e-mail" value={query} maxLength={120} onChange={(event) => setQuery(event.target.value)} />
          {query && <button type="button" className="search-clear" aria-label="Limpar busca" onClick={() => setQuery("")}>×</button>}
        </label>
        {trimmed && <p className="client-search-status" role="status">{tooShort ? "Digite ao menos 3 números do CPF ou do telefone." : !shown || pending ? "Buscando…" : shown.error ?? `${shown.results.length === 0 ? "Nenhum cliente encontrado" : plural(shown.results.length, "cliente encontrado", "clientes encontrados")} para "${trimmed}".`}</p>}
      </div>
      {trimmed && shown && shown.results.length > 0 && (
        <div className="table-scroll"><table className="data-table" aria-label="Resultado da busca">
          <thead><tr><th>Nome</th><th>CPF</th><th>Telefone</th><th>Situação</th><th /></tr></thead>
          <tbody>{shown.results.map((client) => (
            <tr key={client.id}>
              <td><strong>{client.name}</strong>{client.email && <small className="admin-cell-note">{client.email}</small>}</td><td>{formatCpf(client.document) ?? "—"}</td>
              <td className="nowrap-cell">{formatPhone(client.phone) ?? "—"}{client.whatsapp && <small>WhatsApp {formatPhone(client.whatsapp)}</small>}</td>
              <td>{client.archived ? <span className="status-chip status-muted"><i />Arquivado</span> : <span className="status-chip status-active"><i />Ativo</span>}</td>
              <td className="actions-cell">{client.archived ? <small>Histórico em Operações</small> : <span className="row-actions"><button className="outline-button" onClick={() => onOpen(client.id)}>Abrir</button><button className="outline-button" onClick={() => onEdit(client.id)}>Editar</button><button className="outline-button danger-outline" onClick={() => onDelete(client.id)}>Excluir</button></span>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </section>
  );
}

export function ClientsPage({ portfolio, onChanged, onNewOperation, initialClientId = null, readOnly = false, manager }: { portfolio: TenantPortfolio; onChanged: () => void; onNewOperation: () => void; initialClientId?: string | null; readOnly?: boolean; manager?: ManagerRegistration }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  // Número que muda a cada Editar/Cancelar/Salvar: o formulário recomeça com os dados mais recentes salvos.
  const [formVersion, setFormVersion] = useState(0);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const editing = portfolio.clients.find((client) => client.id === editingId) ?? null;
  const startEdit = (row: ClientRow) => { setEditingId(row.id); setEditMode(true); setSavedNotice(null); setFormVersion((version) => version + 1); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const [deleting, setDeleting] = useState<ClientRow | null>(null);
  const [viewingId, setViewingId] = useState<string | null>(initialClientId);
  // Busca o cliente de novo a cada atualização para que a página mostre os valores mais recentes.
  const viewing = portfolio.clients.find((client) => client.id === viewingId);
  const [localFilter, setLocalFilter] = useState("");
  if (viewing) return <ClientDetail client={viewing} portfolio={portfolio} onBack={() => setViewingId(null)} onChanged={onChanged} readOnly={readOnly} />;
  const foldText = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const shownClients = readOnly && localFilter.trim() ? portfolio.clients.filter((client) => foldText(client.name).includes(foldText(localFilter.trim())) || (client.document ?? "").includes(onlyDigits(localFilter)) && onlyDigits(localFilter).length >= 3) : portfolio.clients;
  return (
    <div className="workspace-page">
      <PageHeading eyebrow="CREDIAI · CLIENTES" title="Clientes" description={readOnly ? "Os clientes que você indicou, com a situação real de cada um. Somente leitura." : "Cadastre os clientes da sua carteira para vincular operações."}>
        {!readOnly && <button className="primary-button" onClick={onNewOperation}><Icon name="plus" size={17} /> Nova operação</button>}
      </PageHeading>
      {readOnly && (
        <section className="panel table-panel" aria-label="Buscar cliente">
          <div className="client-search" role="search"><label className="client-search-box"><span className="search-icon"><Icon name="search" size={16} /></span>
            <input type="search" aria-label="Buscar cliente por nome ou CPF" placeholder="Buscar por nome ou CPF" value={localFilter} maxLength={120} onChange={(event) => setLocalFilter(event.target.value)} />
            {localFilter && <button type="button" className="search-clear" aria-label="Limpar busca" onClick={() => setLocalFilter("")}>×</button>}</label></div>
        </section>
      )}
      {!readOnly && <ClientSearch onOpen={(id) => { setViewingId(id); window.scrollTo({ top: 0 }); }}
        onEdit={(id) => { const row = portfolio.clients.find((client) => client.id === id); if (row) startEdit(row); }}
        onDelete={(id) => { const row = portfolio.clients.find((client) => client.id === id); if (row) setDeleting(row); }} />}
      {!readOnly && <ClientForm key={`${editing?.id ?? "new"}:${formVersion}:${editing ? JSON.stringify(editing) : ""}`} editing={editing} readOnly={editing !== null && !editMode} onChanged={onChanged}
        notice={savedNotice} onEdit={() => { setEditMode(true); setSavedNotice(null); setFormVersion((version) => version + 1); }}
        onSaved={(message) => { setSavedNotice(message); setEditMode(false); }}
        onCancel={() => { setSavedNotice(null); if (editing && editMode) { setEditMode(false); setFormVersion((version) => version + 1); } else { setEditingId(null); setEditMode(false); } }} />}
      {readOnly && manager && <ClientForm editing={null} manager={manager} onChanged={onChanged} onCancel={() => {}} />}
      {!readOnly && editing && (() => {
        // Documentos também na edição (anexar depois do cadastro). Usa a linha atual da carteira para a lista refletir os envios.
        const current = portfolio.clients.find((client) => client.id === editing.id);
        return current ? <ClientDocuments key={current.id} client={current} onChanged={onChanged} /> : null;
      })()}
      <section className="panel table-panel" aria-label="Lista de clientes">
        <div className="panel-header"><div><div className="panel-title-row"><h2>Clientes da carteira</h2><span className="today-count">{shownClients.length}</span></div></div></div>
        {portfolio.clients.length === 0 ? <EmptyPanel icon="users" text={readOnly ? "Você ainda não tem clientes indicados. Cadastre o primeiro no formulário acima." : "Nenhum cliente cadastrado ainda."} /> : (
          <div className="table-scroll"><table className="data-table">
            <thead><tr><th>Nome</th><th>CPF</th><th>Telefone</th><th>Operações</th><th>Emprestado</th><th>Juros recebidos</th><th>Saldo</th><th /></tr></thead>
            <tbody>{shownClients.map((client) => <tr key={client.id}><td><button className="text-link client-link" onClick={() => { setViewingId(client.id); window.scrollTo({ top: 0 }); }}><strong>{client.name}</strong></button>{client.notes && <small>{client.notes}</small>}</td><td>{formatCpf(client.document) ?? "—"}</td><td className="nowrap-cell">{formatPhone(client.phone) ?? "—"}{client.whatsapp && <small>WhatsApp {formatPhone(client.whatsapp)}</small>}</td><td>{client.operationCount}</td><td>{formatMoney(client.profile.principalCents)}</td><td>{formatMoney(client.profile.interestPaidCents)}</td><td>{formatMoney(client.profile.balanceCents)}</td><td className="actions-cell"><span className="row-actions"><button className="outline-button" onClick={() => { setViewingId(client.id); window.scrollTo({ top: 0 }); }}>Ver</button>{!readOnly && <><button className="outline-button" onClick={() => startEdit(client)}>Editar</button><button className="outline-button danger-outline" onClick={() => setDeleting(client)}>Excluir</button></>}</span></td></tr>)}</tbody>
          </table></div>
        )}
        {portfolio.archivedClients.length > 0 && <p className="capital-note">Arquivados ({portfolio.archivedClients.length}): {portfolio.archivedClients.map((client) => client.name).join(", ")}. O histórico deles continua em Operações e Pagamentos.</p>}
      </section>
      {deleting && <DeleteClientDialog client={deleting} onClose={() => setDeleting(null)} onChanged={() => { if (editingId === deleting.id) setEditingId(null); onChanged(); }} />}
    </div>
  );
}

// Nova operação. Pagamento único com periodicidade mensal, quinzenal (juros recorrentes, renovação pagando só os juros)
// ou diária (total dividido em pagamentos diários); ou parcelado (valor emprestado, parcela fixa, primeiro vencimento e
// prazo). A prévia usa as mesmas funções de rules.ts que o servidor usa ao gravar.
function OperationForm({ portfolio, onChanged, onNewClient, request, cashAvailableCents }: { portfolio: TenantPortfolio; onChanged: () => void; onNewClient: () => void; request?: (data: FormData) => Promise<ActionResult>; cashAvailableCents?: number }) {
  const [modality, setModality] = useState<"SINGLE" | "INSTALLMENT">("SINGLE");
  const [frequency, setFrequency] = useState<Frequency>("MONTHLY");
  // Parcelado: parcelas mensais (padrão) ou quinzenais.
  const [installmentFrequency, setInstallmentFrequency] = useState<InstallmentFrequency>("MONTHLY");
  const [principal, setPrincipal] = useState("");
  const [rate, setRate] = useState("");
  const [loanAmount, setLoanAmount] = useState("");
  const [installment, setInstallment] = useState("");
  const [term, setTerm] = useState("");
  const [days, setDays] = useState("");
  // Quinzenal: juros pela taxa da quinzena ou por um valor fixo em reais.
  const [interestMode, setInterestMode] = useState<"RATE" | "FIXED">("RATE");
  const [interestAmount, setInterestAmount] = useState("");
  const [firstDue, setFirstDue] = useState(addDays(portfolio.today, 1));
  const [loanDate, setLoanDate] = useState(portfolio.today);
  const [dueDate, setDueDate] = useState("");
  const [resetKey, setResetKey] = useState(0);
  const { pending, feedback, onSubmit } = useFormAction(request ?? createOperationAction, () => {
    setPrincipal(""); setRate(""); setLoanAmount(""); setInstallment(""); setTerm(""); setDays(""); setDueDate(""); setInterestAmount(""); setFirstDue(addDays(portfolio.today, 1)); setLoanDate(portfolio.today); setResetKey((key) => key + 1); onChanged();
  });
  const single = modality === "SINGLE";
  const daily = single && frequency === "DAILY";
  const principalCents = parseMoneyToCents(single ? principal : loanAmount);
  const rateBps = parseLoanRateToBps(rate);
  const installmentCents = parseMoneyToCents(installment);
  const count = /^\d+$/.test(term.trim()) ? Number(term.trim()) : null;
  const dayCount = /^\d+$/.test(days.trim()) && Number(days) >= 1 && Number(days) <= 365 ? Number(days) : null;
  const validLoan = /^\d{4}-\d{2}-\d{2}$/.test(loanDate);
  const validDue = /^\d{4}-\d{2}-\d{2}$/.test(dueDate);
  const fixed = single && frequency === "BIWEEKLY" && interestMode === "FIXED";
  const interestAmountCents = parseMoneyToCents(interestAmount);
  const recurringPreview = !single || daily || principalCents === null || principalCents <= 0 ? null
    : fixed ? (interestAmountCents !== null && interestAmountCents > 0 ? calculateFixedInterest({ principalCents, interestCents: interestAmountCents }) : null)
    : rateBps !== null ? calculateOperation({ principalCents, interestRateBps: rateBps }) : null;
  const validFirstDue = /^\d{4}-\d{2}-\d{2}$/.test(firstDue);
  const dailyPreview = daily && principalCents !== null && rateBps !== null && dayCount !== null && validLoan && validFirstDue ? calculateDaily({ principalCents, interestRateBps: rateBps, days: dayCount, loanDate, firstDueDate: firstDue }) : null;
  const biweeklyInstallments = !single && installmentFrequency === "BIWEEKLY";
  const installmentPreview = !single && principalCents !== null && installmentCents !== null && count !== null && count >= 1 ? calculateInstallments({ principalCents, installmentCents, count, frequency: installmentFrequency }) : null;
  const preview = recurringPreview ?? dailyPreview ?? installmentPreview;
  const availableAfterCents = portfolio.summary.availableCents - (principalCents ?? 0);
  const exceeds = principalCents !== null && principalCents > portfolio.summary.availableCents;
  const exceedsCash = request !== undefined && cashAvailableCents !== undefined && principalCents !== null && principalCents > cashAvailableCents;
  const installmentsBelowValue = !single && preview !== null && preview.interestCents < 0;
  // Próximos vencimentos do mensal/quinzenal (renovando pagando só os juros) e do parcelado.
  const upcoming = validDue ? dueDates(single ? frequency : installmentFrequency, dueDate, single ? 3 : Math.min(count ?? 1, 360)) : [];
  const rows: [string, string][] = !preview ? [] : daily && dailyPreview ? [
    ["Periodicidade", "Diário"], ["Quantidade de pagamentos", String(dailyPreview.installmentCount)],
    ["Valor de cada pagamento", dailyPreview.lastInstallmentCents === dailyPreview.installmentCents ? formatMoney(dailyPreview.installmentCents) : `${formatMoney(dailyPreview.installmentCents)} (o último ${formatMoney(dailyPreview.lastInstallmentCents)})`],
    ["Primeiro vencimento", formatDate(dailyPreview.firstDueDate)], ["Último vencimento", formatDate(dailyPreview.lastDueDate)],
    ["Taxa equivalente", `${formatRate(Math.round(dailyPreview.dailyRateBps * 100) / 100)} ao dia · ${formatRate(Math.round(dailyPreview.monthlyEquivalentBps * 100) / 100)} ao mês`],
  ] : single && recurringPreview ? [
    ["Periodicidade", frequencyLabels[frequency]], ["Juros por período", `${formatMoney(recurringPreview.interestCents)} a cada ${frequency === "BIWEEKLY" ? "quinzena" : "mês"}`],
    ["Quantidade de pagamentos", "1 por período: só os juros renovam; principal + juros quita"],
    ["Valor de cada pagamento", `${formatMoney(recurringPreview.interestCents)} (juros) ou ${formatMoney(recurringPreview.totalCents)} (quitação)`],
    ["Primeiro vencimento", upcoming[0] ? formatDate(upcoming[0]) : "—"], ["Próximos vencimentos", upcoming.length > 1 ? `${upcoming.slice(1).map(formatDate).join(", ")}…` : "—"],
    ...(frequency === "BIWEEKLY" && principalCents ? [["Taxa equivalente", `${formatRate(Math.round((recurringPreview.interestCents * 10_000) / principalCents))} por quinzena · ${formatRate(Math.round(monthlyEquivalentRate((recurringPreview.interestCents * 10_000) / principalCents, 15)))} ao mês`] as [string, string]] : []),
  ] : installmentPreview && installmentPreview.interestCents >= 0 ? [
    ["Periodicidade", biweeklyInstallments ? "Quinzenal (parcelas fixas)" : "Mensal (parcelas fixas)"], ["Quantidade de pagamentos", String(count)], ["Valor de cada pagamento", formatMoney(installmentCents ?? 0)],
    ["Primeiro vencimento", upcoming[0] ? formatDate(upcoming[0]) : "—"], ["Último vencimento", upcoming.length ? formatDate(upcoming[upcoming.length - 1]) : "—"],
    ["Juros totais", formatMoney(installmentPreview.interestCents)],
    ["Taxa de juros (simples)", biweeklyInstallments ? `${percent(installmentPreview.monthlyRate)} por quinzena · ${percent(monthlyEquivalentRate(installmentPreview.monthlyRate, 15))} ao mês` : `${percent(installmentPreview.monthlyRate)} ao mês`],
  ] : [];

  if (portfolio.clients.length === 0) {
    return <section className="panel form-panel"><EmptyPanel icon="users" text="Cadastre um cliente antes de criar a primeira operação." action={<button className="primary-button" onClick={onNewClient}><Icon name="plus" size={16} /> Cadastrar cliente</button>} /></section>;
  }
  const description = !single ? `Parcelas fixas ${biweeklyInstallments ? "quinzenais (dia do primeiro vencimento e 15 dias depois, todo mês)" : "mensais"}. O sistema calcula total, lucro e a taxa simples ${biweeklyInstallments ? "por quinzena" : "ao mês"}.`
    : daily ? "O total (principal + juros do período) é dividido em um pagamento por dia; cada pagamento leva principal e juros."
    : `Juros ${frequency === "BIWEEKLY" ? "a cada quinzena (dois vencimentos por mês)" : "a cada mês"} sobre o principal em aberto. Pagando só os juros, o período é renovado.`;

  return (
    <section className="panel form-panel" aria-label="Nova operação">
      <div className="panel-header"><div><h2>{request ? "Nova operação para aprovação" : "Nova operação"}</h2><p>{request ? "Preencha como o Fernando. Ao enviar, o pedido vai para a aprovação dele e só vira operação ativa depois que ele aprovar. " : ""}{description}</p></div></div>
      <div className="modality-switch" role="radiogroup" aria-label="Modalidade">
        <button type="button" role="radio" aria-checked={single} className={single ? "is-active" : ""} onClick={() => setModality("SINGLE")}>Pagamento único</button>
        <button type="button" role="radio" aria-checked={!single} className={!single ? "is-active" : ""} onClick={() => setModality("INSTALLMENT")}>Parcelado</button>
      </div>
      {!single && (
        <div className="modality-switch frequency-switch" role="radiogroup" aria-label="Periodicidade das parcelas">
          {(["MONTHLY", "BIWEEKLY"] as const).map((option) => (
            <button key={option} type="button" role="radio" aria-checked={installmentFrequency === option} className={installmentFrequency === option ? "is-active" : ""} onClick={() => setInstallmentFrequency(option)}>{frequencyLabels[option]}</button>
          ))}
        </div>
      )}
      {single && (
        <div className="modality-switch frequency-switch" role="radiogroup" aria-label="Periodicidade de recebimento">
          {(["MONTHLY", "BIWEEKLY", "DAILY"] as const).map((option) => (
            <button key={option} type="button" role="radio" aria-checked={frequency === option} className={frequency === option ? "is-active" : ""} onClick={() => setFrequency(option)}>{frequencyLabels[option]}</button>
          ))}
        </div>
      )}
      {single && frequency === "BIWEEKLY" && (
        <div className="modality-switch frequency-switch" role="radiogroup" aria-label="Como informar os juros da quinzena">
          <button type="button" role="radio" aria-checked={interestMode === "RATE"} className={interestMode === "RATE" ? "is-active" : ""} onClick={() => setInterestMode("RATE")}>Taxa da quinzena (%)</button>
          <button type="button" role="radio" aria-checked={interestMode === "FIXED"} className={interestMode === "FIXED" ? "is-active" : ""} onClick={() => setInterestMode("FIXED")}>Valor fixo de juros (R$)</button>
        </div>
      )}
      <form className="form-grid" onSubmit={onSubmit} key={`${modality}-${frequency}-${interestMode}-${resetKey}`}>
        <input type="hidden" name="modality" value={modality} />
        {!single && <input type="hidden" name="installmentFrequency" value={installmentFrequency} />}
        {single && <input type="hidden" name="frequency" value={frequency} />}
        {fixed && <input type="hidden" name="interestMode" value="FIXED" />}
        <label className="field field-wide"><span>Cliente</span><select name="clientId" required defaultValue=""><option value="" disabled>Selecione o cliente</option>{portfolio.clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label>
        {single ? (
          <>
            <label className="field"><span>Valor principal (R$)</span><MoneyInput name="principal" inputMode="decimal" placeholder={frequency === "BIWEEKLY" ? "8.000,00" : daily ? "10.000,00" : "1.000,00"} value={principal} onChange={(event) => setPrincipal(event.target.value)} required /></label>
            {fixed
              ? <label className="field"><span>Juros por quinzena (R$)</span><MoneyInput name="interestAmount" inputMode="decimal" placeholder="1.200,00" value={interestAmount} onChange={(event) => setInterestAmount(event.target.value)} required /></label>
              : <label className="field"><span>{daily ? "Taxa de juros do período (%)" : frequency === "BIWEEKLY" ? "Taxa de juros por quinzena (%)" : "Taxa de juros ao mês (%)"}</span><input name="rate" inputMode="decimal" placeholder={frequency === "BIWEEKLY" ? "15" : "30"} value={rate} onChange={(event) => setRate(event.target.value)} required /></label>}
            <DateField label="Data do empréstimo" name="loanDate" defaultValue={loanDate} onChange={setLoanDate} required />
            {daily ? (
              <>
                <label className="field"><span>Quantidade de dias (pagamentos)</span><input name="days" inputMode="numeric" placeholder="30" value={days} onChange={(event) => setDays(event.target.value.replace(/\D/g, "").slice(0, 3))} required /></label>
                <DateField label="Primeiro vencimento" name="firstDueDate" defaultValue={firstDue} onChange={setFirstDue} min={validLoan ? loanDate : undefined} required />
              </>
            ) : <DateField label={frequency === "BIWEEKLY" ? "Primeiro vencimento" : "Vencimento"} name="dueDate" defaultValue={dueDate} onChange={setDueDate} required />}
          </>
        ) : (
          <>
            <label className="field"><span>Valor emprestado (R$)</span><MoneyInput name="loanAmount" inputMode="decimal" placeholder="10.000,00" value={loanAmount} onChange={(event) => setLoanAmount(event.target.value)} required /></label>
            <label className="field"><span>Valor de cada parcela (R$)</span><MoneyInput name="installment" inputMode="decimal" placeholder="1.200,00" value={installment} onChange={(event) => setInstallment(event.target.value)} required /></label>
            <label className="field"><span>{biweeklyInstallments ? "Quantidade de parcelas (quinzenas)" : "Prazo total (meses)"}</span><input name="term" inputMode="numeric" placeholder={biweeklyInstallments ? "3" : "10"} value={term} onChange={(event) => setTerm(event.target.value.replace(/\D/g, "").slice(0, 3))} required /></label>
            <DateField label="Data do empréstimo" name="loanDate" defaultValue={loanDate} onChange={setLoanDate} required />
            <DateField label="Primeiro vencimento" name="firstDueDate" defaultValue={dueDate} onChange={setDueDate} required />
          </>
        )}
        <div className="operation-preview" aria-live="polite" aria-label="Prévia da operação">
          <div><span>Principal</span><strong>{principalCents !== null ? formatMoney(principalCents) : "—"}</strong></div>
          <div><span>{single ? "Juros" : "Lucro"}</span><strong>{preview && preview.interestCents >= 0 ? formatMoney(preview.interestCents) : "—"}</strong></div>
          <div><span>Total a receber</span><strong>{preview ? formatMoney(preview.totalCents) : "—"}</strong></div>
          {rows.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
          {request && cashAvailableCents !== undefined && <div><span>Caixa disponível após</span><strong>{formatMoney(Math.max(cashAvailableCents - (principalCents ?? 0), 0))}</strong><small>Hoje: {formatMoney(cashAvailableCents)}</small></div>}
          {!request && <div><span>Capital disponível após</span><strong>{formatMoney(Math.max(availableAfterCents, 0))}</strong><small>Hoje: {formatMoney(portfolio.summary.availableCents)}</small></div>}
        </div>
        {!single && installmentPreview && installmentPreview.interestCents >= 0 && upcoming.length > 0 && (
          <div className="schedule-preview field-wide" aria-label="Prévia dos vencimentos">
            <p><strong>Prévia dos vencimentos</strong> · confira as datas e os valores antes de cadastrar.</p>
            <ol>{upcoming.map((date, index) => <li key={date}><span>Parcela {index + 1}</span><strong>{formatDate(date)}</strong><span>{formatMoney(installmentCents ?? 0)}</span></li>)}</ol>
          </div>
        )}
        {installmentsBelowValue && <p className="form-feedback form-feedback-warning field-wide">As parcelas somam menos que o valor emprestado.</p>}
        {exceedsCash && <p className="form-feedback form-feedback-warning">O valor é maior que o seu caixa disponível ({formatMoney(cashAvailableCents ?? 0)}). Peça ao Fernando para aumentar o caixa.</p>}
        {exceeds && !request && <p className="form-feedback form-feedback-warning">O valor é maior que o capital disponível da carteira ({formatMoney(Math.max(portfolio.summary.availableCents, 0))}).</p>}
        <div className="form-actions"><button className="primary-button" disabled={pending || exceedsCash}><Icon name="plus" size={16} /> {pending ? "Enviando…" : request ? "Enviar para aprovação" : "Cadastrar operação"}</button></div>
      </form>
      <Feedback feedback={feedback} />
    </section>
  );
}

type AllocatedPaymentView = OperationView["payments"][number];
// Prévias com o mesmo extrato do servidor (operationLedger em rules.ts), a partir dos termos da operação.
const ledgerOf = (operation: OperationView, payments: { id: string; amountCents: number; paidAt: string; createdAt?: string }[], today: string) => operationLedger(operation.ledgerTerms, payments, today);
const renewalNote = (payment: AllocatedPaymentView) => payment.renewedPeriod
  ? ` · Renovou para o ${payment.renewedPeriod.number}º período, vencimento ${formatDate(payment.renewedPeriod.dueDate)}${payment.renewedPeriod.openedBy === "DUE_DATE" ? " (renovado no vencimento)" : ""}`
  : "";
// Data e hora (horário de Brasília) de uma correção.
const formatDateTime = (timestamp: string) => `${formatDate(todayIso(new Date(timestamp)))} às ${new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp))}`;

// Correção de um pagamento registrado: mostra na hora o saldo e a situação da operação depois da correção.
function EditPaymentForm({ operation, payment, today, onClose, onChanged }: { operation: OperationView; payment: AllocatedPaymentView; today: string; onClose: () => void; onChanged: () => void }) {
  const [amount, setAmount] = useState(centsToInput(payment.amountCents));
  const { pending, feedback, onSubmit } = useFormAction(editPaymentAction, () => { onChanged(); onClose(); });
  const amountCents = parseMoneyToCents(amount);
  const others = operation.payments.filter((item) => item.id !== payment.id);
  const probe = ledgerOf(operation, [...others, { ...payment, amountCents: amountCents ?? 0 }], today);
  const maxCents = probe.items.find((item) => item.id === payment.id)?.balanceBeforeCents ?? 0;
  const exceeds = amountCents !== null && amountCents > maxCents;
  const after = amountCents !== null && amountCents > 0 && !exceeds ? probe : null;
  const renewal = operation.renewals.find((item) => item.paymentId === payment.id);
  return (
    <form className="form-grid edit-payment-form" onSubmit={onSubmit} aria-label="Editar pagamento">
      <input type="hidden" name="paymentId" value={payment.id} />
      <DateField label="Data do pagamento" name="paidAt" defaultValue={payment.paidAt} min={operation.loanDate} max={today} required />
      <label className="field"><span>Valor pago (R$)</span><MoneyInput name="amount" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} required autoFocus /></label>
      {renewal && <p className="capital-note field-wide">Este pagamento renovou o período até {formatDate(renewal.newDueDate)}. Ele pode ser corrigido para um valor maior (o excedente abate o principal), mas não menor que os juros pagos na renovação.</p>}
      <label className="field field-wide"><span>Observação</span><input name="notes" defaultValue={payment.notes ?? ""} placeholder="Opcional" maxLength={500} /></label>
      {exceeds && <p className="form-feedback form-feedback-warning">O pagamento não pode ser maior que {formatMoney(maxCents)}, o saldo da operação sem este pagamento.</p>}
      {after && (
        <div className="operation-preview" aria-live="polite">
          <div><span>Juros recebidos após</span><strong>{formatMoney(after.interestPaidCents)}</strong></div>
          <div><span>Principal recebido após</span><strong>{formatMoney(after.principalPaidCents)}</strong></div>
          <div><span>Saldo após</span><strong>{formatMoney(after.balanceCents)}</strong></div>
          <div><span>Situação após</span><strong>{after.balanceCents === 0 ? "Quitada" : stateLabels[after.state].label}</strong></div>
        </div>
      )}
      <p className="capital-note field-wide">O valor e a data de antes ficam guardados no histórico deste pagamento.</p>
      <div className="form-actions">
        <button type="button" className="outline-button" onClick={onClose}>Cancelar</button>
        <button className="primary-button" disabled={pending || exceeds}><Icon name="check" size={16} /> {pending ? "Salvando…" : "Salvar correção"}</button>
      </div>
      <Feedback feedback={feedback} />
    </form>
  );
}

// Liquidação antecipada: o cliente quita a operação com um valor total negociado. Mostra o resumo do contrato, o que ficou
// de fora (desconto) e exige confirmação explícita antes de gravar. O servidor refaz todas as contas.
function EarlySettlementForm({ operation, today, onClose, onChanged }: { operation: OperationView; today: string; onClose: () => void; onChanged: () => void }) {
  const [amount, setAmount] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const { pending, feedback, onSubmit } = useFormAction(settleOperationEarlyAction, () => { setAmount(""); setConfirmed(false); onClose(); onChanged(); });
  const amountCents = parseMoneyToCents(amount);
  const tooLow = amountCents !== null && amountCents > 0 && amountCents < operation.principalRemainingCents;
  const tooHigh = amountCents !== null && amountCents > operation.balanceCents;
  const valid = amountCents !== null && amountCents > 0 && !tooLow && !tooHigh;
  const after = valid ? operationLedger({ ...operation.ledgerTerms, settlementPaymentId: "preview" }, [...operation.payments, { id: "preview", amountCents: amountCents ?? 0, paidAt: today, createdAt: "9999" }], today) : null;
  const closing = after?.items.find((item) => item.id === "preview");
  const openInstallments = operation.installments.filter((item) => item.state !== "PAID");
  return (
    <form className="form-grid" onSubmit={onSubmit} aria-label="Liquidação antecipada">
      <input type="hidden" name="operationId" value={operation.id} />
      <input type="hidden" name="confirm" value={confirmed ? "yes" : "no"} />
      <p className="capital-note field-full">Informe o valor total negociado para encerrar esta operação hoje. As obrigações futuras deixam de ser cobradas; os pagamentos já feitos continuam como estão.</p>
      <div className="field-full"><dl className="payment-summary">
        <div><dt>Saldo do contrato hoje</dt><dd>{formatMoney(operation.balanceCents)}</dd></div>
        <div><dt>Principal que ainda não voltou</dt><dd>{formatMoney(operation.principalRemainingCents)}</dd></div>
        <div><dt>Já recebido</dt><dd>{formatMoney(operation.paidCents)}</dd></div>
        <div><dt>Obrigações em aberto</dt><dd>{openInstallments.length > 0 ? plural(openInstallments.length, "parcela", "parcelas") : "Período atual"}</dd></div>
      </dl></div>
      <DateField label="Data da liquidação" name="paidAt" defaultValue={today} min={operation.loanDate} max={today} required />
      <label className="field"><span>Valor total negociado (R$)</span><MoneyInput name="amount" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} required autoFocus /></label>
      <label className="field field-full"><span>Observação</span><input name="notes" placeholder="Opcional" maxLength={500} /></label>
      {tooLow && <p className="form-feedback form-feedback-warning field-full">O valor negociado precisa cobrir ao menos o principal que ainda não voltou ({formatMoney(operation.principalRemainingCents)}).</p>}
      {tooHigh && <p className="form-feedback form-feedback-warning field-full">O valor negociado não pode ser maior que o saldo do contrato ({formatMoney(operation.balanceCents)}).</p>}
      {after && closing && (
        <div className="operation-preview field-full" aria-live="polite">
          <div><span>Valor recebido (entra no capital)</span><strong>{formatMoney(closing.amountCents)}</strong></div>
          <div><span>Para principal</span><strong>{formatMoney(closing.principalCents)}</strong></div>
          <div><span>Para juros (lucro realizado)</span><strong>{formatMoney(closing.interestCents)}</strong></div>
          <div><span>Desconto (não cobrado)</span><strong>{formatMoney(after.forgivenCents)}</strong></div>
          <div><span>Saldo após</span><strong>{formatMoney(0)}</strong></div>
        </div>
      )}
      <label className="field-check field-full"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> <span>Confirmo a liquidação antecipada desta operação pelo valor informado. Isso não pode ser desfeito.</span></label>
      <div className="form-actions">
        <button type="button" className="outline-button" onClick={onClose}>Cancelar</button>
        <button className="primary-button" disabled={pending || !valid || !confirmed}><Icon name="check" size={16} /> {pending ? "Liquidando…" : "Liquidar operação"}</button>
      </div>
      <Feedback feedback={feedback} />
    </form>
  );
}

// Situação de uma parcela na tabela do contrato.
function installmentStatus(item: OperationView["installments"][number], today: string) {
  if (item.state === "DEFERRED") return "Renegociada para o final";
  if (item.state === "PAID") return "Paga";
  if (item.state === "CLOSED") return "Encerrada na liquidação";
  return item.dueDate < today ? (item.state === "PARTIAL" ? "Parcial, em atraso" : "Em atraso") : item.state === "PARTIAL" ? "Parcial" : "Em aberto";
}

// Tabela completa do cronograma. Número atual = posição entre as obrigações ativas; a parcela renegociada continua na tabela
// (número original, situação "Renegociada para o final") e a obrigação criada no final mostra de onde veio.
function ScheduleTable({ items, today, label, onDefer }: { items: OperationView["installments"]; today: string; label: string; onDefer?: (item: OperationView["installments"][number]) => (() => void) | null }) {
  const total = items.filter((item) => item.state !== "DEFERRED").length;
  const originalTotal = items.filter((item) => item.deferredFrom === null).length;
  const byOriginal = (number: number) => items.find((item) => item.originalNumber === number && item.deferredFrom === null);
  const history = (item: OperationView["installments"][number]) => {
    if (item.state === "DEFERRED") {
      const target = items.find((other) => other.deferredFrom === item.originalNumber);
      return target ? `Vai para a parcela ${target.number}/${total}: ${formatDate(target.dueDate)}, ${formatMoney(target.amountCents)}${target.additionCents > 0 ? ` (acréscimo de ${formatMoney(target.additionCents)})` : ""}` : "";
    }
    if (item.deferredFrom !== null) {
      const origin = byOriginal(item.deferredFrom);
      return `Veio da parcela ${item.deferredFrom}/${originalTotal}${origin ? ` (venc. ${formatDate(origin.dueDate)}, ${formatMoney(origin.amountCents)})` : ""}${item.additionCents > 0 ? ` + acréscimo de ${formatMoney(item.additionCents)}` : ""}`;
    }
    return "";
  };
  return (
    <table className="data-table" aria-label={label}>
      <thead><tr><th>Parcela atual</th><th>Parcela original</th><th>Vencimento</th><th>Valor</th><th>Pago</th><th>Situação</th><th>Histórico</th>{onDefer && <th>Ação</th>}</tr></thead>
      <tbody>{items.map((item) => {
        const defer = onDefer?.(item) ?? null;
        return (
          <tr key={`${item.originalNumber}-${item.deferredFrom ?? "o"}`} className={item.state === "DEFERRED" ? "row-deferred" : undefined}>
            <td>{item.state === "DEFERRED" ? "—" : `${item.number}/${total}`}</td><td>{`${item.originalNumber}/${originalTotal}`}</td>
            <td>{formatDate(item.dueDate)}</td><td>{formatMoney(item.amountCents)}</td><td>{formatMoney(item.paidCents)}</td>
            <td>{installmentStatus(item, today)}</td><td>{history(item) || "—"}</td>
            {onDefer && <td>{defer && <button type="button" className="outline-button" onClick={defer}>Renegociar parcela</button>}</td>}
          </tr>
        );
      })}</tbody>
    </table>
  );
}

// Modalidade 1: renegociar UMA parcela (jogar para o final). Prévia pelo mesmo extrato do servidor; nada é gravado até confirmar.
function DeferInstallmentForm({ operation, number, today, onClose, onDone }: { operation: OperationView; number: number; today: string; onClose: () => void; onDone: (message: string) => void }) {
  const [addition, setAddition] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const { pending, feedback, onSubmit } = useFormAction(async (data) => {
    const result = await deferInstallmentAction(data);
    if (result.ok) { setConfirmed(false); onDone(result.message); }
    return result;
  });
  const item = operation.installments.find((entry) => entry.originalNumber === number && entry.deferredFrom === null);
  const additionCents = addition.trim() ? parseMoneyToCents(addition) : 0;
  const eligible = deferralEligibility(operation, item);
  const valid = eligible.ok && item !== undefined && additionCents !== null && additionCents >= 0;
  const newDueDate = item ? deferralDueDate(operation.ledgerTerms, operation.installments) : "";
  const after = valid && item ? operationLedger({ ...operation.ledgerTerms, deferrals: [...(operation.ledgerTerms.deferrals ?? []), { originalNumber: item.originalNumber, additionCents: additionCents as number, newDueDate, newAmountCents: item.amountCents + (additionCents as number) }] }, operation.payments, today) : null;
  const moved = after?.schedule.find((entry) => entry.deferredFrom === number);
  const paidCount = operation.installments.filter((entry) => entry.state === "PAID").length;
  return (
    <form className="form-grid" onSubmit={onSubmit} aria-label="Renegociar parcela">
      <input type="hidden" name="operationId" value={operation.id} />
      <input type="hidden" name="number" value={number} />
      <input type="hidden" name="confirm" value={confirmed ? "yes" : "no"} />
      <div className="field-full">
        <p className="capital-note"><strong>{`Renegociar a parcela ${item ? `${item.number}/${operation.installmentTotal}` : number}`}</strong>{" · Ação: "}<span className="modality-switch" role="radiogroup" aria-label="Ação"><button type="button" role="radio" aria-checked="true" className="is-active">Jogar para o final</button></span></p>
        <p className="muted-cell">Adiamento pontual desta parcela: ela vai para o fim do cronograma, sem pagamento, sem lucro realizado e sem mexer no capital. Para refazer o contrato inteiro, use a página Renegociação.</p>
      </div>
      <label className="field"><span>Acréscimo ou multa (R$)</span><MoneyInput name="addition" inputMode="decimal" placeholder="0,00" value={addition} onChange={(event) => setAddition(event.target.value)} autoFocus /></label>
      <label className="field field-wide"><span>Motivo (opcional)</span><input name="reason" maxLength={300} placeholder="Opcional" /></label>
      {!eligible.ok && <p className="form-feedback form-feedback-warning field-full">{eligible.error}</p>}
      {additionCents === null && <p className="form-feedback form-feedback-warning field-full">Informe o acréscimo em reais, por exemplo 100,00.</p>}
      {after && item && moved && (
        <div className="field-full" aria-live="polite">
          <dl className="payment-summary" aria-label="Resumo da renegociação">
            <div><dt>Parcela original renegociada</dt><dd>{`${item.originalNumber}/${operation.installmentTotal} · ${formatDate(item.dueDate)} · ${formatMoney(item.amountCents)}`}</dd></div>
            <div><dt>Situação da original</dt><dd>Renegociada para o final</dd></div>
            <div><dt>Nova data da obrigação</dt><dd>{formatDate(moved.dueDate)}</dd></div>
            <div><dt>Acréscimo informado</dt><dd>{formatMoney(additionCents ?? 0)}</dd></div>
            <div><dt>Novo valor</dt><dd>{formatMoney(moved.amountCents)}</dd></div>
            <div><dt>Já pago pela cliente</dt><dd>{`${formatMoney(operation.paidCents)} (${paidCount} ${paidCount === 1 ? "parcela" : "parcelas"})`}</dd></div>
            <div><dt>Total previsto do contrato, antes</dt><dd>{formatMoney(operation.totalCents)}</dd></div>
            <div><dt>Total previsto do contrato, depois</dt><dd>{formatMoney(after.totalCents)}</dd></div>
            <div className="payment-balance"><dt>Saldo a receber, depois</dt><dd>{formatMoney(after.balanceCents)}</dd></div>
          </dl>
          <p className="muted-cell"><strong>Cronograma depois da renegociação</strong></p>
          <div className="table-scroll"><ScheduleTable items={after.schedule} today={today} label="Cronograma simulado" /></div>
        </div>
      )}
      <label className="field-check field-full"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> <span>Confirmo: jogar esta parcela para o final do contrato. Nenhum pagamento será registrado.</span></label>
      <div className="form-actions">
        <button type="button" className="outline-button" onClick={onClose}>Cancelar</button>
        <button className="primary-button" disabled={pending || !valid || !confirmed}><Icon name="check" size={16} /> {pending ? "Gravando…" : "Confirmar renegociação"}</button>
      </div>
      <Feedback feedback={feedback} />
    </form>
  );
}

// readOnly: operação de ciclo encerrado aberta pelo relatório; só consulta (o servidor também recusa alterações).
function PaymentPanel({ operation, today, onClose, onChanged, readOnly = false }: { operation: OperationView; today: string; onClose: () => void; onChanged: () => void; readOnly?: boolean }) {
  const [amount, setAmount] = useState("");
  const { pending, feedback, onSubmit } = useFormAction(registerPaymentAction, () => { setAmount(""); onChanged(); });
  const isOpen = operation.status === "OPEN" && !readOnly;
  const amountCents = parseMoneyToCents(amount);
  const check = amountCents !== null ? checkPayment({ amountCents, balanceCents: operation.balanceCents, formatMoney }) : null;
  // Prévia deste pagamento (hoje) pelo mesmo extrato usado no servidor: juros primeiro, depois principal.
  const after = check?.ok ? ledgerOf(operation, [...operation.payments, { id: "preview", amountCents: amountCents ?? 0, paidAt: today, createdAt: "9999" }], today) : null;
  const thisPayment = after?.items.find((item) => item.id === "preview");
  const recurringOp = !amortized(operation);
  const canRenew = recurringOp && operation.interestRemainingCents > 0 && operation.principalRemainingCents > 0;
  const next = operation.nextInstallment;
  // Pagamento somente de juros: a mesma regra central que o servidor aplica (interestOnlyRenewal).
  const renewal = check?.ok === true && amountCents !== null ? interestOnlyRenewal(operation.ledgerTerms, operation, amountCents) : null;
  const renews = renewal !== null;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [settling, setSettling] = useState(false);
  const [deferring, setDeferring] = useState<number | null>(null);
  const [deferNotice, setDeferNotice] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="payment-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="panel form-panel payment-panel" role="dialog" aria-modal="true" aria-label={`Pagamentos de ${operation.clientName}`}>
        <div className="panel-header">
          <div><h2>{operation.clientName} — #{operation.code}</h2><p>{modalityLabel(operation)} · {next ? `Parcela ${next.number}/${operation.installmentTotal} vence` : recurringOp && operation.periodNumber > 1 ? `${operation.periodNumber}º período vence` : "Vencimento"} {formatDate(operation.nextDueDate)} · <StatusChip state={operation.state} daysUntilDue={operation.daysUntilDue} /></p></div>
          <button type="button" className="more-button" aria-label="Fechar" onClick={onClose}><Icon name="close" size={18} /></button>
        </div>
        <OperationProfitHero operation={operation} />
        <dl className="payment-summary">
          <div><dt>Principal</dt><dd>{formatMoney(operation.principalCents)}</dd></div>
          <div><dt>{operation.renewalCount > 0 ? "Juros contratados (todos os períodos)" : "Juros"}</dt><dd>{formatMoney(operation.interestCents)}</dd></div>
          <div><dt>Total previsto</dt><dd>{formatMoney(operation.totalCents)}</dd></div>
          <div><dt>Recebido</dt><dd>{formatMoney(operation.paidCents)}</dd></div>
          <div><dt>Juros recebidos</dt><dd>{formatMoney(operation.interestPaidCents)}</dd></div>
          <div><dt>Principal recebido</dt><dd>{formatMoney(operation.principalPaidCents)}</dd></div>
          <div><dt>Juros restantes</dt><dd>{formatMoney(operation.interestRemainingCents)}</dd></div>
          <div><dt>Principal restante</dt><dd>{formatMoney(operation.principalRemainingCents)}</dd></div>
          <div className="payment-balance"><dt>Saldo</dt><dd>{formatMoney(operation.balanceCents)}</dd></div>
        </dl>
        <dl className="payment-summary">
          {recurringOp ? (
            <>
              <div><dt>Período atual</dt><dd>{operation.periodNumber}º · juros de {formatMoney(operation.periodInterestCents)}</dd></div>
              <div><dt>Taxa</dt><dd>{rateLabel(operation)}</dd></div>
              <div><dt>Períodos renovados</dt><dd>{operation.renewalCount}</dd></div>
              <div><dt>Primeiro vencimento</dt><dd>{formatDate(operation.originalDueDate)}</dd></div>
            </>
          ) : (
            <>
              <div><dt>Parcelas pagas</dt><dd>{operation.installments.filter((item) => item.state === "PAID").length} de {operation.installmentTotal}</dd></div>
              <div><dt>Taxa de juros</dt><dd>{rateLabel(operation)}</dd></div>
              <div><dt>Próxima parcela</dt><dd>{next ? `${next.number}ª · ${formatMoney(next.remainingCents)} em ${formatDate(next.dueDate)}` : "—"}</dd></div>
            </>
          )}
          <div><dt>{operation.status === "PAID" ? "Duração" : "Operação ativa"}</dt><dd>{operationAge(operation)}</dd></div>
          <div><dt>Pagamentos realizados</dt><dd>{operation.payments.length}</dd></div>
          <div><dt>Meses com pagamento</dt><dd>{operation.paymentMonths}</dd></div>
        </dl>
        {operation.settlementPaymentId && (
          <p className="capital-note">Liquidada antecipadamente em {operation.settledAt ? formatDate(operation.settledAt) : "—"}: saldo do contrato de {formatMoney(operation.settlementBalanceCents ?? 0)} encerrado com desconto de {formatMoney(operation.settlementDiscountCents ?? 0)}. O desconto não é lucro nem pendência.</p>
        )}
        {isOpen && settling && <EarlySettlementForm operation={operation} today={today} onClose={() => setSettling(false)} onChanged={onChanged} />}
        {isOpen && !settling && (
          <form className="form-grid" onSubmit={onSubmit}>
            <input type="hidden" name="operationId" value={operation.id} />
            <DateField label="Data do pagamento" name="paidAt" defaultValue={today} min={operation.loanDate} max={today} required />
            <label className="field"><span>Valor recebido (R$)</span><MoneyInput name="amount" inputMode="decimal" placeholder={centsToInput(operation.balanceCents)} value={amount} onChange={(event) => setAmount(event.target.value)} required autoFocus /></label>
            <div className="payment-shortcuts field-wide">
              {canRenew && <button type="button" className="outline-button" onClick={() => setAmount(centsToInput(operation.interestRemainingCents))}>Só os juros e renovar ({formatMoney(operation.interestRemainingCents)})</button>}
              {next && next.remainingCents < operation.balanceCents && <button type="button" className="outline-button" onClick={() => setAmount(centsToInput(next.remainingCents))}>Parcela {next.number} ({formatMoney(next.remainingCents)})</button>}
              <button type="button" className="outline-button" onClick={() => setAmount(centsToInput(operation.balanceCents))}>Saldo total ({formatMoney(operation.balanceCents)})</button>
            </div>
            <label className="field field-wide"><span>Observação</span><input name="notes" placeholder="Opcional" maxLength={500} /></label>
            {check && !check.ok && <p className="form-feedback form-feedback-warning">{check.error}</p>}
            {renews && (
              <div className="renewal-box field-wide" aria-live="polite">
                <p><strong>Pagamento somente de juros / Renovação de período.</strong> O principal continua {formatMoney(renewal.principalBaseCents)} e não há juros sobre juros: o próximo período tem juros de {formatMoney(renewal.nextInterestCents)} e o valor para quitação continua {formatMoney(renewal.principalBaseCents + renewal.nextInterestCents)}.</p>
                <DateField key={renewal.previousDueDate} label="Novo vencimento" name="newDueDate" defaultValue={renewal.defaultNewDueDate} min={addDays(renewal.previousDueDate, 1)} required />
              </div>
            )}
            {renewal && (
              <div className="operation-preview" aria-live="polite">
                <div><span>Para juros</span><strong>{formatMoney(amountCents ?? 0)}</strong></div>
                <div><span>Para principal</span><strong>{formatMoney(0)}</strong></div>
                <div><span>Saldo principal</span><strong>{formatMoney(operation.principalRemainingCents)}</strong></div>
                <div><span>Valor para quitação após</span><strong>{formatMoney(renewal.principalBaseCents + renewal.nextInterestCents)}</strong></div>
                <div><span>Situação após</span><strong>Renovação / Ativa</strong></div>
              </div>
            )}
            {!renews && thisPayment && after && (
              <div className="operation-preview" aria-live="polite">
                <div><span>Para juros</span><strong>{formatMoney(thisPayment.interestCents)}</strong></div>
                <div><span>Para principal</span><strong>{formatMoney(thisPayment.principalCents)}</strong></div>
                <div><span>Saldo principal</span><strong>{formatMoney(after.principalRemainingCents)}</strong></div>
                <div><span>Saldo após</span><strong>{formatMoney(after.balanceCents)}</strong></div>
                <div><span>Situação após</span><strong>{after.balanceCents === 0 ? "Quitada" : `${stateLabels[after.state].label} · vence ${formatDate(after.nextDueDate)}`}</strong></div>
              </div>
            )}
            <div className="form-actions">
              <button type="button" className="outline-button" onClick={() => setSettling(true)}>Liquidação antecipada</button>
              <button className="primary-button" disabled={pending || (check !== null && !check.ok)}><Icon name="check" size={16} /> {pending ? "Registrando…" : "Registrar pagamento"}</button>
            </div>
          </form>
        )}
        <Feedback feedback={feedback} />
        {deferNotice && <p className="form-feedback" role="status">{deferNotice}</p>}
        {isOpen && deferring !== null && <DeferInstallmentForm operation={operation} number={deferring} today={today} onClose={() => setDeferring(null)} onDone={(message) => { setDeferring(null); setDeferNotice(message); onChanged(); }} />}
        {!recurringOp && (
          <div className="table-scroll installment-table">
            <ScheduleTable items={operation.installments} today={today} label="Parcelas" onDefer={isOpen && operation.modality === "INSTALLMENT" ? (item) => deferralEligibility(operation, item).ok ? () => setDeferring(item.originalNumber) : null : undefined} />
          </div>
        )}
        <div className="payment-history">
          <h3>Histórico de pagamentos</h3>
          {operation.payments.length === 0 ? <p className="muted-cell">Nenhum pagamento registrado.</p> : (
            <ul>{operation.payments.map((payment) => (
              <li key={payment.id}>
                <span>{formatDate(payment.paidAt)}</span><strong>{formatMoney(payment.amountCents)}</strong><span className={`status-chip ${payment.kind === "SETTLEMENT" ? "status-paid" : payment.kind === "RENEWAL" ? "status-renewal" : "status-active"}`}><i />{paymentKindLabels[payment.kind]}</span>
                {operation.status !== "CANCELED" && operation.status !== "RENEGOTIATED" && !operation.settlementPaymentId && !readOnly && editingId !== payment.id && <button type="button" className="outline-button payment-edit-button" onClick={() => setEditingId(payment.id)}>Editar pagamento</button>}
                <small>Juros {formatMoney(payment.interestCents)} · Principal {formatMoney(payment.principalCents)}{renewalNote(payment)}{payment.notes ? ` · ${payment.notes}` : ""}</small>
                {(payment.revisions ?? []).map((revision) => <small key={revision.id} className="payment-revision">Corrigido em {formatDateTime(revision.editedAt)}{revision.editedBy ? ` por ${revision.editedBy}` : ""}: antes {formatMoney(revision.previousAmountCents)} em {formatDate(revision.previousPaidAt)}, depois {formatMoney(revision.amountCents)} em {formatDate(revision.paidAt)}.</small>)}
                {editingId === payment.id && <EditPaymentForm operation={operation} payment={payment} today={today} onClose={() => setEditingId(null)} onChanged={onChanged} />}
              </li>
            ))}</ul>
          )}
        </div>
        {(operation.corrections ?? []).length > 0 && (
          <div className="payment-history">
            <h3>Correções da operação</h3>
            <ul>{(operation.corrections ?? []).map((correction) => (
              <li key={correction.id}>
                <span>{formatDateTime(correction.editedAt)}</span><strong>{correction.reason}</strong>
                <small>{`${correction.editedBy ? `Por ${correction.editedBy}. ` : ""}${correction.changes.map((change) => `${change.field}: de ${change.before ?? "vazio"} para ${change.after ?? "vazio"}`).join("; ")}.`}</small>
              </li>
            ))}</ul>
          </div>
        )}
      </section>
    </div>
  );
}

function PaymentButton({ operation, today, onChanged }: { operation: OperationView; today: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  if (operation.status === "CANCELED") return null;
  const isOpen = operation.status === "OPEN";
  return (
    <>
      {isOpen
        ? <button className="outline-button" onClick={() => setOpen(true)}><Icon name="check" size={13} /> Registrar pagamento</button>
        : <button className="outline-button" onClick={() => setOpen(true)}>Ver pagamentos</button>}
      {!isOpen && operation.settledAt && <small className="muted-cell">Quitada em {formatDate(operation.settledAt)}</small>}
      {open && <PaymentPanel operation={operation} today={today} onClose={() => setOpen(false)} onChanged={onChanged} />}
    </>
  );
}

function DeleteOperationButton({ operation, onChanged }: { operation: OperationView; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const hasPayments = operation.payments.length > 0;
  const title = `Excluir operação #${operation.code}`;
  return (
    <>
      <button className="outline-button danger-outline" onClick={() => setOpen(true)}>Excluir</button>
      {open && (
        <ConfirmDialog title={title} confirmLabel="Excluir operação" action={hasPayments ? undefined : cancelOperationAction} fields={{ operationId: operation.id }} onClose={() => setOpen(false)} onDone={onChanged}>
          <dl className="payment-summary">
            <div><dt>Cliente</dt><dd>{operation.clientName}</dd></div>
            <div><dt>Principal</dt><dd>{formatMoney(operation.principalCents)}</dd></div>
            <div><dt>Saldo</dt><dd>{formatMoney(operation.balanceCents)}</dd></div>
          </dl>
          {hasPayments ? (
            <p><strong>Esta operação tem histórico financeiro:</strong> {formatMoney(operation.paidCents)} em {operation.payments.length} pagamento{operation.payments.length === 1 ? "" : "s"} registrado{operation.payments.length === 1 ? "" : "s"}. Para não apagar dinheiro que entrou de verdade, ela não pode ser excluída.</p>
          ) : (
            <><p>Sem pagamentos registrados. A operação deixa de aparecer em Operações, Cobranças e no Dashboard e sai de Principal emprestado, Total a receber e Juros previstos.</p>
              <p>Os <strong>{formatMoney(operation.principalCents)}</strong> voltam para o capital disponível. O histórico do capital registra a exclusão. O cliente continua cadastrado.</p></>
          )}
        </ConfirmDialog>
      )}
    </>
  );
}

type ClientOption = TenantPortfolio["clients"][number];

// Correção de operação sem pagamentos (Etapa G, parte 1): mesmos campos do cadastro, na mesma modalidade e periodicidade.
// Primeiro "Revisar alterações" (o servidor mostra antes e depois, sem gravar); depois "Confirmar correção", com motivo.
function EditOperationPanel({ operation, clients, onClose, onChanged }: { operation: OperationView; clients: ClientOption[]; onClose: () => void; onChanged: () => void }) {
  const installment = operation.modality === "INSTALLMENT";
  const daily = !installment && operation.frequency === "DAILY";
  const biweekly = !installment && operation.frequency === "BIWEEKLY";
  const [interestMode, setInterestMode] = useState<"RATE" | "FIXED">(operation.ledgerTerms.interestMode === "FIXED" ? "FIXED" : "RATE");
  const [review, setReview] = useState<Extract<OperationEditPreview, { ok: true }> | null>(null);
  const [checking, startChecking] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const { pending, feedback, onSubmit } = useFormAction(updateOperationAction, () => { onChanged(); onClose(); });
  const rateInput = String(operation.interestRateBps / 100).replace(".", ",");
  const firstDue = operation.firstDueDate ?? operation.dueDate;
  const options = clients.filter((client) => !client.archivedAt || client.id === operation.clientId);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const check = (form: HTMLFormElement) => {
    setError(null);
    startChecking(async () => {
      try {
        const result = await previewOperationEditAction(new FormData(form));
        if (result.ok) setReview(result); else { setReview(null); setError(result.error); }
      } catch { setError("Não foi possível revisar. Tente novamente."); }
    });
  };
  return (
    <div className="payment-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="panel form-panel payment-panel" role="dialog" aria-modal="true" aria-label={`Corrigir operação #${operation.code}`}>
        <div className="panel-header"><div><h2>{`Corrigir operação #${operation.code}`}</h2><p>{`${modalityLabel(operation)}. Sem pagamentos registrados: dá para corrigir valores, datas e cliente. Modalidade e periodicidade não mudam.`}</p></div>
          <button type="button" className="more-button" aria-label="Fechar" onClick={onClose}><Icon name="close" size={18} /></button></div>
        {biweekly && (
          <div className="modality-switch frequency-switch" role="radiogroup" aria-label="Como informar os juros da quinzena">
            <button type="button" role="radio" aria-checked={interestMode === "RATE"} className={interestMode === "RATE" ? "is-active" : ""} onClick={() => { setInterestMode("RATE"); setReview(null); }}>Taxa da quinzena (%)</button>
            <button type="button" role="radio" aria-checked={interestMode === "FIXED"} className={interestMode === "FIXED" ? "is-active" : ""} onClick={() => { setInterestMode("FIXED"); setReview(null); }}>Valor fixo de juros (R$)</button>
          </div>
        )}
        <form className="form-grid" key={interestMode} onSubmit={onSubmit} onChange={() => setReview(null)}>
          <input type="hidden" name="operationId" value={operation.id} />
          <input type="hidden" name="modality" value={operation.modality} />
          {installment ? <input type="hidden" name="installmentFrequency" value={operation.frequency} /> : <input type="hidden" name="frequency" value={operation.frequency} />}
          {biweekly && interestMode === "FIXED" && <input type="hidden" name="interestMode" value="FIXED" />}
          <label className="field field-wide"><span>Cliente</span><select name="clientId" defaultValue={operation.clientId}>{options.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label>
          {installment ? (
            <>
              <label className="field"><span>Valor emprestado (R$)</span><MoneyInput name="loanAmount" inputMode="decimal" defaultValue={centsToInput(operation.principalCents)} required /></label>
              <label className="field"><span>Valor de cada parcela (R$)</span><MoneyInput name="installment" inputMode="decimal" defaultValue={centsToInput(operation.installmentCents ?? 0)} required /></label>
              <label className="field"><span>{operation.frequency === "BIWEEKLY" ? "Quantidade de parcelas (quinzenas)" : "Prazo total (meses)"}</span><input name="term" inputMode="numeric" maxLength={3} defaultValue={String(operation.installments.length)} required /></label>
              <DateField label="Data do empréstimo" name="loanDate" defaultValue={operation.loanDate} onChange={() => setReview(null)} required />
              <DateField label="Primeiro vencimento" name="firstDueDate" defaultValue={firstDue} onChange={() => setReview(null)} required />
            </>
          ) : (
            <>
              <label className="field"><span>Valor principal (R$)</span><MoneyInput name="principal" inputMode="decimal" defaultValue={centsToInput(operation.principalCents)} required /></label>
              {biweekly && interestMode === "FIXED"
                ? <label className="field"><span>Juros por quinzena (R$)</span><MoneyInput name="interestAmount" inputMode="decimal" defaultValue={operation.ledgerTerms.interestMode === "FIXED" ? centsToInput(operation.periodInterestCents) : ""} required /></label>
                : <label className="field"><span>{daily ? "Taxa de juros do período (%)" : biweekly ? "Taxa de juros por quinzena (%)" : "Taxa de juros ao mês (%)"}</span><input name="rate" inputMode="decimal" defaultValue={operation.ledgerTerms.interestMode === "FIXED" ? "" : rateInput} required /></label>}
              <DateField label="Data do empréstimo" name="loanDate" defaultValue={operation.loanDate} onChange={() => setReview(null)} required />
              {daily ? (
                <>
                  <label className="field"><span>Quantidade de dias (pagamentos)</span><input name="days" inputMode="numeric" maxLength={3} defaultValue={String(operation.installments.length)} required /></label>
                  <DateField label="Primeiro vencimento" name="firstDueDate" defaultValue={firstDue} onChange={() => setReview(null)} required />
                </>
              ) : <DateField label={biweekly ? "Primeiro vencimento" : "Vencimento"} name="dueDate" defaultValue={operation.dueDate} onChange={() => setReview(null)} required />}
            </>
          )}
          <label className="field field-wide"><span>Motivo da correção</span><input name="reason" maxLength={300} placeholder="Ex.: valor digitado errado" required /></label>
          {review && <input type="hidden" name="confirmed" value="1" />}
          {review && <input type="hidden" name="version" value={review.version} />}
          {review && (
            <div className="field-wide edit-review" aria-label="Antes e depois">
              {review.changes.length === 0 ? <p>Nada foi alterado.</p> : (
                <table className="data-table compact-table">
                  <thead><tr><th>Campo</th><th>Antes</th><th>Depois</th></tr></thead>
                  <tbody>{review.changes.map((change) => <tr key={change.field}><td>{change.field}</td><td>{change.before ?? "—"}</td><td><strong>{change.after ?? "—"}</strong></td></tr>)}</tbody>
                </table>
              )}
              <p className="capital-note">{`Capital disponível depois da correção: ${formatMoney(Math.max(review.availableAfterCents, 0))}. A correção fica no histórico da operação com o motivo.`}</p>
            </div>
          )}
          {error && <p className="form-feedback form-feedback-error field-wide">{error}</p>}
          <div className="form-actions">
            <button type="button" className="outline-button" onClick={onClose}>Cancelar</button>
            {review && review.changes.length > 0
              ? <button className="primary-button" disabled={pending}><Icon name="check" size={16} /> {pending ? "Salvando…" : "Confirmar correção"}</button>
              : <button type="button" className="primary-button" disabled={checking} onClick={(event) => { const form = event.currentTarget.form; if (form?.reportValidity()) check(form); }}>{checking ? "Revisando…" : "Revisar alterações"}</button>}
          </div>
        </form>
        <Feedback feedback={feedback} />
      </section>
    </div>
  );
}

function EditOperationButton({ operation, clients, onChanged }: { operation: OperationView; clients: ClientOption[]; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  if (operation.status !== "OPEN") return null;
  // Com pagamento ou renovação, o botão só explica o bloqueio (o servidor também recusa a correção).
  const locked = operation.payments.length > 0 || operation.renewalCount > 0;
  return (
    <>
      <button className="outline-button" onClick={() => setOpen(true)}>Corrigir</button>
      {open && (locked ? (
        <ConfirmDialog title={`Corrigir operação #${operation.code}`} confirmLabel="Corrigir" fields={{ operationId: operation.id }} onClose={() => setOpen(false)} onDone={onChanged}>
          <p><strong>Correção bloqueada para preservar o histórico financeiro.</strong> Esta operação já tem {[operation.payments.length > 0 && `${operation.payments.length} pagamento${operation.payments.length === 1 ? "" : "s"}`, operation.renewalCount > 0 && `${operation.renewalCount} renova${operation.renewalCount === 1 ? "ção" : "ções"}`].filter(Boolean).join(" e ")} registrado{operation.payments.length + operation.renewalCount === 1 ? "" : "s"}. Mudar valor, taxa ou datas agora mudaria o que já foi recebido.</p>
        </ConfirmDialog>
      ) : <EditOperationPanel operation={operation} clients={clients} onClose={() => setOpen(false)} onChanged={onChanged} />)}
    </>
  );
}

// Quanto cobrar na próxima data (mesma conta da tela Cobranças). Parcelado: o que falta da parcela em aberto, já descontado
// pagamento parcial. Pagamento único ou juros: o total a quitar na data.
function AmountToCollectCell({ operation }: { operation: OperationView }) {
  const due = operation.nextInstallment
    ? { cents: operation.nextInstallment.remainingCents, note: operation.nextInstallment.remainingCents < operation.nextInstallment.amountCents ? `saldo da parcela ${operation.nextInstallment.number}/${operation.installmentTotal}` : `parcela ${operation.nextInstallment.number}/${operation.installmentTotal}` }
    : { cents: operation.balanceCents, note: "total a quitar" };
  return <td data-label="A cobrar no vencimento">{operation.nextOpenDueDate && due.cents > 0 ? <><strong>{formatMoney(due.cents)}</strong><small>{due.note}</small></> : <span>—</span>}</td>;
}

type ManagerOption = { id: string; name: string; commissionBps: number };
type OperationManagerInfo = { transferredTo: string | null; transferredId: string | null; bps: number | null; clientManager: string | null };

// Transfere SÓ este contrato para um gerente de contas (a comissão vale para o contrato; pagamentos e capital não mudam).
function TransferOperationButton({ operation, managers, info, onChanged }: { operation: OperationView; managers: ManagerOption[]; info?: OperationManagerInfo; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [managerId, setManagerId] = useState(info?.transferredId ?? "");
  const [commission, setCommission] = useState(info?.bps != null ? String(info.bps / 100).replace(".", ",") : "");
  if (operation.status === "CANCELED" || operation.status === "RENEGOTIATED") return null;
  const pickManager = (id: string) => { setManagerId(id); const manager = managers.find((row) => row.id === id); if (manager && !commission) setCommission(String(manager.commissionBps / 100).replace(".", ",")); };
  return (
    <>
      <button className="outline-button" onClick={() => setOpen(true)}>Transferir</button>
      {open && (
        <ConfirmDialog title={`Transferir contrato #${operation.code}`} confirmLabel={managerId ? "Transferir contrato" : "Devolver ao gerente do cliente"} action={transferOperationAction} fields={{ operationId: operation.id, managerId, commission }} onClose={() => setOpen(false)} onDone={onChanged}>
          <dl className="payment-summary">
            <div><dt>Cliente</dt><dd>{operation.clientName}</dd></div>
            <div><dt>Principal</dt><dd>{formatMoney(operation.principalCents)}</dd></div>
            <div><dt>Gerente hoje</dt><dd>{info?.transferredTo ?? info?.clientManager ?? "Sem gerente"}</dd></div>
          </dl>
          <label className="field"><span>Transferir para</span>
            <select value={managerId} onChange={(event) => pickManager(event.target.value)}>
              <option value="">{info?.transferredTo ? "Devolver ao gerente do cliente" : "Escolha o gerente"}</option>
              {managers.map((manager) => <option key={manager.id} value={manager.id}>{manager.name}</option>)}
            </select>
          </label>
          {managerId && <label className="field"><span>Comissão deste contrato (%)</span><input inputMode="decimal" value={commission} onChange={(event) => setCommission(event.target.value)} placeholder="10" /></label>}
          <p><small>Vale só para este contrato. Os outros contratos do cliente não mudam, e pagamentos e capital continuam como estão.</small></p>
        </ConfirmDialog>
      )}
    </>
  );
}

function OperationsTable({ operations, clients, today, onChanged, readOnly = false, managers = [], operationManagers = {} }: { operations: OperationView[]; clients: ClientOption[]; today: string; onChanged: () => void; readOnly?: boolean; managers?: ManagerOption[]; operationManagers?: Record<string, OperationManagerInfo> }) {
  // Tabela compacta: cabe na largura da tela sem rolar para o lado. Dados menos usados ficam como linha pequena sob o principal.
  return (
    <div className="table-scroll"><table className="data-table fit-table">
      <thead><tr><th>Cliente</th><th>Principal e juros</th><th>Total</th><th>Recebido</th><th>Saldo</th><th>A cobrar no vencimento</th><th>Vencimento e situação</th><th /></tr></thead>
      <tbody>{operations.map((operation) => (
        <tr key={operation.id}>
          <td data-label="Cliente"><strong>{operation.clientName}</strong><small>#{operation.code} · emprestado em {formatDate(operation.loanDate)} · {operationAge(operation)}</small>{operationManagers[operation.id]?.transferredTo && <small>Gerente do contrato: {operationManagers[operation.id].transferredTo} · comissão {((operationManagers[operation.id].bps ?? 0) / 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%</small>}</td>
          <td data-label="Principal e juros">{formatMoney(operation.principalCents)}<small>juros {formatMoney(operation.interestCents)} · {rateLabel(operation)} · {operation.modality === "INSTALLMENT" ? `parcelado ${operation.frequency === "BIWEEKLY" ? "quinzenal" : "mensal"}` : frequencyLabels[operation.frequency].toLowerCase()}</small></td>
          <td data-label="Total">{formatMoney(operation.totalCents)}</td><td data-label="Recebido">{formatMoney(operation.paidCents)}</td><td data-label="Saldo"><strong>{formatMoney(operation.balanceCents)}</strong></td>
          <AmountToCollectCell operation={operation} />
          <td data-label="Vencimento e situação">{formatDate(operation.nextDueDate)}{operation.nextInstallment && <small>Parcela {operation.nextInstallment.number}/{operation.installmentTotal}</small>}{operation.renewalCount > 0 && <small>{plural(operation.renewalCount, "renovação", "renovações")}</small>}<div className="fit-status"><StatusChip state={operation.state} daysUntilDue={operation.daysUntilDue} /></div></td>
          <td className="actions-cell">{readOnly ? <OperationDetailsButton operation={operation} today={today} onChanged={onChanged} readOnly /> : <span className="row-actions"><PaymentButton operation={operation} today={today} onChanged={onChanged} /><EditOperationButton operation={operation} clients={clients} onChanged={onChanged} />{managers.length > 0 && <TransferOperationButton operation={operation} managers={managers} info={operationManagers[operation.id]} onChanged={onChanged} />}<DeleteOperationButton operation={operation} onChanged={onChanged} /></span>}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

export type OperationsFocus = "lent" | "interest" | null;

// Explica de quais operações vem o número de um card do dashboard. O total da tabela é o mesmo valor do card.
function FocusPanel({ focus, portfolio, onClear }: { focus: Exclude<OperationsFocus, null>; portfolio: TenantPortfolio; onClear: () => void }) {
  const lent = focus === "lent";
  const rows = portfolio.operations.filter((operation) => operation.status === "OPEN" && (lent ? operation.principalRemainingCents > 0 : operation.interestRemainingCents > 0));
  // Do maior para o menor principal (empate: maior principal a receber).
  if (lent) rows.sort((a, b) => b.principalCents - a.principalCents || b.principalRemainingCents - a.principalRemainingCents);
  const total = lent ? portfolio.summary.lentCents : portfolio.summary.expectedInterestCents;
  return (
    <section className="panel table-panel focus-panel" aria-label={lent ? "Composição do principal emprestado" : "Composição dos juros previstos"}>
      <div className="panel-header">
        <div><div className="panel-title-row"><h2>{lent ? "Principal emprestado" : "Juros previstos"}: {formatMoney(total)}</h2></div>
          <p><strong>Este valor vem destas operações.</strong> {lent ? "Principal que ainda não voltou para a carteira, nas operações em aberto abaixo." : "Juros que ainda faltam receber nas operações em aberto abaixo. Juros já recebidos não entram aqui."}</p></div>
        <button className="outline-button" onClick={onClear}>Ver todas as operações</button>
      </div>
      {rows.length === 0 ? <EmptyPanel icon="wallet" text={lent ? "Nenhum principal emprestado no momento." : "Nenhum juro previsto no momento."} /> : (
        <div className="table-scroll"><table className="data-table">
          <thead><tr><th>Cliente</th><th>Operação</th>{lent ? <><th>Principal</th><th>Principal recebido</th><th>Principal a receber</th></> : <><th>Juros da operação</th><th>Juros recebidos</th><th>Juros a receber</th></>}<th>Vencimento</th><th>Situação</th></tr></thead>
          <tbody>{rows.map((operation) => (
            <tr key={operation.id}>
              <td><strong>{operation.clientName}</strong></td><td>#{operation.code}</td>
              {lent
                ? <><td>{formatMoney(operation.principalCents)}</td><td>{formatMoney(operation.principalPaidCents)}</td><td><strong>{formatMoney(operation.principalRemainingCents)}</strong></td></>
                : <><td>{formatMoney(operation.interestCents)}</td><td>{formatMoney(operation.interestPaidCents)}</td><td><strong>{formatMoney(operation.interestRemainingCents)}</strong></td></>}
              <td>{formatDate(operation.nextDueDate)}</td><td><StatusChip state={operation.state} daysUntilDue={operation.daysUntilDue} /></td>
            </tr>
          ))}</tbody>
          <tfoot><tr><td colSpan={4}><strong>Total</strong></td><td><strong>{formatMoney(total)}</strong></td><td colSpan={2} /></tr></tfoot>
        </table></div>
      )}
    </section>
  );
}

type OperationSituation = "OPEN" | "PAID" | "ALL";
const SITUATION_TABS: { key: OperationSituation; label: string; icon: ReactNode }[] = [
  { key: "OPEN", label: "Ativas", icon: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></> },
  { key: "PAID", label: "Quitadas", icon: <><circle cx="12" cy="12" r="9" /><path d="m8 12.5 3 3 5-6" /></> },
  { key: "ALL", label: "Todos", icon: <><path d="M4 6h16M4 12h16M4 18h16" /></> },
];

// Pedidos de operação das gerentes de contas. O dono aprova (a operação nasce ativa) ou reprova com o motivo; a gerente acompanha o andamento.
export function OperationRequestsPanel({ requests, owner, onChanged }: { requests: TenantPortfolio["operationRequests"]; owner: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [feedback, setFeedback] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const pending = requests.filter((request) => request.status === "PENDING");
  // Aprovadas cujo Pix ao cliente ainda não foi confirmado: o compromisso de pagamento do dia (também em Contas a pagar).
  const pixTodo = owner ? requests.filter((request) => request.status === "APPROVED" && !request.pixPaidOn) : [];
  const decided = requests.filter((request) => request.status !== "PENDING" && !pixTodo.includes(request)).slice(0, owner ? 10 : 20);
  const run = async (id: string, action: () => Promise<ActionResult>) => {
    setBusy(id); setFeedback(null);
    try {
      const result = await action();
      setFeedback(result.ok ? { tone: "ok", text: result.message } : { tone: "error", text: result.error });
      if (result.ok) { setRejecting(null); setReason(""); onChanged(); }
    } catch { setFeedback({ tone: "error", text: "Não foi possível concluir. Tente novamente." }); } finally { setBusy(null); }
  };
  const statusLabel = { PENDING: "Aguardando aprovação", APPROVED: "Aprovada", REJECTED: "Reprovada" } as const;
  const badgeOf = (request: (typeof requests)[number]) => (owner && request.status === "APPROVED" ? (request.pixPaidOn ? `Aprovada · Pix feito ${formatDate(request.pixPaidOn)}` : "Pix a fazer") : statusLabel[request.status]);
  const row = (request: (typeof requests)[number]) => (
    <li key={request.id} className={`request-row request-${request.status.toLowerCase()}`}>
      <div className="request-main">
        <strong>{request.clientName}</strong>
        <span>{formatMoney(request.principalCents)} emprestados · total a receber {formatMoney(request.totalCents)} · {request.modality} · empréstimo em {formatDate(request.loanDate)}</span>
        {owner && <span>Enviado por {request.managerName} em {formatDate(request.createdAt.slice(0, 10))}</span>}
        {request.status === "REJECTED" && request.decisionNote && <span className="request-note">Motivo: {request.decisionNote}</span>}
      </div>
      <span className={`request-badge request-badge-${request.status.toLowerCase()}`}>{badgeOf(request)}</span>
      {owner && request.status === "APPROVED" && !request.pixPaidOn && (
        <div className="request-actions">
          <button type="button" className="primary-button" disabled={busy === request.id} onClick={() => void run(request.id, () => confirmOperationPixAction(request.id))}><Icon name="check" size={15} /> {busy === request.id ? "Confirmando…" : "Pix feito"}</button>
        </div>
      )}
      {owner && request.status === "PENDING" && (
        rejecting === request.id ? (
          <div className="request-actions">
            <input aria-label="Motivo da reprovação" placeholder="Motivo para a gerente" value={reason} maxLength={300} onChange={(event) => setReason(event.target.value)} />
            <button type="button" className="primary-button danger-button" disabled={busy === request.id} onClick={() => void run(request.id, () => rejectOperationRequestAction(request.id, reason))}>Confirmar reprovação</button>
            <button type="button" className="secondary-button" onClick={() => { setRejecting(null); setReason(""); }}>Voltar</button>
          </div>
        ) : (
          <div className="request-actions">
            <button type="button" className="primary-button" disabled={busy === request.id} onClick={() => void run(request.id, () => approveOperationRequestAction(request.id))}>{busy === request.id ? "Aprovando…" : "Aprovar"}</button>
            <button type="button" className="secondary-button" disabled={busy === request.id} onClick={() => { setRejecting(request.id); setReason(""); }}>Reprovar</button>
          </div>
        )
      )}
    </li>
  );
  return (
    <section className="panel" aria-label="Pedidos de operação">
      <div className="panel-header"><div><div className="panel-title-row"><h2>{owner ? "Operações aguardando aprovação" : "Meus pedidos de operação"}</h2><span className="today-count">{pending.length}</span></div><p>{owner ? "Aprove para a operação ficar ativa e faça o Pix. Reprove com o motivo para a gerente ajustar." : "Acompanhe o que você enviou. Quando o Fernando aprovar, a operação fica ativa."}</p></div></div>
      {pending.length === 0 ? <p className="muted">Nenhum pedido aguardando aprovação.</p> : <ul className="request-list">{pending.map(row)}</ul>}
      {pixTodo.length > 0 && <><h3 className="request-subtitle">Pix a fazer hoje ({pixTodo.length})</h3><p className="muted">Operação aprovada e ativa. Faça o Pix ao cliente e confirme; o capital já foi baixado na aprovação.</p><ul className="request-list">{pixTodo.map(row)}</ul></>}
      {decided.length > 0 && <><h3 className="request-subtitle">Decididos</h3><ul className="request-list">{decided.map(row)}</ul></>}
      <Feedback feedback={feedback} />
    </section>
  );
}

// Conferência da fase em que a proposta está: itens marcados + observação. "Avançar fase" só libera com todos os itens marcados e salvos.
function ProposalReviewBox({ proposal, busy, run }: { proposal: TenantPortfolio["proposals"][number]; busy: boolean; run: (task: () => Promise<ActionResult>) => Promise<void> }) {
  const review = reviewOf(proposal.phase);
  const saved = proposal.reviews.find((item) => item.phase === proposal.phase);
  const [checks, setChecks] = useState<Record<string, boolean>>(saved?.checks ?? {});
  const [note, setNote] = useState(saved?.note ?? "");
  if (!review) return null;
  return (
    <fieldset className="pipeline-review">
      <legend>{review.title}</legend>
      {proposal.phase === "CAPACITY" && (() => {
        const indicator = capacityIndicator(proposal.requestedCents, proposal.termMonths, proposal.monthlyIncomeCents, proposal.installmentCents);
        return <small className="pipeline-indicator">{proposal.installmentCents === null ? "Parcela estimada sem juros" : "Parcela negociada"}: {formatMoney(indicator.installmentCents)} por mês{indicator.incomeShare === null ? " (renda não informada)" : `, ${String(indicator.incomeShare).replace(".", ",")}% da renda informada`}.</small>;
      })()}
      {review.checks.map((item) => (
        <label key={item.key} className="pipeline-check"><input type="checkbox" checked={checks[item.key] === true} onChange={(event) => setChecks({ ...checks, [item.key]: event.currentTarget.checked })} /> {item.label}</label>
      ))}
      <textarea aria-label="Observação da conferência" placeholder="Observação (opcional)" maxLength={500} rows={2} value={note} onChange={(event) => setNote(event.currentTarget.value)} />
      <div className="pipeline-actions">
        <button className="outline-button" disabled={busy} onClick={() => void run(() => saveProposalReviewAction(proposal.id, checks, note))}>Salvar conferência</button>
        <small>{saved?.completed ? "Conferência concluída." : "Conclua a conferência para avançar."}</small>
      </div>
    </fieldset>
  );
}

// Oferta aprovada (fase 6): valor até o pedido, prazo e taxa. O motor reconfere antes de gravar; depois de salva, a proposta pode avançar para o aceite.
function ProposalOfferBox({ proposal, defaultRateBps, busy, run }: { proposal: TenantPortfolio["proposals"][number]; defaultRateBps: number | null; busy: boolean; run: (task: () => Promise<ActionResult>) => Promise<void> }) {
  const offer = proposal.offer;
  const [approved, setApproved] = useState(((offer?.cents ?? proposal.requestedCents) / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 }));
  const [term, setTerm] = useState(String(offer?.termMonths ?? proposal.termMonths));
  const [rate, setRate] = useState(offer ? String(offer.rateBps / 100).replace(".", ",") : defaultRateBps === null ? "" : String(defaultRateBps / 100).replace(".", ","));
  return (
    <fieldset className="pipeline-review">
      <legend>Oferta aprovada</legend>
      {proposal.installmentCents !== null && <small className="pipeline-indicator">Parcela negociada com o cliente: {formatMoney(proposal.installmentCents)} por mês em {proposal.termMonths}x.</small>}
      <div className="pipeline-offer-fields">
        <label>Valor aprovado<input aria-label="Valor aprovado" inputMode="decimal" value={approved} onChange={(event) => setApproved(event.currentTarget.value)} /></label>
        <label>Prazo (meses)<input aria-label="Prazo aprovado em meses" inputMode="numeric" value={term} onChange={(event) => setTerm(event.currentTarget.value)} /></label>
        <label>Taxa ao mês (%)<input aria-label="Taxa de juros ao mês" inputMode="decimal" placeholder="7,5" value={rate} onChange={(event) => setRate(event.currentTarget.value)} /></label>
      </div>
      <div className="pipeline-actions">
        <button className="outline-button" disabled={busy} onClick={() => void run(() => saveProposalOfferAction(proposal.id, approved, term, rate))}>Aprovar oferta</button>
        <small>{offer ? `Oferta salva: ${formatMoney(offer.cents)} em ${offer.termMonths}x, parcela ${formatMoney(offer.installmentCents)}.` : "Salve a oferta para avançar."}</small>
      </div>
    </fieldset>
  );
}

// Esteira de crédito: as 7 fases em colunas; cada proposta avança ou volta uma fase por vez.
export function CreditPipelinePage({ portfolio, onChanged }: { portfolio: TenantPortfolio; onChanged: () => void }) {
  const defaultRateText = portfolio.creditPolicy.defaultRateBps === null ? "" : String(portfolio.creditPolicy.defaultRateBps / 100).replace(".", ",");
  const [newRequested, setNewRequested] = useState("");
  const [newTerm, setNewTerm] = useState("");
  const [newRate, setNewRate] = useState(defaultRateText);
  const [newInstallment, setNewInstallment] = useState("");
  // Taxa, valor solicitado e prazo calculam a parcela; ao negociar a parcela direto, a taxa passa a ser a equivalente.
  const recalcInstallment = (requestedText: string, termText: string, rateText: string) => {
    const requested = parseMoneyToCents(requestedText);
    const term = /^\d{1,3}$/.test(termText.trim()) ? Number(termText) : null;
    const rateBps = parseLoanRateToBps(rateText);
    if (requested === null || requested <= 0 || term === null || term < 1 || rateBps === null) return;
    setNewInstallment(centsToInput(offerSummary(requested, term, rateBps).installmentCents));
  };
  const { pending, feedback, onSubmit } = useFormAction(createCreditProposalAction, (text) => {
    setNewRequested(""); setNewTerm(""); setNewRate(defaultRateText); setNewInstallment("");
    onChanged();
  });
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Endereço do site só no navegador: no servidor não existe window, e usar o global "origin" derrubava a tela com link ativo.
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const proposals = portfolio.proposals;
  const open = proposals.filter((proposal) => proposal.status === "OPEN");
  const rejected = proposals.filter((proposal) => proposal.status === "REJECTED");
  const run = async (task: () => Promise<ActionResult>) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await task();
      setMessage(result.ok ? { tone: "ok", text: result.message } : { tone: "error", text: result.error });
      if (result.ok) { setRejecting(null); onChanged(); }
    } catch {
      setMessage({ tone: "error", text: "Não foi possível concluir. Tente novamente." });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="workspace-page">
      <PageHeading eyebrow="CREDIAI · ESTEIRA DE CRÉDITO" title="Esteira de Crédito" description="Acompanhe cada proposta da fase 1 até o aceite do cliente." />
      <section className="panel form-panel" aria-label="Link de proposta">
        <div className="panel-header"><div><h2>Link de proposta</h2><p>Envie este link ao cliente: ele cria uma conta, preenche a proposta e anexa os documentos obrigatórios. Só então a proposta entra na fase 1.</p></div></div>
        {portfolio.proposalLink ? (
          <div className="pipeline-actions">
            <input readOnly aria-label="Endereço do link de proposta" value={`${origin}/proposta/${portfolio.proposalLink}`} onFocus={(event) => event.currentTarget.select()} />
            <button className="outline-button" disabled={busy} onClick={() => { void navigator.clipboard?.writeText(`${origin}/proposta/${portfolio.proposalLink}`); setMessage({ tone: "ok", text: "Link copiado." }); }}>Copiar link</button>
            <button className="outline-button" disabled={busy} onClick={() => void run(() => manageProposalLinkAction("rotate"))}>Gerar novo link</button>
            <button className="outline-button" disabled={busy} onClick={() => void run(() => manageProposalLinkAction("disable"))}>Desativar</button>
          </div>
        ) : <div className="pipeline-actions"><button className="primary-button" disabled={busy} onClick={() => void run(() => manageProposalLinkAction("create"))}>Gerar link de proposta</button></div>}
      </section>
      <section className="panel form-panel" aria-label="Nova proposta">
        <div className="panel-header"><div><h2>Nova proposta</h2><p>Cadastro manual: entra direto na fase "Proposta recebida". O cliente também pode enviar pelo link acima.</p></div></div>
        <form className="form-grid form-grid-inline" onSubmit={onSubmit}>
          <label className="field"><span>Nome completo</span><input name="applicantName" required maxLength={120} /></label>
          <label className="field"><span>CPF</span><input name="cpf" inputMode="numeric" required maxLength={14} onChange={(event) => { event.currentTarget.value = maskCpf(event.currentTarget.value); }} /></label>
          <label className="field"><span>Valor solicitado (R$)</span><MoneyInput name="requested" placeholder="5.000,00" required value={newRequested} onChange={(event) => { setNewRequested(event.target.value); recalcInstallment(event.target.value, newTerm, newRate); }} /></label>
          <label className="field"><span>Prazo (meses)</span><input name="termMonths" inputMode="numeric" required maxLength={3} value={newTerm} onChange={(event) => { setNewTerm(event.target.value); recalcInstallment(newRequested, event.target.value, newRate); }} /></label>
          <label className="field"><span>Taxa de juros (% ao mês)</span><input name="rate" inputMode="decimal" placeholder="30" value={newRate} onChange={(event) => { setNewRate(event.target.value); recalcInstallment(newRequested, newTerm, event.target.value); }} /></label>
          <label className="field"><span>Valor da parcela (R$)</span><MoneyInput name="installment" placeholder="Calculado pela taxa" value={newInstallment} onChange={(event) => {
            setNewInstallment(event.target.value);
            const requested = parseMoneyToCents(newRequested), installment = parseMoneyToCents(event.target.value), term = /^\d{1,3}$/.test(newTerm.trim()) ? Number(newTerm) : null;
            if (requested && requested > 0 && installment && installment > 0 && term && term >= 1) setNewRate(String(impliedRateBps(requested, installment, term) / 100).replace(".", ","));
          }} /></label>
          <label className="field"><span>E-mail</span><input name="email" type="email" maxLength={160} /></label>
          <label className="field"><span>Telefone</span><input name="phone" inputMode="tel" maxLength={16} onChange={(event) => { event.currentTarget.value = maskPhone(event.currentTarget.value); }} /></label>
          <div className="form-actions"><button className="primary-button" disabled={pending}><Icon name="plus" size={16} /> {pending ? "Salvando…" : "Cadastrar proposta"}</button></div>
        </form>
        <Feedback feedback={feedback} />
      </section>
      <Feedback feedback={message} />
      <div className="pipeline-board" aria-label="Fases da esteira">
        {PROPOSAL_PHASES.map((phase, index) => {
          const items = open.filter((proposal) => proposal.phase === phase.key);
          return (
            <section className="pipeline-column" key={phase.key} aria-label={phase.label}>
              <header><span className="pipeline-step">{index + 1}</span><div><h3>{phase.label}</h3><small>{phase.hint}</small></div><span className="nav-count">{items.length}</span></header>
              {items.length === 0 ? <p className="empty-state">Nenhuma proposta.</p> : items.map((proposal) => (
                <article className="pipeline-card" key={proposal.id}>
                  <strong>{proposal.applicantName}</strong>
                  <span>CPF {formatCpf(proposal.cpf)}</span>
                  <span>{formatMoney(proposal.requestedCents)} em {proposal.termMonths} {proposal.termMonths === 1 ? "mês" : "meses"}</span>
                  <small>Desde {formatDate(proposal.phaseChangedAt.slice(0, 10))}{proposal.source === "APPLICANT" ? " · enviada pelo cliente" : ""}</small>
                  {proposal.installmentCents !== null && <span>Parcela negociada {formatMoney(proposal.installmentCents)} (≈ {formatRate(impliedRateBps(proposal.requestedCents, proposal.installmentCents, proposal.termMonths))} ao mês)</span>}
                  {proposal.monthlyIncomeCents !== null && <span>Renda mensal {formatMoney(proposal.monthlyIncomeCents)}</span>}
                  {proposal.documents.length > 0 && <div className="pipeline-docs">{proposal.documents.map((doc) => (
                    <a key={doc.id} href={`/esteira/documento/${doc.id}`} target="_blank" rel="noreferrer">{PROPOSAL_DOCUMENTS.find((item) => item.kind === doc.kind)?.label ?? doc.kind}</a>
                  ))}</div>}
                  {proposal.offer && proposal.phase === "ACCEPTANCE" && (
                    <small className="pipeline-indicator">Oferta: {formatMoney(proposal.offer.cents)} em {proposal.offer.termMonths}x a {String(proposal.offer.rateBps / 100).replace(".", ",")}% ao mês. Parcela {formatMoney(proposal.offer.installmentCents)}, total {formatMoney(proposal.offer.totalCents)}.</small>
                  )}
                  {proposal.phase === "ACCEPTANCE" && (
                    proposal.acceptedAt
                      ? <small className="pipeline-indicator">Aceita pelo cliente em {formatDateTime(proposal.acceptedAt)} ({proposal.acceptedVia === "OWNER" ? "registrada por você" : "pelo portal"}).</small>
                      : proposal.source === "OWNER"
                        ? <div className="pipeline-actions"><button className="outline-button" disabled={busy || !proposal.offer} onClick={() => void run(() => registerOfferAcceptanceAction(proposal.id))}>Registrar aceite do cliente</button></div>
                        : <small className="pipeline-indicator">Aguardando o cliente aceitar a oferta no portal.</small>
                  )}
                  {proposal.phase === "APPROVAL" && <ProposalOfferBox key={`${proposal.id}-offer-${proposal.offer?.cents ?? 0}`} proposal={proposal} defaultRateBps={portfolio.creditPolicy.defaultRateBps} busy={busy} run={run} />}
                  {proposal.phase === "ENGINE" && (
                    <fieldset className="pipeline-review">
                      <legend>Motor de crédito</legend>
                      {proposal.engine.rules.map((rule) => (
                        <small key={rule.key} className={`pipeline-rule pipeline-rule-${rule.status.toLowerCase()}`}><strong>{rule.status === "PASS" ? "✔" : rule.status === "FAIL" ? "✖" : "•"} {rule.label}:</strong> {rule.detail}</small>
                      ))}
                      <small>{proposal.engine.passed ? "Dentro da política. Pode avançar." : "Fora da política. Volte uma fase para corrigir ou reprove a proposta."}</small>
                    </fieldset>
                  )}
                  <ProposalReviewBox key={`${proposal.id}-${proposal.phase}`} proposal={proposal} busy={busy} run={run} />
                  {rejecting === proposal.id ? (
                    <form className="pipeline-actions" onSubmit={(event) => { event.preventDefault(); const reason = String(new FormData(event.currentTarget).get("reason") ?? ""); void run(() => rejectCreditProposalAction(proposal.id, reason)); }}>
                      <input name="reason" placeholder="Motivo da reprovação" maxLength={300} required />
                      <button className="outline-button" disabled={busy}>Confirmar reprovação</button>
                      <button type="button" className="outline-button" onClick={() => setRejecting(null)}>Cancelar</button>
                    </form>
                  ) : (
                    <div className="pipeline-actions">
                      {index > 0 && !proposal.acceptedAt && <button className="outline-button" disabled={busy} onClick={() => void run(() => moveCreditProposalAction(proposal.id, "back"))}>Voltar fase</button>}
                      {index < PROPOSAL_PHASES.length - 1 && <button className="primary-button" disabled={busy || (proposal.phase === "ENGINE" && !proposal.engine.passed) || (proposal.phase === "APPROVAL" && !proposal.offer) || (reviewOf(proposal.phase) !== null && !proposal.reviews.some((item) => item.phase === proposal.phase && item.completed))} onClick={() => void run(() => moveCreditProposalAction(proposal.id, "next"))}>Avançar fase</button>}
                      {!proposal.acceptedAt && <button className="outline-button" disabled={busy} onClick={() => setRejecting(proposal.id)}>Reprovar</button>}
                    </div>
                  )}
                </article>
              ))}
            </section>
          );
        })}
      </div>
      {rejected.length > 0 && (
        <section className="panel" aria-label="Propostas reprovadas">
          <div className="panel-header"><div><h2>Reprovadas</h2><p>Ficam registradas com o motivo.</p></div></div>
          <div className="request-list">{rejected.map((proposal) => (
            <div className="request-row" key={proposal.id}><div className="request-main"><strong>{proposal.applicantName}</strong><span>{formatMoney(proposal.requestedCents)} · CPF {formatCpf(proposal.cpf)}</span><span className="request-note">Motivo: {proposal.decisionNote}</span></div><span className="request-badge request-badge-rejected">Reprovada</span></div>
          ))}</div>
        </section>
      )}
    </div>
  );
}

// Política de crédito: os limites que o dono define para a carteira. Vazio = sem limite.
export function CreditPolicyPage({ portfolio, onChanged }: { portfolio: TenantPortfolio; onChanged: () => void }) {
  const policy = portfolio.creditPolicy;
  const { pending, feedback, onSubmit } = useFormAction(saveCreditPolicyAction, onChanged, false);
  const money = (cents: number | null) => (cents === null ? "" : (cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 }));
  return (
    <div className="workspace-page">
      <PageHeading eyebrow="CREDIAI · POLÍTICA DE CRÉDITO" title="Política de crédito" description="Defina os limites da sua carteira. Deixe o campo em branco para não ter limite naquele item." />
      <section className="panel form-panel" aria-label="Limites da política de crédito">
        <div className="panel-header"><div><h2>Limites</h2><p>Os valores ficam guardados e podem ser alterados quando quiser. Cada alteração fica no registro de auditoria.</p></div></div>
        <form className="form-grid" onSubmit={onSubmit}>
          <label className="field"><span>Exposição máxima por CPF (R$)</span><MoneyInput name="maxExposurePerCpf" placeholder="Sem limite" defaultValue={money(policy.maxExposurePerCpfCents)} /><small>Total que um mesmo cliente pode dever em aberto.</small></label>
          <label className="field"><span>Prazo máximo (meses)</span><input name="maxTermMonths" inputMode="numeric" placeholder="Sem limite" defaultValue={policy.maxTermMonths ?? ""} maxLength={3} /><small>Do empréstimo até o último vencimento.</small></label>
          <label className="field"><span>Limite por contrato (R$)</span><MoneyInput name="maxContract" placeholder="Sem limite" defaultValue={money(policy.maxContractCents)} /><small>Valor máximo emprestado em cada operação.</small></label>
          <label className="field"><span>Taxa de juros mínima (% ao mês)</span><input name="minRate" inputMode="decimal" placeholder="Sem mínimo" defaultValue={policy.minRateBps === null ? "" : String(policy.minRateBps / 100).replace(".", ",")} maxLength={8} /><small>Taxa mensal abaixo da qual a operação não deve ser feita.</small></label>
          <label className="field"><span>Taxa de juros padrão (% ao mês)</span><input name="defaultRate" inputMode="decimal" placeholder="Ex.: 30" defaultValue={policy.defaultRateBps === null ? "" : String(policy.defaultRateBps / 100).replace(".", ",")} maxLength={8} /><small>Sugerida automaticamente na oferta e no simulador.</small></label>
          <div className="form-actions"><button className="primary-button" disabled={pending}><Icon name="check" size={16} /> {pending ? "Salvando…" : "Salvar política"}</button></div>
        </form>
        <Feedback feedback={feedback} />
      </section>
    </div>
  );
}

// Tela do dono: pedidos das gerentes para aprovar/reprovar, Pix a fazer e histórico. Cada aprovação vira compromisso do dia em Contas a pagar.
export function ApprovalsPage({ portfolio, onChanged }: { portfolio: TenantPortfolio; onChanged: () => void }) {
  return (
    <div className="workspace-page">
      <PageHeading eyebrow="CREDIAI · APROVAÇÕES" title="Aprovações" description="Pedidos de operação enviados pelas gerentes de contas. Aprovar ativa a operação e gera o Pix do dia em Contas a pagar; reprovar devolve o motivo para a gerente." />
      <OperationRequestsPanel requests={portfolio.operationRequests} owner onChanged={onChanged} />
    </div>
  );
}

// Bloco da visão geral do dono: quanto espera aprovação e quanto de Pix está por fazer.
export function ApprovalsOverview({ portfolio, onOpen }: { portfolio: TenantPortfolio; onOpen: () => void }) {
  const pending = portfolio.operationRequests.filter((request) => request.status === "PENDING");
  const pix = portfolio.operationRequests.filter((request) => request.status === "APPROVED" && !request.pixPaidOn);
  const sum = (rows: { principalCents: number }[]) => rows.reduce((total, row) => total + row.principalCents, 0);
  return (
    <section className="panel payables-dashboard" aria-label="Aprovações">
      <div className="panel-header">
        <div><div className="panel-title-row"><h2>Aprovações</h2><span className="today-count">{pending.length}</span></div><p>Pedidos das gerentes de contas e Pix do dia</p></div>
        <button type="button" className="outline-button" onClick={onOpen}>Abrir Aprovações <Icon name="arrow" size={14} /></button>
      </div>
      <div className="payables-kpis" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }} role="group" aria-label="Indicadores das aprovações">
        <button type="button" className="payables-kpi payables-kpi-amber" onClick={onOpen} style={{ textAlign: "left", font: "inherit" }}><span>Aguardando aprovação</span><strong>{formatMoney(sum(pending))}</strong><small>{pending.length === 1 ? "1 pedido" : `${pending.length} pedidos`}</small></button>
        <button type="button" className="payables-kpi payables-kpi-cyan" onClick={onOpen} style={{ textAlign: "left", font: "inherit" }}><span>Pix a fazer hoje</span><strong>{formatMoney(sum(pix))}</strong><small>{pix.length === 1 ? "1 operação aprovada" : `${pix.length} operações aprovadas`}</small></button>
      </div>
      {pending.length === 0 && pix.length === 0 ? <p className="empty-state">Nenhum pedido aguardando e nenhum Pix pendente.</p> : (
        <div>{[...pending, ...pix].slice(0, 4).map((request) => (
          <div key={request.id} className="payables-row">
            <div className="charge-person"><strong>{request.clientName}</strong><small>Enviado por {request.managerName}</small></div>
            <span className={`request-badge request-badge-${request.status.toLowerCase()}`}>{request.status === "PENDING" ? "Aguardando aprovação" : "Pix a fazer"}</span>
            <strong className="charge-amount">{formatMoney(request.principalCents)}</strong>
          </div>
        ))}</div>
      )}
    </section>
  );
}

export function OperationsPage({ portfolio, onChanged, onNewClient, focus = null, onClearFocus, readOnly = false, request, cashAvailableCents }: { request?: (data: FormData) => Promise<ActionResult>; cashAvailableCents?: number; portfolio: TenantPortfolio; onChanged: () => void; onNewClient: () => void; focus?: OperationsFocus; onClearFocus?: () => void; readOnly?: boolean }) {
  const ids = focus ? new Set(portfolio.operations.filter((operation) => operation.status === "OPEN" && (focus === "lent" ? operation.principalRemainingCents > 0 : operation.interestRemainingCents > 0)).map((operation) => operation.id)) : null;
  // Ordem definida no servidor pela próxima obrigação em aberto (compareByNextOpenDue); o filtro mantém a ordem.
  const byId = new Map(portfolio.operations.map((operation) => [operation.id, operation]));
  const ordered = portfolio.operationOrder.flatMap((id) => byId.get(id) ?? []);
  // Vindo do cartão "Principal emprestado": maior principal primeiro (empate: maior principal a receber; o resto mantém a ordem do servidor).
  const focused = ids ? ordered.filter((operation) => ids.has(operation.id)) : ordered;
  if (focus === "lent") focused.sort((a, b) => b.principalCents - a.principalCents || b.principalRemainingCents - a.principalRemainingCents);
  // Filtro por cliente (nome sem acento, CPF, telefone, e-mail) ou código da operação; só esconde linhas, nada é recalculado.
  const [clientFilter, setClientFilter] = useState("");
  // Situação: ativas por padrão (quitadas poluem a busca do dia a dia); Todos inclui quitadas, renegociadas e canceladas.
  const [situation, setSituation] = useState<OperationSituation>("OPEN");
  const wanted = clientFilter.trim();
  const fold = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const clientsById = new Map(portfolio.clients.map((client) => [client.id, client]));
  const situationCounts = { OPEN: focused.filter((operation) => operation.status === "OPEN").length, PAID: focused.filter((operation) => operation.status === "PAID").length, ALL: focused.length };
  const bySituation = focus || situation === "ALL" ? focused : focused.filter((operation) => operation.status === situation);
  const operations = wanted === "" ? bySituation : bySituation.filter((operation) => {
    const client = clientsById.get(operation.clientId);
    const digits = onlyDigits(wanted);
    return fold(operation.clientName).includes(fold(wanted)) || fold(operation.code).includes(fold(wanted.replace(/^#/, "")))
      || (client?.email ? fold(client.email).includes(fold(wanted)) : false)
      || (digits.length >= 3 && [client?.document, client?.phone, client?.whatsapp].some((value) => value && onlyDigits(value).includes(digits)));
  });
  return (
    <div className="workspace-page">
      <PageHeading eyebrow="CREDIAI · OPERAÇÕES" title="Operações" description={readOnly ? "Cadastre operações dos clientes que você indicou (elas vão para a aprovação do Fernando) e acompanhe os empréstimos." : "Cadastre e acompanhe os empréstimos da sua carteira."} />
      {readOnly && portfolio.operationRequests.length > 0 && <OperationRequestsPanel requests={portfolio.operationRequests} owner={false} onChanged={onChanged} />}
      {readOnly && !request ? null : focus ? <FocusPanel focus={focus} portfolio={portfolio} onClear={() => onClearFocus?.()} /> : <OperationForm portfolio={portfolio} onChanged={onChanged} onNewClient={onNewClient} request={request} cashAvailableCents={cashAvailableCents} />}
      <section className="panel table-panel" aria-label="Lista de operações">
        <div className="panel-header"><div><div className="panel-title-row"><h2>{focus ? "Operações que compõem este valor" : "Operações da carteira"}</h2><span className="today-count">{operations.length}</span></div><p>Ativas: {portfolio.summary.counts.active} · Quitadas: {portfolio.summary.counts.paid} · Em atraso: {portfolio.summary.counts.overdue}</p></div></div>
        {!focus && focused.length > 0 && (
          <div className="situation-tabs" role="group" aria-label="Situação das operações">
            {SITUATION_TABS.map((tab) => (
              <button key={tab.key} type="button" className={`situation-tab${situation === tab.key ? " active" : ""}`} aria-pressed={situation === tab.key} onClick={() => setSituation(tab.key)}>
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{tab.icon}</svg>
                {tab.label}<span className="situation-count">{situationCounts[tab.key]}</span>
              </button>
            ))}
          </div>
        )}
        {focused.length > 0 && (
          <div className="client-search" role="search">
            <label className="client-search-box">
              <span className="search-icon"><Icon name="search" size={16} /></span>
              <input type="search" aria-label="Filtrar operações por cliente" placeholder="Filtrar por cliente: nome, CPF, telefone, e-mail ou código" value={clientFilter} maxLength={120} onChange={(event) => setClientFilter(event.target.value)} />
              {clientFilter && <button type="button" className="search-clear" aria-label="Limpar filtro" onClick={() => setClientFilter("")}>×</button>}
            </label>
            {wanted && <p className="client-search-status" role="status">{operations.length === 0 ? "Nenhuma operação encontrada para esse cliente." : `${operations.length} ${operations.length === 1 ? "operação" : "operações"} de ${wanted}.`}</p>}
          </div>
        )}
        {operations.length === 0 ? <EmptyPanel icon="wallet" text={focus ? "Nenhuma operação em aberto." : focused.length > 0 ? (wanted ? `Nenhuma operação ${situation === "OPEN" ? "ativa" : situation === "PAID" ? "quitada" : ""} encontrada para essa busca.`.replace("  ", " ") : situation === "PAID" ? "Nenhuma operação quitada." : "Nenhuma operação ativa.") : "Nenhuma operação cadastrada ainda."} /> : <OperationsTable operations={operations} clients={portfolio.clients} today={portfolio.today} onChanged={onChanged} readOnly={readOnly} managers={portfolio.managers} operationManagers={portfolio.operationManagers} />}
      </section>
    </div>
  );
}

export function CapitalPage({ portfolio, onChanged }: { portfolio: TenantPortfolio; onChanged: () => void }) {
  const contribution = useFormAction(registerContributionAction, onChanged);
  const withdrawal = useFormAction(registerWithdrawalAction, onChanged);
  const initial = useFormAction(saveWalletAction, onChanged);
  const [reversing, setReversing] = useState<TenantPortfolio["capitalLedger"][number] | null>(null);
  const linkedToInvestor = new Set(portfolio.investorLinkedContributionIds);
  const { summary } = portfolio;
  return (
    <div className="workspace-page">
      <PageHeading eyebrow="CREDIAI · CAPITAL" title="Capital da carteira" description={`De onde vem o seu capital disponível: capital inicial, aportes, retiradas, empréstimos feitos e valores recebidos.${summary.cycleNumber > 1 ? ` Ciclo ${summary.cycleNumber} da carteira; ciclos anteriores ficam em Configurações.` : ""}`} />
      <section className="panel form-panel" aria-label="Resumo do capital">
        <div className="panel-header"><div><div className="panel-title-row"><h2>Capital disponível: {formatMoney(summary.availableCents)}</h2><span className="status-chip status-active"><i />Ciclo atual: {summary.cycleNumber}</span></div><p>Capital inicial + aportes + outras entradas − estornos − retiradas e saídas − capital usado em operações + valores recebidos. Juros ainda não recebidos não contam.</p></div></div>
        <dl className="payment-summary">
          <div><dt>Capital inicial</dt><dd>{formatMoney(summary.initialCapitalCents)}</dd></div>
          <div><dt>Aportes</dt><dd>+ {formatMoney(summary.grossContributionsCents)}</dd></div>
          {summary.reversalsCents > 0 && <div><dt>Estornos de aporte</dt><dd>− {formatMoney(summary.reversalsCents)}</dd></div>}
          {summary.otherIncomeCents > 0 && <div><dt>Outras entradas (Financeiro)</dt><dd>+ {formatMoney(summary.otherIncomeCents)}</dd></div>}
          <div><dt>Retiradas e saídas</dt><dd>− {formatMoney(summary.withdrawalsCents)}</dd></div>
          <div><dt>Capital usado em operações</dt><dd>− {formatMoney(summary.usedCapitalCents)}</dd></div>
          <div><dt>Valores recebidos</dt><dd>+ {formatMoney(summary.receivedCents)}</dd></div>
          <div className="payment-balance"><dt>Capital disponível</dt><dd>{formatMoney(summary.availableCents)}</dd></div>
        </dl>
        <p className="capital-note">Total aportado (inicial + aportes, já descontados os estornos): {formatMoney(summary.investedCents)}. Dos valores recebidos, {formatMoney(summary.receivedPrincipalCents)} são principal devolvido e {formatMoney(summary.receivedInterestCents)} são juros. Ainda estão emprestados {formatMoney(summary.lentCents)} de principal.</p>
      </section>
      {summary.needsInitialCapital ? (
        <section className="panel form-panel wallet-setup" aria-label="Definir capital inicial">
          <div className="panel-header"><div><h2>Defina o capital inicial{summary.cycleNumber > 1 ? ` do ciclo ${summary.cycleNumber}` : ""}</h2><p>Depois disso você pode registrar aportes.</p></div></div>
          <form className="form-grid form-grid-inline" onSubmit={initial.onSubmit}>
            <label className="field"><span>Capital inicial (R$)</span><MoneyInput name="initialCapital" inputMode="decimal" placeholder="20.000,00" required /></label>
            <button className="primary-button" disabled={initial.pending}><Icon name="check" size={16} /> {initial.pending ? "Salvando…" : "Salvar capital inicial"}</button>
          </form>
          <Feedback feedback={initial.feedback} />
        </section>
      ) : (
        <section className="panel form-panel" aria-label="Registrar aporte">
          <div className="panel-header"><div><h2>Registrar aporte</h2><p>Dinheiro novo colocado na carteira. Entra no capital disponível na hora.</p></div></div>
          <form className="form-grid" onSubmit={contribution.onSubmit}>
            <label className="field"><span>Valor do aporte (R$)</span><MoneyInput name="amount" inputMode="decimal" placeholder="2.000,00" required /></label>
            <label className="field"><span>Data do aporte</span><input name="occurredAt" type="date" defaultValue={portfolio.today} max={portfolio.today} required /></label>
            <label className="field field-wide"><span>Observação</span><input name="notes" placeholder="Opcional" maxLength={500} /></label>
            <div className="form-actions"><button className="primary-button" disabled={contribution.pending}><Icon name="plus" size={16} /> {contribution.pending ? "Registrando…" : "Registrar aporte"}</button></div>
          </form>
          <Feedback feedback={contribution.feedback} />
        </section>
      )}
      {summary.hasWallet && (
        <section className="panel form-panel" aria-label="Registrar retirada">
          <div className="panel-header"><div><h2>Registrar retirada</h2><p>Dinheiro tirado da carteira. Limitado ao capital disponível de {formatMoney(Math.max(summary.availableCents, 0))}. Para registrar com categoria (salário, retirada de sócio, despesas, impostos), use <a className="text-link inline-link" href="/financeiro">Financeiro</a>.</p></div></div>
          <form className="form-grid" onSubmit={withdrawal.onSubmit}>
            <label className="field"><span>Valor da retirada (R$)</span><MoneyInput name="amount" inputMode="decimal" placeholder="2.000,00" required /></label>
            <label className="field"><span>Data da retirada</span><input name="occurredAt" type="date" defaultValue={portfolio.today} max={portfolio.today} required /></label>
            <label className="field field-wide"><span>Observação</span><input name="notes" placeholder="Opcional" maxLength={500} /></label>
            <div className="form-actions"><button className="primary-button" disabled={withdrawal.pending}><Icon name="arrow" size={16} /> {withdrawal.pending ? "Registrando…" : "Registrar retirada"}</button></div>
          </form>
          <Feedback feedback={withdrawal.feedback} />
        </section>
      )}
      <section className="panel table-panel" aria-label="Movimentos de capital">
        <div className="panel-header"><div><div className="panel-title-row"><h2>Histórico do capital</h2><span className="today-count">{portfolio.capitalLedger.length}</span></div><p>Cada entrada e saída de capital, com o saldo disponível depois dela. O capital inicial é alterado em Configurações.</p></div></div>
        {portfolio.capitalLedger.length === 0 ? <EmptyPanel icon="wallet" text="Nenhum movimento de capital ainda." /> : (
          <div className="table-scroll"><table className="data-table">
            <thead><tr><th>Data</th><th>Movimento</th><th>Descrição</th><th>Valor</th><th>Disponível após</th><th /></tr></thead>
            <tbody>{portfolio.capitalLedger.map((entry) => (
              <tr key={entry.key}>
                <td>{formatDate(entry.date)}</td>
                <td><span className={`status-chip ${entry.amountCents < 0 ? "status-due" : entry.kind === "PAYMENT" ? "status-paid" : "status-active"}`}><i />{entry.source === "INVESTOR" && entry.category && isInvestorCategory(entry.category) ? INVESTOR_CATEGORIES[entry.category] : capitalLedgerLabels[entry.kind]}</span></td>
                <td>{entry.description}</td>
                <td><strong>{entry.amountCents < 0 ? "− " : "+ "}{formatMoney(Math.abs(entry.amountCents))}</strong></td>
                <td>{formatMoney(entry.balanceCents)}</td>
                <td className="actions-cell">{entry.kind === "CONTRIBUTION" && entry.source !== "INVESTOR" && (entry.reversed ? <span className="status-chip status-muted"><i />Estornado</span>
                  : linkedToInvestor.has(entry.movementId ?? "") ? <small className="admin-cell-note">Ligado a contrato de investidor: não se estorna</small>
                  : <button className="outline-button danger-outline" onClick={() => setReversing(entry)}>Estornar aporte</button>)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      {reversing?.movementId && (
        <ConfirmDialog title="Estornar aporte" confirmLabel={`Estornar ${formatMoney(reversing.amountCents)}`} action={reverseContributionAction} fields={{ movementId: reversing.movementId }} onClose={() => setReversing(null)} onDone={onChanged}>
          <p>Aporte de <strong>{formatMoney(reversing.amountCents)}</strong> em {formatDate(reversing.date)} ({reversing.description}).</p>
          <p>O aporte continua no histórico, marcado como estornado, e um movimento de <strong>Estorno de aporte</strong> com a data de hoje tira {formatMoney(reversing.amountCents)} do capital disponível ({formatMoney(summary.availableCents)} → {formatMoney(summary.availableCents - reversing.amountCents)}).</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

// Rentabilidade da carteira inteira e por cliente, no ciclo atual. Juros previstos nunca são somados ao lucro realizado.
export function ReportsPage({ portfolio, onChanged = () => {} }: { portfolio: TenantPortfolio; onChanged?: () => void }) {
  const { profitability } = portfolio;
  const activeClients = portfolio.clients.filter((client) => client.profile.openCount > 0).length;
  const [filters, setFilters] = useState<ReportFilters>({ period: "CYCLE", from: "", to: "", status: "ALL" });
  const [scope, setScope] = useState<ReportScope>("CURRENT");
  // Todos os ciclos: carregado do servidor só quando escolhido (só leitura).
  const [allCycles, setAllCycles] = useState<{ operations: OperationView[] } | { error: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  useEffect(() => {
    if (scope !== "ALL" || allCycles) return;
    let active = true;
    loadAllCyclesReportAction()
      .then((result) => { if (active) setAllCycles(result.ok ? { operations: result.operations } : { error: result.error }); })
      .catch(() => { if (active) setAllCycles({ error: "Não foi possível carregar os ciclos encerrados. Tente de novo." }); });
    return () => { active = false; };
  }, [scope, allCycles]);
  const loadingAll = scope === "ALL" && (!allCycles || "error" in allCycles);
  const reportOperations = scope === "ALL" && allCycles && "operations" in allCycles ? allCycles.operations : portfolio.operations;
  const report = profitabilityReport(loadingAll ? [] : reportOperations, filters, portfolio.today);
  const filtered = filters.period !== "CYCLE" || filters.status !== "ALL" || scope !== "CURRENT";
  const origin = scope === "ALL" ? "o primeiro ciclo" : "o início do ciclo";
  const rangeLabel = report.range.from || report.range.to
    ? `De ${report.range.from ? formatDate(report.range.from) : origin} a ${report.range.to ? formatDate(report.range.to) : "hoje"}`
    : scope === "ALL" ? "Todos os ciclos da carteira" : "Todo o ciclo atual";
  // Operações de ciclos encerrados abrem só para consulta (o servidor também recusa pagamento fora do ciclo atual).
  const openedOperation = reportOperations.find((operation) => operation.id === opened) ?? null;
  const set = (patch: Partial<ReportFilters>) => { setFilters((current) => ({ ...current, ...patch })); setExpanded(null); };
  return (
    <div className="workspace-page">
      <PageHeading eyebrow="CREDIAI · RELATÓRIOS" title="Rentabilidade da carteira" description="Calculada só com os pagamentos registrados. Juros previstos ainda não são lucro; só os juros recebidos são." />
      <section className="panel form-panel" aria-label="Rentabilidade da carteira">
        <div className="panel-header"><div><h2>Carteira{portfolio.summary.cycleNumber > 1 ? ` · ciclo ${portfolio.summary.cycleNumber}` : ""}</h2><p>{plural(profitability.operationCount, "operação", "operações")} ({profitability.openCount} em aberto, {profitability.paidCount} quitada{profitability.paidCount === 1 ? "" : "s"}) · {plural(activeClients, "cliente ativo", "clientes ativos")} com operação em aberto · {plural(portfolio.clients.length, "cliente cadastrado", "clientes cadastrados")}</p></div></div>
        <dl className="payment-summary">
          <div><dt>Principal emprestado</dt><dd>{formatMoney(profitability.principalCents)}</dd></div>
          <div><dt>Principal recuperado</dt><dd>{formatMoney(profitability.principalPaidCents)}</dd></div>
          <div><dt>Juros recebidos (lucro realizado)</dt><dd>{formatMoney(profitability.interestPaidCents)}</dd></div>
          <div><dt>Juros previstos (ainda não recebidos)</dt><dd>{formatMoney(profitability.interestRemainingCents)}</dd></div>
          <div><dt>Saldo de principal</dt><dd>{formatMoney(profitability.principalRemainingCents)}</dd></div>
          <div><dt>Operações ativas</dt><dd>{profitability.openCount}</dd></div>
          <div><dt>Operações quitadas</dt><dd>{profitability.paidCount}</dd></div>
          <div><dt>Total recebido</dt><dd>{formatMoney(profitability.paidCents)}</dd></div>
          <div className="payment-balance"><dt>Total a receber</dt><dd>{formatMoney(profitability.balanceCents)}</dd></div>
        </dl>
      </section>
      <section className="panel table-panel" aria-label="Rentabilidade por cliente">
        <div className="panel-header"><div><div className="panel-title-row"><h2>Por cliente</h2><span className="today-count">{report.clients.length}</span></div>
          <p>{`${rangeLabel}. Recebidos contam pela data do pagamento e emprestado pela data do empréstimo; saldo e juros previstos são os de hoje. Clique no cliente para ver cada operação.`}</p></div></div>
        <form className="report-filters" role="search" aria-label="Filtros do relatório" onSubmit={(event) => event.preventDefault()}>
          <label className="field"><span>Período</span><select value={filters.period} onChange={(event) => set({ period: event.target.value as ReportPeriod })}>
            {(Object.keys(REPORT_PERIODS) as ReportPeriod[]).map((period) => <option key={period} value={period}>{REPORT_PERIODS[period]}</option>)}
          </select></label>
          {filters.period === "CUSTOM" && (
            <>
              <DateField label="De" name="reportFrom" defaultValue={filters.from} onChange={(from) => set({ from })} />
              <DateField label="Até" name="reportTo" defaultValue={filters.to} onChange={(to) => set({ to })} />
            </>
          )}
          <label className="field"><span>Ciclos</span><select value={scope} onChange={(event) => { setScope(event.target.value as ReportScope); setExpanded(null); }}>
            {(Object.keys(REPORT_SCOPES) as ReportScope[]).map((key) => <option key={key} value={key}>{REPORT_SCOPES[key]}</option>)}
          </select></label>
          <label className="field"><span>Situação</span><select value={filters.status} onChange={(event) => set({ status: event.target.value as ReportStatus })}>
            {(Object.keys(REPORT_STATUSES) as ReportStatus[]).map((status) => <option key={status} value={status}>{REPORT_STATUSES[status]}</option>)}
          </select></label>
          {filtered && <button type="button" className="text-link" onClick={() => { set({ period: "CYCLE", from: "", to: "", status: "ALL" }); setScope("CURRENT"); }}>Limpar filtros</button>}
        </form>
        {loadingAll ? <EmptyPanel icon="chart" text={allCycles && "error" in allCycles ? allCycles.error : "Carregando os ciclos encerrados…"} /> : report.clients.length === 0 ? <EmptyPanel icon="chart" text={filtered ? "Nenhuma operação com esses filtros." : "Nenhuma operação no ciclo atual."} /> : (
          <div className="table-scroll"><table className="data-table report-table">
            <thead><tr><th>Cliente</th><th>Operações</th><th>Principal emprestado</th><th>Principal recuperado</th><th>Juros recebidos</th><th>Juros previstos</th><th>Saldo</th><th>Pagamentos</th></tr></thead>
            <tbody>{report.clients.map((client) => (
              <Fragment key={client.clientId}>
                <tr className="report-client-row">
                  <td><button type="button" className="text-link client-link" aria-expanded={expanded === client.clientId} onClick={() => setExpanded(expanded === client.clientId ? null : client.clientId)}><strong>{client.clientName}</strong></button></td>
                  <td>{client.totals.operationCount}</td><td>{formatMoney(client.totals.principalLentCents)}</td><td>{formatMoney(client.totals.principalReceivedCents)}</td><td>{formatMoney(client.totals.interestReceivedCents)}</td><td>{formatMoney(client.totals.interestRemainingCents)}</td><td><strong>{formatMoney(client.totals.balanceCents)}</strong></td><td>{client.totals.paymentCount}</td>
                </tr>
                {expanded === client.clientId && client.operations.map(({ operation, row }) => (
                  <tr key={operation.id} className="report-operation-row">
                    <td><span className="row-actions"><button type="button" className="outline-button" onClick={() => setOpened(operation.id)}>{`Abrir #${operation.code}`}</button></span><small>{`${modalityLabel(operation)} · empréstimo ${formatDate(operation.loanDate)}${scope === "ALL" && operation.cycleNumber ? ` · ciclo ${operation.cycleNumber}${operation.cycleNumber === portfolio.summary.cycleNumber ? " (atual)" : ""}` : ""}`}</small></td>
                    <td><StatusChip state={operation.state} daysUntilDue={operation.daysUntilDue} /></td><td>{formatMoney(row.principalLentCents)}</td><td>{formatMoney(row.principalReceivedCents)}</td><td>{formatMoney(row.interestReceivedCents)}</td><td>{formatMoney(row.interestRemainingCents)}</td><td>{formatMoney(row.balanceCents)}</td><td>{row.paymentCount}</td>
                  </tr>
                ))}
              </Fragment>
            ))}</tbody>
            <tfoot><tr><td><strong>Total</strong></td><td>{report.totals.operationCount}</td><td>{formatMoney(report.totals.principalLentCents)}</td><td>{formatMoney(report.totals.principalReceivedCents)}</td><td>{formatMoney(report.totals.interestReceivedCents)}</td><td>{formatMoney(report.totals.interestRemainingCents)}</td><td><strong>{formatMoney(report.totals.balanceCents)}</strong></td><td>{report.totals.paymentCount}</td></tr></tfoot>
          </table></div>
        )}
      </section>
      {openedOperation && <PaymentPanel operation={openedOperation} today={portfolio.today} onClose={() => setOpened(null)} onChanged={() => { setAllCycles(null); onChanged(); }} readOnly={openedOperation.cycleNumber !== undefined && openedOperation.cycleNumber !== portfolio.summary.cycleNumber} />}
    </div>
  );
}

export function PaymentsPage({ portfolio }: { portfolio: TenantPortfolio }) {
  return (
    <div className="workspace-page">
      <PageHeading eyebrow="CREDIAI · PAGAMENTOS" title="Pagamentos" description={`Recebido até hoje: ${formatMoney(portfolio.summary.receivedCents)}.`} />
      <section className="panel table-panel" aria-label="Pagamentos recebidos">
        {portfolio.payments.length === 0 ? <EmptyPanel icon="receipt" text="Nenhum pagamento registrado. Registre pagamentos em Operações ou Cobranças." /> : (
          <div className="table-scroll"><table className="data-table">
            <thead><tr><th>Cliente</th><th>Detalhe</th><th>Situação</th><th>Valor</th></tr></thead>
            <tbody>{portfolio.payments.map((payment) => <tr key={payment.key}><td><strong>{payment.clientName}</strong></td><td>{payment.detail}</td><td><span className="status-chip status-paid"><i />{payment.status}</span></td><td><strong>{formatMoney(payment.amountCents)}</strong></td></tr>)}</tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}

export type ChargesView = ChargeFilter | "Em aberto";

export function ChargesPage({ portfolio, onChanged, initialFilter = "Em aberto", readOnly = false }: { portfolio: TenantPortfolio; onChanged: () => void; initialFilter?: ChargesView; readOnly?: boolean }) {
  const filters: ChargesView[] = ["Em aberto", "Em atraso", "Hoje", "Amanhã", "Próximas"];
  const [filter, setFilter] = useState<ChargesView>(initialFilter);
  const open = portfolio.operations.filter((operation) => operation.status === "OPEN");
  const countOf = (item: ChargesView) => (item === "Em aberto" ? open.length : portfolio.charges[item].length);
  // A ordem vem pronta do servidor (chargeOrder e cada aba em charges): a vencida há mais tempo primeiro.
  const byId = new Map(portfolio.operations.map((operation) => [operation.id, operation]));
  const ids = filter === "Em aberto" ? portfolio.chargeOrder : portfolio.charges[filter].map((charge) => charge.operationId);
  const operations = ids.flatMap((id) => byId.get(id) ?? []);
  const balance = operations.reduce((total, operation) => total + operation.balanceCents, 0);
  return (
    <div className="workspace-page">
      <PageHeading eyebrow="CREDIAI · COBRANÇAS" title="Cobranças" description={readOnly ? "Operações em aberto dos seus clientes, por vencimento. Somente leitura." : "Operações em aberto por vencimento. Registre cada pagamento quando receber."} />
      <section className="panel table-panel">
        <div className="panel-header"><div><div className="panel-title-row"><h2>{filter === "Em aberto" ? `Total a receber: ${formatMoney(portfolio.summary.receivableCents)}` : `${filter}: ${formatMoney(balance)}`}</h2></div><p>{filter === "Em aberto" ? "Principal + juros ainda não recebidos de todas as operações em aberto." : "Saldo em aberto das operações deste filtro."}</p></div></div>
        <div className="charge-tabs" role="tablist" aria-label="Filtro de cobranças">{filters.map((item) => <button key={item} role="tab" aria-selected={filter === item} className={filter === item ? "charge-tab-active" : ""} onClick={() => setFilter(item)}>{item} ({countOf(item)})</button>)}</div>
        {operations.length === 0 ? <EmptyPanel icon="calendar" text={filter === "Em aberto" ? "Nenhuma operação em aberto." : "Nenhuma cobrança neste filtro."} /> : <OperationsTable operations={operations} clients={portfolio.clients} today={portfolio.today} onChanged={onChanged} readOnly={readOnly} managers={portfolio.managers} operationManagers={portfolio.operationManagers} />}
      </section>
    </div>
  );
}
