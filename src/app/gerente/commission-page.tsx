"use client";

import { formatDate, formatMoney } from "@/lib/finance/format";
import type { ManagerPanel } from "@/lib/managers/queries";
import { EmptyPanel, PageHeading } from "../portfolio-pages";

const percent = (bps: number) => `${(bps / 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;

// "Minha comissão": quanto a gerente já ganhou sobre os juros que os clientes indicados realmente pagaram, quanto já recebeu e quanto falta.
// Só leitura, no mesmo visual das outras telas do app.
export function ManagerCommissionPage({ panel }: { panel: ManagerPanel }) {
  const { summary } = panel;
  return (
    <div className="workspace-page">
      <PageHeading eyebrow="CREDIAI · MINHA COMISSÃO" title="Minha comissão" description="Calculada sobre os juros que os clientes que você indicou já pagaram. O percentual de cada cliente é definido pelo Fernando." />
      <section className="panel form-panel" aria-label="Resumo da comissão">
        <dl className="payment-summary client-highlights">
          <div className="payment-balance"><dt>A receber agora</dt><dd>{formatMoney(summary.balanceCents)}</dd><small>{summary.advanceCents > 0 ? `Você recebeu ${formatMoney(summary.advanceCents)} adiantado` : "Comissão gerada menos o que já foi paga"}</small></div>
          <div><dt>Já recebida</dt><dd>{formatMoney(summary.paidOutCents)}</dd></div>
          <div><dt>Comissão gerada até hoje</dt><dd>{formatMoney(summary.earnedCents)}</dd></div>
          <div><dt>Juros já pagos pelos indicados</dt><dd>{formatMoney(summary.interestReceivedCents)}</dd></div>
          <div><dt>Prevista (juros ainda a pagar)</dt><dd>{formatMoney(summary.expectedCents)}</dd></div>
        </dl>
      </section>
      <section className="panel table-panel" aria-label="Comissão por cliente">
        <div className="panel-header"><div><div className="panel-title-row"><h2>Por cliente</h2><span className="today-count">{panel.clients.length}</span></div><p>Quanto cada cliente indicado já rendeu para você.</p></div></div>
        {panel.clients.length === 0 ? <EmptyPanel icon="users" text="Você ainda não tem clientes indicados." /> : (
          <div className="table-scroll"><table className="data-table">
            <thead><tr><th>Cliente</th><th>Percentual</th><th>Juros pagos</th><th>Sua comissão</th></tr></thead>
            <tbody>{panel.clients.map((client) => <tr key={client.id}><td><strong>{client.name}</strong></td><td>{percent(client.commissionBps)}</td><td>{formatMoney(client.interestReceivedCents)}</td><td><strong>{formatMoney(client.commissionCents)}</strong></td></tr>)}</tbody>
          </table></div>
        )}
      </section>
      <section className="panel table-panel" aria-label="Comissões já recebidas">
        <div className="panel-header"><div><div className="panel-title-row"><h2>Comissões já recebidas</h2><span className="today-count">{panel.payouts.length}</span></div></div></div>
        {panel.payouts.length === 0 ? <EmptyPanel icon="receipt" text="Nenhum pagamento de comissão registrado ainda." /> : (
          <div className="table-scroll"><table className="data-table">
            <thead><tr><th>Data</th><th>Observação</th><th>Valor</th></tr></thead>
            <tbody>{panel.payouts.map((payout) => <tr key={payout.id}><td>{formatDate(payout.paidOn)}</td><td>{payout.notes ?? "—"}</td><td><strong>{formatMoney(payout.amountCents)}</strong></td></tr>)}</tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}
