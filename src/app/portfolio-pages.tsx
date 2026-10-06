"use client";

import { useEffect, useState, useTransition, type FormEvent, type InputHTMLAttributes, type ReactNode } from "react";
import { cancelOperationAction, createClientAction, createOperationAction, deleteClientAction, deleteClientDocumentAction, editPaymentAction, registerContributionAction, registerPaymentAction, registerWithdrawalAction, resetWalletAction, reverseContributionAction, saveWalletAction, updateClientAction, uploadClientDocumentAction, type ActionResult } from "./actions";
import { Icon, type IconName } from "./ui-icon";
import { addDays, centsToInput, formatCpf, formatDate, formatElapsed, todayIso, formatMoney, formatPhone, formatRate, maskCpf, maskPhone, onlyDigits, parseMoneyToCents, parseRateToBps } from "@/lib/finance/format";
import { capitalLedgerLabels, type ChargeFilter, type OperationsSummary, type OperationView } from "@/lib/finance/portfolio";
import type { TenantPortfolio } from "@/lib/finance/queries";
import { addressKey, addressKinds, addressPartLabels, addressParts, brazilianStates, formatAddress, guarantorPartLabels, maskCep, referenceKey, referenceSlots, type AddressKind, type AddressPart } from "@/lib/finance/client-profile";
import { calculateDaily, calculateFixedInterest, calculateInstallments, calculateOperation, checkPayment, dueDates, frequencyLabels, interestOnlyRenewal, monthlyEquivalentRate, operationLedger, paymentKindLabels, simpleMonthlyRate, type Frequency } from "@/lib/finance/rules";
import { DateField } from "./date-field";

function useFormAction(action: (data: FormData) => Promise<ActionResult>, onDone?: () => void) {
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setFeedback(null);
    startTransition(async () => {
      try {
        const result = await action(data);
        if (result.ok) {
          form.reset();
          setFeedback({ tone: "ok", text: result.message });
          onDone?.();
        } else {
          setFeedback({ tone: "error", text: result.error });
        }
      } catch {
        setFeedback({ tone: "error", text: "Não foi possível salvar. Tente novamente." });
      }
    });
  };
  return { pending, feedback, onSubmit };
}

function Feedback({ feedback }: { feedback: { tone: "ok" | "error"; text: string } | null }) {
  if (!feedback) return null;
  return <p className={`form-feedback ${feedback.tone === "error" ? "form-feedback-error" : ""}`} role={feedback.tone === "error" ? "alert" : "status"}>{feedback.text}</p>;
}

function PageHeading({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children?: ReactNode }) {
  return (
    <section className="page-heading">
      <div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>
      {children && <div className="heading-actions">{children}</div>}
    </section>
  );
}

function EmptyPanel({ icon, text, action }: { icon: IconName; text: string; action?: ReactNode }) {
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
    return `${percent(simpleMonthlyRate({ principalCents: operation.principalCents, interestCents: operation.originalInterestCents, months: operation.installments.length }))} ao mês`;
  }
  if (operation.frequency === "DAILY") return `${formatRate(operation.interestRateBps)} em ${operation.installments.length} dias`;
  if (operation.ledgerTerms.interestMode === "FIXED") return `${formatMoney(operation.periodInterestCents)} por quinzena (≈ ${formatRate(operation.interestRateBps)})`;
  return `${formatRate(operation.interestRateBps)} ${operation.frequency === "BIWEEKLY" ? "por quinzena" : "ao mês"}`;
}
const amortized = (operation: OperationView) => operation.modality === "INSTALLMENT" || operation.frequency === "DAILY";
function modalityLabel(operation: OperationView) {
  if (operation.modality === "INSTALLMENT") return `Parcelado em ${operation.installments.length}x de ${formatMoney(operation.installmentCents ?? 0)}`;
  if (operation.frequency === "DAILY") return `Pagamento único · Diário · ${operation.installments.length} pagamentos`;
  return `Pagamento único · ${frequencyLabels[operation.frequency]}`;
}

