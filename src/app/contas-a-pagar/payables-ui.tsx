"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";
import { formatDate, formatMoney, parseMoneyToCents, centsToInput } from "@/lib/finance/format";
import {
  LEGACY_EVIDENCE_ERROR, OBLIGATION_KINDS, OBLIGATION_SOURCES, OBLIGATION_STATUS, PAYABLE_TABS, PAYMENT_METHODS, PAYMENT_NOTES_MAX, REFERENCE_MAX, kindSlug, obligationDescription, statusSlug,
  type Obligation, type ObligationKind, type ObligationStatus, type PayableTab, type PaymentMethod,
} from "@/lib/investors/payables";
import type { PayablesPageData } from "@/lib/investors/payables-queries";
import { DateField } from "../date-field";
import { MoneyInput } from "../money-input";
import { FinanceSubnav } from "../financeiro/finance-subnav";
import { EmptyPanel, Feedback, PageHeading, useFormAction } from "../portfolio-pages";
import { Icon, type IconName } from "../ui-icon";
import { registerInvestmentPaymentAction } from "./actions";
import { PayablesKpis } from "./payables-kpis";

const statusTone: Record<ObligationStatus, string> = { PREVISTA: "status-active", PARCIAL: "status-due", PAGA: "status-paid", VENCIDA: "status-late" };
export function ObligationStatusChip({ status }: { status: ObligationStatus }) {
  return <span className={`status-chip ${statusTone[status]}`}><i />{OBLIGATION_STATUS[status]}</span>;
}

// Chave de cada envio, criada no primeiro clique e repetida em qualquer reenvio (clique duplo, nova tentativa depois de
// uma queda de conexão): o servidor grava uma única baixa por chave.
const newRequestId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);

