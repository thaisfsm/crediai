"use client";

import { useState } from "react";
import { formatDate, formatMoney } from "@/lib/finance/format";
import { DELINQUENCY_BANDS, delinquencyOverview, type DelinquencyBand } from "@/lib/finance/delinquency";
import type { TenantPortfolio } from "@/lib/finance/queries";
import { EmptyPanel, PageHeading } from "./portfolio-pages";
import { Icon } from "./ui-icon";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const percent = (bps: number) => `${(bps / 100).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;

// Dashboard → Gestão de inadimplência (só leitura): operações em atraso por faixa de dias, com a lista de cada faixa.
// A partir de 91 dias a operação está em PDD (Provisão de Devedores Duvidosos), tratada como prejuízo.
export function DelinquencyPage({ portfolio, onOpenClient }: { portfolio: TenantPortfolio; onOpenClient: (clientId: string) => void }) {
  const overview = delinquencyOverview(portfolio.operations);
  const [band, setBand] = useState<DelinquencyBand | null>(null);
  const selected = band ? overview.bands.find((item) => item.key === band)! : null;
  const operations = selected ? selected.operations : overview.operations;
  return (
    <div className="workspace-page">
      <PageHeading eyebrow="CREDIAI · DASHBOARD" title="Gestão de inadimplência" description="Operações em atraso por faixa de dias, contados do vencimento em aberto mais antigo (o mesmo atraso das Cobranças). De 91 dias em diante a operação entra em PDD e é tratada como prejuízo." />
      <section className="panel form-panel" aria-label="Resumo da inadimplência">
        <div className="panel-header"><div><h2>Inadimplência da carteira</h2><p>{plural(overview.operationCount, "operação", "operações")} em atraso · {plural(overview.clientCount, "cliente", "clientes")}</p></div></div>
        <dl className="payment-summary">
          <div><dt>Saldo em atraso</dt><dd>{formatMoney(overview.balanceCents)}</dd></div>
          <div><dt>Principal em atraso</dt><dd>{formatMoney(overview.principalRemainingCents)}</dd></div>
          <div className="payment-balance"><dt>Do total a receber ({formatMoney(overview.receivableCents)})</dt><dd>{percent(overview.shareBps)} em atraso</dd></div>
        </dl>
      </section>
      <section className="delinquency-bands" aria-label="Inadimplência por faixa de atraso">
        <h2 className="delinquency-title">Inadimplência por faixa de atraso</h2>
        <div className="metric-grid">
          {overview.bands.map((item) => {
            const pdd = item.key === "91+";
            const active = band === item.key;
            return (
              <button key={item.key} type="button" aria-pressed={active} className={`metric-card metric-card-clickable delinquency-band ${pdd ? "delinquency-band-pdd" : ""} ${active ? "delinquency-band-active" : ""}`} onClick={() => setBand(active ? null : item.key)}>
                <div className="metric-top"><span>{item.label}</span><span className="metric-icon"><Icon name={pdd ? "alert" : "calendar"} size={17} /></span></div>
                <div className="metric-value">{formatMoney(item.balanceCents)}</div>
                <div className="metric-foot"><span className="metric-caption">{plural(item.operationCount, "operação", "operações")} · {plural(item.clientCount, "cliente", "clientes")}</span></div>
                <small className="delinquency-note">{pdd ? "PDD · prejuízo · passar ao cobrador" : `Principal em aberto ${formatMoney(item.principalRemainingCents)}`}</small>
              </button>
            );
          })}
        </div>
      </section>
      <section className="panel table-panel" aria-label="Operações em atraso">
        <div className="panel-header"><div><div className="panel-title-row"><h2>{selected ? `${selected.label}${selected.key === "91+" ? " · PDD" : ""}` : "Todas as faixas"}</h2><span className="today-count">{operations.length}</span></div>
          <p>{selected ? "Clique na mesma faixa para ver todas de novo." : "Clique em uma faixa para ver só as operações dela."} O atraso mais antigo primeiro. Clique no cliente para abrir a ficha.</p></div></div>
        {operations.length === 0 ? <EmptyPanel icon="check" text={selected ? "Nenhuma operação nesta faixa." : "Nenhuma operação em atraso."} /> : (
          <div className="table-scroll">
            <table className="data-table fit-table">
              <thead><tr><th>Cliente</th><th>Operação</th><th>Faixa</th><th>Dias em atraso</th><th>Vencimento em aberto</th><th>Principal em aberto</th><th>Saldo em aberto</th></tr></thead>
              <tbody>
                {operations.map((operation) => (
                  <tr key={operation.id}>
                    <td><button type="button" className="text-link client-link" onClick={() => onOpenClient(operation.clientId)}><strong>{operation.clientName}</strong></button></td>
                    <td>#{operation.code}{operation.nextInstallment ? ` · Parcela ${operation.nextInstallment.number}/${operation.installmentTotal}` : ""}</td>
                    <td>{operation.band === "91+" ? <span className="delinquency-pdd-tag">PDD</span> : DELINQUENCY_BANDS.find((item) => item.key === operation.band)!.label}</td>
                    <td>{operation.daysLate}</td>
                    <td>{operation.nextOpenDueDate ? formatDate(operation.nextOpenDueDate) : "—"}</td>
                    <td>{formatMoney(operation.principalRemainingCents)}</td>
                    <td><strong>{formatMoney(operation.balanceCents)}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