export function WalletSetup({ onSaved, cycleNumber = 1 }: { onSaved: () => void; cycleNumber?: number }) {
  const { pending, feedback, onSubmit } = useFormAction(saveWalletAction, onSaved);
  return (
    <section className="panel form-panel wallet-setup" aria-label="Configurar carteira">
      <div className="panel-header"><div><h2>{cycleNumber > 1 ? `Novo ciclo da carteira (ciclo ${cycleNumber})` : "Configure sua carteira"}</h2><p>{cycleNumber > 1 ? "A carteira foi zerada. Informe o capital inicial deste novo ciclo; os clientes cadastrados continuam disponíveis." : "Informe o capital inicial para o CrediAI calcular o capital disponível conforme as suas operações."}</p></div></div>
      <form className="form-grid form-grid-inline" onSubmit={onSubmit}>
        <label className="field"><span>Capital inicial (R$)</span><input name="initialCapital" inputMode="decimal" placeholder="20.000,00" required /></label>
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
          <label className="field"><span>Capital inicial (R$)</span><input name="initialCapital" inputMode="decimal" placeholder="20.000,00" defaultValue={summary.hasWallet ? (summary.initialCapitalCents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 }) : ""} required /></label>
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
          <li><strong>Capital disponível:</strong> capital inicial + aportes − retiradas − estornos de aporte − principal emprestado + pagamentos recebidos. Juros ainda não recebidos não contam. Aportes, retiradas e estornos são registrados em Capital.</li>
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
  const movementCount = portfolio.capitalLedger.filter((entry) => entry.kind === "CONTRIBUTION" || entry.kind === "WITHDRAWAL" || entry.kind === "CONTRIBUTION_REVERSAL").length;
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
                <div><dt>Aportes, retiradas e estornos</dt><dd>{movementCount}</dd></div>
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

// Campo com máscara (CPF, telefone, CEP) que guarda o valor digitado já formatado.
function MaskedInput({ name, mask, initial, ...props }: { name: string; mask: (value: string) => string; initial: string } & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "defaultValue">) {
  const [value, setValue] = useState(initial);
  return <input name={name} value={value} onChange={(event) => setValue(mask(event.target.value))} {...props} />;
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
  const initial = (part: AddressPart) => client?.[addressKey(kind, part)] ?? "";
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
      <input name={addressKey(kind, part)} value={values[part]} onChange={(event) => set(part, event.target.value)} maxLength={160} {...props} /></label>
  );
  return (
    <fieldset className="form-section field-wide">
      <legend>{addressKinds[kind]}</legend>
      <div className="form-grid">
        <label className="field"><span>CEP</span><input name={addressKey(kind, "Cep")} inputMode="numeric" placeholder="00000-000" value={values.Cep}
          onChange={(event) => { const masked = maskCep(event.target.value); set("Cep", masked); if (onlyDigits(masked).length === 8) void searchCep(masked); }} /></label>
        {field("Street", { placeholder: "Rua, avenida…" })}
        {field("Number", { placeholder: "123" })}
        {field("Complement", { placeholder: "Apto, sala (opcional)" })}
        {field("District")}
        {field("City")}
        <label className="field"><span>Estado</span><select name={addressKey(kind, "State")} value={values.State} onChange={(event) => set("State", event.target.value)}>
          <option value="">UF</option>{brazilianStates.map((state) => <option key={state} value={state}>{state}</option>)}</select></label>
        {lookup && <p className={`form-feedback field-wide ${lookup.tone === "error" ? "form-feedback-warning" : ""}`} role="status">{lookup.text}</p>}
      </div>
    </fieldset>
  );
}