// Janela "Registrar pagamento" da obrigação, igual à das Operações: resumo, data do pagamento, valor pago, atalhos de um
// clique (parcela e saldo), forma, referência e observação. O servidor confere tudo de novo com a obrigação travada
// (capital, entrada do contrato, saldo). Obrigação bloqueada mostra o motivo e o caminho para destravar.
export function ObligationPaymentDialog({ obligation, today, minDate, availableCents, onDone, onClose }: {
  obligation: Obligation; today: string; minDate: string; availableCents: number | null; onDone: () => void; onClose: () => void;
}) {
  const requestId = useRef<string | null>(null);
  const [amountText, setAmountText] = useState("");
  const { pending, feedback, onSubmit } = useFormAction(registerInvestmentPaymentAction, () => { requestId.current = null; onDone(); onClose(); });
  const blocked = obligation.paymentBlock;
  const amountCents = amountText.trim() ? parseMoneyToCents(amountText) : null;
  const invalid = amountText.trim() !== "" && (amountCents === null || amountCents <= 0);
  const aboveBalance = amountCents !== null && amountCents > obligation.balanceCents;
  const aboveCapital = availableCents !== null && amountCents !== null && amountCents > availableCents;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    const input = event.currentTarget.elements.namedItem("requestId") as HTMLInputElement;
    requestId.current ??= newRequestId();
    input.value = requestId.current;
    onSubmit(event);
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const contractHref = `/investidores/investimentos/${obligation.investmentId}`;
  return (
    <div className="payment-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="panel form-panel payment-panel" role="dialog" aria-modal="true" aria-label={`Registrar pagamento de ${obligation.investorName}`}>
        <div className="panel-header">
          <div><h2>{obligation.investorName} — {obligation.contractLabel}</h2><p>Parcela {obligation.number} vence {formatDate(obligation.dueDate)} · <ObligationStatusChip status={obligation.status} /></p></div>
          <button type="button" className="more-button" aria-label="Fechar" onClick={onClose}><Icon name="close" size={18} /></button>
        </div>
        <ObligationDetail obligation={obligation} />
        {blocked ? (
          <>
            <p className="capital-note">{blocked}</p>
            <div className="form-actions">
              <button type="button" className="outline-button" onClick={onClose}>Fechar</button>
              <Link prefetch={false} className="primary-button" href={contractHref}>{blocked === LEGACY_EVIDENCE_ERROR ? "Indicar a entrada ou o aporte no contrato" : "Registrar a entrada no capital"}</Link>
            </div>
          </>
        ) : (
          <form className="form-grid" onSubmit={submit}>
            <input type="hidden" name="scheduleItemId" value={obligation.scheduleItemId} />
            <input type="hidden" name="kind" value={obligation.kind} />
            <input type="hidden" name="requestId" defaultValue="" />
            <DateField label="Data do pagamento" name="paidOn" defaultValue={today} min={minDate} max={today} required />
            <label className="field"><span>Valor pago (R$)</span><MoneyInput name="amount" inputMode="decimal" placeholder={centsToInput(obligation.balanceCents)} value={amountText} onChange={(event) => setAmountText(event.target.value)} aria-invalid={invalid || aboveBalance || aboveCapital} required autoFocus /></label>
            <div className="payment-shortcuts field-wide">
              <button type="button" className="outline-button" onClick={() => setAmountText(centsToInput(obligation.balanceCents))}>Parcela {obligation.number} ({formatMoney(obligation.balanceCents)})</button>
              {obligation.balanceCents > 1 && <button type="button" className="outline-button" onClick={() => setAmountText(centsToInput(Math.floor(obligation.balanceCents / 2)))}>Metade ({formatMoney(Math.floor(obligation.balanceCents / 2))})</button>}
            </div>
            <label className="field"><span>Forma de pagamento</span><select name="method" defaultValue={obligation.defaultMethod ?? "OTHER"} required>
              {(Object.keys(PAYMENT_METHODS) as PaymentMethod[]).map((method) => <option key={method} value={method}>{PAYMENT_METHODS[method]}</option>)}
            </select></label>
            <label className="field"><span>Referência ou comprovante</span><input name="reference" maxLength={REFERENCE_MAX} placeholder="Ex.: ID da transação Pix (opcional)" /></label>
            <label className="field field-wide"><span>Observação</span><input name="notes" maxLength={PAYMENT_NOTES_MAX} placeholder="Opcional" /></label>
            {invalid && <p className="form-feedback form-feedback-error field-wide" role="alert">O valor precisa ser maior que zero, sem sinal de menos.</p>}
            {aboveBalance && <p className="form-feedback form-feedback-error field-wide" role="alert">O valor é maior que o saldo da obrigação ({formatMoney(obligation.balanceCents)}).</p>}
            {!aboveBalance && aboveCapital && <p className="form-feedback form-feedback-error field-wide" role="alert">O valor é maior que o capital disponível ({formatMoney(Math.max(availableCents ?? 0, 0))}).</p>}
            {amountCents !== null && amountCents > 0 && !aboveBalance && !aboveCapital && (
              <p className="capital-note field-wide">
                Saldo da obrigação: {formatMoney(obligation.balanceCents)} → <strong>{formatMoney(obligation.balanceCents - amountCents)}</strong>
                {availableCents !== null && <> · Capital disponível: {formatMoney(availableCents)} → <strong>{formatMoney(availableCents - amountCents)}</strong></>}. Sai do capital uma única vez, na data informada.
              </p>
            )}
            <div className="form-actions">
              <button type="button" className="outline-button" onClick={onClose}>Cancelar</button>
              <button className="primary-button" disabled={pending || amountCents === null || invalid || aboveBalance || aboveCapital}><Icon name="check" size={16} /> {pending ? "Registrando…" : "Registrar pagamento"}</button>
            </div>
          </form>
        )}
        <Feedback feedback={feedback} />
      </section>
    </div>
  );
}

