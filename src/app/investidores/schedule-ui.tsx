"use client";

import { useState } from "react";
import { centsToInput, formatDate, formatMoney, parseMoneyToCents } from "@/lib/finance/format";
import { LINE_STATUS, type LineStatus } from "@/lib/investors/position";
import type { Obligation } from "@/lib/investors/payables";
import type { InvestmentDetail } from "@/lib/investors/queries";
import { LINE_KINDS, MAX_SCHEDULE_ITEMS, PAYMENT_FREQUENCIES, applyRedemptionDate, defaultModelPlan, redemptionDate, suggestScheduleLines, type LineKind, type PaymentFrequency, type ScheduleLineInput } from "@/lib/investors/rules";
import { DateField } from "../date-field";
import { MoneyInput } from "../money-input";
import { PayObligationButton } from "../contas-a-pagar/payables-ui";
import { EmptyPanel, Feedback, useFormAction } from "../portfolio-pages";
import { Icon } from "../ui-icon";
import { addInvestmentScheduleItemAction, deleteInvestmentScheduleItemAction, saveInvestmentScheduleLinesAction, updateInvestmentScheduleItemAction } from "./actions";

type Line = InvestmentDetail["schedule"]["lines"][number];
const moneyInput = (cents: number) => (cents ? centsToInput(cents) : "");
const lineTone: Record<LineStatus, string> = { PREVISTA: "status-due", VENCIDA: "status-late", PARCIAL: "status-due", PAGA: "status-paid", CANCELADA: "status-muted", RENOVADA: "status-active" };
export function LineStatusChip({ status }: { status: LineStatus }) {
  return <span className={`status-chip ${lineTone[status]}`}><i />{LINE_STATUS[status]}</span>;
}

// Painel do contrato: tudo somado dos registros (valor do contrato, cronograma digitado e baixas). Nenhum valor vem de
// taxa, não há juros de atraso nem multa, e nada vira pago só porque a data passou.
export function PositionSection({ data }: { data: InvestmentDetail }) {
  const { position, divergences, investment } = data;
  const received = position.principalReceived;
  const cells: [string, string, string?][] = [
    ["Principal contratado", formatMoney(position.principalContractedCents)],
    ["Principal recebido", received?.kind === "entry" || received?.kind === "renewal" ? formatMoney(received.cents) : received?.kind === "prior" ? "Por aporte anterior" : "Não registrado",
      received?.kind === "renewal" ? "Veio da renovação, sem nova entrada" : received ? "Entrada no capital" : "Registre a entrada em “Capital e pagamentos”"],
    ["Principal devolvido", formatMoney(position.principalReturnedCents)],
    ["Principal restante", formatMoney(position.principalRemainingCents), position.principalRolledOverCents ? `${formatMoney(position.principalRolledOverCents)} passaram para a renovação` : "Contratado menos o devolvido"],
    ["Rendimentos previstos", formatMoney(position.yieldExpectedCents), "Informados no cronograma"],
    ["Rendimentos pagos", formatMoney(position.yieldPaidCents)],
    ["Rendimentos pendentes", formatMoney(position.yieldPendingCents)],
    ["Principal sem data de devolução", formatMoney(position.principalUnscheduledCents), "Ainda não agendado no cronograma"],
    ["Total das obrigações", formatMoney(position.obligationsTotalCents), "Rendimentos + principal agendado"],
    ["Total pago", formatMoney(position.paidTotalCents)],
    ["Próximo vencimento em aberto", position.nextDueDate ? formatDate(position.nextDueDate) : "—"],
    ["Obrigações pendentes", String(position.pendingCount), position.overdueCount ? `${position.overdueCount} vencida${position.overdueCount === 1 ? "" : "s"}` : "Nenhuma vencida"],
  ];
  return (
    <section className="panel form-panel" aria-label="Posição do contrato">
      <div className="panel-header"><div><h2>Posição do contrato</h2><p>Somas do cronograma digitado e das baixas registradas. O sistema não calcula rendimento por taxa, juros de atraso nem multa; uma obrigação só fica paga com a baixa.</p></div></div>
      <dl className="position-grid">{cells.map(([label, value, note]) => <div key={label}><dt>{label}</dt><dd>{value}{note && <small>{note}</small>}</dd></div>)}</dl>
      {investment.status === "CANCELED" && <p className="capital-note">Contrato cancelado: as linhas sem pagamento aparecem como canceladas e não contam como pendentes.</p>}
      {divergences.length > 0 && (
        <div role="note" aria-label="Divergências nos dados do contrato">
          <p className="form-feedback form-feedback-warning">Divergências encontradas nos dados gravados. Nada foi corrigido automaticamente; confira e ajuste se for o caso:</p>
          <ul className="divergence-list">{divergences.map((problem) => <li key={problem}>{problem}</li>)}</ul>
        </div>
      )}
    </section>
  );
}

