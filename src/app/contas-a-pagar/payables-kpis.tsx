import Link from "next/link";
import { formatDate, formatMoney } from "@/lib/finance/format";
import type { PayablesOverview, PayableTab } from "@/lib/investors/payables";

type Tone = "amber" | "red" | "cyan" | "green";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

// Card clicável no padrão dos indicadores da administração (brilho de cor no topo; vermelho só quando há atraso).
function PayableKpi({ href, label, value, caption, tone, current }: { href: string; label: string; value: string; caption: string; tone?: Tone; current?: boolean }) {
  return (
    <Link prefetch={false} href={href} className={`payables-kpi${tone ? ` payables-kpi-${tone}` : ""}`} aria-current={current ? "page" : undefined}>
      <span>{label}</span><strong>{value}</strong><small>{caption}</small>
    </Link>
  );
}

// Os mesmos cinco cards no Dashboard e na tela Contas a pagar, na ordem das abas (Hoje, Vencidos, Próximos, Pagos) e
// depois o capital. Cada card abre a aba correspondente; `tabHref` deixa a tela manter a busca e os filtros.
export function PayablesKpis({ overview, availableCents, tabHref = (tab) => (tab === "hoje" ? "/contas-a-pagar" : `/contas-a-pagar?aba=${tab}`), currentTab }: {
  overview: PayablesOverview; availableCents: number; tabHref?: (tab: PayableTab) => string; currentTab?: PayableTab;
}) {
  return (
    <div className="payables-kpis" aria-label="Indicadores das contas a pagar" role="group">
      <PayableKpi href={tabHref("hoje")} current={currentTab === "hoje"} tone="amber" label="A pagar hoje" value={formatMoney(overview.dueTodayCents)}
        caption={`Previsto hoje ${formatMoney(overview.expectedTodayCents)} · ${plural(overview.pendingTodayCount, "pendente", "pendentes")}`} />
      <PayableKpi href={tabHref("vencidos")} current={currentTab === "vencidos"} tone={overview.overdueCount ? "red" : undefined} label="Vencidas" value={formatMoney(overview.overdueCents)}
        caption={overview.overdueCount ? `${plural(overview.overdueCount, "obrigação", "obrigações")} em atraso` : "Nada em atraso"} />
      <PayableKpi href={tabHref("proximos")} current={currentTab === "proximos"} tone="cyan" label="Próximos 7 dias" value={formatMoney(overview.upcomingCents)}
        caption={`${plural(overview.upcomingCount, "obrigação", "obrigações")} até ${formatDate(overview.upcomingUntil)}`} />
      <PayableKpi href={tabHref("pagos")} current={currentTab === "pagos"} tone="green" label="Pago hoje" value={formatMoney(overview.paidTodayCents)}
        caption={plural(overview.paidTodayCount, "baixa", "baixas")} />
      <PayableKpi href="/?tela=capital" label="Capital disponível" value={formatMoney(availableCents)} caption="Só a baixa confirmada tira do capital" />
    </div>
  );
}