// Botão "Registrar pagamento" que abre a janela acima; vale em qualquer tela que liste obrigações.
export function PayObligationButton({ obligation, today, cycleStartedOn = null, availableCents = null, onDone }: {
  obligation: Obligation; today: string; cycleStartedOn?: string | null; availableCents?: number | null; onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const minDate = [obligation.startDate, cycleStartedOn ?? ""].sort().at(-1) as string;
  return (
    <>
      <button type="button" className="primary-button" onClick={() => setOpen(true)}><Icon name="check" size={15} /> Registrar pagamento</button>
      {open && <ObligationPaymentDialog obligation={obligation} today={today} minDate={minDate} availableCents={availableCents} onDone={onDone} onClose={() => setOpen(false)} />}
    </>
  );
}

// Detalhe da obrigação: previsto, pago, saldo e as baixas já registradas (que não se alteram nem se apagam).
export function ObligationDetail({ obligation }: { obligation: Obligation }) {
  return (
    <div className="obligation-detail">
      <dl className="payment-summary">
        <div><dt>Investidor</dt><dd><Link prefetch={false} className="text-link inline-link" href={`/investidores/${obligation.investorId}`}>{obligation.investorName}</Link></dd></div>
        <div><dt>Contrato</dt><dd><Link prefetch={false} className="text-link inline-link" href={`/investidores/investimentos/${obligation.investmentId}`}>{obligation.contractLabel}</Link></dd></div>
        <div><dt>Parcela do cronograma</dt><dd>{obligation.number}{obligation.description ? ` · ${obligation.description}` : ""}</dd></div>
        <div><dt>Previsto</dt><dd>{formatMoney(obligation.expectedCents)}</dd></div>
        <div><dt>Pago</dt><dd>{formatMoney(obligation.paidCents)}</dd></div>
        <div><dt>Saldo</dt><dd><strong>{formatMoney(obligation.balanceCents)}</strong></dd></div>
      </dl>
      {obligation.payments.length > 0 ? (
        <div className="table-scroll"><table className="data-table" aria-label="Baixas registradas">
          <thead><tr><th>Data do pagamento</th><th>Valor</th><th>Forma</th><th>Referência</th><th>Registrado por</th></tr></thead>
          <tbody>{obligation.payments.map((payment) => (
            <tr key={payment.id}><td>{formatDate(payment.paidOn)}</td><td><strong>{formatMoney(payment.amountCents)}</strong></td><td>{PAYMENT_METHODS[payment.method]}</td><td>{payment.reference ?? "—"}{payment.notes && <small className="admin-cell-note">{payment.notes}</small>}</td><td>{payment.createdBy ?? "—"}</td></tr>
          ))}</tbody>
        </table></div>
      ) : <p className="capital-note">Nenhuma baixa registrada ainda.</p>}
      <p className="capital-note">Baixas confirmadas não podem ser alteradas nem apagadas: a correção de um pagamento ainda não tem regra definida.</p>
    </div>
  );
}

// Tabela de obrigações com detalhe e baixa na própria linha. canPay: só a carteira dona do contrato registra baixa.
export function ObligationsTable({ obligations, today, cycleStartedOn, availableCents, canPay, showInvestor = true, label, onDone }: {
  obligations: Obligation[]; today: string; cycleStartedOn: string | null; availableCents: number | null; canPay: boolean; showInvestor?: boolean; label: string; onDone: () => void;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [paying, setPaying] = useState<string | null>(null);
  const columns = showInvestor ? 9 : 8;
  return (
    <div className="table-scroll"><table className="data-table" aria-label={label}>
      <thead><tr><th>Descrição</th>{showInvestor && <th>Investidor e contrato</th>}<th>Vencimento</th><th>Tipo</th><th>Previsto</th><th>Pago</th><th>Saldo</th><th>Situação</th><th /></tr></thead>
      <tbody>{obligations.map((obligation) => {
        const open = openKey === obligation.key;
        const minDate = [obligation.startDate, cycleStartedOn ?? ""].sort().at(-1) as string;
        return (
          <Fragment key={obligation.key}>
            <tr>
              <td>{obligationDescription(obligation)}<small className="admin-cell-note">{OBLIGATION_SOURCES[obligation.source]}</small></td>
              {showInvestor && <td><strong>{obligation.investorName}</strong><small className="admin-cell-note">{obligation.contractLabel} · parcela {obligation.number}</small></td>}
              <td>{formatDate(obligation.dueDate)}</td>
              <td>{OBLIGATION_KINDS[obligation.kind]}</td>
              <td>{formatMoney(obligation.expectedCents)}</td>
              <td>{formatMoney(obligation.paidCents)}</td>
              <td><strong>{formatMoney(obligation.balanceCents)}</strong></td>
              <td><ObligationStatusChip status={obligation.status} /></td>
              <td className="actions-cell"><span className="row-actions">
                <button type="button" className="outline-button" aria-expanded={open} onClick={() => { setOpenKey(open ? null : obligation.key); }}>{open ? "Fechar" : "Detalhes"}</button>
                {canPay && obligation.balanceCents > 0 && obligation.investmentStatus !== "CANCELED" && (
                  <button type="button" className={obligation.paymentBlock ? "outline-button" : "primary-button"} onClick={() => setPaying(obligation.key)}><Icon name="check" size={15} /> Registrar pagamento</button>
                )}
              </span>
              {paying === obligation.key && (
                <ObligationPaymentDialog obligation={obligation} today={today} minDate={minDate} availableCents={availableCents}
                  onDone={onDone} onClose={() => setPaying(null)} />
              )}
              {canPay && obligation.balanceCents > 0 && obligation.investmentStatus !== "CANCELED" && obligation.paymentBlock && (
                <small className="admin-cell-note payment-block-note">Baixa bloqueada: <Link prefetch={false} className="text-link inline-link" href={`/investidores/investimentos/${obligation.investmentId}`}>{obligation.paymentBlock === LEGACY_EVIDENCE_ERROR ? "indique a entrada ou o aporte anterior" : "registre a entrada no capital"}</Link></small>
              )}</td>
            </tr>
            {open && (
              <tr className="obligation-detail-row"><td colSpan={columns}>
                <ObligationDetail obligation={obligation} />
              </td></tr>
            )}
          </Fragment>
        );
      })}</tbody>
    </table></div>
  );
}

const SECTIONS = [
  { key: "overdue", title: "Vencidas", empty: "Nenhuma obrigação vencida.", icon: "alert" },
  { key: "dueToday", title: "Vencem hoje", empty: "Nada vence hoje.", icon: "clock" },
  { key: "upcoming", title: "Próximas", empty: "Nenhuma obrigação futura em aberto.", icon: "calendar" },
  { key: "paid", title: "Pagas", empty: "Nenhuma obrigação paga ainda.", icon: "check" },
] as const;
type SectionKey = (typeof SECTIONS)[number]["key"] | "today";
const TAB_SECTIONS: Record<PayableTab, { key: SectionKey; title: string; empty: string; icon: IconName }[]> = {
  hoje: [{ key: "today", title: "Obrigações de hoje", empty: "Nada vence hoje.", icon: "clock" }],
  vencidos: [SECTIONS[0]],
  proximos: [SECTIONS[2]],
  pagos: [SECTIONS[3]],
  todos: [...SECTIONS],
};

// /contas-a-pagar (dentro do Financeiro): obrigações com investidores vindas dos cronogramas dos contratos, em abas
// (Hoje, Vencidos, Próximos, Pagos, Todos), com o resumo do dia, busca e filtros. Só a carteira da sessão.
export function PayablesHome({ data }: { data: PayablesPageData }) {
  const router = useRouter();
  const { filters, totals, sections, overview, tab } = data;
  const filtered = Boolean(filters.q || filters.from || filters.to || filters.status || filters.kind);
  const period = filters.from || filters.to ? `${filters.from ? formatDate(filters.from) : "início"} a ${filters.to ? formatDate(filters.to) : "hoje"}` : "Todo o histórico";
  const query = (aba: PayableTab) => {
    const params = new URLSearchParams();
    if (aba !== "hoje") params.set("aba", aba);
    if (filters.q) params.set("q", filters.q);
    if (filters.from) params.set("de", filters.from);
    if (filters.to) params.set("ate", filters.to);
    if (filters.status) params.set("situacao", statusSlug(filters.status));
    if (filters.kind) params.set("tipo", kindSlug(filters.kind));
    const text = params.toString();
    return text ? `/contas-a-pagar?${text}` : "/contas-a-pagar";
  };
  const tabCount: Record<PayableTab, number> = { hoje: sections.today.length, vencidos: sections.overdue.length, proximos: sections.upcoming.length, pagos: sections.paid.length, todos: data.matched };
  return (
    <div className="workspace-page">
      <PageHeading eyebrow="CREDIAI · FINANCEIRO" title="Contas a pagar"
        description="Rendimentos e devoluções de principal combinados com os investidores, a partir do cronograma de cada contrato. Só a baixa confirmada tira dinheiro do capital." />
      <FinanceSubnav active="contas" />

      {!data.hasWallet && <EmptyPanel icon="wallet" text="Defina o capital inicial da carteira na tela Capital para registrar pagamentos." action={<Link prefetch={false} className="primary-button" href="/?tela=capital">Ir para Capital</Link>} />}

      <section aria-label="Resumo do dia"><PayablesKpis overview={overview} availableCents={data.availableCents} tabHref={query} currentTab={tab} /></section>

      <nav className="payables-tabs" aria-label="Filtro das contas a pagar">
        {(Object.keys(PAYABLE_TABS) as PayableTab[]).map((key) => (
          <Link prefetch={false} key={key} href={query(key)} aria-current={tab === key ? "page" : undefined}>{PAYABLE_TABS[key]} <span>{tabCount[key]}</span></Link>
        ))}
      </nav>

      {tab === "hoje" && overview.overdueCount > 0 && (
        <p className="payables-alert" role="note"><Icon name="alert" size={15} /> {overview.overdueCount} {overview.overdueCount === 1 ? "obrigação vencida continua" : "obrigações vencidas continuam"} em aberto ({formatMoney(overview.overdueCents)}). <Link prefetch={false} className="text-link inline-link" href={query("vencidos")}>Ver vencidos</Link></p>
      )}

      <section className="panel form-panel" aria-label="Filtros">
        <form className="investor-filters payables-filters" action="/contas-a-pagar" method="get" role="search" key={JSON.stringify(filters)}>
          {tab !== "hoje" && <input type="hidden" name="aba" value={tab} />}
          <label className="field"><span>Investidor</span><select name="q" defaultValue={filters.q}>
            <option value="">Todos os investidores</option>
            {[...new Set([...data.investorNames, ...(filters.q ? [filters.q] : [])])].map((name) => <option key={name} value={name}>{name}</option>)}
          </select></label>
          <DateField label="Vencimento de" name="de" defaultValue={filters.from ?? ""} />
          <DateField label="até" name="ate" defaultValue={filters.to ?? ""} />
          <label className="field"><span>Situação</span><select name="situacao" defaultValue={filters.status ? statusSlug(filters.status) : ""}>
            <option value="">Todas</option>
            {(Object.keys(OBLIGATION_STATUS) as ObligationStatus[]).map((status) => <option key={status} value={statusSlug(status)}>{OBLIGATION_STATUS[status]}</option>)}
          </select></label>
          <label className="field"><span>Tipo</span><select name="tipo" defaultValue={filters.kind ? kindSlug(filters.kind) : ""}>
            <option value="">Todos</option>
            {(Object.keys(OBLIGATION_KINDS) as ObligationKind[]).map((kind) => <option key={kind} value={kindSlug(kind)}>{OBLIGATION_KINDS[kind]}</option>)}
          </select></label>
          <div className="investor-filter-actions"><button className="outline-button"><Icon name="filter" size={15} /> Aplicar</button>{filtered && <Link prefetch={false} className="text-link" href={tab === "hoje" ? "/contas-a-pagar" : `/contas-a-pagar?aba=${tab}`}>Limpar filtros</Link>}</div>
        </form>
        <p className="capital-note">{filtered ? `${data.matched} de ${data.totalCount} obrigações com estes filtros. Pago no período: ${formatMoney(totals.paidCents)} (${period}).` : `${data.totalCount} obrigações nos cronogramas dos contratos. Pago em todo o histórico: ${formatMoney(totals.paidCents)}.`}</p>
      </section>

      {data.withoutSchedule.length > 0 && (
        <section className="panel table-panel" aria-label="Contratos sem cronograma">
          <div className="panel-header"><div><div className="panel-title-row"><h2>Contratos sem cronograma</h2><span className="today-count">{data.withoutSchedule.length}</span></div>
            <p>Contratos cadastrados que ainda não têm cronograma de pagamentos. Não há valor previsto até o cronograma ser montado.</p></div></div>
          <div className="table-scroll"><table className="data-table" aria-label="Contratos sem cronograma">
            <thead><tr><th>Investidor e contrato</th><th>Valor</th><th>Início</th><th>Vencimento</th><th>Situação</th><th /></tr></thead>
            <tbody>{data.withoutSchedule.map((contract) => (
              <tr key={contract.id}>
                <td><strong>{contract.investorName}</strong><small className="admin-cell-note">{contract.contractNumber ? `Contrato ${contract.contractNumber}` : "Sem número de contrato"}</small></td>
                <td>{formatMoney(contract.amountCents)}</td>
                <td>{formatDate(contract.startDate)}</td>
                <td>{contract.maturityDate ? formatDate(contract.maturityDate) : "—"}</td>
                <td><span className={`status-chip ${contract.status === "ACTIVE" ? "status-due" : "status-active"}`}><i />{contract.status === "ACTIVE" ? "Sem cronograma" : "Aguardando assinatura · sem cronograma"}</span></td>
                <td><Link prefetch={false} className="outline-button" href={`/investidores/investimentos/${contract.id}`}>Abrir contrato</Link></td>
              </tr>
            ))}</tbody>
          </table></div>
        </section>
      )}

      {data.totalCount === 0 && data.withoutSchedule.length === 0 && <EmptyPanel icon="briefcase" text="Nenhuma obrigação ainda. Monte o cronograma de pagamentos na página de cada contrato de investimento." action={<Link prefetch={false} className="outline-button" href="/investidores">Ir para Investidores</Link>} />}

      {data.totalCount > 0 && TAB_SECTIONS[tab].map((section) => {
        const list = sections[section.key];
        return (
          <section key={section.key} className="panel table-panel" aria-label={section.title}>
            <div className="panel-header"><div><div className="panel-title-row"><h2>{section.title}</h2><span className="today-count">{list.length}</span></div></div></div>
            {list.length === 0 ? <EmptyPanel icon={section.icon} text={section.empty} /> : (
              <ObligationsTable obligations={list} today={data.today} cycleStartedOn={data.cycleStartedOn} availableCents={data.availableCents} canPay={data.hasWallet} label={section.title} onDone={() => router.refresh()} />
            )}
          </section>
        );
      })}
      <p className="capital-note">Os valores previstos são os digitados no cronograma: o sistema não calcula rendimento. Uma obrigação pendente não mexe no capital; cada baixa grava uma única saída no Financeiro (Rendimento pago a investidor ou Devolução de principal a investidor).</p>
    </div>
  );
}
