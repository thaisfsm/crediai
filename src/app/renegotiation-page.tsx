"use client";

// Renegociação (Etapa H, parte 1): escolher o cliente e as operações em aberto e simular novas condições.
// SÓ SIMULA: esta tela não chama nenhuma ação do servidor; nada é gravado, encerrado ou lançado no capital.
import { useState } from "react";
import { addDays, formatDate, formatMoney, formatRate, parseMoneyToCents, parseRateToBps } from "@/lib/finance/format";
import type { TenantPortfolio } from "@/lib/finance/queries";
import { renegotiationPosition, simulateRenegotiation, type RenegotiationFrequency, type RenegotiationModality } from "@/lib/finance/renegotiation";
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
  const [modality, setModality] = useState<RenegotiationModality>("INSTALLMENT");
  const [frequency, setFrequency] = useState<RenegotiationFrequency>("MONTHLY");
  const [rate, setRate] = useState("");
  const [count, setCount] = useState("3");
  const [firstDueDate, setFirstDueDate] = useState(addDays(portfolio.today, 30));
  const operations = open.filter((operation) => operation.clientId === clientId);
  const chosen = operations.filter((operation) => !excluded.includes(operation.id));
  const position = renegotiationPosition(chosen);
  const rateBps = parseRateToBps(rate);
  const adjustmentCents = adjustmentKind === "NONE" ? 0 : parseMoneyToCents(adjustment);
  const periods = modality === "INSTALLMENT" ? (/^\d{1,3}$/.test(count) ? Number(count) : NaN) : 1;
  const ready = chosen.length > 0 && rateBps !== null && rateBps <= 100_000 && adjustmentCents !== null && Number.isInteger(periods) && periods >= 1 && periods <= 360 && /^\d{4}-\d{2}-\d{2}$/.test(firstDueDate);
  const result = ready ? simulateRenegotiation(position, { modality, frequency, rateBps: rateBps as number, count: periods, firstDueDate, adjustmentCents: adjustmentKind === "DISCOUNT" ? -(adjustmentCents as number) : (adjustmentCents as number) }) : null;
  const periodWord = frequency === "BIWEEKLY" ? "quinzena" : "mês";
  return (
    <div className="workspace-page">
      <PageHeading eyebrow="CREDIAI · RENEGOCIAÇÃO" title="Renegociação" description="Simule novas condições para as operações em aberto de um cliente. Esta tela só simula: nada é gravado." />
      <p className="form-feedback form-feedback-warning">Simulação apenas. Gravar a renegociação (encerrar as operações antigas e criar a nova) depende das suas decisões D-H1 a D-H4 e ainda não existe.</p>
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
                <thead><tr><th>Incluir</th><th>Operação</th><th>Empréstimo</th><th>Principal em aberto</th><th>Juros em aberto</th><th>Saldo</th><th>Situação</th></tr></thead>
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
            <label className="field"><span>{`Taxa de juros por ${periodWord} (%)`}</span><input inputMode="decimal" placeholder="5" value={rate} onChange={(event) => setRate(event.target.value)} /></label>
            {modality === "INSTALLMENT" && <label className="field"><span>{frequency === "BIWEEKLY" ? "Quantidade de parcelas (quinzenas)" : "Quantidade de parcelas (meses)"}</span><input inputMode="numeric" maxLength={3} value={count} onChange={(event) => setCount(event.target.value.replace(/\D/g, ""))} /></label>}
            <DateField label={modality === "INSTALLMENT" ? "Primeiro vencimento" : "Vencimento"} name="simulationFirstDue" defaultValue={firstDueDate} onChange={setFirstDueDate} />
          </div>
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
            <div><dt>Valor renegociado</dt><dd>{formatMoney(result.renegotiatedCents)}</dd></div>
            <div><dt>{`Juros novos (${formatRate(rateBps as number)} por ${periodWord}${modality === "INSTALLMENT" ? ` × ${periods}` : ""})`}</dt><dd>{formatMoney(result.newInterestCents)}</dd></div>
            <div className="payment-balance"><dt>Total a receber (depois)</dt><dd>{formatMoney(result.totalCents)}</dd></div>
          </dl>
          {result.warnings.map((warning) => <p key={warning} className="form-feedback form-feedback-warning">{warning}</p>)}
          <div className="schedule-preview" aria-label="Pagamentos simulados">
            <p><strong>{modality === "INSTALLMENT" ? "Parcelas simuladas" : "Pagamento simulado"}</strong>{modality === "SINGLE" ? ` · pagando só os juros (${formatMoney(result.periodInterestCents)}), o período renovaria, como nas operações de hoje` : ""}</p>
            <ol>{result.payments.map((payment) => <li key={payment.number}><span>{modality === "INSTALLMENT" ? `Parcela ${payment.number}` : "Quitação"}</span><strong>{formatDate(payment.dueDate)}</strong><span>{formatMoney(payment.amountCents)}</span></li>)}</ol>
          </div>
          <p className="capital-note">Efeito no capital, pela proposta D-H2 (ainda não decidida): nenhum dinheiro sai nem entra na renegociação; o principal em aberto continua emprestado e os juros em aberto incorporados só contam como lucro quando forem pagos.</p>
        </section>
      )}
    </div>
  );
}
