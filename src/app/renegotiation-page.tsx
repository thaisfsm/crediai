"use client";

// Renegociação (Etapa H): escolher o cliente e as operações em aberto, simular as novas condições e GRAVAR. Gravar encerra as
// operações antigas como "Renegociada", cria o contrato novo ligado a elas e não move dinheiro do capital (renegotiateAction).
import { useState, useTransition } from "react";
import { addDays, formatDate, formatMoney, formatRate, parseMoneyToCents, parseLoanRateToBps } from "@/lib/finance/format";
import type { TenantPortfolio } from "@/lib/finance/queries";
import { renegotiateAction } from "./renegotiation-actions";
import { renegotiationContract, renegotiationPosition, simulateRenegotiation, type RenegotiationFrequency, type RenegotiationModality } from "@/lib/finance/renegotiation";
import { DateField } from "./date-field";
import { EmptyPanel, PageHeading } from "./portfolio-pages";

const stateLabel: Record<string, string> = { ACTIVE: "Ativa", DUE_TODAY: "Vence hoje", OVERDUE: "Em atraso" };

export function RenegotiationPage({ portfolio }: { portfolio: TenantPortfolio }) {
  const open = portfolio.operations.filter((operation) => operation.status === "OPEN");
  const clientIds = [...new Set(open.map((operation) => operation.clientId))];
  const clients = clientIds.map((id) => ({ id, name: open.find((operation) => operation.clientId === id)?.clientName ?? "" })).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  const [clientId, setClientId] = useState("");
  const [excluded, setExcluded] = useState<string[]>([]);
  const [adjustmentKind, setAdjustmentKind] = useState<"NONE" | "DISCOUNT" | "ADDITION">("NONE");
  const [adjustment, setAdjustment] = useState("");
  const [adjustmentReason, setAdjustmentReason] = useState("");
  const [penalty, setPenalty] = useState("");
  const [modality, setModality] = useState<RenegotiationModality>("INSTALLMENT");
  const [frequency, setFrequency] = useState<RenegotiationFrequency>("MONTHLY");
  const [rate, setRate] = useState("");
  const [count, setCount] = useState("3");
  const [firstDueDate, setFirstDueDate] = useState(addDays(portfolio.today, 30));
  const [confirmed, setConfirmed] = useState(false);
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const operations = open.filter((operation) => operation.clientId === clientId);
  const chosen = operations.filter((operation) => !excluded.includes(operation.id));
  const position = renegotiationPosition(chosen);
  const rateBps = parseLoanRateToBps(rate);
  const adjustmentCents = adjustmentKind === "NONE" ? 0 : parseMoneyToCents(adjustment);
  const periods = modality === "INSTALLMENT" ? (/^\d{1,3}$/.test(count) ? Number(count) : NaN) : 1;
  const penaltyCents = penalty.trim() ? parseMoneyToCents(penalty) : 0;
  // Desconto, acréscimo ou multa só entram com motivo (D-H1).
  const needsReason = adjustmentKind !== "NONE" || (penaltyCents ?? 0) > 0;
  const reasonMissing = needsReason && adjustmentReason.trim().length < 3;
  const ready = chosen.length > 0 && !reasonMissing && penaltyCents !== null && rateBps !== null && rateBps <= 100_000 && adjustmentCents !== null && Number.isInteger(periods) && periods >= 1 && periods <= 360 && /^\d{4}-\d{2}-\d{2}$/.test(firstDueDate);
  const result = ready ? simulateRenegotiation(position, { modality, frequency, rateBps: rateBps as number, count: periods, firstDueDate, adjustmentCents: adjustmentKind === "DISCOUNT" ? -(adjustmentCents as number) : (adjustmentCents as number), penaltyCents: penaltyCents as number }) : null;
  const contract = result ? renegotiationContract(position, { modality, frequency, rateBps: rateBps as number, count: periods, firstDueDate, adjustmentCents: adjustmentKind === "DISCOUNT" ? -(adjustmentCents as number) : (adjustmentCents as number), penaltyCents: penaltyCents as number }, portfolio.today) : null;
  const save = () => {
    const data = new FormData();
    data.set("clientId", clientId);
    for (const operation of chosen) data.append("operationIds", operation.id);
    data.set("modality", modality); data.set("frequency", frequency); data.set("rate", rate); data.set("count", String(periods)); data.set("firstDueDate", firstDueDate);
    data.set("adjustmentKind", adjustmentKind); data.set("adjustment", adjustment); data.set("penalty", penalty); data.set("reason", adjustmentReason); data.set("confirm", confirmed ? "1" : "0");
    setFeedback(null);
    startTransition(async () => {
      try {
        const saved = await renegotiateAction(data);
        if (saved.ok) { setFeedback({ tone: "ok", text: saved.message }); setClientId(""); setExcluded([]); setConfirmed(false); setRate(""); setAdjustment(""); setAdjustmentReason(""); setAdjustmentKind("NONE"); setPenalty(""); }
        else setFeedback({ tone: "error", text: saved.error });
      } catch { setFeedback({ tone: "error", text: "Não foi possível gravar a renegociação. Nada foi alterado; tente novamente." }); }
    });
  };
  const periodWord = frequency === "BIWEEKLY" ? "quinzena" : "mês";
  return (
    <div className="workspace-page">
      <PageHeading eyebrow="CREDIAI · RENEGOCIAÇÃO" title="Renegociação" description="Renegociação integral do contrato: escolha as operações em aberto de um cliente, simule as novas condições e grave. As antigas ficam como renegociadas e o novo contrato guarda o vínculo." />
      <p className="capital-note">Para adiar só UMA parcela para o final do contrato (com acréscimo ou multa), não use esta página: abra a operação (botão “Registrar pagamento” em Operações): na tabela de parcelas use “Renegociar parcela”. O contrato não é refeito.</p>
      {feedback && <p className={`form-feedback ${feedback.tone === "ok" ? "" : "form-feedback-error"}`} role="status">{feedback.text}</p>}
      <section className="panel form-panel" aria-label="Operações a renegociar">
        <div className="panel-header"><div><h2>1. Cliente e operações</h2><p>Só operações em aberto do ciclo atual.</p></div></div>
        {clients.length === 0 ? <EmptyPanel icon="wallet" text="Nenhuma operação em aberto para renegociar." /> : (
          <>
            <div className="form-grid">
              <label className="field field-wide"><span>Cliente</span><select value={clientId} onChange={(event) => { setClientId(event.target.value); setExcluded([]); }}>
                <option value="">Escolha o cliente</option>{clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
              </select></label>
            </div>
            {operations.length > 0 && (
              <div className="table-scroll"><table className="data-table">
                <thead><tr><th>Incluir</th><th>Operação</th><th>Empréstimo</th><th>Principal em aberto</th><th>Juros em aberto</th><th>Saldo para quitação</th><th>Situação</th></tr></thead>
                <tbody>{operations.map((operation) => (
                  <tr key={operation.id}>
                    <td><input type="checkbox" aria-label={`Incluir #${operation.code}`} checked={!excluded.includes(operation.id)} onChange={(event) => setExcluded(event.target.checked ? excluded.filter((id) => id !== operation.id) : [...excluded, operation.id])} /></td>
                    <td><strong>#{operation.code}</strong></td><td>{formatDate(operation.loanDate)}</td><td>{formatMoney(operation.principalRemainingCents)}</td><td>{formatMoney(operation.interestRemainingCents)}</td>
                    <td><strong>{formatMoney(operation.balanceCents)}</strong></td><td>{stateLabel[operation.state] ?? operation.state}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </>
        )}
      </section>

      {chosen.length > 0 && (
        <section className="panel form-panel" aria-label="Novas condições">
          <div className="panel-header"><div><h2>2. Novas condições</h2><p>{`Posição atual de ${chosen.length} ${chosen.length === 1 ? "operação" : "operações"}: principal em aberto ${formatMoney(position.principalOpenCents)}, juros em aberto ${formatMoney(position.interestOpenCents)}, saldo ${formatMoney(position.balanceCents)}.`}</p></div></div>
          <div className="modality-switch" role="radiogroup" aria-label="Nova modalidade">
            <button type="button" role="radio" aria-checked={modality === "SINGLE"} className={modality === "SINGLE" ? "is-active" : ""} onClick={() => setModality("SINGLE")}>Pagamento único</button>
            <button type="button" role="radio" aria-checked={modality === "INSTALLMENT"} className={modality === "INSTALLMENT" ? "is-active" : ""} onClick={() => setModality("INSTALLMENT")}>Parcelado</button>
          </div>
          <div className="modality-switch frequency-switch" role="radiogroup" aria-label="Nova periodicidade">
            <button type="button" role="radio" aria-checked={frequency === "MONTHLY"} className={frequency === "MONTHLY" ? "is-active" : ""} onClick={() => setFrequency("MONTHLY")}>Mensal</button>
            <button type="button" role="radio" aria-checked={frequency === "BIWEEKLY"} className={frequency === "BIWEEKLY" ? "is-active" : ""} onClick={() => setFrequency("BIWEEKLY")}>Quinzenal</button>
          </div>
          <div className="form-grid">
            <label className="field"><span>Ajuste</span><select value={adjustmentKind} onChange={(event) => setAdjustmentKind(event.target.value as typeof adjustmentKind)}>
              <option value="NONE">Sem ajuste</option><option value="DISCOUNT">Desconto</option><option value="ADDITION">Acréscimo</option>
            </select></label>
            {adjustmentKind !== "NONE" && <label className="field"><span>{adjustmentKind === "DISCOUNT" ? "Valor do desconto (R$)" : "Valor do acréscimo (R$)"}</span><input inputMode="decimal" placeholder="0,00" value={adjustment} onChange={(event) => setAdjustment(event.target.value)} /></label>}
            <label className="field"><span>Multa na última parcela (R$)</span><input inputMode="decimal" placeholder="0,00" value={penalty} onChange={(event) => setPenalty(event.target.value)} /></label>
            {needsReason && <label className="field field-wide"><span>{adjustmentKind === "NONE" ? "Motivo da multa" : adjustmentKind === "DISCOUNT" ? "Motivo do desconto" : "Motivo do acréscimo"}</span><input maxLength={300} placeholder="Ex.: parcela em atraso jogada para o final" value={adjustmentReason} onChange={(event) => setAdjustmentReason(event.target.value)} /></label>}
            <label className="field"><span>{`Taxa de juros por ${periodWord} (%)`}</span><input inputMode="decimal" placeholder="5" value={rate} onChange={(event) => setRate(event.target.value)} /></label>
            {modality === "INSTALLMENT" && <label className="field"><span>{frequency === "BIWEEKLY" ? "Quantidade de parcelas (quinzenas)" : "Quantidade de parcelas (meses)"}</span><input inputMode="numeric" maxLength={3} value={count} onChange={(event) => setCount(event.target.value.replace(/\D/g, ""))} /></label>}
            <DateField label={modality === "INSTALLMENT" ? "Primeiro vencimento" : "Vencimento"} name="simulationFirstDue" defaultValue={firstDueDate} onChange={setFirstDueDate} />
          </div>
          <p className="capital-note">{"A multa é somada só à última parcela (a parcela em atraso que vai para o final). As demais parcelas ficam iguais."}</p>
          {reasonMissing && <p className="form-feedback form-feedback-warning">Informe o motivo para ver a simulação.</p>}
        </section>
      )}

      {result && (
        <section className="panel form-panel" aria-label="Resultado da simulação">
          <div className="panel-header"><div><h2>3. Resultado da simulação</h2><p>Juros simples sobre o principal em aberto; os juros em aberto entram como valor fixo, sem juros sobre juros.</p></div></div>
          <dl className="payment-summary">
            <div><dt>Saldo atual (antes)</dt><dd>{formatMoney(position.balanceCents)}</dd></div>
            <div><dt>Principal em aberto (base dos juros)</dt><dd>{formatMoney(result.baseCents)}</dd></div>
            <div><dt>Juros em aberto incorporados</dt><dd>{formatMoney(result.carriedInterestCents)}</dd></div>
            <div><dt>{result.adjustmentCents < 0 ? "Desconto" : "Acréscimo"}</dt><dd>{formatMoney(Math.abs(result.adjustmentCents))}</dd></div>
            {result.penaltyCents > 0 && <div><dt>Multa (na última parcela)</dt><dd>{formatMoney(result.penaltyCents)}</dd></div>}
            <div><dt>Valor renegociado</dt><dd>{formatMoney(result.renegotiatedCents)}</dd></div>
            <div><dt>{`Juros novos (${formatRate(rateBps as number)} por ${periodWord}${modality === "INSTALLMENT" ? ` × ${periods}` : ""})`}</dt><dd>{formatMoney(result.newInterestCents)}</dd></div>
            <div className="payment-balance"><dt>Total a receber (depois)</dt><dd>{formatMoney(result.totalCents)}</dd></div>
          </dl>
          {result.warnings.map((warning) => <p key={warning} className="form-feedback form-feedback-warning">{warning}</p>)}
          <div className="schedule-preview" aria-label="Pagamentos simulados">
            <p><strong>{modality === "INSTALLMENT" ? "Parcelas simuladas" : "Pagamento simulado"}</strong>{modality === "SINGLE" ? ` · pagando só os juros (${formatMoney(result.periodInterestCents)}), o período renovaria, como nas operações de hoje` : ""}</p>
            <ol>{result.payments.map((payment) => <li key={payment.number}><span>{modality === "INSTALLMENT" ? `Parcela ${payment.number}` : "Quitação"}</span><strong>{formatDate(payment.dueDate)}</strong><span>{formatMoney(payment.amountCents)}</span></li>)}</ol>
          </div>
          {needsReason && <p className="muted-cell">{`Motivo: ${adjustmentReason.trim()}`}</p>}
          <div className="table-scroll"><table className="data-table renegotiation-compare" aria-label="Atual e proposta">
            <thead><tr><th>Comparação</th><th>Hoje</th><th>Proposta</th></tr></thead>
            <tbody>
              <tr><td>Principal em aberto</td><td>{formatMoney(result.comparison.principal.current)}</td><td>{formatMoney(result.comparison.principal.proposal)}</td></tr>
              <tr><td>Juros a receber</td><td>{formatMoney(result.comparison.interest.current)}</td><td>{formatMoney(result.comparison.interest.proposal)}</td></tr>
              <tr><td>Total a receber</td><td><strong>{formatMoney(result.comparison.total.current)}</strong></td><td><strong>{formatMoney(result.comparison.total.proposal)}</strong></td></tr>
              <tr><td>Último vencimento</td><td>{formatDate(chosen.reduce((last, operation) => operation.dueDate > last ? operation.dueDate : last, chosen[0].dueDate))}</td><td>{formatDate(result.payments[result.payments.length - 1].dueDate)}</td></tr>
              <tr><td>Lucro realizado (juros recebidos)</td><td>{formatMoney(result.comparison.realizedProfit.current)}</td><td>{formatMoney(result.comparison.realizedProfit.proposal)}</td></tr>
              <tr><td>Saída de caixa na renegociação</td><td>—</td><td>{formatMoney(result.comparison.capitalOutflowCents)}</td></tr>
            </tbody>
          </table></div>
          <p className="capital-note">Ao gravar: nenhum dinheiro sai do capital, porque o principal do contrato novo é o mesmo já emprestado. Os juros em aberto passam para o contrato novo e só viram lucro quando forem pagos; os juros já recebidos continuam registrados nas operações antigas, que ficam como Renegociada, com o histórico intacto e o vínculo com o contrato novo.</p>
          {contract && !contract.ok && !contract.error.startsWith("O desconto") && <p className="form-feedback form-feedback-warning">{contract.error}</p>}
          {contract?.ok && contract.roundingCents > 0 && <p className="muted-cell">{`Parcela fixa arredondada para cima: o total do contrato fica ${formatMoney(contract.roundingCents)} acima da simulação (centavos somados aos juros).`}</p>}
          <label className="field-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> <span>{`Confirmo: encerrar ${chosen.length === 1 ? "a operação" : `as ${chosen.length} operações`} como renegociada${chosen.length === 1 ? "" : "s"} e criar o contrato novo de ${formatMoney(result.totalCents)}.`}</span></label>
          <div className="form-actions"><button type="button" className="primary-button" disabled={!confirmed || pending || !contract?.ok} onClick={save}>{pending ? "Gravando…" : "Gravar renegociação"}</button></div>
        </section>
      )}
    </div>
  );
}
