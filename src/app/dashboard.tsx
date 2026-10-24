"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { dayAndMonth, formatMoney, splitMoney } from "@/lib/finance/format";
import { CHART_VIEWBOX, chartGeometry, type ChartSeries } from "@/lib/finance/chart";
import type { ChargeFilter, ChartPeriod } from "@/lib/finance/portfolio";
import type { TenantPortfolio } from "@/lib/finance/queries";
import { searchPortfolio, type SearchResult } from "@/lib/finance/search";
import { Icon } from "./ui-icon";
import { Sidebar, initialsOfUser, navHref, navKeyFromSlug, useTableLabels, type NavKey } from "./app-shell";
import { RenegotiationPage } from "./renegotiation-page";
import { PayablesDashboard } from "./payables-dashboard";
import { ReceivablesDashboard } from "./receivables-dashboard";
import { receivablesOverview } from "@/lib/finance/receivables";
import type { PayablesOverview } from "@/lib/investors/payables";
import type { ManagerPanel } from "@/lib/managers/queries";
import { ManagerCommissionPage } from "./gerente/commission-page";
import { setManagerThemeAction } from "./gerente/actions";
import { CapitalPage, ChargesPage, ClientsPage, OperationsPage, PaymentsPage, ReportsPage, SettingsPage, WalletSetup, type ChargesView, type OperationsFocus } from "./portfolio-pages";

const chargeFilters: ChargeFilter[] = ["Hoje", "Amanhã", "Próximas", "Em atraso", "Histórico"];
const chargeHeadings: Record<ChargeFilter, { heading: string; description: string; totalLabel: string; empty: string }> = {
  Hoje: { heading: "Cobranças de hoje", description: "Operações com vencimento hoje.", totalLabel: "Total previsto para hoje", empty: "Nenhuma cobrança vence hoje." },
  Amanhã: { heading: "Cobranças de amanhã", description: "Vencimentos previstos para amanhã.", totalLabel: "Total previsto para amanhã", empty: "Nenhuma cobrança vence amanhã." },
  Próximas: { heading: "Próximos vencimentos", description: "Operações que vencem nos próximos 7 dias.", totalLabel: "Total previsto nos próximos dias", empty: "Nenhum vencimento nos próximos 7 dias." },
  "Em atraso": { heading: "Operações em atraso", description: "Vencimentos passados ainda em aberto.", totalLabel: "Saldo em atraso", empty: "Nenhuma operação em atraso." },
  Histórico: { heading: "Histórico de cobranças", description: "Pagamentos registrados na carteira.", totalLabel: "Total recebido", empty: "Nenhum pagamento registrado ainda." },
};

function Money({ cents }: { cents: number }) {
  const { whole, fraction } = splitMoney(cents);
  return <>{whole}<span>{fraction}</span></>;
}

function compactMoney(cents: number) {
  const reais = cents / 100;
  if (reais >= 1_000_000) return `R$ ${(reais / 1_000_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi`;
  if (reais >= 1_000) return `R$ ${(reais / 1_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mil`;
  return `R$ ${Math.round(reais).toLocaleString("pt-BR")}`;
}

