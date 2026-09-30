"use client";

import { useEffect, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { createClientAction, createOperationAction, registerPaymentAction, saveWalletAction, updateClientAction, type ActionResult } from "./actions";
import { Icon, type IconName } from "./ui-icon";
import { centsToInput, formatCpf, formatDate, formatMoney, formatPhone, formatRate, maskCpf, maskPhone, parseMoneyToCents, parseRateToBps } from "@/lib/finance/format";
import type { ChargeFilter, OperationView } from "@/lib/finance/portfolio";
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

export function WalletSetup({ onSaved }: { onSaved: () => void }) {
  const { pending, feedback, onSubmit } = useFormAction(saveWalletAction, onSaved);
  return (
    <section className="panel form-panel wallet-setup" aria-label="Configurar carteira">
      <div className="panel-header"><div><h2>Configure sua carteira</h2><p>Informe o capital inicial para o CrediAI calcular o capital disponível conforme as suas operações.</p></div></div>
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
          <li><strong>Capital disponível:</strong> capital inicial − principal emprestado + pagamentos recebidos. Juros ainda não recebidos não contam.</li>
          <li><strong>Em atraso:</strong> operação em aberto com vencimento anterior a hoje. Multa e juros de mora ainda não são aplicados.</li>
        </ul>
      </section>
    </div>
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

export function ClientsPage({ portfolio, onChanged, onNewOperation }: { portfolio: TenantPortfolio; onChanged: () => void; onNewOperation: () => void }) {
  const [editing, setEditing] = useState<ClientRow | null>(null);
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
            <thead><tr><th>Nome</th><th>CPF</th><th>Telefone</th><th>Operações</th><th /></tr></thead>
            <tbody>{portfolio.clients.map((client) => <tr key={client.id}><td><strong>{client.name}</strong>{client.notes && <small>{client.notes}</small>}</td><td>{formatCpf(client.document) ?? "—"}</td><td>{formatPhone(client.phone) ?? "—"}</td><td>{client.operationCount}</td><td className="actions-cell"><button className="outline-button" onClick={() => { setEditing(client); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Editar</button></td></tr>)}</tbody>
          </table></div>
        )}
      </section>
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

function OperationsTable({ operations, today, onChanged }: { operations: OperationView[]; today: string; onChanged: () => void }) {
  return (
    <div className="table-scroll"><table className="data-table">
      <thead><tr><th>Operação</th><th>Cliente</th><th>Principal</th><th>Taxa</th><th>Juros</th><th>Total</th><th>Recebido</th><th>Saldo</th><th>Empréstimo</th><th>Vencimento</th><th>Situação</th><th /></tr></thead>
      <tbody>{operations.map((operation) => (
        <tr key={operation.id}>
          <td><strong>#{operation.code}</strong></td><td>{operation.clientName}</td><td>{formatMoney(operation.principalCents)}</td><td>{formatRate(operation.interestRateBps)}</td>
          <td>{formatMoney(operation.interestCents)}</td><td>{formatMoney(operation.totalCents)}</td><td>{formatMoney(operation.paidCents)}</td><td><strong>{formatMoney(operation.balanceCents)}</strong></td>
          <td>{formatDate(operation.loanDate)}</td><td>{formatDate(operation.dueDate)}</td>
          <td><StatusChip state={operation.state} daysUntilDue={operation.daysUntilDue} /></td><td className="actions-cell"><PaymentButton operation={operation} today={today} onChanged={onChanged} /></td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

export function OperationsPage({ portfolio, onChanged, onNewClient }: { portfolio: TenantPortfolio; onChanged: () => void; onNewClient: () => void }) {
  return (
    <div className="workspace-page">
      <PageHeading eyebrow="CREDIAI · OPERAÇÕES" title="Operações" description="Cadastre e acompanhe os empréstimos da sua carteira." />
      <OperationForm portfolio={portfolio} onChanged={onChanged} onNewClient={onNewClient} />
      <section className="panel table-panel" aria-label="Lista de operações">
        <div className="panel-header"><div><div className="panel-title-row"><h2>Operações da carteira</h2><span className="today-count">{portfolio.operations.length}</span></div><p>Ativas: {portfolio.summary.counts.active} · Quitadas: {portfolio.summary.counts.paid} · Em atraso: {portfolio.summary.counts.overdue}</p></div></div>
        {portfolio.operations.length === 0 ? <EmptyPanel icon="wallet" text="Nenhuma operação cadastrada ainda." /> : <OperationsTable operations={portfolio.operations} today={portfolio.today} onChanged={onChanged} />}
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

export function ChargesPage({ portfolio, onChanged }: { portfolio: TenantPortfolio; onChanged: () => void }) {
  const filters: ChargeFilter[] = ["Em atraso", "Hoje", "Amanhã", "Próximas"];
  const [filter, setFilter] = useState<ChargeFilter>(portfolio.summary.counts.overdue > 0 ? "Em atraso" : "Hoje");
  const ids = new Set(portfolio.charges[filter].map((charge) => charge.operationId));
  const operations = portfolio.operations.filter((operation) => ids.has(operation.id)).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return (
    <div className="workspace-page">
      <PageHeading eyebrow="CREDIAI · COBRANÇAS" title="Cobranças" description="Operações em aberto por vencimento. Registre cada pagamento quando receber." />
      <section className="panel table-panel">
        <div className="charge-tabs" role="tablist" aria-label="Filtro de cobranças">{filters.map((item) => <button key={item} role="tab" aria-selected={filter === item} className={filter === item ? "charge-tab-active" : ""} onClick={() => setFilter(item)}>{item} ({portfolio.charges[item].length})</button>)}</div>
        {operations.length === 0 ? <EmptyPanel icon="calendar" text="Nenhuma cobrança neste filtro." /> : <OperationsTable operations={operations} today={portfolio.today} onChanged={onChanged} />}
      </section>
    </div>
  );
}