// Formulário de cadastro e edição. CPF e telefone recebem máscara enquanto o usuário digita; o servidor grava só os dígitos.
function ClientForm({ editing, onChanged, onCancel }: { editing: ClientRow | null; onChanged: () => void; onCancel: () => void }) {
  // Troca a chave dos campos depois de cadastrar, para limpar também os campos com máscara e o endereço.
  const [resetKey, setResetKey] = useState(0);
  const { pending, feedback, onSubmit } = useFormAction(editing ? updateClientAction : createClientAction, () => {
    setResetKey((key) => key + 1);
    onChanged();
    if (editing) onCancel();
  });
  return (
    <section className="panel form-panel" aria-label={editing ? "Editar cliente" : "Novo cliente"}>
      <div className="panel-header"><div><h2>{editing ? `Editar ${editing.name}` : "Novo cliente"}</h2><p>Somente o nome é obrigatório.</p></div></div>
      <form className="form-grid" onSubmit={onSubmit} key={resetKey}>
        {editing && <input type="hidden" name="clientId" value={editing.id} />}
        <label className="field field-wide"><span>Nome completo</span><input name="name" placeholder="Nome completo" maxLength={120} defaultValue={editing?.name ?? ""} required /></label>
        <label className="field"><span>CPF</span><MaskedInput name="document" mask={maskCpf} initial={editing ? formatCpf(editing.document) ?? "" : ""} inputMode="numeric" placeholder="000.000.000-00" maxLength={40} /></label>
        <label className="field"><span>Telefone</span><MaskedInput name="phone" mask={maskPhone} initial={editing ? formatPhone(editing.phone) ?? "" : ""} inputMode="tel" placeholder="(11) 98765-4321" maxLength={40} /></label>
        <label className="field field-wide"><span>Observações</span><input name="notes" placeholder="Opcional" maxLength={500} defaultValue={editing?.notes ?? ""} /></label>
        <AddressFields kind="residential" client={editing} />
        <AddressFields kind="business" client={editing} />
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
            <label className="field"><span>{guarantorPartLabels.Document}</span><MaskedInput name="guarantorDocument" mask={maskCpf} initial={formatCpf(editing?.guarantorDocument ?? null) ?? ""} inputMode="numeric" placeholder="000.000.000-00" maxLength={40} /></label>
            <label className="field"><span>{guarantorPartLabels.Phone}</span><MaskedInput name="guarantorPhone" mask={maskPhone} initial={formatPhone(editing?.guarantorPhone ?? null) ?? ""} inputMode="tel" placeholder="(11) 98765-4321" maxLength={40} /></label>
            <label className="field field-wide"><span>{guarantorPartLabels.Notes}</span><input name="guarantorNotes" placeholder="Opcional" maxLength={500} defaultValue={editing?.guarantorNotes ?? ""} /></label>
            <p className="capital-note field-wide">O avalista fica no cadastro do cliente e aparece em todas as operações dele.</p>
          </div>
        </fieldset>
        <div className="form-actions">
          {editing && <button type="button" className="outline-button" onClick={onCancel}>Cancelar</button>}
          <button className="primary-button" disabled={pending}><Icon name={editing ? "check" : "plus"} size={16} /> {pending ? "Salvando…" : editing ? "Salvar alterações" : "Cadastrar cliente"}</button>
        </div>
      </form>
      <Feedback feedback={feedback} />
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

function OperationDetailsButton({ operation, today, onChanged }: { operation: OperationView; today: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="outline-button" onClick={() => setOpen(true)}>Detalhes</button>
      {open && <PaymentPanel operation={operation} today={today} onClose={() => setOpen(false)} onChanged={onChanged} />}
    </>
  );
}

// Frases de uma operação, como o cliente e a carteira enxergam: quanto emprestou, quanto já recebeu e quanto falta.
function operationPhrases(operation: OperationView) {
  const phrases = [`Emprestou ${formatMoney(operation.principalCents)} para ${operation.clientName} em ${formatDate(operation.loanDate)}.`];
  if (amortized(operation)) {
    phrases.push(`${modalityLabel(operation)} (taxa de ${rateLabel(operation)}, lucro previsto de ${formatMoney(operation.interestCents)}).`,
      `${operation.installments.filter((item) => item.state === "PAID").length} de ${plural(operation.installments.length, "parcela paga", "parcelas pagas")}.`);
  } else {
    phrases.push(`${modalityLabel(operation)}. Juros por período: ${formatMoney(operation.periodInterestCents)} (${rateLabel(operation)} sobre ${formatMoney(operation.principalRemainingCents || operation.principalCents)}).`);
  }
  phrases.push(`Já recebeu ${formatMoney(operation.interestPaidCents)} de juros (lucro realizado).`);
  const elapsed = formatElapsed(operation.loanDate, operation.elapsedUntil);
  if (operation.status === "PAID") {
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

const formatBytes = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(Math.round(bytes / 1024), 1)} KB` : `${(bytes / 1024 / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`);

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
function ClientProfilePanel({ client }: { client: ClientRow }) {
  const references = referenceSlots.map((slot) => ({
    slot, name: client[referenceKey(slot, "Name")], phone: formatPhone(client[referenceKey(slot, "Phone")]), relationship: client[referenceKey(slot, "Relationship")],
  }));
  const guarantor = [client.guarantorName, formatCpf(client.guarantorDocument) && `CPF ${formatCpf(client.guarantorDocument)}`, formatPhone(client.guarantorPhone), client.guarantorNotes].filter(Boolean).join(" · ");
  return (
    <section className="panel form-panel" aria-label={`Cadastro de ${client.name}`}>
      <div className="panel-header"><div><h2>Cadastro</h2><p>Use &quot;Editar&quot; na lista de clientes para alterar estes dados.</p></div></div>
      <dl className="payment-summary profile-summary">
        <div><dt>CPF</dt><dd>{formatCpf(client.document) ?? "—"}</dd></div>
        <div><dt>Telefone</dt><dd>{formatPhone(client.phone) ?? "—"}</dd></div>
        {(Object.keys(addressKinds) as AddressKind[]).map((kind) => <div key={kind}><dt>{addressKinds[kind]}</dt><dd>{formatAddress(client, kind) ?? "Não informado"}</dd></div>)}
        {references.map((reference) => (
          <div key={reference.slot}><dt>Referência {reference.slot}</dt><dd>{reference.name ? [reference.name, reference.relationship, reference.phone].filter(Boolean).join(" · ") : "Não informada"}</dd></div>
        ))}
        <div><dt>Avalista</dt><dd>{guarantor || "Não informado"}</dd></div>
        {client.notes && <div><dt>Observações</dt><dd>{client.notes}</dd></div>}
      </dl>
    </section>
  );
}

// Página do cliente: cadastro, documentos, resumo financeiro e cada operação separada. Valores só do ciclo atual da carteira.
function ClientDetail({ client, portfolio, onBack, onChanged }: { client: ClientRow; portfolio: TenantPortfolio; onBack: () => void; onChanged: () => void }) {
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
          <div className="table-scroll"><table className="data-table">
            <thead><tr><th>Operação</th><th>Data</th><th>Vencimento</th><th>Principal</th><th>Juros</th><th>Total original</th><th>Recebido</th><th>Juros recebidos</th><th>Principal recebido</th><th>Saldo</th><th>Pagamentos</th><th>Tempo</th><th>Situação</th><th /></tr></thead>
            <tbody>{operations.map((operation) => (
              <tr key={operation.id}>
                <td><strong>#{operation.code}</strong></td><td>{formatDate(operation.loanDate)}</td><td>{formatDate(operation.nextDueDate)}</td><td>{formatMoney(operation.principalCents)}</td><td>{formatMoney(operation.interestCents)}{operation.renewalCount > 0 && <small>{plural(operation.renewalCount, "renovação", "renovações")}</small>}</td>
                <td>{formatMoney(operation.originalTotalCents)}</td><td>{formatMoney(operation.paidCents)}</td><td>{formatMoney(operation.interestPaidCents)}</td><td>{formatMoney(operation.principalPaidCents)}</td>
                <td><strong>{formatMoney(operation.balanceCents)}</strong></td><td>{operation.payments.length}</td><td>{operationAge(operation)}</td>
                <td><StatusChip state={operation.state} daysUntilDue={operation.daysUntilDue} /></td>
                <td className="actions-cell"><OperationDetailsButton operation={operation} today={portfolio.today} onChanged={onChanged} /></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      <ClientProfilePanel client={client} />
      <ClientDocuments client={client} onChanged={onChanged} />
    </div>
  );
}

export function ClientsPage({ portfolio, onChanged, onNewOperation }: { portfolio: TenantPortfolio; onChanged: () => void; onNewOperation: () => void }) {
  const [editing, setEditing] = useState<ClientRow | null>(null);
  const [deleting, setDeleting] = useState<ClientRow | null>(null);
  const [viewingId, setViewingId] = useState<string | null>(null);
  // Busca o cliente de novo a cada atualização para que a página mostre os valores mais recentes.
  const viewing = portfolio.clients.find((client) => client.id === viewingId);
  if (viewing) return <ClientDetail client={viewing} portfolio={portfolio} onBack={() => setViewingId(null)} onChanged={onChanged} />;
  return (
    <div className="workspace-page">
      <PageHeading eyebrow="CREDIAI · CLIENTES" title="Clientes" description="Cadastre os clientes da sua carteira para vincular operações.">
        <button className="primary-button" onClick={onNewOperation}><Icon name="plus" size={17} /> Nova operação</button>
      </PageHeading>
      <ClientForm key={editing?.id ?? "new"} editing={editing} onChanged={onChanged} onCancel={() => setEditing(null)} />
      <section className="panel table-panel" aria-label="Lista de clientes">
        <div className="panel-header"><div><div className="panel-title-row"><h2>Clientes da carteira</h2><span className="today-count">{portfolio.clients.length}</span></div></div></div>
        {portfolio.clients.length === 0 ? <EmptyPanel icon="users" text="Nenhum cliente cadastrado ainda." /> : (
          <div className="table-scroll"><table className="data-table">
            <thead><tr><th>Nome</th><th>CPF</th><th>Telefone</th><th>Operações</th><th>Emprestado</th><th>Juros recebidos</th><th>Saldo</th><th /></tr></thead>
            <tbody>{portfolio.clients.map((client) => <tr key={client.id}><td><button className="text-link client-link" onClick={() => { setViewingId(client.id); window.scrollTo({ top: 0 }); }}><strong>{client.name}</strong></button>{client.notes && <small>{client.notes}</small>}</td><td>{formatCpf(client.document) ?? "—"}</td><td>{formatPhone(client.phone) ?? "—"}</td><td>{client.operationCount}</td><td>{formatMoney(client.profile.principalCents)}</td><td>{formatMoney(client.profile.interestPaidCents)}</td><td>{formatMoney(client.profile.balanceCents)}</td><td className="actions-cell"><span className="row-actions"><button className="outline-button" onClick={() => { setViewingId(client.id); window.scrollTo({ top: 0 }); }}>Ver</button><button className="outline-button" onClick={() => { setEditing(client); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Editar</button><button className="outline-button danger-outline" onClick={() => setDeleting(client)}>Excluir</button></span></td></tr>)}</tbody>
          </table></div>
        )}
        {portfolio.archivedClients.length > 0 && <p className="capital-note">Arquivados ({portfolio.archivedClients.length}): {portfolio.archivedClients.map((client) => client.name).join(", ")}. O histórico deles continua em Operações e Pagamentos.</p>}
      </section>
      {deleting && <DeleteClientDialog client={deleting} onClose={() => setDeleting(null)} onChanged={() => { if (editing?.id === deleting.id) setEditing(null); onChanged(); }} />}
    </div>
  );
}

// Nova operação. Pagamento único com periodicidade mensal, quinzenal (juros recorrentes, renovação pagando só os juros)
// ou diária (total dividido em pagamentos diários); ou parcelado (valor emprestado, parcela fixa, primeiro vencimento e
// prazo). A prévia usa as mesmas funções de rules.ts que o servidor usa ao gravar.
function OperationForm({ portfolio, onChanged, onNewClient }: { portfolio: TenantPortfolio; onChanged: () => void; onNewClient: () => void }) {
  const [modality, setModality] = useState<"SINGLE" | "INSTALLMENT">("SINGLE");
  const [frequency, setFrequency] = useState<Frequency>("MONTHLY");
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
  const { pending, feedback, onSubmit } = useFormAction(createOperationAction, () => {
    setPrincipal(""); setRate(""); setLoanAmount(""); setInstallment(""); setTerm(""); setDays(""); setDueDate(""); setInterestAmount(""); setFirstDue(addDays(portfolio.today, 1)); setLoanDate(portfolio.today); setResetKey((key) => key + 1); onChanged();
  });
  const single = modality === "SINGLE";
  const daily = single && frequency === "DAILY";
  const principalCents = parseMoneyToCents(single ? principal : loanAmount);
  const rateBps = parseRateToBps(rate);
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
  const installmentPreview = !single && principalCents !== null && installmentCents !== null && count !== null && count >= 1 ? calculateInstallments({ principalCents, installmentCents, count }) : null;
  const preview = recurringPreview ?? dailyPreview ?? installmentPreview;
  const availableAfterCents = portfolio.summary.availableCents - (principalCents ?? 0);
  const exceeds = principalCents !== null && principalCents > portfolio.summary.availableCents;
  const installmentsBelowValue = !single && preview !== null && preview.interestCents < 0;
  // Próximos vencimentos do mensal/quinzenal (renovando pagando só os juros) e do parcelado.
  const upcoming = validDue ? dueDates(single ? frequency : "MONTHLY", dueDate, single ? 3 : Math.min(count ?? 1, 360)) : [];
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
    ["Periodicidade", "Mensal (parcelas fixas)"], ["Quantidade de pagamentos", String(count)], ["Valor de cada pagamento", formatMoney(installmentCents ?? 0)],
    ["Primeiro vencimento", upcoming[0] ? formatDate(upcoming[0]) : "—"], ["Último vencimento", upcoming.length ? formatDate(upcoming[upcoming.length - 1]) : "—"],
    ["Juros totais", formatMoney(installmentPreview.interestCents)], ["Taxa de juros (simples)", `${percent(installmentPreview.monthlyRate)} ao mês`],
  ] : [];

  if (portfolio.clients.length === 0) {
    return <section className="panel form-panel"><EmptyPanel icon="users" text="Cadastre um cliente antes de criar a primeira operação." action={<button className="primary-button" onClick={onNewClient}><Icon name="plus" size={16} /> Cadastrar cliente</button>} /></section>;
  }
  const description = !single ? "Parcelas fixas mensais. O sistema calcula total, lucro e a taxa simples ao mês."
    : daily ? "O total (principal + juros do período) é dividido em um pagamento por dia; cada pagamento leva principal e juros."
    : `Juros ${frequency === "BIWEEKLY" ? "a cada quinzena (dois vencimentos por mês)" : "a cada mês"} sobre o principal em aberto. Pagando só os juros, o período é renovado.`;

  return (
    <section className="panel form-panel" aria-label="Nova operação">
      <div className="panel-header"><div><h2>Nova operação</h2><p>{description}</p></div></div>
      <div className="modality-switch" role="radiogroup" aria-label="Modalidade">
        <button type="button" role="radio" aria-checked={single} className={single ? "is-active" : ""} onClick={() => setModality("SINGLE")}>Pagamento único</button>
        <button type="button" role="radio" aria-checked={!single} className={!single ? "is-active" : ""} onClick={() => setModality("INSTALLMENT")}>Parcelado</button>
      </div>
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
        {single && <input type="hidden" name="frequency" value={frequency} />}
        {fixed && <input type="hidden" name="interestMode" value="FIXED" />}
        <label className="field field-wide"><span>Cliente</span><select name="clientId" required defaultValue=""><option value="" disabled>Selecione o cliente</option>{portfolio.clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label>
        {single ? (
          <>
            <label className="field"><span>Valor principal (R$)</span><input name="principal" inputMode="decimal" placeholder={frequency === "BIWEEKLY" ? "8.000,00" : daily ? "10.000,00" : "1.000,00"} value={principal} onChange={(event) => setPrincipal(event.target.value)} required /></label>
            {fixed
              ? <label className="field"><span>Juros por quinzena (R$)</span><input name="interestAmount" inputMode="decimal" placeholder="1.200,00" value={interestAmount} onChange={(event) => setInterestAmount(event.target.value)} required /></label>
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
            <label className="field"><span>Valor emprestado (R$)</span><input name="loanAmount" inputMode="decimal" placeholder="10.000,00" value={loanAmount} onChange={(event) => setLoanAmount(event.target.value)} required /></label>
            <label className="field"><span>Valor de cada parcela (R$)</span><input name="installment" inputMode="decimal" placeholder="1.200,00" value={installment} onChange={(event) => setInstallment(event.target.value)} required /></label>
            <label className="field"><span>Prazo total (meses)</span><input name="term" inputMode="numeric" placeholder="10" value={term} onChange={(event) => setTerm(event.target.value.replace(/\D/g, "").slice(0, 3))} required /></label>
            <DateField label="Data do empréstimo" name="loanDate" defaultValue={loanDate} onChange={setLoanDate} required />
            <DateField label="Primeiro vencimento" name="firstDueDate" defaultValue={dueDate} onChange={setDueDate} required />
          </>
        )}
        <div className="operation-preview" aria-live="polite" aria-label="Prévia da operação">
          <div><span>Principal</span><strong>{principalCents !== null ? formatMoney(principalCents) : "—"}</strong></div>
          <div><span>{single ? "Juros" : "Lucro"}</span><strong>{preview && preview.interestCents >= 0 ? formatMoney(preview.interestCents) : "—"}</strong></div>
          <div><span>Total a receber</span><strong>{preview ? formatMoney(preview.totalCents) : "—"}</strong></div>
          {rows.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
          <div><span>Capital disponível após</span><strong>{formatMoney(Math.max(availableAfterCents, 0))}</strong><small>Hoje: {formatMoney(portfolio.summary.availableCents)}</small></div>
        </div>
        {installmentsBelowValue && <p className="form-feedback form-feedback-warning field-wide">As parcelas somam menos que o valor emprestado.</p>}
        {exceeds && <p className="form-feedback form-feedback-warning">O valor é maior que o capital disponível da carteira ({formatMoney(Math.max(portfolio.summary.availableCents, 0))}).</p>}
        <div className="form-actions"><button className="primary-button" disabled={pending}><Icon name="plus" size={16} /> {pending ? "Salvando…" : "Cadastrar operação"}</button></div>
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
      <DateField label="Data do pagamento" name="paidAt" defaultValue={payment.paidAt} min={operation.loanDate} required />
      <label className="field"><span>Valor pago (R$)</span><input name="amount" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} required autoFocus /></label>
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

function PaymentPanel({ operation, today, onClose, onChanged }: { operation: OperationView; today: string; onClose: () => void; onChanged: () => void }) {
  const [amount, setAmount] = useState("");
  const { pending, feedback, onSubmit } = useFormAction(registerPaymentAction, () => { setAmount(""); onChanged(); });
  const isOpen = operation.status === "OPEN";
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="payment-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="panel form-panel payment-panel" role="dialog" aria-modal="true" aria-label={`Pagamentos de ${operation.clientName}`}>
        <div className="panel-header">
          <div><h2>{operation.clientName} — #{operation.code}</h2><p>{modalityLabel(operation)} · {next ? `Parcela ${next.number}/${operation.installments.length} vence` : recurringOp && operation.periodNumber > 1 ? `${operation.periodNumber}º período vence` : "Vencimento"} {formatDate(operation.nextDueDate)} · <StatusChip state={operation.state} daysUntilDue={operation.daysUntilDue} /></p></div>
          <button type="button" className="more-button" aria-label="Fechar" onClick={onClose}><Icon name="close" size={18} /></button>
        </div>
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
              <div><dt>Parcelas pagas</dt><dd>{operation.installments.filter((item) => item.state === "PAID").length} de {operation.installments.length}</dd></div>
              <div><dt>Taxa de juros</dt><dd>{rateLabel(operation)}</dd></div>
              <div><dt>Próxima parcela</dt><dd>{next ? `${next.number}ª · ${formatMoney(next.remainingCents)} em ${formatDate(next.dueDate)}` : "—"}</dd></div>
            </>
          )}
          <div><dt>{operation.status === "PAID" ? "Duração" : "Operação ativa"}</dt><dd>{operationAge(operation)}</dd></div>
          <div><dt>Pagamentos realizados</dt><dd>{operation.payments.length}</dd></div>
          <div><dt>Meses com pagamento</dt><dd>{operation.paymentMonths}</dd></div>
        </dl>
        {isOpen && (
          <form className="form-grid" onSubmit={onSubmit}>
            <input type="hidden" name="operationId" value={operation.id} />
            <DateField label="Data do pagamento" name="paidAt" defaultValue={today} min={operation.loanDate} required />
            <label className="field"><span>Valor recebido (R$)</span><input name="amount" inputMode="decimal" placeholder={centsToInput(operation.balanceCents)} value={amount} onChange={(event) => setAmount(event.target.value)} required autoFocus /></label>
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
            <div className="form-actions"><button className="primary-button" disabled={pending || (check !== null && !check.ok)}><Icon name="check" size={16} /> {pending ? "Registrando…" : "Registrar pagamento"}</button></div>
          </form>
        )}
        <Feedback feedback={feedback} />
        {!recurringOp && (
          <div className="table-scroll installment-table">
            <table className="data-table" aria-label="Parcelas">
              <thead><tr><th>Parcela</th><th>Vencimento</th><th>Valor</th><th>Pago</th><th>Situação</th></tr></thead>
              <tbody>{operation.installments.map((item) => (
                <tr key={item.number}>
                  <td>{item.number}/{operation.installments.length}</td><td>{formatDate(item.dueDate)}</td><td>{formatMoney(item.amountCents)}</td><td>{formatMoney(item.paidCents)}</td>
                  <td>{item.state === "PAID" ? "Paga" : item.dueDate < today ? (item.state === "PARTIAL" ? "Parcial, em atraso" : "Em atraso") : item.state === "PARTIAL" ? "Parcial" : "Em aberto"}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        <div className="payment-history">
          <h3>Histórico de pagamentos</h3>
          {operation.payments.length === 0 ? <p className="muted-cell">Nenhum pagamento registrado.</p> : (
            <ul>{operation.payments.map((payment) => (
              <li key={payment.id}>
                <span>{formatDate(payment.paidAt)}</span><strong>{formatMoney(payment.amountCents)}</strong><span className={`status-chip ${payment.kind === "SETTLEMENT" ? "status-paid" : payment.kind === "RENEWAL" ? "status-renewal" : "status-active"}`}><i />{paymentKindLabels[payment.kind]}</span>
                {operation.status !== "CANCELED" && editingId !== payment.id && <button type="button" className="outline-button payment-edit-button" onClick={() => setEditingId(payment.id)}>Editar pagamento</button>}
                <small>Juros {formatMoney(payment.interestCents)} · Principal {formatMoney(payment.principalCents)}{renewalNote(payment)}{payment.notes ? ` · ${payment.notes}` : ""}</small>
                {(payment.revisions ?? []).map((revision) => <small key={revision.id} className="payment-revision">Corrigido em {formatDateTime(revision.editedAt)}{revision.editedBy ? ` por ${revision.editedBy}` : ""}: antes {formatMoney(revision.previousAmountCents)} em {formatDate(revision.previousPaidAt)}, depois {formatMoney(revision.amountCents)} em {formatDate(revision.paidAt)}.</small>)}
                {editingId === payment.id && <EditPaymentForm operation={operation} payment={payment} today={today} onClose={() => setEditingId(null)} onChanged={onChanged} />}
              </li>
            ))}</ul>
          )}
        </div>
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
            <><p>Sem pagamentos registrados. A operação deixa de aparecer em Operações, Cobranças e no Dashboard e sai de Capital emprestado, Total a receber e Juros previstos.</p>
              <p>Os <strong>{formatMoney(operation.principalCents)}</strong> voltam para o capital disponível. O histórico do capital registra a exclusão. O cliente continua cadastrado.</p></>
          )}
        </ConfirmDialog>
      )}
    </>
  );
}

function OperationsTable({ operations, today, onChanged }: { operations: OperationView[]; today: string; onChanged: () => void }) {
  return (
    <div className="table-scroll"><table className="data-table">
      <thead><tr><th>Operação</th><th>Cliente</th><th>Principal</th><th>Taxa</th><th>Juros</th><th>Total</th><th>Recebido</th><th>Saldo</th><th>Empréstimo</th><th>Vencimento</th><th>Situação</th><th /></tr></thead>
      <tbody>{operations.map((operation) => (
        <tr key={operation.id}>
          <td><strong>#{operation.code}</strong></td><td>{operation.clientName}</td><td>{formatMoney(operation.principalCents)}</td><td>{rateLabel(operation)}<small>{operation.modality === "INSTALLMENT" ? "Parcelado" : frequencyLabels[operation.frequency]}</small></td>
          <td>{formatMoney(operation.interestCents)}</td><td>{formatMoney(operation.totalCents)}</td><td>{formatMoney(operation.paidCents)}</td><td><strong>{formatMoney(operation.balanceCents)}</strong></td>
          <td>{formatDate(operation.loanDate)}<small>{operationAge(operation)}</small></td><td>{formatDate(operation.nextDueDate)}{operation.nextInstallment && <small>Parcela {operation.nextInstallment.number}/{operation.installments.length}</small>}{operation.renewalCount > 0 && <small>{plural(operation.renewalCount, "renovação", "renovações")}</small>}</td>
          <td><StatusChip state={operation.state} daysUntilDue={operation.daysUntilDue} /></td><td className="actions-cell"><span className="row-actions"><PaymentButton operation={operation} today={today} onChanged={onChanged} /><DeleteOperationButton operation={operation} onChanged={onChanged} /></span></td>
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
  const total = lent ? portfolio.summary.lentCents : portfolio.summary.expectedInterestCents;
  return (
    <section className="panel table-panel focus-panel" aria-label={lent ? "Composição do capital emprestado" : "Composição dos juros previstos"}>
      <div className="panel-header">
        <div><div className="panel-title-row"><h2>{lent ? "Capital emprestado" : "Juros previstos"}: {formatMoney(total)}</h2></div>
          <p><strong>Este valor vem destas operações.</strong> {lent ? "Principal que ainda não voltou para a carteira, nas operações em aberto abaixo." : "Juros que ainda faltam receber nas operações em aberto abaixo. Juros já recebidos não entram aqui."}</p></div>
        <button className="outline-button" onClick={onClear}>Ver todas as operações</button>
      </div>
      {rows.length === 0 ? <EmptyPanel icon="wallet" text={lent ? "Nenhum capital emprestado no momento." : "Nenhum juro previsto no momento."} /> : (
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

export function OperationsPage({ portfolio, onChanged, onNewClient, focus = null, onClearFocus }: { portfolio: TenantPortfolio; onChanged: () => void; onNewClient: () => void; focus?: OperationsFocus; onClearFocus?: () => void }) {
  const ids = focus ? new Set(portfolio.operations.filter((operation) => operation.status === "OPEN" && (focus === "lent" ? operation.principalRemainingCents > 0 : operation.interestRemainingCents > 0)).map((operation) => operation.id)) : null;
  const operations = ids ? portfolio.operations.filter((operation) => ids.has(operation.id)) : portfolio.operations;
  return (
    <div className="workspace-page">
      <PageHeading eyebrow="CREDIAI · OPERAÇÕES" title="Operações" description="Cadastre e acompanhe os empréstimos da sua carteira." />
      {focus ? <FocusPanel focus={focus} portfolio={portfolio} onClear={() => onClearFocus?.()} /> : <OperationForm portfolio={portfolio} onChanged={onChanged} onNewClient={onNewClient} />}
      <section className="panel table-panel" aria-label="Lista de operações">
        <div className="panel-header"><div><div className="panel-title-row"><h2>{focus ? "Operações que compõem este valor" : "Operações da carteira"}</h2><span className="today-count">{operations.length}</span></div><p>Ativas: {portfolio.summary.counts.active} · Quitadas: {portfolio.summary.counts.paid} · Em atraso: {portfolio.summary.counts.overdue}</p></div></div>
        {operations.length === 0 ? <EmptyPanel icon="wallet" text={focus ? "Nenhuma operação em aberto." : "Nenhuma operação cadastrada ainda."} /> : <OperationsTable operations={operations} today={portfolio.today} onChanged={onChanged} />}
      </section>
    </div>
  );
}

export function CapitalPage({ portfolio, onChanged }: { portfolio: TenantPortfolio; onChanged: () => void }) {
  const contribution = useFormAction(registerContributionAction, onChanged);
  const withdrawal = useFormAction(registerWithdrawalAction, onChanged);
  const initial = useFormAction(saveWalletAction, onChanged);
  const [reversing, setReversing] = useState<TenantPortfolio["capitalLedger"][number] | null>(null);
  const { summary } = portfolio;
  return (
    <div className="workspace-page">
      <PageHeading eyebrow="CREDIAI · CAPITAL" title="Capital da carteira" description={`De onde vem o seu capital disponível: capital inicial, aportes, retiradas, empréstimos feitos e valores recebidos.${summary.cycleNumber > 1 ? ` Ciclo ${summary.cycleNumber} da carteira; ciclos anteriores ficam em Configurações.` : ""}`} />
      <section className="panel form-panel" aria-label="Resumo do capital">
        <div className="panel-header"><div><div className="panel-title-row"><h2>Capital disponível: {formatMoney(summary.availableCents)}</h2><span className="status-chip status-active"><i />Ciclo atual: {summary.cycleNumber}</span></div><p>Capital inicial + aportes − estornos − retiradas − capital usado em operações + valores recebidos. Juros ainda não recebidos não contam.</p></div></div>
        <dl className="payment-summary">
          <div><dt>Capital inicial</dt><dd>{formatMoney(summary.initialCapitalCents)}</dd></div>
          <div><dt>Aportes</dt><dd>+ {formatMoney(summary.grossContributionsCents)}</dd></div>
          {summary.reversalsCents > 0 && <div><dt>Estornos de aporte</dt><dd>− {formatMoney(summary.reversalsCents)}</dd></div>}
          <div><dt>Retiradas</dt><dd>− {formatMoney(summary.withdrawalsCents)}</dd></div>
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
            <label className="field"><span>Capital inicial (R$)</span><input name="initialCapital" inputMode="decimal" placeholder="20.000,00" required /></label>
            <button className="primary-button" disabled={initial.pending}><Icon name="check" size={16} /> {initial.pending ? "Salvando…" : "Salvar capital inicial"}</button>
          </form>
          <Feedback feedback={initial.feedback} />
        </section>
      ) : (
        <section className="panel form-panel" aria-label="Registrar aporte">
          <div className="panel-header"><div><h2>Registrar aporte</h2><p>Dinheiro novo colocado na carteira. Entra no capital disponível na hora.</p></div></div>
          <form className="form-grid" onSubmit={contribution.onSubmit}>
            <label className="field"><span>Valor do aporte (R$)</span><input name="amount" inputMode="decimal" placeholder="2.000,00" required /></label>
            <label className="field"><span>Data do aporte</span><input name="occurredAt" type="date" defaultValue={portfolio.today} max={portfolio.today} required /></label>
            <label className="field field-wide"><span>Observação</span><input name="notes" placeholder="Opcional" maxLength={500} /></label>
            <div className="form-actions"><button className="primary-button" disabled={contribution.pending}><Icon name="plus" size={16} /> {contribution.pending ? "Registrando…" : "Registrar aporte"}</button></div>
          </form>
          <Feedback feedback={contribution.feedback} />
        </section>
      )}
      {summary.hasWallet && (
        <section className="panel form-panel" aria-label="Registrar retirada">
          <div className="panel-header"><div><h2>Registrar retirada</h2><p>Dinheiro tirado da carteira. Limitado ao capital disponível de {formatMoney(Math.max(summary.availableCents, 0))}.</p></div></div>
          <form className="form-grid" onSubmit={withdrawal.onSubmit}>
            <label className="field"><span>Valor da retirada (R$)</span><input name="amount" inputMode="decimal" placeholder="2.000,00" required /></label>
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
                <td><span className={`status-chip ${entry.amountCents < 0 ? "status-due" : entry.kind === "PAYMENT" ? "status-paid" : "status-active"}`}><i />{capitalLedgerLabels[entry.kind]}</span></td>
                <td>{entry.description}</td>
                <td><strong>{entry.amountCents < 0 ? "− " : "+ "}{formatMoney(Math.abs(entry.amountCents))}</strong></td>
                <td>{formatMoney(entry.balanceCents)}</td>
                <td className="actions-cell">{entry.kind === "CONTRIBUTION" && (entry.reversed ? <span className="status-chip status-muted"><i />Estornado</span> : <button className="outline-button danger-outline" onClick={() => setReversing(entry)}>Estornar aporte</button>)}</td>
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
export function ReportsPage({ portfolio }: { portfolio: TenantPortfolio }) {
  const { profitability } = portfolio;
  const activeClients = portfolio.clients.filter((client) => client.profile.openCount > 0).length;
  const rows = portfolio.clients.filter((client) => client.profile.operationCount > 0);
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
        <div className="panel-header"><div><div className="panel-title-row"><h2>Por cliente</h2><span className="today-count">{rows.length}</span></div><p>Abra o cliente em Clientes para ver cada operação.</p></div></div>
        {rows.length === 0 ? <EmptyPanel icon="chart" text="Nenhuma operação no ciclo atual." /> : (
          <div className="table-scroll"><table className="data-table">
            <thead><tr><th>Cliente</th><th>Operações</th><th>Principal emprestado</th><th>Principal recuperado</th><th>Juros recebidos</th><th>Juros previstos</th><th>Saldo</th><th>Pagamentos</th></tr></thead>
            <tbody>{rows.map((client) => (
              <tr key={client.id}><td><strong>{client.name}</strong></td><td>{client.profile.operationCount}</td><td>{formatMoney(client.profile.principalCents)}</td><td>{formatMoney(client.profile.principalPaidCents)}</td><td>{formatMoney(client.profile.interestPaidCents)}</td><td>{formatMoney(client.profile.interestRemainingCents)}</td><td><strong>{formatMoney(client.profile.balanceCents)}</strong></td><td>{client.profile.paymentCount}</td></tr>
            ))}</tbody>
            <tfoot><tr><td><strong>Total</strong></td><td>{profitability.operationCount}</td><td>{formatMoney(profitability.principalCents)}</td><td>{formatMoney(profitability.principalPaidCents)}</td><td>{formatMoney(profitability.interestPaidCents)}</td><td>{formatMoney(profitability.interestRemainingCents)}</td><td><strong>{formatMoney(profitability.balanceCents)}</strong></td><td>{profitability.paymentCount}</td></tr></tfoot>
          </table></div>
        )}
      </section>
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

export function ChargesPage({ portfolio, onChanged, initialFilter = "Em aberto" }: { portfolio: TenantPortfolio; onChanged: () => void; initialFilter?: ChargesView }) {
  const filters: ChargesView[] = ["Em aberto", "Em atraso", "Hoje", "Amanhã", "Próximas"];
  const [filter, setFilter] = useState<ChargesView>(initialFilter);
  const open = portfolio.operations.filter((operation) => operation.status === "OPEN");
  const countOf = (item: ChargesView) => (item === "Em aberto" ? open.length : portfolio.charges[item].length);
  const ids = new Set(filter === "Em aberto" ? open.map((operation) => operation.id) : portfolio.charges[filter].map((charge) => charge.operationId));
  const operations = portfolio.operations.filter((operation) => ids.has(operation.id)).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const balance = operations.reduce((total, operation) => total + operation.balanceCents, 0);
  return (
    <div className="workspace-page">
      <PageHeading eyebrow="CREDIAI · COBRANÇAS" title="Cobranças" description="Operações em aberto por vencimento. Registre cada pagamento quando receber." />
      <section className="panel table-panel">
        <div className="panel-header"><div><div className="panel-title-row"><h2>{filter === "Em aberto" ? `Total a receber: ${formatMoney(portfolio.summary.receivableCents)}` : `${filter}: ${formatMoney(balance)}`}</h2></div><p>{filter === "Em aberto" ? "Principal + juros ainda não recebidos de todas as operações em aberto." : "Saldo em aberto das operações deste filtro."}</p></div></div>
        <div className="charge-tabs" role="tablist" aria-label="Filtro de cobranças">{filters.map((item) => <button key={item} role="tab" aria-selected={filter === item} className={filter === item ? "charge-tab-active" : ""} onClick={() => setFilter(item)}>{item} ({countOf(item)})</button>)}</div>
        {operations.length === 0 ? <EmptyPanel icon="calendar" text={filter === "Em aberto" ? "Nenhuma operação em aberto." : "Nenhuma cobrança neste filtro."} /> : <OperationsTable operations={operations} today={portfolio.today} onChanged={onChanged} />}
      </section>
    </div>
  );
}