function WalletChart({ series }: { series: ChartSeries }) {
  const { peak, top, points } = chartGeometry(series);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const active = activeIndex === null ? null : points[activeIndex];
  const line = points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
  const area = `${line} L 688 190 L 96 190 Z`;
  const current = series.values.at(-1) ?? 0;
  // Posição em % da caixa do SVG (preserveAspectRatio="none" estica o viewBox inteiro sobre ela).
  const left = (x: number) => `${(x / CHART_VIEWBOX.width) * 100}%`;
  const topOf = (y: number) => `${(y / CHART_VIEWBOX.height) * 100}%`;

  return (
    <div className="chart-visual">
      {/* Sem <title> dentro do SVG: o navegador mostrava esse título como tooltip nativo ao passar o mouse em qualquer ponto. */}
      <div className="chart-plot" onPointerLeave={() => setActiveIndex(null)}>
        <svg className="wallet-chart" viewBox="0 0 700 220" role="img" aria-label="Evolução da carteira" aria-describedby="chart-description" preserveAspectRatio="none">
          <desc id="chart-description">Saldo a receber da carteira de {series.labels[0]} a {series.labels.at(-1)}, terminando em {formatMoney(current)}.</desc>
          <defs>
            <linearGradient id="chartFill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#36b9ad" stopOpacity=".20" />
              <stop offset="100%" stopColor="#36b9ad" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[28, 77, 126, 175].map((y) => <line key={y} x1="90" x2="688" y1={y} y2={y} className="chart-gridline" />)}
          {[1, 2 / 3, 1 / 3, 0].map((fraction, index) => <text key={index} x="0" y={31 + index * 49} className="chart-axis">{compactMoney(top * fraction)}</text>)}
          <path d={area} fill="url(#chartFill)" />
          <path d={line} fill="none" className="chart-line" />
          {points.map((point, index) => {
            const isCurrent = index === points.length - 1;
            return <circle key={index} cx={point.x} cy={point.y} r={isCurrent ? 5 : index === activeIndex ? 4.5 : 3.5} className={`chart-dot${isCurrent ? " chart-dot-current" : ""}${index === activeIndex ? " chart-dot-active" : ""}`} />;
          })}
        </svg>
        <div className="chart-hits">
          {points.map((point, index) => (
            <button key={index} type="button" className="chart-hit" style={{ left: left(point.x), top: topOf(point.y) }} aria-label={`${point.dateLabel}: saldo a receber ${point.valueLabel}`} aria-describedby={index === activeIndex ? "chart-tooltip" : undefined} onPointerEnter={() => setActiveIndex(index)} onFocus={() => setActiveIndex(index)} onBlur={() => setActiveIndex(null)} onClick={() => setActiveIndex(index)} onKeyDown={(event) => { if (event.key === "Escape") setActiveIndex(null); }} />
          ))}
        </div>
        {active && (
          <div id="chart-tooltip" role="tooltip" className={`chart-tooltip${activeIndex === 0 ? " chart-tooltip-start" : activeIndex === points.length - 1 ? " chart-tooltip-end" : ""}${active.y < 90 ? " chart-tooltip-below" : ""}`} style={{ left: left(active.x), top: topOf(active.y) }}>
            <span className="chart-tooltip-date">{active.dateLabel}</span>
            <strong className="chart-tooltip-value">{active.valueLabel}</strong>
            <small>Saldo a receber</small>
          </div>
        )}
      </div>
      {peak === 0 && <div className="chart-empty">Sem saldo a receber no período. Cadastre uma operação para acompanhar a evolução.</div>}
      <div className="chart-labels" aria-hidden="true">{series.labels.map((label, index) => <span key={index}>{label}</span>)}</div>
      <div className="chart-summary"><span><i className="legend-dot" /> Saldo a receber</span><span className="chart-current">{formatMoney(current)}</span></div>
    </div>
  );
}

function greetingFor(now: Date) {
  const hour = Number(new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "numeric", hourCycle: "h23" }).format(now));
  return hour < 12 ? "Bom dia" : hour < 18 ? "Boa tarde" : "Boa noite";
}

