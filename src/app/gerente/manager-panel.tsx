"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { authClient } from "@/lib/auth-client";
import { formatDate, formatMoney } from "@/lib/finance/format";
import type { ClientSituation } from "@/lib/managers/commission";
import type { ManagerClientCard, ManagerPanel } from "@/lib/managers/queries";
import { setManagerThemeAction } from "./actions";
import type { ManagerTheme } from "./theme";

const SITUATION: Record<ClientSituation, { label: string; tone: string }> = {
  OVERDUE: { label: "Em atraso", tone: "bad" }, ON_TIME: { label: "Em dia", tone: "good" }, PAID: { label: "Quitado", tone: "done" }, NO_OPERATIONS: { label: "Sem operações", tone: "idle" },
};
const OPERATION_STATE: Record<string, { label: string; tone: string }> = {
  ACTIVE: { label: "Em dia", tone: "good" }, DUE_TODAY: { label: "Vence hoje", tone: "warn" }, OVERDUE: { label: "Em atraso", tone: "bad" },
  PAID: { label: "Quitada", tone: "done" }, RENEGOTIATED: { label: "Renegociada", tone: "idle" }, CANCELED: { label: "Cancelada", tone: "idle" },
};
const percent = (bps: number) => `${(bps / 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;
const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
const dueText = (iso: string | null, today: string) => {
  if (!iso) return "—";
  const days = Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  return `${formatDate(iso)}${days === 0 ? " · hoje" : days > 0 ? ` · em ${days} ${days === 1 ? "dia" : "dias"}` : ` · ${-days} ${days === -1 ? "dia" : "dias"} atrás`}`;
};

function Donut({ slices }: { slices: { value: number; color: string; label: string }[] }) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  const radius = 52, circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <svg viewBox="0 0 140 140" className="mgr-donut" role="img" aria-label={slices.map((slice) => `${slice.label}: ${slice.value}`).join(", ")}>
      <circle cx="70" cy="70" r={radius} fill="none" stroke="var(--track)" strokeWidth="14" />
      {total > 0 && slices.filter((slice) => slice.value > 0).map((slice) => {
        const length = (slice.value / total) * circumference;
        const circle = <circle key={slice.label} cx="70" cy="70" r={radius} fill="none" stroke={slice.color} strokeWidth="14" strokeLinecap="butt" strokeDasharray={`${Math.max(0, length - 2)} ${circumference}`} strokeDashoffset={-offset} transform="rotate(-90 70 70)" />;
        offset += length;
        return circle;
      })}
      <text x="70" y="66" textAnchor="middle" className="mgr-donut-number">{total}</text>
      <text x="70" y="84" textAnchor="middle" className="mgr-donut-label">{total === 1 ? "cliente" : "clientes"}</text>
    </svg>
  );
}

function ClientCard({ card, today, open, onToggle }: { card: ManagerClientCard; today: string; open: boolean; onToggle: () => void }) {
  const situation = SITUATION[card.situation];
  return (
    <li className={`mgr-client mgr-tone-${situation.tone}`}>
      <button type="button" className="mgr-client-head" aria-expanded={open} onClick={onToggle}>
        <span className="mgr-avatar" aria-hidden="true">{initials(card.name)}</span>
        <span className="mgr-client-name"><strong>{card.name}</strong>
          <small>{card.openCount > 0 ? `${card.openCount} ${card.openCount === 1 ? "operação ativa" : "operações ativas"}` : card.paidCount > 0 ? `${card.paidCount} ${card.paidCount === 1 ? "operação quitada" : "operações quitadas"}` : "Nenhuma operação ainda"}</small></span>
        <span className="mgr-client-figures">
          <span><small>Saldo em aberto</small><strong>{formatMoney(card.balanceCents)}</strong></span>
          <span><small>Próximo vencimento</small><strong>{dueText(card.nextDueDate, today)}</strong></span>
          <span><small>Sua comissão ({percent(card.commissionBps)})</small><strong>{formatMoney(card.commissionCents)}</strong></span>
        </span>
        <span className={`mgr-chip mgr-chip-${situation.tone}`}><i />{situation.label}{card.situation === "OVERDUE" && card.worstDaysLate > 0 ? ` · ${card.worstDaysLate} ${card.worstDaysLate === 1 ? "dia" : "dias"}` : ""}</span>
        <span className="mgr-caret" aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="mgr-ops">
          {card.operations.length === 0 ? <p className="mgr-empty">Este cliente ainda não tem operações.</p> : (
            <table>
              <thead><tr><th>Operação</th><th>Emprestado em</th><th>Valor</th><th>Pago</th><th>Saldo</th><th>Vencimento</th><th>Situação</th></tr></thead>
              <tbody>
                {card.operations.map((operation) => {
                  const state = OPERATION_STATE[operation.state] ?? { label: operation.state, tone: "idle" };
                  return (
                    <tr key={operation.id}>
                      <td data-label="Operação"><strong>{operation.code}</strong></td>
                      <td data-label="Emprestado em">{formatDate(operation.loanDate)}</td>
                      <td data-label="Valor">{formatMoney(operation.principalCents)}</td>
                      <td data-label="Pago">{formatMoney(operation.paidCents)}</td>
                      <td data-label="Saldo"><strong>{formatMoney(operation.balanceCents)}</strong></td>
                      <td data-label="Vencimento">{operation.nextDueDate ? <>{formatDate(operation.nextDueDate)}{operation.installment && <small> · {operation.installment}</small>}</> : "—"}</td>
                      <td data-label="Situação"><span className={`mgr-chip mgr-chip-${state.tone}`}><i />{state.label}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </li>
  );
}

export function ManagerPanelView({ panel, initialTheme }: { panel: ManagerPanel; initialTheme: ManagerTheme }) {
  const router = useRouter();
  const [theme, setTheme] = useState<ManagerTheme>(initialTheme);
  const [, startTransition] = useTransition();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"ALL" | ClientSituation>("ALL");
  const [openId, setOpenId] = useState<string | null>(null);
  const { summary, counts, today } = panel;
  const chooseTheme = (next: ManagerTheme) => { setTheme(next); startTransition(() => { void setManagerThemeAction(next); }); };
  const fold = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const shown = useMemo(() => panel.clients.filter((card) => (filter === "ALL" || card.situation === filter) && (!query.trim() || fold(card.name).includes(fold(query.trim())))), [panel.clients, filter, query]);
  const firstName = panel.managerName.trim().split(/\s+/)[0];
  const totalGross = summary.earnedCents + summary.expectedCents;
  const pct = (value: number) => (totalGross > 0 ? Math.max(0, Math.min(100, (value / totalGross) * 100)) : 0);
  const filters: { key: "ALL" | ClientSituation; label: string; count: number }[] = [
    { key: "ALL", label: "Todos", count: counts.clients }, { key: "ON_TIME", label: "Em dia", count: counts.onTime }, { key: "OVERDUE", label: "Em atraso", count: counts.overdue }, { key: "PAID", label: "Quitados", count: counts.paid },
  ];
  return (
    <div className="mgr-root" data-theme={theme}>
      <div className="mgr-aurora" aria-hidden="true" />
      <header className="mgr-top">
        <div className="mgr-brand"><span className="mgr-logo" aria-hidden="true">C</span><span>CrediAI</span><em>Painel da gerente</em></div>
        <div className="mgr-top-actions">
          <div className="mgr-theme" role="group" aria-label="Cor do painel">
            <button type="button" className={theme === "padrao" ? "active" : ""} aria-pressed={theme === "padrao"} onClick={() => chooseTheme("padrao")}><i className="swatch swatch-default" />Padrão</button>
            <button type="button" className={theme === "roxo" ? "active" : ""} aria-pressed={theme === "roxo"} onClick={() => chooseTheme("roxo")}><i className="swatch swatch-purple" />Roxo</button>
          </div>
          <span className="mgr-user">{panel.userName}</span>
          <button type="button" className="mgr-signout" onClick={async () => { await authClient.signOut(); router.replace("/login"); router.refresh(); }}>Sair</button>
        </div>
      </header>

      <main className="mgr-main">
        <section className="mgr-hero" aria-label="Resumo da sua comissão">
          <div className="mgr-hero-card">
            <p className="mgr-eyebrow">Olá, {firstName}</p>
            <h1>Sua comissão a receber</h1>
            <div className="mgr-hero-value">{formatMoney(summary.balanceCents)}</div>
            <p className="mgr-hero-sub">Calculada sobre os juros que os clientes que você indicou já pagaram.</p>
            <div className="mgr-bar" role="img" aria-label={`Já recebida ${formatMoney(summary.paidOutCents)}, a receber ${formatMoney(summary.balanceCents)}, prevista ${formatMoney(summary.expectedCents)}`}>
              <span className="mgr-bar-paid" style={{ width: `${pct(Math.min(summary.paidOutCents, summary.earnedCents))}%` }} />
              <span className="mgr-bar-due" style={{ width: `${pct(summary.balanceCents)}%` }} />
              <span className="mgr-bar-exp" style={{ width: `${pct(summary.expectedCents)}%` }} />
            </div>
            <ul className="mgr-legend">
              <li><i className="dot paid" />Já recebida <strong>{formatMoney(summary.paidOutCents)}</strong></li>
              <li><i className="dot due" />A receber agora <strong>{formatMoney(summary.balanceCents)}</strong></li>
              <li><i className="dot exp" />Prevista (juros ainda a pagar) <strong>{formatMoney(summary.expectedCents)}</strong></li>
            </ul>
            {summary.advanceCents > 0 && <p className="mgr-note">Você já recebeu {formatMoney(summary.advanceCents)} além do que foi gerado até agora; isso será abatido das próximas comissões.</p>}
          </div>
          <div className="mgr-card mgr-donut-card">
            <h2>Situação dos seus clientes</h2>
            <div className="mgr-donut-wrap">
              <Donut slices={[
                { value: counts.onTime, color: "var(--good)", label: "Em dia" }, { value: counts.overdue, color: "var(--bad)", label: "Em atraso" },
                { value: counts.paid, color: "var(--done)", label: "Quitados" }, { value: counts.none, color: "var(--idle)", label: "Sem operações" },
              ]} />
              <ul className="mgr-legend mgr-legend-col">
                <li><i className="dot good" />Em dia <strong>{counts.onTime}</strong></li>
                <li><i className="dot bad" />Em atraso <strong>{counts.overdue}</strong></li>
                <li><i className="dot done" />Quitados <strong>{counts.paid}</strong></li>
                {counts.none > 0 && <li><i className="dot idle" />Sem operações <strong>{counts.none}</strong></li>}
              </ul>
            </div>
          </div>
        </section>

        <section className="mgr-kpis" aria-label="Indicadores">
          <div className="mgr-card mgr-kpi"><small>Clientes indicados</small><strong>{counts.clients}</strong><span>{counts.openOperations} {counts.openOperations === 1 ? "operação ativa" : "operações ativas"}</span></div>
          <div className="mgr-card mgr-kpi"><small>Juros já pagos por eles</small><strong>{formatMoney(summary.interestReceivedCents)}</strong><span>base da sua comissão</span></div>
          <div className="mgr-card mgr-kpi"><small>Comissão gerada até hoje</small><strong>{formatMoney(summary.earnedCents)}</strong><span>já paga: {formatMoney(summary.paidOutCents)}</span></div>
          <div className="mgr-card mgr-kpi"><small>Carteira indicada em aberto</small><strong>{formatMoney(panel.principalOpenCents)}</strong><span>principal ainda a receber</span></div>
        </section>

        <section className="mgr-card mgr-clients" aria-label="Clientes indicados">
          <div className="mgr-clients-head">
            <div><h2>Seus clientes</h2><p>Tudo que o Fernando atualiza aparece aqui na hora. Somente leitura.</p></div>
            <label className="mgr-search"><span className="sr-only">Buscar cliente</span><input type="search" placeholder="Buscar cliente pelo nome" value={query} onChange={(event) => setQuery(event.target.value)} maxLength={80} /></label>
          </div>
          <div className="mgr-filters" role="group" aria-label="Filtrar por situação">
            {filters.map((item) => <button type="button" key={item.key} className={filter === item.key ? "active" : ""} aria-pressed={filter === item.key} onClick={() => setFilter(item.key)}>{item.label}<span>{item.count}</span></button>)}
          </div>
          {panel.clients.length === 0 ? <p className="mgr-empty">Você ainda não tem clientes indicados. Quando o Fernando ligar um cliente a você, ele aparece aqui.</p>
            : shown.length === 0 ? <p className="mgr-empty">Nenhum cliente encontrado.</p>
            : <ul className="mgr-client-list">{shown.map((card) => <ClientCard key={card.id} card={card} today={today} open={openId === card.id} onToggle={() => setOpenId(openId === card.id ? null : card.id)} />)}</ul>}
        </section>

        <section className="mgr-card mgr-payouts" aria-label="Comissões já recebidas">
          <h2>Comissões já recebidas</h2>
          {panel.payouts.length === 0 ? <p className="mgr-empty">Nenhum pagamento de comissão registrado ainda.</p> : (
            <ul>{panel.payouts.map((payout) => <li key={payout.id}><span>{formatDate(payout.paidOn)}</span><span className="mgr-payout-note">{payout.notes ?? "Pagamento de comissão"}</span><strong>{formatMoney(payout.amountCents)}</strong></li>)}</ul>
          )}
        </section>

        <p className="mgr-footnote">Acesso somente para visualização. Você vê o nome e a situação das operações dos clientes que indicou; dados pessoais dos clientes não aparecem aqui.</p>
      </main>
    </div>
  );
}
