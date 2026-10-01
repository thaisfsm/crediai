"use client";

import { useEffect, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { cancelOperationAction, createClientAction, createOperationAction, deleteClientAction, registerContributionAction, registerPaymentAction, registerWithdrawalAction, resetWalletAction, reverseContributionAction, saveWalletAction, updateClientAction, type ActionResult } from "./actions";
import { Icon, type IconName } from "./ui-icon";
import { centsToInput, formatCpf, formatDate, formatElapsed, formatMoney, formatPhone, formatRate, maskCpf, maskPhone, parseMoneyToCents, parseRateToBps } from "@/lib/finance/format";
import { capitalLedgerLabels, type ChargeFilter, type OperationsSummary, type OperationView } from "@/lib/finance/portfolio";
import type { TenantPortfolio } from "@/lib/finance/queries";
import { allocatePayments, calculateOperation, calculationRuleLabels, checkPayment, paymentKindLabels } from "@/lib/finance/rules";

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
          <li><strong>Juros:</strong> taxa informada aplicada uma vez sobre o principal da operação.</li>
          <li><strong>Total a receber:</strong> principal + juros, com vencimento na data informada.</li>
          <li><strong>Pagamentos:</strong> a operação aceita vários pagamentos. Cada valor recebido quita primeiro os juros pendentes e depois o principal. Pagar o saldo inteiro quita a operação; valores acima do saldo são bloqueados.</li>
          <li><strong>Capital disponível:</strong> capital inicial + aportes − retiradas − estornos de aporte − principal emprestado + pagamentos recebidos. Juros ainda não recebidos não contam. Aportes, retiradas e estornos são registrados em Capital.</li>
          <li><strong>Exclusões:</strong> operação sem pagamento pode ser excluída e devolve o principal ao capital; com pagamento fica bloqueada. Cliente sem operações é excluído; com histórico é arquivado.</li>
          <li><strong>Em atraso:</strong> operação em aberto com vencimento anterior a hoje. Multa e juros de mora ainda não são aplicados.</li>
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

// Formulário de cadastro e edição. CPF e telefone recebem máscara enquanto o usuário digita; o servidor grava só os dígitos.
function ClientForm({ editing, onChanged, onCancel }: { editing: ClientRow | null; onChanged: () => void; onCancel: () => void }) {
  const [documentValue, setDocumentValue] = useState(editing ? formatCpf(editing.document) ?? "" : "");
  const [phoneValue, setPhoneValue] = useState(editing ? formatPhone(editing.phone) ?? "" : "");
  const { pending, feedback, onSubmit } = useFormAction(editing ? updateClientAction : createClientAction, () => {
    setDocumentValue("");
    setPhoneValue("");
    onChanged();
    if (editing) onCancel();
  });
  return (
    <section className="panel form-panel" aria-label={editing ? "Editar cliente" : "Novo cliente"}>
      <div className="panel-header"><div><h2>{editing ? `Editar ${editing.name}` : "Novo cliente"}</h2><p>Somente o nome é obrigatório.</p></div></div>
      <form className="form-grid" onSubmit={onSubmit}>
        {editing && <input type="hidden" name="clientId" value={editing.id} />}
        <label className="field field-wide"><span>Nome</span><input name="name" placeholder="Nome completo" maxLength={120} defaultValue={editing?.name ?? ""} required /></label>
        <label className="field"><span>CPF</span><input name="document" inputMode="numeric" placeholder="000.000.000-00" maxLength={40} value={documentValue} onChange={(event) => setDocumentValue(maskCpf(event.target.value))} /></label>
        <label className="field"><span>Telefone</span><input name="phone" inputMode="tel" placeholder="(11) 98765-4321" maxLength={40} value={phoneValue} onChange={(event) => setPhoneValue(maskPhone(event.target.value))} /></label>
        <label className="field field-wide"><span>Observações</span><input name="notes" placeholder="Opcional" maxLength={500} defaultValue={editing?.notes ?? ""} /></label>
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
function ProfitabilitySummary({ profile }: { profile: OperationsSummary }) {
  return (
    <dl className="payment-summary">
      <div><dt>Principal emprestado</dt><dd>{formatMoney(profile.principalCents)}</dd></div>
      <div><dt>Juros contratados</dt><dd>{formatMoney(profile.interestCents)}</dd></div>
      <div><dt>Total originalmente previsto</dt><dd>{formatMoney(profile.totalCents)}</dd></div>
      <div><dt>Total recebido</dt><dd>{formatMoney(profile.paidCents)}</dd></div>
      <div><dt>Juros recebidos (lucro realizado)</dt><dd>{formatMoney(profile.interestPaidCents)}</dd></div>
      <div><dt>Principal recuperado</dt><dd>{formatMoney(profile.principalPaidCents)}</dd></div>
      <div><dt>Saldo de principal</dt><dd>{formatMoney(profile.principalRemainingCents)}</dd></div>
      <div><dt>Saldo de juros (lucro previsto)</dt><dd>{formatMoney(profile.interestRemainingCents)}</dd></div>
      <div className="payment-balance"><dt>Saldo total</dt><dd>{formatMoney(profile.balanceCents)}</dd></div>
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

// Página do cliente: resumo geral e, abaixo, cada operação separada. Valores só do ciclo atual da carteira.
function ClientDetail({ client, portfolio, onBack, onChanged }: { client: ClientRow; portfolio: TenantPortfolio; onBack: () => void; onChanged: () => void }) {
  const profile = client.profile;
  const operations = portfolio.operations.filter((operation) => operation.clientId === client.id);
  const situation = clientSituation(profile);
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
        <ProfitabilitySummary profile={profile} />
        <dl className="payment-summary">
          <div><dt>Operações</dt><dd>{profile.operationCount} ({profile.openCount} em aberto · {profile.paidCount} quitada{profile.paidCount === 1 ? "" : "s"})</dd></div>
          <div><dt>Pagamentos realizados</dt><dd>{profile.paymentCount}</dd></div>
          <div><dt>Cliente desde</dt><dd>{profile.firstLoanDate ? `${formatDate(profile.firstLoanDate)} (${formatElapsed(profile.firstLoanDate, portfolio.today)})` : "—"}</dd></div>
        </dl>
      </section>
      <section className="panel table-panel" aria-label={`Operações de ${client.name}`}>
        <div className="panel-header"><div><div className="panel-title-row"><h2>Operações</h2><span className="today-count">{operations.length}</span></div><p>Cada operação separadamente. &quot;Detalhes&quot; abre o histórico de pagamentos.</p></div></div>
        {operations.length === 0 ? <EmptyPanel icon="wallet" text="Nenhuma operação para este cliente no ciclo atual." /> : (
          <div className="table-scroll"><table className="data-table">
            <thead><tr><th>Operação</th><th>Data</th><th>Principal</th><th>Juros</th><th>Total original</th><th>Recebido</th><th>Juros recebidos</th><th>Principal recebido</th><th>Saldo</th><th>Pagamentos</th><th>Tempo</th><th>Situação</th><th /></tr></thead>
            <tbody>{operations.map((operation) => (
              <tr key={operation.id}>
                <td><strong>#{operation.code}</strong></td><td>{formatDate(operation.loanDate)}</td><td>{formatMoney(operation.principalCents)}</td><td>{formatMoney(operation.interestCents)}</td>
                <td>{formatMoney(operation.totalCents)}</td><td>{formatMoney(operation.paidCents)}</td><td>{formatMoney(operation.interestPaidCents)}</td><td>{formatMoney(operation.principalPaidCents)}</td>
                <td><strong>{formatMoney(operation.balanceCents)}</strong></td><td>{operation.payments.length}</td><td>{operationAge(operation)}</td>
                <td><StatusChip state={operation.state} daysUntilDue={operation.daysUntilDue} /></td>
                <td className="actions-cell"><OperationDetailsButton operation={operation} today={portfolio.today} onChanged={onChanged} /></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
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

function OperationForm({ portfolio, onChanged, onNewClient }: { portfolio: TenantPortfolio; onChanged: () => void; onNewClient: () => void }) {
  const [principal, setPrincipal] = useState("");
  const [rate, setRate] = useState("");
  const { pending, feedback, onSubmit } = useFormAction(createOperationAction, () => { setPrincipal(""); setRate(""); onChanged(); });
  const principalCents = parseMoneyToCents(principal);
  const rateBps = parseRateToBps(rate);
  const preview = principalCents !== null && rateBps !== null ? calculateOperation({ principalCents, interestRateBps: rateBps }) : null;
  const availableAfterCents = portfolio.summary.availableCents - (principalCents ?? 0);
  const exceeds = principalCents !== null && principalCents > portfolio.summary.availableCents;

  if (portfolio.clients.length === 0) {
    return <section className="panel form-panel"><EmptyPanel icon="users" text="Cadastre um cliente antes de criar a primeira operação." action={<button className="primary-button" onClick={onNewClient}><Icon name="plus" size={16} /> Cadastrar cliente</button>} /></section>;
  }

  return (
    <section className="panel form-panel" aria-label="Nova operação">
      <div className="panel-header"><div><h2>Nova operação</h2><p>{calculationRuleLabels[calculateOperation({ principalCents: 0, interestRateBps: 0 }).calculationRule]}.</p></div></div>
      <form className="form-grid" onSubmit={onSubmit}>
        <label className="field field-wide"><span>Cliente</span><select name="clientId" required defaultValue=""><option value="" disabled>Selecione o cliente</option>{portfolio.clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label>
        <label className="field"><span>Valor principal (R$)</span><input name="principal" inputMode="decimal" placeholder="1.000,00" value={principal} onChange={(event) => setPrincipal(event.target.value)} required /></label>
        <label className="field"><span>Taxa de juros (%)</span><input name="rate" inputMode="decimal" placeholder="30" value={rate} onChange={(event) => setRate(event.target.value)} required /></label>
        <label className="field"><span>Data do empréstimo</span><input name="loanDate" type="date" defaultValue={portfolio.today} required /></label>
        <label className="field"><span>Vencimento</span><input name="dueDate" type="date" required /></label>
        <div className="operation-preview" aria-live="polite">
          <div><span>Principal</span><strong>{principalCents !== null ? formatMoney(principalCents) : "—"}</strong></div>
          <div><span>Juros</span><strong>{preview ? formatMoney(preview.interestCents) : "—"}</strong></div>
          <div><span>Total a receber</span><strong>{preview ? formatMoney(preview.totalCents) : "—"}</strong></div>
          <div><span>Capital disponível após</span><strong>{formatMoney(Math.max(availableAfterCents, 0))}</strong><small>Hoje: {formatMoney(portfolio.summary.availableCents)}</small></div>
        </div>
        {exceeds && <p className="form-feedback form-feedback-warning">O valor é maior que o capital disponível da carteira ({formatMoney(Math.max(portfolio.summary.availableCents, 0))}).</p>}
        <div className="form-actions"><button className="primary-button" disabled={pending}><Icon name="plus" size={16} /> {pending ? "Salvando…" : "Cadastrar operação"}</button></div>
      </form>
      <Feedback feedback={feedback} />
    </section>
  );
}

function PaymentPanel({ operation, today, onClose, onChanged }: { operation: OperationView; today: string; onClose: () => void; onChanged: () => void }) {
  const [amount, setAmount] = useState("");
  const { pending, feedback, onSubmit } = useFormAction(registerPaymentAction, () => { setAmount(""); onChanged(); });
  const isOpen = operation.status === "OPEN";
  const amountCents = parseMoneyToCents(amount);
  const check = amountCents !== null ? checkPayment({ amountCents, balanceCents: operation.balanceCents, formatMoney }) : null;
  // Prévia deste pagamento pela mesma regra usada no servidor (juros primeiro, depois principal).
  const after = check?.ok ? allocatePayments(operation, [...operation.payments, { id: "preview", amountCents: amountCents ?? 0, paidAt: "9999-12-31" }]) : null;
  const thisPayment = after?.items.at(-1);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="payment-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="panel form-panel payment-panel" role="dialog" aria-modal="true" aria-label={`Pagamentos de ${operation.clientName}`}>
        <div className="panel-header">
          <div><h2>{operation.clientName} — #{operation.code}</h2><p>Vencimento {formatDate(operation.dueDate)} · <StatusChip state={operation.state} daysUntilDue={operation.daysUntilDue} /></p></div>
          <button type="button" className="more-button" aria-label="Fechar" onClick={onClose}><Icon name="close" size={18} /></button>
        </div>
        <dl className="payment-summary">
          <div><dt>Principal</dt><dd>{formatMoney(operation.principalCents)}</dd></div>
          <div><dt>Juros</dt><dd>{formatMoney(operation.interestCents)}</dd></div>
          <div><dt>Total previsto</dt><dd>{formatMoney(operation.totalCents)}</dd></div>
          <div><dt>Recebido</dt><dd>{formatMoney(operation.paidCents)}</dd></div>
          <div><dt>Juros recebidos</dt><dd>{formatMoney(operation.interestPaidCents)}</dd></div>
          <div><dt>Principal recebido</dt><dd>{formatMoney(operation.principalPaidCents)}</dd></div>
          <div><dt>Juros restantes</dt><dd>{formatMoney(operation.interestRemainingCents)}</dd></div>
          <div><dt>Principal restante</dt><dd>{formatMoney(operation.principalRemainingCents)}</dd></div>
          <div className="payment-balance"><dt>Saldo</dt><dd>{formatMoney(operation.balanceCents)}</dd></div>
        </dl>
        <dl className="payment-summary">
          <div><dt>{operation.status === "PAID" ? "Duração" : "Operação ativa"}</dt><dd>{operationAge(operation)}</dd></div>
          <div><dt>Pagamentos realizados</dt><dd>{operation.payments.length}</dd></div>
          <div><dt>Meses com pagamento</dt><dd>{operation.paymentMonths}</dd></div>
        </dl>
        {isOpen && (
          <form className="form-grid" onSubmit={onSubmit}>
            <input type="hidden" name="operationId" value={operation.id} />
            <label className="field"><span>Data do pagamento</span><input name="paidAt" type="date" defaultValue={today} min={operation.loanDate} max={today} required /></label>
            <label className="field"><span>Valor recebido (R$)</span><input name="amount" inputMode="decimal" placeholder={centsToInput(operation.balanceCents)} value={amount} onChange={(event) => setAmount(event.target.value)} required autoFocus /></label>
            <div className="payment-shortcuts field-wide">
              {operation.interestRemainingCents > 0 && operation.interestRemainingCents < operation.balanceCents && <button type="button" className="outline-button" onClick={() => setAmount(centsToInput(operation.interestRemainingCents))}>Só os juros ({formatMoney(operation.interestRemainingCents)})</button>}
              <button type="button" className="outline-button" onClick={() => setAmount(centsToInput(operation.balanceCents))}>Saldo total ({formatMoney(operation.balanceCents)})</button>
            </div>
            <label className="field field-wide"><span>Observação</span><input name="notes" placeholder="Opcional" maxLength={500} /></label>
            {check && !check.ok && <p className="form-feedback form-feedback-warning">{check.error}</p>}
            {thisPayment && after && (
              <div className="operation-preview" aria-live="polite">
                <div><span>Para juros</span><strong>{formatMoney(thisPayment.interestCents)}</strong></div>
                <div><span>Para principal</span><strong>{formatMoney(thisPayment.principalCents)}</strong></div>
                <div><span>Saldo após</span><strong>{formatMoney(after.balanceCents)}</strong></div>
                <div><span>Situação após</span><strong>{after.balanceCents === 0 ? "Quitada" : "Ativa"}</strong></div>
              </div>
            )}
            <div className="form-actions"><button className="primary-button" disabled={pending || (check !== null && !check.ok)}><Icon name="check" size={16} /> {pending ? "Registrando…" : "Registrar pagamento"}</button></div>
          </form>
        )}
        <Feedback feedback={feedback} />
        <div className="payment-history">
          <h3>Histórico de pagamentos</h3>
          {operation.payments.length === 0 ? <p className="muted-cell">Nenhum pagamento registrado.</p> : (
            <ul>{operation.payments.map((payment) => (
              <li key={payment.id}>
                <span>{formatDate(payment.paidAt)}</span><strong>{formatMoney(payment.amountCents)}</strong><span className={`status-chip ${payment.kind === "SETTLEMENT" ? "status-paid" : "status-active"}`}><i />{paymentKindLabels[payment.kind]}</span>
                <small>Juros {formatMoney(payment.interestCents)} · Principal {formatMoney(payment.principalCents)}{payment.notes ? ` · ${payment.notes}` : ""}</small>
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
          <td><strong>#{operation.code}</strong></td><td>{operation.clientName}</td><td>{formatMoney(operation.principalCents)}</td><td>{formatRate(operation.interestRateBps)}</td>
          <td>{formatMoney(operation.interestCents)}</td><td>{formatMoney(operation.totalCents)}</td><td>{formatMoney(operation.paidCents)}</td><td><strong>{formatMoney(operation.balanceCents)}</strong></td>
          <td>{formatDate(operation.loanDate)}<small>{operationAge(operation)}</small></td><td>{formatDate(operation.dueDate)}</td>
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
          <p>{lent ? "Principal que ainda não voltou para a carteira, nas operações em aberto abaixo." : "Juros que ainda faltam receber nas operações em aberto abaixo. Juros já recebidos não entram aqui."}</p></div>
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
              <td>{formatDate(operation.dueDate)}</td><td><StatusChip state={operation.state} daysUntilDue={operation.daysUntilDue} /></td>
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
        <div className="panel-header"><div><h2>Capital disponível: {formatMoney(summary.availableCents)}</h2><p>Capital inicial + aportes − retiradas − capital usado em operações + valores recebidos. Juros ainda não recebidos não contam.</p></div></div>
        <dl className="payment-summary">
          <div><dt>Capital inicial</dt><dd>{formatMoney(summary.initialCapitalCents)}</dd></div>
          <div><dt>Aportes</dt><dd>+ {formatMoney(summary.contributionsCents)}</dd></div>
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
