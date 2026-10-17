"use client";

import Link from "next/link";
import { dayAndMonth, formatDate, formatMoney } from "@/lib/finance/format";
import { obligationDescription, type Obligation, type PayablesOverview } from "@/lib/investors/payables";
import { PayablesKpis } from "./contas-a-pagar/payables-kpis";
import { ObligationStatusChip } from "./contas-a-pagar/payables-ui";
import { Icon } from "./ui-icon";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function ObligationRow({ obligation }: { obligation: Obligation }) {
  return (
    <div className="payables-row">
      <div className="charge-person"><strong>{obligation.investorName}</strong><small>{obligationDescription(obligation)} · {obligation.contractLabel}</small></div>
      <ObligationStatusChip status={obligation.status} />
      <strong className="charge-amount">{formatMoney(obligation.balanceCents > 0 ? obligation.balanceCents : obligation.expectedCents)}</strong>
    </div>
  );
}

// Contas a pagar no Dashboard: o mesmo resumo (payablesOverview) da tela Financeiro → Contas a pagar, calculado no
// servidor com as obrigações da carteira da sessão. Previsto, pago e pendente ficam separados; nada pago entra no pendente.
export function PayablesDashboard({ overview, availableCents }: { overview: PayablesOverview; availableCents: number }) {
  return (
    <section className="panel payables-dashboard" aria-label="Contas a pagar">
      <div className="panel-header">
        <div><div className="panel-title-row"><h2>Contas a pagar</h2><span className="today-count">{overview.pendingTodayCount}</span></div><p>Compromissos com investidores · {formatDate(overview.today)}</p></div>
        <Link prefetch={false} className="outline-button" href="/contas-a-pagar">Abrir Contas a pagar <Icon name="arrow" size={14} /></Link>
      </div>
      <PayablesKpis overview={overview} availableCents={availableCents} />
      {overview.overdueCount > 0 && (
        <p className="payables-alert" role="note"><Icon name="alert" size={15} /> {plural(overview.overdueCount, "obrigação vencida continua", "obrigações vencidas continuam")} em aberto ({formatMoney(overview.overdueCents)}). <Link prefetch={false} className="text-link inline-link" href="/contas-a-pagar?aba=vencidos">Ver vencidas</Link></p>
      )}
      <div className="payables-lists">
        <div aria-label="Vencem hoje" role="region">
          <h3>Vencem hoje</h3>
          {overview.todayList.length === 0 ? <p className="empty-state">Nada vence hoje.</p> : overview.todayList.map((obligation) => <ObligationRow key={obligation.key} obligation={obligation} />)}
          {overview.dueTodayCount > overview.todayList.length && <Link prefetch={false} className="activity-link" href="/contas-a-pagar">Ver todas as {overview.dueTodayCount} de hoje <Icon name="arrow" size={14} /></Link>}
        </div>
        <div aria-label="Próximos compromissos" role="region">
          <h3>Próximos compromissos <small>até {formatDate(overview.upcomingUntil)}</small></h3>
          {overview.upcomingList.length === 0 ? <p className="empty-state">Nenhum compromisso nos próximos dias.</p> : overview.upcomingList.map((obligation) => {
            const date = dayAndMonth(obligation.dueDate);
            return (
              <div className="upcoming-row" key={obligation.key}>
                <span className="next-date-card"><strong>{date.day}</strong><small>{date.month}</small></span>
                <div className="upcoming-copy"><strong>{obligation.investorName}</strong><small>{obligationDescription(obligation)}</small></div>
                <div className="upcoming-amount"><strong>{formatMoney(obligation.balanceCents)}</strong><small>{obligation.status === "PARCIAL" ? "Parcialmente paga" : "Pendente"}</small></div>
              </div>
            );
          })}
          {overview.upcomingCount > 0 && <p className="capital-note">Total nos próximos dias: <strong>{formatMoney(overview.upcomingCents)}</strong> ({plural(overview.upcomingCount, "obrigação", "obrigações")}).</p>}
          <Link prefetch={false} className="activity-link" href="/contas-a-pagar?aba=proximos">Ver próximos <Icon name="arrow" size={14} /></Link>
        </div>
      </div>
    </section>
  );
}