// Cronograma de pagamentos ao investidor: linhas digitadas pelo usuário, de qualquer periodicidade (inclusive irregular).
// A sugestão pela periodicidade só preenche a revisão; nada é gravado sem o usuário conferir as linhas.
export function ScheduleSection({ data, onDone }: { data: InvestmentDetail; onDone: () => void }) {
  const { investment, schedule } = data;
  const editable = investment.status !== "CANCELED" && investment.status !== "CLOSED";
  const [mode, setMode] = useState<"append" | "replace" | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const done = () => { setMode(null); setAdding(false); setEditingId(null); onDone(); };
  const { totals, lines } = schedule;
  const anyPaid = lines.some((line) => line.paidCents > 0);
  return (
    <section className="panel form-panel" aria-label="Cronograma de pagamentos ao investidor">
      <div className="panel-header">
        <div><div className="panel-title-row"><h2>Cronograma de pagamentos</h2><span className="today-count">{totals.count}</span></div>
          <p>Datas e valores combinados com {data.investor.name}, digitados por você, em qualquer periodicidade. O cronograma não mexe no capital: cada pagamento é registrado (baixa) em Contas a Pagar.</p></div>
        {editable && (
          <span className="row-actions">
            <button type="button" className="outline-button" onClick={() => { setAdding(!adding); setMode(null); }}>{adding ? "Fechar" : "Incluir pagamento"}</button>
            <button type="button" className="outline-button" onClick={() => { setMode(mode === "append" ? null : "append"); setAdding(false); }}>{mode === "append" ? "Fechar" : "Incluir várias linhas"}</button>
            {!anyPaid && <button type="button" className="primary-button" onClick={() => { setMode(mode === "replace" ? null : "replace"); setAdding(false); }}>{mode === "replace" ? "Fechar" : lines.length ? "Substituir cronograma" : "Montar cronograma"}</button>}
          </span>
        )}
      </div>
      {!editable && <p className="capital-note">Investimento encerrado ou cancelado: o cronograma fica só para consulta.</p>}
      {editable && anyPaid && <p className="capital-note">Linhas com pagamento registrado ficam travadas para preservar o histórico financeiro; o cronograma não pode mais ser substituído, mas novas linhas podem ser incluídas.</p>}
      {mode && <ScheduleLinesEditor data={data} mode={mode} onDone={done} onCancel={() => setMode(null)} />}
      {adding && <ScheduleItemForm investmentId={investment.id} onDone={done} onCancel={() => setAdding(false)} />}
      {lines.length === 0 ? <EmptyPanel icon="calendar" text="Nenhum pagamento no cronograma ainda. Monte o cronograma para os pagamentos aparecerem em Financeiro > Contas a pagar, na data combinada." /> : (
        <>
          <dl className="payment-summary">
            <div><dt>Rendimentos informados</dt><dd>{formatMoney(totals.yieldCents)}</dd></div>
            <div><dt>Devolução de principal informada</dt><dd>{formatMoney(totals.principalCents)}</dd></div>
            <div><dt>Total do cronograma</dt><dd>{formatMoney(totals.totalCents)}</dd></div>
            <div><dt>Principal sem data de devolução</dt><dd>{formatMoney(data.position.principalUnscheduledCents)}</dd></div>
          </dl>
          <div className="table-scroll"><table className="data-table" aria-label="Linhas do cronograma">
            <thead><tr><th>#</th><th>Vencimento</th><th>Tipo</th><th>Rendimento</th><th>Principal</th><th>Total</th><th>Pago</th><th>Última baixa</th><th>Situação</th><th>Observação</th>{editable && <th />}</tr></thead>
            <tbody>{lines.map((line, index) => (
              <ScheduleRow key={line.id} line={line} position={index + 1} investmentId={investment.id} editable={editable} editing={editingId === line.id}
                payable={data.cash.obligations.filter((obligation) => obligation.scheduleItemId === line.id && obligation.balanceCents > 0 && !obligation.paymentBlock)} today={data.cash.today}
                onEdit={() => setEditingId(editingId === line.id ? null : line.id)} onDone={done} />
            ))}</tbody>
          </table></div>
          <p className="capital-note">A forma, a referência e o lançamento no capital de cada baixa aparecem em &ldquo;Capital e pagamentos&rdquo;, em Detalhes de cada obrigação.</p>
        </>
      )}
    </section>
  );
}