function longDate(iso: string) {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${iso}T12:00:00Z`)).toUpperCase();
}

function IntelligenceCore({ open, fast, onToggle, onClose, onPointerEnter, onPointerLeave }: { open: boolean; fast: boolean; onToggle: () => void; onClose: () => void; onPointerEnter: () => void; onPointerLeave: () => void }) {
  return (
    <div className={`intelligence-core-wrap ${open ? "intelligence-core-open" : ""}`} onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
      <button className="intelligence-core" type="button" aria-label="CrediAI Intelligence Core, status demonstrativo do sistema" aria-expanded={open} aria-controls="intelligence-core-popover" onClick={onToggle} onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}>
        <svg className="core-visual" viewBox="0 0 48 48" aria-hidden="true">
          <defs><radialGradient id="coreLight"><stop stopColor="#d7fffd" /><stop offset=".35" stopColor="#53f3ec" /><stop offset="1" stopColor="#138bff" stopOpacity=".08" /></radialGradient></defs>
          <ellipse className="core-orbit core-orbit-a" cx="24" cy="24" rx="18" ry="9" />
          <ellipse className="core-orbit core-orbit-b" cx="24" cy="24" rx="18" ry="9" />
          <circle className="core-pulse" cx="24" cy="24" r="7" />
          <circle className="core-halo" cx="24" cy="24" r="6" fill="url(#coreLight)" />
          <circle className="core-center" cx="24" cy="24" r="2.4" />
          <circle className="core-static-particle" cx="7" cy="24" r="1.4" />
          <circle className="core-static-particle" cx="40" cy="18" r="1.2" />
          <circle className="core-particle" r="1.45" fill="#bdffff"><animateMotion dur={fast ? "3.35s" : "3.8s"} repeatCount="indefinite" path="M 6 24 A 18 9 0 1 1 42 24 A 18 9 0 1 1 6 24" /></circle>
          <circle className="core-particle core-particle-blue" r="1.15" fill="#8eafff"><animateMotion dur={fast ? "4.05s" : "4.6s"} begin="-2.1s" repeatCount="indefinite" path="M 8 20 C 14 8 32 10 40 26 C 34 40 16 39 8 20" /></circle>
          <circle className="core-particle core-particle-input" r="1.2" fill="#75fbf0"><animateMotion dur={fast ? "2.75s" : "3.1s"} begin="-1.3s" repeatCount="indefinite" path="M 1 35 C 10 35 12 29 19 26 C 25 23 28 22 34 16 C 38 12 40 11 46 11" /></circle>
        </svg>
        <span className="core-label"><strong>CrediAI Intelligence</strong><small>Prévia local</small></span>
        <span className="core-live-mark" aria-hidden="true" />
      </button>
      <div className="core-status-popover" id="intelligence-core-popover" role="status" aria-live="polite">
        <div className="core-popover-heading"><span className="core-popover-icon"><Icon name="sparkles" size={15} /></span><span><strong>CrediAI Intelligence</strong><small>Núcleo demonstrativo</small></span><button type="button" aria-label="Fechar status" onClick={onClose}><Icon name="close" size={15} /></button></div>
        <ul className="core-status-list"><li><i /> Sistema operacional</li><li><i /> Serviços conectados</li><li><i /> Processamento ativo</li></ul>
        <div className="core-sync"><span>Última sincronização</span><strong><i /> agora</strong></div>
        <p className="core-demo-note">Status ilustrativos nesta prévia local.</p>
      </div>
    </div>
  );
}

function MetricSignal({ variant = "cyan" }: { variant?: "cyan" | "blue" | "violet" }) {
  return <svg className={`metric-signal signal-${variant}`} viewBox="0 0 100 24" aria-hidden="true"><path d="M1 19 15 15 26 17 39 8 52 12 65 5 78 9 99 2" /><path className="signal-fill" d="M1 19 15 15 26 17 39 8 52 12 65 5 78 9 99 2V24H1Z" /></svg>;
}


// Modo gerente de contas: as mesmas telas do dono, só com os clientes dele, sem edição, sem capital e com o resumo da comissão.
export type ManagerMode = { panel: ManagerPanel; initialTheme: "padrao" | "roxo" };
const MANAGER_SECTIONS: NavKey[] = ["Visão geral", "Clientes", "Operações", "Pagamentos", "Cobranças", "Comissão"];

export default function Dashboard({ userName, portfolio, payables, isSuperAdmin = false, initialSection, manager }: { userName: string; portfolio: TenantPortfolio; payables: PayablesOverview | null; isSuperAdmin?: boolean; initialSection?: string; manager?: ManagerMode }) {
  const router = useRouter();
  const initials = initialsOfUser(userName);
  const [active, setActive] = useState<NavKey>(() => { const key = navKeyFromSlug(initialSection); return manager && !MANAGER_SECTIONS.includes(key) ? "Visão geral" : key; });
  const [theme, setTheme] = useState<"padrao" | "roxo">(manager?.initialTheme ?? "padrao");
  const chooseTheme = (next: "padrao" | "roxo") => { setTheme(next); void setManagerThemeAction(next); };
  const readOnly = Boolean(manager);
  const [period, setPeriod] = useState<ChartPeriod>("30D");
  const [chargeFilter, setChargeFilter] = useState<ChargeFilter>("Hoje");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [openClientId, setOpenClientId] = useState<string | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  useTableLabels();
  const [intelligenceCoreOpen, setIntelligenceCoreOpen] = useState(false);
  const [intelligenceCoreHovered, setIntelligenceCoreHovered] = useState(false);
  const { summary, charges, upcoming, chart } = portfolio;
  const { counts } = summary;
  const visibleCharges = charges[chargeFilter];
  const chargeCopy = chargeHeadings[chargeFilter];
  const pendingCharges = counts.dueToday + counts.overdue;
  const series = chart[period];
  const periodStart = series.values[0] ?? 0;
  const periodEnd = series.values.at(-1) ?? 0;
  const periodChange = periodStart > 0 ? ((periodEnd - periodStart) / periodStart) * 100 : null;
  const interestBase = summary.receivedInterestCents + summary.expectedInterestCents;
  const receivedShare = interestBase > 0 ? Math.round((summary.receivedInterestCents / interestBase) * 100) : 0;
  const refresh = () => router.refresh();

  // Cada card do dashboard abre a tela que explica o próprio número (focus/chargesView); o menu abre a visão completa.
  const [operationsFocus, setOperationsFocus] = useState<OperationsFocus>(null);
  const [chargesView, setChargesView] = useState<ChargesView>("Em aberto");
  // Cada clique no menu abre a tela do início (por exemplo, Clientes volta para a lista, saindo da página de um cliente).
  const [visit, setVisit] = useState(0);
  const navigate = (label: NavKey, options: { focus?: OperationsFocus; charges?: ChargesView; clientId?: string } = {}) => {
    setOpenClientId(options.clientId ?? null);
    setVisit((count) => count + 1);
    setOperationsFocus(options.focus ?? null);
    setChargesView(options.charges ?? "Em aberto");
    setActive(label);
    setMobileMenuOpen(false);
    // Endereço da tela atual (recarregar a página mantém a tela). replaceState não refaz a requisição ao servidor.
    if (window.location.pathname === (manager ? "/gerente" : "/") && window.location.search !== navHref(label, "").replace(/^\//, "")) window.history.replaceState(window.history.state, "", navHref(label, manager ? "/gerente" : "/"));
  };

  // Só dados da carteira já carregados pelo servidor com o tenant da sessão: a busca não consulta nada novo.
  const searchResults = searchOpen ? searchPortfolio(searchQuery, portfolio.clients, portfolio.operations) : [];
  const closeSearch = () => { setSearchOpen(false); setSearchQuery(""); };
  // Cliente abre a página dele em Clientes; operação abre a tela de Operações.
  const openResult = (result: SearchResult) => {
    closeSearch();
    if (result.kind === "client") navigate("Clientes", { clientId: result.id }); else navigate("Operações");
  };

  return (
    <div className="app-shell" data-theme={manager ? theme : undefined}>
      {mobileMenuOpen && <button className="mobile-scrim" aria-label="Fechar menu" onClick={() => setMobileMenuOpen(false)} />}
      <Sidebar active={active} initials={initials} mobileOpen={mobileMenuOpen} pendingCharges={pendingCharges} onNavigate={navigate} manager={readOnly} />

      <main className="main-area">
        <header className="topbar">
          <button className="mobile-menu-button icon-button" aria-label={mobileMenuOpen ? "Fechar menu" : "Abrir menu"} onClick={() => setMobileMenuOpen(!mobileMenuOpen)}><span className="hamburger"><i /><i /><i /></span></button>
          <div className="breadcrumbs"><span>CrediAI</span><Icon name="chevron" size={14} /><strong>{active}</strong></div>
          <div className="topbar-actions">
            {!readOnly && <IntelligenceCore open={intelligenceCoreOpen} fast={intelligenceCoreHovered || intelligenceCoreOpen} onToggle={() => setIntelligenceCoreOpen(!intelligenceCoreOpen)} onClose={() => setIntelligenceCoreOpen(false)} onPointerEnter={() => setIntelligenceCoreHovered(true)} onPointerLeave={() => setIntelligenceCoreHovered(false)} />}
            {!readOnly && <span className="secure-label"><Icon name="sparkles" size={14} /> Prévia local</span>}
            <div className="top-action-wrap">
              <button className={`icon-button ${searchOpen ? "icon-button-selected" : ""}`} aria-label="Abrir busca" onClick={() => setSearchOpen(!searchOpen)}><Icon name="search" size={18} /></button>
              {searchOpen && <div className="search-popover search-popover-results">
                <div className="search-row"><Icon name="search" size={17} /><input autoFocus placeholder="Buscar clientes ou operações" aria-label="Buscar clientes ou operações" maxLength={80} value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") closeSearch(); if (event.key === "Enter" && searchResults[0]) openResult(searchResults[0]); }} /><button aria-label="Fechar busca" onClick={closeSearch}><Icon name="close" size={16} /></button></div>
                {searchQuery.trim().length >= 2 && (searchResults.length
                  ? <ul className="search-results" aria-label="Resultados da busca">{searchResults.map((result) => <li key={`${result.kind}-${result.id}`}><button type="button" onClick={() => openResult(result)}><strong>{result.title}</strong><small>{result.detail}</small></button></li>)}</ul>
                  : <p className="search-empty" role="status">Nenhum cliente ou operação encontrado.</p>)}
              </div>}
            </div>
            <div className="top-action-wrap">
              <button className={`icon-button notification-button ${notificationsOpen ? "icon-button-selected" : ""}`} aria-label="Notificações" aria-expanded={notificationsOpen} onClick={() => setNotificationsOpen(!notificationsOpen)}><Icon name="bell" size={18} />{pendingCharges > 0 && <span className="notification-dot" />}</button>
              {notificationsOpen && <div className="notification-popover"><div className="popover-title"><strong>Notificações</strong><span>{pendingCharges > 0 ? `${pendingCharges} pendente${pendingCharges > 1 ? "s" : ""}` : "Tudo em dia"}</span></div><p><i className="notification-mark amber-mark" />Você tem <strong>{counts.dueToday} cobrança{counts.dueToday === 1 ? "" : "s"}</strong> para hoje.</p><p><i className="notification-mark teal-mark" />{counts.overdue > 0 ? <><strong>{counts.overdue} operaç{counts.overdue === 1 ? "ão" : "ões"}</strong> em atraso.</> : "Nenhuma operação em atraso."}</p><button onClick={() => setNotificationsOpen(false)}>Entendi</button></div>}
            </div>
            {readOnly && (
              <div className="theme-switch" role="group" aria-label="Cor do painel">
                <button type="button" className={theme === "padrao" ? "active" : ""} aria-pressed={theme === "padrao"} onClick={() => chooseTheme("padrao")}><i className="swatch swatch-default" />Padrão</button>
                <button type="button" className={theme === "roxo" ? "active" : ""} aria-pressed={theme === "roxo"} onClick={() => chooseTheme("roxo")}><i className="swatch swatch-purple" />Roxo</button>
              </div>
            )}
            <span className="topbar-divider" />
            {/* Único lugar com o usuário e o "Sair". */}
            <div className="top-action-wrap">
              <button className="top-profile" aria-label={`Menu da conta de ${userName}`} aria-expanded={profileOpen} onClick={() => { setProfileOpen(!profileOpen); setNotificationsOpen(false); setSearchOpen(false); }}><span className="profile-avatar">{initials}</span><span>{userName}</span><Icon name="chevron" size={14} /></button>
              {profileOpen && (
                <div className="notification-popover profile-popover" role="menu" onKeyDown={(event) => { if (event.key === "Escape") setProfileOpen(false); }}>
                  <div className="popover-title"><strong>{userName}</strong><span>Minha conta</span></div>
                  {readOnly ? (
                    <div className="theme-picker" role="group" aria-label="Cor do painel">
                      <button type="button" role="menuitemradio" aria-checked={theme === "padrao"} className={theme === "padrao" ? "active" : ""} onClick={() => chooseTheme("padrao")}><i className="swatch swatch-default" /> Padrão</button>
                      <button type="button" role="menuitemradio" aria-checked={theme === "roxo"} className={theme === "roxo" ? "active" : ""} onClick={() => chooseTheme("roxo")}><i className="swatch swatch-purple" /> Roxo</button>
                    </div>
                  ) : <button role="menuitem" onClick={() => { setProfileOpen(false); navigate("Configurações"); }}><Icon name="settings" size={15} /> Configurações</button>}
                  {isSuperAdmin && <button role="menuitem" onClick={() => { setProfileOpen(false); router.push("/admin"); }}><Icon name="settings" size={15} /> Administração da plataforma</button>}
                  <button role="menuitem" className="profile-signout" onClick={async () => { await authClient.signOut(); router.push("/login"); router.refresh(); }}><Icon name="arrow" size={15} /> Sair</button>
                </div>
              )}
            </div>
          </div>
        </header>

        <div className="page-content">
          {active === "Comissão" && manager ? (
            <ManagerCommissionPage panel={manager.panel} />
          ) : active === "Visão geral" ? (
            <>
              <section className="page-heading">
                <div><div className="eyebrow">{longDate(portfolio.today)}</div><h1 suppressHydrationWarning>{greetingFor(new Date())}, {userName.split(" ")[0]} <span className="greeting-mark" aria-hidden="true"><svg viewBox="0 0 26 26" fill="none"><defs><linearGradient id="greetingDollar" x1="7" y1="5" x2="20" y2="22" gradientUnits="userSpaceOnUse"><stop stopColor="#91fff0" /><stop offset="1" stopColor="#39caff" /></linearGradient></defs><path d="M18 7.8c-1-1.2-2.5-1.8-4.6-1.8-2.7 0-4.5 1.3-4.5 3.2 0 2 1.7 2.8 4.6 3.4 2.9.6 4.6 1.4 4.6 3.4 0 2.1-1.9 3.6-4.9 3.6-2.2 0-3.9-.7-5.1-2" stroke="url(#greetingDollar)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /><path d="M13.1 3.8v18.4" stroke="url(#greetingDollar)" strokeWidth="1.8" strokeLinecap="round" /></svg></span></h1><p>{manager ? "Acompanhe os clientes que você indicou e quanto isso rende para você." : "Acompanhe o panorama da sua carteira em um só lugar."}</p></div>
                {!readOnly && <div className="heading-actions"><button className="primary-button" onClick={() => navigate("Operações")}><Icon name="plus" size={17} /> Nova operação</button></div>}
              </section>

              {!readOnly && summary.needsInitialCapital && <WalletSetup onSaved={refresh} cycleNumber={summary.cycleNumber} />}

              {manager ? (
              <section className="metric-grid" aria-label="Indicadores da comissão e da carteira indicada">
                <Link prefetch={false} href="/gerente?tela=comissao" className="metric-card metric-card-clickable metric-featured" aria-label="Comissão a receber, abrir minha comissão" onClick={(event) => { event.preventDefault(); navigate("Comissão"); }}><div className="metric-top"><span>Comissão a receber</span><span className="metric-icon metric-icon-dark"><Icon name="dollar" size={17} /></span></div><div className="metric-value"><Money cents={manager!.panel.summary.balanceCents} /></div><div className="metric-foot"><span className="metric-caption">Comissão gerada menos a já recebida</span><span className="metric-neutral">Já recebida {formatMoney(manager!.panel.summary.paidOutCents)}</span></div><MetricSignal /><div className="metric-accent-line" /></Link>
                <Link prefetch={false} href="/gerente?tela=clientes" className="metric-card metric-card-clickable" aria-label="Clientes indicados, ver clientes" onClick={(event) => { event.preventDefault(); navigate("Clientes"); }}><div className="metric-top"><span>Clientes indicados</span><span className="metric-icon metric-icon-teal"><Icon name="users" size={17} /></span></div><div className="metric-value">{portfolio.clients.length}</div><div className="metric-foot"><span className="metric-caption">Em {counts.active} operaç{counts.active === 1 ? "ão ativa" : "ões ativas"}</span><span className="metric-neutral">{counts.overdue} em atraso</span></div><MetricSignal /></Link>
                <Link prefetch={false} href="/gerente?tela=cobrancas" className="metric-card metric-card-clickable" aria-label="Total a receber dos seus clientes, ver saldos em aberto" onClick={(event) => { event.preventDefault(); navigate("Cobranças", { charges: "Em aberto" }); }}><div className="metric-top"><span>Total a receber dos clientes</span><span className="metric-icon metric-icon-blue"><Icon name="receipt" size={17} /></span></div><div className="metric-value"><Money cents={summary.receivableCents} /></div><div className="metric-foot"><span className="metric-caption">Principal + juros previstos</span><span className="metric-neutral">Em aberto</span></div><MetricSignal variant="blue" /></Link>
                <Link prefetch={false} href="/gerente?tela=comissao" className="metric-card metric-card-clickable" aria-label="Comissão prevista, abrir minha comissão" onClick={(event) => { event.preventDefault(); navigate("Comissão"); }}><div className="metric-top"><span>Comissão prevista</span><span className="metric-icon metric-icon-purple"><Icon name="chart" size={17} /></span></div><div className="metric-value"><Money cents={manager!.panel.summary.expectedCents} /></div><div className="metric-foot"><span className="metric-caption">Sobre juros ainda a pagar</span><span className="metric-neutral">Gerada {formatMoney(manager!.panel.summary.earnedCents)}</span></div><MetricSignal variant="violet" /></Link>
              </section>
              ) : (
              <section className="metric-grid" aria-label="Indicadores financeiros da carteira">
                <Link prefetch={false} href="/?tela=capital" className="metric-card metric-card-clickable metric-featured" aria-label="Capital disponível, abrir capital da carteira" onClick={(event) => { event.preventDefault(); navigate("Capital"); }}><div className="metric-top"><span>Capital disponível</span><span className="metric-icon metric-icon-dark"><Icon name="wallet" size={17} /></span></div><div className="metric-value"><Money cents={summary.availableCents} /></div><div className="metric-foot"><span className="metric-caption">Disponível para novas operações</span><span className="metric-neutral">Aportado {formatMoney(summary.investedCents)}</span></div><MetricSignal /><div className="metric-accent-line" /></Link>
                <Link prefetch={false} href="/?tela=operacoes" className="metric-card metric-card-clickable" aria-label="Capital emprestado, ver operações que compõem o valor" onClick={(event) => { event.preventDefault(); navigate("Operações", { focus: "lent" }); }}><div className="metric-top"><span>Capital emprestado</span><span className="metric-icon metric-icon-teal"><Icon name="dollar" size={17} /></span></div><div className="metric-value"><Money cents={summary.lentCents} /></div><div className="metric-foot"><span className="metric-caption">Em {counts.active} operaç{counts.active === 1 ? "ão ativa" : "ões ativas"}</span><span className="metric-neutral">Principal a receber</span></div><MetricSignal /></Link>
                <Link prefetch={false} href="/?tela=cobrancas" className="metric-card metric-card-clickable" aria-label="Total a receber, ver saldos em aberto" onClick={(event) => { event.preventDefault(); navigate("Cobranças", { charges: "Em aberto" }); }}><div className="metric-top"><span>Total a receber</span><span className="metric-icon metric-icon-blue"><Icon name="receipt" size={17} /></span></div><div className="metric-value"><Money cents={summary.receivableCents} /></div><div className="metric-foot"><span className="metric-caption">Principal + juros previstos</span><span className="metric-neutral">Em aberto</span></div><MetricSignal variant="blue" /></Link>
                <Link prefetch={false} href="/?tela=operacoes" className="metric-card metric-card-clickable" aria-label="Juros previstos, ver operações que compõem o valor" onClick={(event) => { event.preventDefault(); navigate("Operações", { focus: "interest" }); }}><div className="metric-top"><span>Juros previstos</span><span className="metric-icon metric-icon-purple"><Icon name="chart" size={17} /></span></div><div className="metric-value"><Money cents={summary.expectedInterestCents} /></div><div className="metric-foot"><span className="metric-caption">Ainda a receber</span><span className="metric-neutral">Recebidos {formatMoney(summary.receivedInterestCents)}</span></div><MetricSignal variant="violet" /></Link>
              </section>
              )}

              {manager && portfolio.clients.length === 0 ? (
              <section className="manager-welcome" aria-label="Boas-vindas">
                <div className="manager-welcome-orb"><Icon name="users" size={30} /></div>
                <h2>Sua vitrine de comissões está pronta</h2>
                <p>Assim que o seu primeiro cliente indicado for vinculado ao seu painel, aqui aparecem as cobranças, os pagamentos e a comissão que você ganha, atualizados na hora.</p>
                <div className="manager-welcome-steps">
                  <div><span>1</span><strong>Você indica</strong><small>O cliente é vinculado ao seu nome com a sua porcentagem.</small></div>
                  <div><span>2</span><strong>Ele paga os juros</strong><small>Cada pagamento recebido entra na conta da comissão.</small></div>
                  <div><span>3</span><strong>Você acompanha</strong><small>Veja o saldo a receber e o que já foi pago a você.</small></div>
                </div>
                <small className="manager-welcome-note"><Icon name="shield" size={13} /> Painel somente leitura, com acesso apenas aos seus clientes.</small>
              </section>
              ) : (<>
              {payables && <PayablesDashboard overview={payables} availableCents={summary.availableCents} />}
              <ReceivablesDashboard overview={receivablesOverview(portfolio.operations, portfolio.today, summary.receivableCents)} onOpen={(filter) => navigate("Cobranças", { charges: filter })} />

              {!readOnly && <section className="intelligence-panel" aria-label="Resumo inteligente da carteira">
                <div className="intelligence-orb"><Icon name="sparkles" size={21} /></div>
                <div className="intelligence-copy"><span className="intelligence-kicker">CREDIAI INTELLIGENCE <i /> PRÉVIA</span><h2>Uma visão mais clara da sua carteira.</h2><p>Indicadores calculados com os dados cadastrados na sua carteira. Nenhuma IA está ativa nesta etapa.</p></div>
                <div className="intelligence-stat"><strong>{String(counts.active).padStart(2, "0")}</strong><span>operações ativas</span></div><div className="intelligence-stat"><strong>{String(counts.dueToday).padStart(2, "0")}</strong><span>cobranças hoje</span></div>
                <button className="intelligence-action" onClick={() => navigate("Cobranças")}>Ver cobranças <Icon name="chevron" size={15} /></button>
              </section>}

              <section className="secondary-metrics" aria-label="Situação das operações">
                <div className="secondary-title"><span className="secondary-title-mark" />Resumo das operações · {counts.total}</div>
                <div className="secondary-stat"><span className="secondary-icon active-icon"><Icon name="wallet" size={16} /></span><span className="secondary-label">Ativas</span><strong>{counts.active}</strong></div>
                <span className="stat-separator" />
                <div className="secondary-stat"><span className="secondary-icon paid-icon"><Icon name="check" size={16} /></span><span className="secondary-label">Quitadas</span><strong>{counts.paid}</strong></div>
                <span className="stat-separator" />
                <div className="secondary-stat"><span className="secondary-icon due-icon"><Icon name="clock" size={16} /></span><span className="secondary-label">Vencendo hoje</span><strong>{counts.dueToday}</strong></div>
                <span className="stat-separator" />
                <div className="secondary-stat"><span className="secondary-icon late-icon"><Icon name="alert" size={16} /></span><span className="secondary-label">Em atraso</span><strong>{counts.overdue}</strong></div>
                <button className="text-link" onClick={() => navigate("Operações")}>Ver operações <Icon name="chevron" size={14} /></button>
              </section>

              <section className="dashboard-grid">
                <article className="panel portfolio-panel">
                  <div className="panel-header"><div><div className="panel-title-row"><h2>Evolução da carteira</h2><span className="info-dot" title="Saldo a receber (principal + juros em aberto) no fim de cada dia">i</span></div><p>Saldo a receber da carteira ao longo do tempo.</p></div><div className="period-switch" aria-label="Período do gráfico">{(["7D", "30D", "90D"] as ChartPeriod[]).map((item) => <button key={item} className={period === item ? "period-active" : ""} onClick={() => setPeriod(item)} aria-pressed={period === item}>{item}</button>)}</div></div>
                  <div className="chart-stats"><div><span>Carteira a receber</span><strong>{formatMoney(summary.receivableCents)}</strong></div>{periodChange !== null && <span className="chart-change"><Icon name="trend" size={14} /> {periodChange.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}% <small>no período</small></span>}</div>
                  <WalletChart key={period} series={series} />
                </article>

                <article className="panel yield-panel">
                  <div className="panel-header"><div><div className="panel-title-row"><h2>Resultados</h2><span className="info-dot" title="Juros efetivamente recebidos nos pagamentos e juros que ainda faltam receber">i</span></div><p>Juros da carteira</p></div><button className="more-button" aria-label="Mais opções" onClick={() => navigate("Pagamentos")}><Icon name="more" size={18} /></button></div>
                  <div className="yield-total"><Money cents={summary.receivedInterestCents} /><small>juros recebidos</small></div>
                  <div className="yield-chart-wrap"><div className="yield-donut" style={{ ["--yield" as string]: `${receivedShare}%` }}><div><strong>{receivedShare}%</strong><small>da projeção</small></div></div><div className="yield-legend"><div><i className="legend-received" /><span>Recebidos</span><strong>{formatMoney(summary.receivedInterestCents)}</strong></div><div><i className="legend-pending" /><span>A receber</span><strong>{formatMoney(summary.expectedInterestCents)}</strong></div></div></div>
                  <div className="yield-foot"><span><Icon name="trend" size={14} /> Total recebido</span><strong>{formatMoney(summary.receivedCents)}</strong></div>
                </article>
              </section>

              <section className="bottom-grid">
                <article className="panel charges-panel">
                  <div className="panel-header charges-header"><div><div className="panel-title-row"><h2>{chargeCopy.heading}</h2><span className="today-count">{visibleCharges.length}</span></div><p>{chargeCopy.description}</p></div><button className="outline-button" onClick={() => navigate("Cobranças")}>Ver central <Icon name="arrow" size={14} /></button></div>
                  <div className="charge-tabs" role="tablist" aria-label="Período das cobranças">{chargeFilters.map((filter) => <button key={filter} role="tab" aria-selected={chargeFilter === filter} className={chargeFilter === filter ? "charge-tab-active" : ""} onClick={() => setChargeFilter(filter)}>{filter}</button>)}</div>
                  <div className="charge-list" role="tabpanel" aria-label={chargeCopy.heading}>
                    {visibleCharges.length === 0 && <p className="empty-state">{chargeCopy.empty}</p>}
                    {visibleCharges.map((charge) => <div className="charge-row" key={charge.key}><span className={`person-avatar ${charge.color}`}>{charge.initials}</span><div className="charge-person"><strong>{charge.clientName}</strong><small>{charge.detail}</small></div><span className={`charge-status ${charge.tone === "late" ? "charge-status-late" : ""} ${charge.tone === "received" ? "charge-status-received" : ""}`}><i />{charge.status}</span><strong className="charge-amount">{formatMoney(charge.amountCents)}</strong><button className="row-more" aria-label={`Abrir operações de ${charge.clientName}`} onClick={() => navigate("Operações")}><Icon name="more" size={17} /></button></div>)}
                  </div>
                  <div className="charges-total"><span>{chargeCopy.totalLabel}</span><strong>{formatMoney(visibleCharges.reduce((total, charge) => total + charge.amountCents, 0))}</strong></div>
                </article>

                <article className="panel upcoming-panel">
                  <div className="panel-header"><div><h2>Próximos vencimentos</h2><p>Agenda de cobranças em aberto</p></div><button className="more-button" aria-label="Abrir cobranças" onClick={() => navigate("Cobranças")}><Icon name="more" size={18} /></button></div>
                  <div className="upcoming-list">
                    {upcoming.length === 0 && <p className="empty-state">Nenhum vencimento em aberto.</p>}
                    {upcoming.map((item) => { const date = dayAndMonth(item.nextDueDate); return <div className="upcoming-row" key={item.id}><span className="next-date-card"><strong>{date.day}</strong><small>{date.month}</small></span><div className="upcoming-copy"><strong>{item.clientName}</strong><small>{item.nextInstallment ? `Parcela ${item.nextInstallment.number}/${item.installmentTotal}` : "Pagamento único"} · Op. #{item.code}</small></div><div className="upcoming-amount"><strong>{formatMoney(item.nextInstallment ? item.nextInstallment.remainingCents : item.balanceCents)}</strong><small>{item.daysUntilDue === 0 ? "Hoje" : item.daysUntilDue === 1 ? "Amanhã" : `Em ${item.daysUntilDue} dias`}</small></div></div>; })}
                  </div>
                  <button className="activity-link" onClick={() => navigate("Cobranças")}>Ver central de cobranças <Icon name="arrow" size={14} /></button>
                </article>
              </section>

              </>)}

              <footer className="page-footer"><span>CrediAI <i /> Gestão de carteira inteligente</span><span><Icon name="shield" size={13} /> {manager ? "Somente leitura" : "Dados da sua carteira"}</span></footer>
            </>
          ) : active === "Capital" ? (
            <CapitalPage portfolio={portfolio} onChanged={refresh} />
          ) : active === "Clientes" ? (
            <ClientsPage key={visit} initialClientId={openClientId} portfolio={portfolio} onChanged={refresh} onNewOperation={() => navigate("Operações")} readOnly={readOnly} />
          ) : active === "Operações" ? (
            <OperationsPage portfolio={portfolio} onChanged={refresh} onNewClient={() => navigate("Clientes")} focus={operationsFocus} onClearFocus={() => setOperationsFocus(null)} readOnly={readOnly} />
          ) : active === "Pagamentos" ? (
            <PaymentsPage portfolio={portfolio} />
          ) : active === "Cobranças" ? (
            <ChargesPage key={chargesView} portfolio={portfolio} onChanged={refresh} initialFilter={chargesView} readOnly={readOnly} />
          ) : active === "Renegociação" ? (
            <RenegotiationPage portfolio={portfolio} />
          ) : active === "Relatórios" ? (
            <ReportsPage portfolio={portfolio} onChanged={refresh} />
          ) : (
            // Todas as áreas do menu já têm tela própria; Configurações é a última.
            <SettingsPage portfolio={portfolio} onChanged={refresh} />
          )}
        </div>
      </main>
    </div>
  );
}
