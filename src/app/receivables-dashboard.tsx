"use client";

import Link from "next/link";
import { formatDate, formatMoney } from "@/lib/finance/format";
import type { ReceivableRow, ReceivablesOverview } from "@/lib/finance/receivables";
import type { ChargesView } from "./portfolio-pages";
import { Icon } from "./ui-icon";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
type Tone = "amber" | "red" | "cyan" | "green";

// Card no padrão do painel Contas a pagar. Os que levam à tela Cobranças abrem já no filtro certo.
function ReceivableKpi({ label, value, caption, tone, alert, filter, href = "/?tela=cobrancas", onOpen }: { label: string; value: string; caption: string; tone: Tone | "blue"; alert?: boolean; filter?: ChargesView | "Pagamentos de hoje"; href?: string; onOpen: (filter: ChargesView | "Pagamentos de hoje") => void }) {
  const className = `payables-kpi payables-kpi-${tone}${alert ? " payables-kpi-alert" : ""}`;
  if (!filter) return <div className={className}><span>{label}</span><strong>{value}</strong><small>{caption}</small></div>;
  return (
    <Link prefetch={false} href={href} className={className} onClick={(event) => { event.preventDefault(); onOpen(filter); }}>
      <span>{label}</span><strong>{value}</strong><small>{caption}</small>
    </Link>
  );
}

function Row({ row, late }: { row: ReceivableRow; late: boolean }) {
  return (
    <div className="payables-row">
      <div className="charge-person"><strong>{row.clientName}</strong><small>{row.detail} · vence {formatDate(row.dueDate)}</small></div>
      <span className={`status-chip ${late ? "status-late" : "status-due"}`}><i />{late ? "Em atraso" : "Vence hoje"}</span>
      <strong className="charge-amount">{formatMoney(row.amountCents)}</strong>
    </div>
  );
}

// Contas a receber no Dashboard: calculado no servidor, das mesmas operações em aberto da tela Cobranças
// (receivablesOverview). Atrasado, a receber hoje, próximos 7 dias e recebido hoje ficam separados; o total é o saldo
// em aberto da carteira (principal + juros que ainda faltam), o mesmo do card "Total a receber".
export function ReceivablesDashboard({ overview, onOpen, onOpenPayments }: { overview: ReceivablesOverview; onOpen: (filter: ChargesView) => void; onOpenPayments?: () => void }) {
  const open = (filter: ChargesView | "Pagamentos de hoje") => (filter === "Pagamentos de hoje" ? onOpenPayments?.() : onOpen(filter));
  return (
    <section className="panel payables-dashboard" aria-label="Contas a receber">
      <div className="panel-header">
        <div><div className="panel-title-row"><h2>Contas a receber</h2><span className="today-count">{overview.dueTodayCount}</span></div><p>Cobranças dos clientes · {formatDate(overview.today)}</p></div>
        <Link prefetch={false} className="outline-button" href="/?tela=cobrancas" onClick={(event) => { event.preventDefault(); onOpen("Em aberto"); }}>Abrir Cobranças <Icon name="arrow" size={14} /></Link>
      </div>
      <div className="payables-kpis" role="group" aria-label="Indicadores das contas a receber">
        <ReceivableKpi tone="red" alert={overview.overdueCount > 0} label="Em atraso" value={formatMoney(overview.overdueCents)} filter="Em atraso" onOpen={open}
          caption={overview.overdueCount ? `${plural(overview.overdueCount, "operação", "operações")} em atraso` : "Nada em atraso"} />
        <ReceivableKpi tone="amber" label="A receber hoje" value={formatMoney(overview.dueTodayCents)} filter="Hoje" onOpen={open}
          caption={overview.dueTodayCount ? plural(overview.dueTodayCount, "operação vence hoje", "operações vencem hoje") : "Nada vence hoje"} />
        <ReceivableKpi tone="cyan" label="Próximos 7 dias" value={formatMoney(overview.upcomingCents)} filter="Próximas" onOpen={open}
          caption={`${plural(overview.upcomingCount, "operação", "operações")} até ${formatDate(overview.upcomingUntil)}`} />
        <ReceivableKpi tone="green" label="Recebido hoje" value={formatMoney(overview.receivedTodayCents)} filter={onOpenPayments ? "Pagamentos de hoje" : undefined} href="/?tela=pagamentos" onOpen={open} caption={plural(overview.receivedTodayCount, "pagamento", "pagamentos")} />
        <ReceivableKpi tone="blue" label="Total a receber" value={formatMoney(overview.totalCents)} filter="Em aberto" onOpen={open}
          caption={`${plural(overview.openCount, "operação ativa", "operações ativas")} · principal + juros`} />
      </div>
      {overview.overdueCount > 0 && (
        <p className="payables-alert" role="note"><Icon name="alert" size={15} /> {plural(overview.overdueCount, "operação com cobrança atrasada", "operações com cobranças atrasadas")} ({formatMoney(overview.overdueCents)}). <Link prefetch={false} className="text-link inline-link" href="/?tela=cobrancas" onClick={(event) => { event.preventDefault(); onOpen("Em atraso"); }}>Ver em atraso</Link></p>
      )}
      <div className="payables-lists">
        <div aria-label="Em atraso" role="region">
          <h3>Em atraso <small>mais antigas primeiro</small></h3>
          {overview.overdueList.length === 0 ? <p className="empty-state">Nenhuma cobrança em atraso.</p> : overview.overdueList.map((row) => <Row key={row.operationId} row={row} late />)}
          {overview.overdueCount > overview.overdueList.length && <Link prefetch={false} className="activity-link" href="/?tela=cobrancas" onClick={(event) => { event.preventDefault(); onOpen("Em atraso"); }}>Ver as {overview.overdueCount} em atraso <Icon name="arrow" size={14} /></Link>}
        </div>
        <div aria-label="Vencem hoje (a receber)" role="region">
          <h3>Vencem hoje</h3>
          {overview.todayList.length === 0 ? <p className="empty-state">Nada para receber hoje.</p> : overview.todayList.map((row) => <Row key={row.operationId} row={row} late={false} />)}
          {overview.dueTodayCount > overview.todayList.length && <Link prefetch={false} className="activity-link" href="/?tela=cobrancas" onClick={(event) => { event.preventDefault(); onOpen("Hoje"); }}>Ver as {overview.dueTodayCount} de hoje <Icon name="arrow" size={14} /></Link>}
        </div>
      </div>
    </section>
  );
}