function ScheduleRow({ line, position, investmentId, editable, editing, payable, today, onEdit, onDone }: { line: Line; position: number; investmentId: string; editable: boolean; editing: boolean; payable: Obligation[]; today: string; onEdit: () => void; onDone: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const remove = useFormAction(deleteInvestmentScheduleItemAction, onDone);
  const locked = line.payments.length > 0;
  return (
    <>
      <tr>
        <td>{position}</td>
        <td>{formatDate(line.dueDate)}</td>
        <td>{LINE_KINDS[line.kind]}</td>
        <td>{line.yieldCents ? formatMoney(line.yieldCents) : "—"}</td>
        <td>{line.principalCents ? formatMoney(line.principalCents) : "—"}</td>
        <td><strong>{formatMoney(line.totalCents)}</strong></td>
        <td>{line.paidCents ? formatMoney(line.paidCents) : "—"}</td>
        <td>{line.lastPaidOn ? formatDate(line.lastPaidOn) : "—"}</td>
        <td><LineStatusChip status={line.status} /></td>
        <td>{line.description ?? "—"}</td>
        {editable && locked && <td className="actions-cell"><span className="row-actions">
          {payable.map((obligation) => <PayObligationButton key={obligation.key} obligation={obligation} today={today} onDone={onDone} />)}
          <span className="status-chip status-paid"><i />Com pagamento</span></span></td>}
        {editable && !locked && (
          <td className="actions-cell">
            {payable.length > 0 && <span className="row-actions">{payable.map((obligation) => <PayObligationButton key={obligation.key} obligation={obligation} today={today} onDone={onDone} />)}</span>}
            <form className="row-actions" onSubmit={remove.onSubmit}>
              <input type="hidden" name="investmentId" value={investmentId} /><input type="hidden" name="itemId" value={line.id} />
              <button type="button" className="outline-button" onClick={onEdit}>{editing ? "Fechar" : "Editar"}</button>
              {confirming
                ? <><button className="primary-button danger-button" disabled={remove.pending}>{remove.pending ? "Retirando…" : "Confirmar retirada"}</button><button type="button" className="text-link" onClick={() => setConfirming(false)}>Manter</button></>
                : <button type="button" className="outline-button" onClick={() => setConfirming(true)}>Retirar</button>}
            </form>
            <Feedback feedback={remove.feedback} />
          </td>
        )}
      </tr>
      {editing && <tr><td colSpan={11}><ScheduleItemForm investmentId={investmentId} item={line} onDone={onDone} onCancel={onEdit} /></td></tr>}
    </>
  );
}

// Tipo + valores de uma linha. O total mostrado é sempre a soma; na combinada os dois valores ficam separados.
function LineAmounts({ kind, yieldAmount, principalAmount, onKind, onYield, onPrincipal }: {
  kind: LineKind; yieldAmount: string; principalAmount: string; onKind: (kind: LineKind) => void; onYield: (value: string) => void; onPrincipal: (value: string) => void;
}) {
  const total = (parseMoneyToCents(yieldAmount || "0") ?? 0) + (parseMoneyToCents(principalAmount || "0") ?? 0);
  return (
    <>
      <label className="field"><span>Tipo</span><select name="kind" value={kind} onChange={(event) => onKind(event.target.value as LineKind)}>
        {(Object.keys(LINE_KINDS) as LineKind[]).map((key) => <option key={key} value={key}>{LINE_KINDS[key]}</option>)}
      </select></label>
      {kind !== "PRINCIPAL" && <label className="field"><span>Rendimento (R$)</span><MoneyInput name="yieldAmount" inputMode="decimal" placeholder="1.000,00" value={yieldAmount} onChange={(event) => onYield(event.target.value)} required /></label>}
      {kind !== "YIELD" && <label className="field"><span>Devolução do principal (R$)</span><MoneyInput name="principalAmount" inputMode="decimal" placeholder="10.000,00" value={principalAmount} onChange={(event) => onPrincipal(event.target.value)} required /></label>}
      <label className="field"><span>Total da linha</span><input value={formatMoney(total)} readOnly aria-readonly="true" tabIndex={-1} /></label>
    </>
  );
}

function ScheduleItemForm({ investmentId, item, onDone, onCancel }: { investmentId: string; item?: Line; onDone: () => void; onCancel: () => void }) {
  const { pending, feedback, onSubmit } = useFormAction(item ? updateInvestmentScheduleItemAction : addInvestmentScheduleItemAction, onDone);
  const [kind, setKind] = useState<LineKind>(item?.kind ?? "YIELD");
  const [yieldAmount, setYieldAmount] = useState(item ? moneyInput(item.yieldCents) : "");
  const [principalAmount, setPrincipalAmount] = useState(item ? moneyInput(item.principalCents) : "");
  return (
    <div className="schedule-form">
      <form className="form-grid" onSubmit={onSubmit} aria-label={item ? "Editar pagamento do cronograma" : "Incluir pagamento no cronograma"}>
        <input type="hidden" name="investmentId" value={investmentId} />
        {item && <input type="hidden" name="itemId" value={item.id} />}
        <DateField label="Data do pagamento" name="dueDate" defaultValue={item?.dueDate ?? ""} required />
        <LineAmounts kind={kind} yieldAmount={yieldAmount} principalAmount={principalAmount} onKind={setKind} onYield={setYieldAmount} onPrincipal={setPrincipalAmount} />
        <label className="field"><span>Observação (opcional)</span><input name="description" maxLength={200} placeholder="Ex.: rendimento de março" defaultValue={item?.description ?? ""} /></label>
        <div className="form-actions">
          <button type="button" className="outline-button" onClick={onCancel}>Cancelar</button>
          <button className="primary-button" disabled={pending}><Icon name="check" size={16} /> {pending ? "Salvando…" : item ? "Salvar pagamento" : "Incluir pagamento"}</button>
        </div>
      </form>
      <Feedback feedback={feedback} />
    </div>
  );
}

const emptyLine = (): ScheduleLineInput => ({ kind: "YIELD", dueDate: "", yieldAmount: "", principalAmount: "", description: "" });

// Várias linhas de uma vez: a sugestão pela periodicidade (opcional) preenche a tabela de revisão; o usuário confere,
// altera, retira ou acrescenta linhas e só então grava. Nada é dividido nem calculado.
function ScheduleLinesEditor({ data, mode, onDone, onCancel }: { data: InvestmentDetail; mode: "append" | "replace"; onDone: () => void; onCancel: () => void }) {
  const { investment, schedule } = data;
  const initialFrequency = investment.paymentFrequency && investment.paymentFrequency !== "OTHER" ? investment.paymentFrequency : "MONTHLY";
  const [frequency, setFrequency] = useState<PaymentFrequency>(initialFrequency);
  const [firstDueDate, setFirstDueDate] = useState("");
  const [dateKey, setDateKey] = useState(0);
  const [count, setCount] = useState(String(investment.installmentCount ?? ""));
  // Dia do pagamento combinado: vem do contrato (se houver) e pode ser trocado aqui; não precisa ser o dia do início.
  const [dueDay, setDueDay] = useState(investment.dueDay ? String(investment.dueDay) : "");
  const [yieldAmount, setYieldAmount] = useState(investment.yieldPaymentCents ? centsToInput(investment.yieldPaymentCents) : "");
  const [principalAmount, setPrincipalAmount] = useState("");
  const [description, setDescription] = useState("");
  const [lines, setLines] = useState<ScheduleLineInput[]>([]);
  const [hint, setHint] = useState<string | null>(null);
  const { pending, feedback, onSubmit } = useFormAction(saveInvestmentScheduleLinesAction, onDone);
  const options = (Object.keys(PAYMENT_FREQUENCIES) as PaymentFrequency[]).filter((key) => key !== "OTHER");
  const dayNumber = (value: string) => (/^\d{1,2}$/.test(value) && Number(value) >= 1 && Number(value) <= 31 ? Number(value) : null);
  const suggestWith = (values: { frequency: PaymentFrequency; firstDueDate: string; count: string; principalAmount: string }) => {
    if (dueDay && !dayNumber(dueDay)) return setHint("O dia do pagamento vai de 1 a 31 (ou deixe em branco para usar o dia da primeira data).");
    const suggestion = suggestScheduleLines({ frequency: values.frequency, firstDueDate: values.firstDueDate, count: values.frequency === "AT_MATURITY" ? 1 : Number(values.count), yieldAmount: yieldAmount.trim(), principalAmount: values.principalAmount.trim(), description: description.trim(), dueDay: dayNumber(dueDay) });
    if (suggestion.length === 0) return setHint(`Informe a data do primeiro pagamento combinada e a quantidade (1 a ${MAX_SCHEDULE_ITEMS}).`);
    // Liquidez combinada: a devolução do principal vai para a data de resgate (ao término do contrato ou D+N).
    const resgate = redemptionDate(investment.maturityDate, investment.redemptionRule, investment.redemptionDays);
    setHint(resgate ? `Devolução do principal na data de resgate combinada (${formatDate(resgate)}). Confira antes de gravar.` : null);
    setLines(applyRedemptionDate(suggestion, resgate));
  };
  const suggest = () => suggestWith({ frequency, firstDueDate, count, principalAmount });
  // Modelo padrão: preenche periodicidade, quantidade até o vencimento final e principal integral na última data. A
  // primeira data é a que você digitou; sem ela, a primeira no dia do pagamento depois do início (editável); sem dia
  // combinado, você informa a negociada. O rendimento é o combinado, digitado por você; as linhas só aparecem para revisão.
  const useDefaultModel = () => {
    if (dueDay && !dayNumber(dueDay)) return setHint("O dia do pagamento vai de 1 a 31 (ou deixe em branco para usar o dia da primeira data).");
    const plan = defaultModelPlan(investment, { firstDueDate, dueDay: dayNumber(dueDay) });
    setFrequency(plan.frequency); setPrincipalAmount(plan.principalAmount);
    if (!plan.firstDueDate) return setHint("Informe a data do primeiro pagamento combinada (ou o dia do pagamento) e clique de novo em “Usar modelo padrão”. O sistema não presume a primeira data.");
    const values = { frequency: plan.frequency, firstDueDate: plan.firstDueDate, count: plan.count ? String(plan.count) : count, principalAmount: plan.principalAmount };
    if (values.firstDueDate !== firstDueDate) { setFirstDueDate(values.firstDueDate); setDateKey((key) => key + 1); }
    setCount(values.count);
    if (!values.count) return setHint("Modelo padrão preenchido. Informe a quantidade de pagamentos (o contrato não tem prazo nem vencimento que a defina), o rendimento de cada data e clique em “Sugerir linhas para revisar”.");
    if (!yieldAmount.trim()) return setHint("Modelo padrão preenchido. Digite o rendimento combinado de cada data e clique em “Sugerir linhas para revisar”.");
    suggestWith(values);
  };
  const update = (index: number, patch: Partial<ScheduleLineInput>) => setLines((current) => current.map((line, position) => {
    if (position !== index) return line;
    const next = { ...line, ...patch };
    if (patch.kind === "YIELD") next.principalAmount = "";
    if (patch.kind === "PRINCIPAL") next.yieldAmount = "";
    return next;
  }));
  const totals = lines.reduce((sum, line) => ({ yieldCents: sum.yieldCents + (parseMoneyToCents(line.yieldAmount || "0") ?? 0), principalCents: sum.principalCents + (parseMoneyToCents(line.principalAmount || "0") ?? 0) }), { yieldCents: 0, principalCents: 0 });
  return (
    <div className="schedule-form" aria-label={mode === "replace" ? "Montar cronograma" : "Incluir várias linhas"}>
      <div className="form-grid">
        <p className="capital-note field-wide">Opcional: as datas e os valores são os combinados com o investidor, e o dia do pagamento não precisa ser o dia do início do contrato (ex.: início em 10/10 e pagamentos todo dia 25). Gere uma sugestão pela periodicidade a partir da primeira data combinada, ou use o modelo padrão (rendimento periódico até o vencimento final e principal integral na última data). A sugestão só preenche a tabela de revisão abaixo; nada é dividido nem calculado, e nada é gravado antes de você conferir. Você pode alterar qualquer data ou valor, retirar ou acrescentar linhas, ou montar tudo à mão com &ldquo;Linha em branco&rdquo;.</p>
        <label className="field"><span>Periodicidade da sugestão</span><select value={frequency} onChange={(event) => setFrequency(event.target.value as PaymentFrequency)}>
          {options.map((key) => <option key={key} value={key}>{PAYMENT_FREQUENCIES[key]}</option>)}
        </select></label>
        <DateField key={dateKey} label={frequency === "AT_MATURITY" ? "Data do pagamento" : "Data do primeiro pagamento"} name="suggestFirstDueDate" defaultValue={firstDueDate} onChange={setFirstDueDate} />
        {frequency !== "AT_MATURITY" && <label className="field"><span>Dia do pagamento (opcional)</span><input inputMode="numeric" maxLength={2} placeholder="Ex.: 25 (mês curto usa o último dia)" value={dueDay} onChange={(event) => setDueDay(event.target.value.replace(/\D/g, ""))} title="Mês sem esse dia usa o último dia do mês." /></label>}
        {frequency !== "AT_MATURITY" && <label className="field"><span>Quantidade de pagamentos</span><input inputMode="numeric" maxLength={3} placeholder="12" value={count} onChange={(event) => setCount(event.target.value.replace(/\D/g, ""))} /></label>}
        <label className="field"><span>{frequency === "AT_MATURITY" ? "Rendimento (R$)" : "Rendimento de cada data (R$)"}</span><input inputMode="decimal" placeholder="1.000,00" value={yieldAmount} onChange={(event) => setYieldAmount(event.target.value)} /></label>
        <label className="field"><span>Devolução do principal na última data (R$)</span><MoneyInput inputMode="decimal" placeholder={centsToInput(investment.amountCents)} value={principalAmount} onChange={(event) => setPrincipalAmount(event.target.value)} /></label>
        <label className="field"><span>Observação (opcional)</span><input maxLength={200} placeholder="Ex.: rendimento mensal" value={description} onChange={(event) => setDescription(event.target.value)} /></label>
        <div className="form-actions"><button type="button" className="outline-button" onClick={useDefaultModel}>Usar modelo padrão</button><button type="button" className="outline-button" onClick={suggest}>Sugerir linhas para revisar</button><button type="button" className="outline-button" onClick={() => setLines((current) => [...current, emptyLine()])}><Icon name="plus" size={16} /> Linha em branco</button></div>
        {hint && <p className="form-feedback form-feedback-error field-wide" role="alert">{hint}</p>}
      </div>
      {lines.length > 0 && (
        <form onSubmit={onSubmit} aria-label="Revisão das linhas">
          <input type="hidden" name="investmentId" value={investment.id} />
          <input type="hidden" name="mode" value={mode} />
          <input type="hidden" name="seen" value={schedule.version} />
          <input type="hidden" name="lines" value={JSON.stringify(lines)} />
          <div className="table-scroll"><table className="data-table lines-editor" aria-label="Linhas para revisar">
            <thead><tr><th>#</th><th>Vencimento</th><th>Tipo</th><th>Rendimento (R$)</th><th>Principal (R$)</th><th>Observação</th><th /></tr></thead>
            <tbody>{lines.map((line, index) => (
              <tr key={index}>
                <td>{index + 1}</td>
                <td><input type="date" aria-label={`Vencimento da linha ${index + 1}`} value={line.dueDate} onChange={(event) => update(index, { dueDate: event.target.value })} required /></td>
                <td><select aria-label={`Tipo da linha ${index + 1}`} value={line.kind} onChange={(event) => update(index, { kind: event.target.value })}>
                  {(Object.keys(LINE_KINDS) as LineKind[]).map((key) => <option key={key} value={key}>{LINE_KINDS[key]}</option>)}
                </select></td>
                <td><MoneyInput aria-label={`Rendimento da linha ${index + 1}`} inputMode="decimal" value={line.yieldAmount} disabled={line.kind === "PRINCIPAL"} onChange={(event) => update(index, { yieldAmount: event.target.value })} /></td>
                <td><MoneyInput aria-label={`Principal da linha ${index + 1}`} inputMode="decimal" value={line.principalAmount} disabled={line.kind === "YIELD"} onChange={(event) => update(index, { principalAmount: event.target.value })} /></td>
                <td><input aria-label={`Observação da linha ${index + 1}`} maxLength={200} value={line.description ?? ""} onChange={(event) => update(index, { description: event.target.value })} /></td>
                <td><button type="button" className="text-link" onClick={() => setLines((current) => current.filter((_, position) => position !== index))}>Retirar</button></td>
              </tr>
            ))}</tbody>
          </table></div>
          <p className="capital-note">{lines.length} {lines.length === 1 ? "linha" : "linhas"}: rendimento {formatMoney(totals.yieldCents)} e devolução de principal {formatMoney(totals.principalCents)} (valor do contrato {formatMoney(investment.amountCents)}). O total do cronograma não precisa ser igual ao principal; só a devolução de principal não pode passar do valor do contrato.</p>
          {mode === "replace" && schedule.items.length > 0 && (
            <label className="check-field"><input type="checkbox" name="replace" value="1" required /><span>{`Substituir o cronograma atual (${schedule.items.length} ${schedule.items.length === 1 ? "pagamento" : "pagamentos"}). Fica registrado no histórico.`}</span></label>
          )}
          <div className="form-actions">
            <button type="button" className="outline-button" onClick={onCancel}>Cancelar</button>
            <button className="primary-button" disabled={pending}><Icon name="check" size={16} /> {pending ? "Gravando…" : mode === "replace" ? "Gravar cronograma revisado" : "Incluir as linhas revisadas"}</button>
          </div>
        </form>
      )}
      <Feedback feedback={feedback} />
    </div>
  );
}
