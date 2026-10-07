"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { dayAndMonth, formatMoney, splitMoney } from "@/lib/finance/format";
import type { ChargeFilter, ChartPeriod } from "@/lib/finance/portfolio";
import type { TenantPortfolio } from "@/lib/finance/queries";
import { Icon, type IconName } from "./ui-icon";
import { CapitalPage, ChargesPage, ClientsPage, OperationsPage, PaymentsPage, ReportsPage, SettingsPage, WalletSetup, type ChargesView, type OperationsFocus } from "./portfolio-pages";

type NavKey = "Visão geral" | "Capital" | "Clientes" | "Operações" | "Pagamentos" | "Cobranças" | "Relatórios" | "Configurações";

// Cada tela do menu tem um endereço (/?tela=…). Os itens do menu são links de verdade: um clique dado antes de o
// JavaScript terminar de carregar (hidratação) abre a tela pelo servidor, em vez de se perder. Depois de carregado,
// o clique troca a tela na hora, sem recarregar, e só atualiza o endereço.
export const NAV_SLUGS: Record<NavKey, string> = {
  "Visão geral": "visao-geral", Capital: "capital", Clientes: "clientes", Operações: "operacoes",
  Pagamentos: "pagamentos", Cobranças: "cobrancas", Relatórios: "relatorios", Configurações: "configuracoes",
};
export function navKeyFromSlug(slug: string | undefined): NavKey {
  return (Object.keys(NAV_SLUGS) as NavKey[]).find((key) => NAV_SLUGS[key] === slug) ?? "Visão geral";
}
const navHref = (label: NavKey) => (label === "Visão geral" ? "/" : `/?tela=${NAV_SLUGS[label]}`);

const navGroups: { title: string; items: { label: NavKey; icon: IconName }[] }[] = [
  { title: "VISÃO DA CARTEIRA", items: [{ label: "Visão geral", icon: "grid" }, { label: "Capital", icon: "dollar" }, { label: "Clientes", icon: "users" }, { label: "Operações", icon: "wallet" }] },
  { title: "ACOMPANHAMENTO", items: [{ label: "Pagamentos", icon: "receipt" }, { label: "Cobranças", icon: "calendar" }, { label: "Relatórios", icon: "chart" }] },
  { title: "PREFERÊNCIAS", items: [{ label: "Configurações", icon: "settings" }] },
];


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

function niceCeiling(value: number) {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 1.5, 2, 3, 5, 7.5, 10].find((candidate) => candidate * magnitude >= value) ?? 10;
  return step * magnitude;
}

function WalletChart({ series }: { series: { labels: string[]; values: number[] } }) {
  const peak = Math.max(0, ...series.values);
  const top = peak > 0 ? niceCeiling(peak) : 100_000;
  const coords = series.values.map((value, index) => ({
    x: 96 + (index / Math.max(series.values.length - 1, 1)) * 592,
    y: 175 - (value / top) * 147,
  }));
  const line = coords.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
  const area = `${line} L 688 190 L 96 190 Z`;
  const current = series.values.at(-1) ?? 0;

  return (
    <div className="chart-visual">
      <svg className="wallet-chart" viewBox="0 0 700 220" role="img" aria-labelledby="chart-title chart-description" preserveAspectRatio="none">
        <title id="chart-title">Evolução da carteira</title>
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
        {coords.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r={index === coords.length - 1 ? 5 : 3.5} className={index === coords.length - 1 ? "chart-dot chart-dot-current" : "chart-dot"} />)}
      </svg>
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


// Em telas estreitas as tabelas viram cartões (CSS): cada célula recebe o título da sua coluna em data-label.
// Observa a página porque as tabelas mudam a cada navegação e atualização dos dados.
function useTableLabels() {
  useEffect(() => {
    const label = () => document.querySelectorAll<HTMLTableElement>(".data-table").forEach((table) => {
      const heads = [...table.querySelectorAll("thead th")].map((th) => th.textContent?.trim() ?? "");
      table.querySelectorAll<HTMLTableRowElement>("tbody tr, tfoot tr").forEach((row) => {
        let column = 0;
        for (const cell of row.cells) {
          const text = heads[column] ?? "";
          if (cell.dataset.label !== text) cell.dataset.label = text;
          column += cell.colSpan || 1;
        }
      });
    });
    label();
    const observer = new MutationObserver(label);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
}

export default function Dashboard({ userName, portfolio, isSuperAdmin = false, initialSection }: { userName: string; portfolio: TenantPortfolio; isSuperAdmin?: boolean; initialSection?: string }) {
  const router = useRouter();
  const initials = userName.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
  const [active, setActive] = useState<NavKey>(() => navKeyFromSlug(initialSection));
  const [period, setPeriod] = useState<ChartPeriod>("30D");
  const [chargeFilter, setChargeFilter] = useState<ChargeFilter>("Hoje");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
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
  const navigate = (label: NavKey, options: { focus?: OperationsFocus; charges?: ChargesView } = {}) => {
    setVisit((count) => count + 1);
    setOperationsFocus(options.focus ?? null);
    setChargesView(options.charges ?? "Em aberto");
    setActive(label);
    setMobileMenuOpen(false);
    // Endereço da tela atual (recarregar a página mantém a tela). replaceState não refaz a requisição ao servidor.
    if (window.location.pathname === "/" && window.location.search !== navHref(label).slice(1)) window.history.replaceState(window.history.state, "", navHref(label));
  };

  return (
    <div className="app-shell">
      {mobileMenuOpen && <button className="mobile-scrim" aria-label="Fechar menu" onClick={() => setMobileMenuOpen(false)} />}
      <aside className={`sidebar ${mobileMenuOpen ? "sidebar-open" : ""}`} aria-label="Navegação principal">
        <Link prefetch={false} className="brand" href="/" onClick={(event) => { event.preventDefault(); navigate("Visão geral"); }} aria-label="CrediAI, início">
          <span className="brand-logo-image" role="img" aria-label="CrediAI — Crédito + Inteligência" />
        </Link>
        <div className="workspace-switcher">
          <div className="workspace-avatar">{initials}</div>
          <div className="workspace-copy"><span>Minha carteira</span><small>Espaço de trabalho</small></div>
          <Icon name="chevron" size={15} />
        </div>
        <nav className="side-nav">
          {navGroups.map((group) => (
            <div className="nav-group" key={group.title}>
              <p className="nav-heading">{group.title}</p>
              {group.items.map((item) => (
                <Link prefetch={false} key={item.label} href={navHref(item.label)} className={`nav-item ${active === item.label ? "nav-item-active" : ""}`} onClick={(event) => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return; event.preventDefault(); navigate(item.label); }} aria-current={active === item.label ? "page" : undefined}>
                  <Icon name={item.icon} size={18} /><span>{item.label}</span>
                  {item.label === "Cobranças" && pendingCharges > 0 && <span className="nav-count">{pendingCharges}</span>}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="security-note"><span className="security-icon"><Icon name="shield" size={15} /></span><span><strong>Ambiente isolado</strong><small>Separação reforçada por tenant</small></span></div>
          <button className="nav-item help-link" onClick={() => navigate("Configurações")}><Icon name="help" size={18} /><span>Central de ajuda</span><Icon name="arrow" size={14} /></button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <button className="mobile-menu-button icon-button" aria-label={mobileMenuOpen ? "Fechar menu" : "Abrir menu"} onClick={() => setMobileMenuOpen(!mobileMenuOpen)}><span className="hamburger"><i /><i /><i /></span></button>
          <div className="breadcrumbs"><span>CrediAI</span><Icon name="chevron" size={14} /><strong>{active}</strong></div>
          <div className="topbar-actions">
            <IntelligenceCore open={intelligenceCoreOpen} fast={intelligenceCoreHovered || intelligenceCoreOpen} onToggle={() => setIntelligenceCoreOpen(!intelligenceCoreOpen)} onClose={() => setIntelligenceCoreOpen(false)} onPointerEnter={() => setIntelligenceCoreHovered(true)} onPointerLeave={() => setIntelligenceCoreHovered(false)} />
            <span className="secure-label"><Icon name="sparkles" size={14} /> Prévia local</span>
            <div className="top-action-wrap">
              <button className={`icon-button ${searchOpen ? "icon-button-selected" : ""}`} aria-label="Abrir busca" onClick={() => setSearchOpen(!searchOpen)}><Icon name="search" size={18} /></button>
              {searchOpen && <div className="search-popover"><Icon name="search" size={17} /><input autoFocus placeholder="Buscar clientes ou operações" aria-label="Buscar clientes ou operações" /><button aria-label="Fechar busca" onClick={() => setSearchOpen(false)}><Icon name="close" size={16} /></button></div>}
            </div>
            <div className="top-action-wrap">
              <button className={`icon-button notification-button ${notificationsOpen ? "icon-button-selected" : ""}`} aria-label="Notificações" aria-expanded={notificationsOpen} onClick={() => setNotificationsOpen(!notificationsOpen)}><Icon name="bell" size={18} />{pendingCharges > 0 && <span className="notification-dot" />}</button>
              {notificationsOpen && <div className="notification-popover"><div className="popover-title"><strong>Notificações</strong><span>{pendingCharges > 0 ? `${pendingCharges} pendente${pendingCharges > 1 ? "s" : ""}` : "Tudo em dia"}</span></div><p><i className="notification-mark amber-mark" />Você tem <strong>{counts.dueToday} cobrança{counts.dueToday === 1 ? "" : "s"}</strong> para hoje.</p><p><i className="notification-mark teal-mark" />{counts.overdue > 0 ? <><strong>{counts.overdue} operaç{counts.overdue === 1 ? "ão" : "ões"}</strong> em atraso.</> : "Nenhuma operação em atraso."}</p><button onClick={() => setNotificationsOpen(false)}>Entendi</button></div>}
            </div>
            <span className="topbar-divider" />
            {/* Único lugar com o usuário e o "Sair". */}
            <div className="top-action-wrap">
              <button className="top-profile" aria-label={`Menu da conta de ${userName}`} aria-expanded={profileOpen} onClick={() => { setProfileOpen(!profileOpen); setNotificationsOpen(false); setSearchOpen(false); }}><span className="profile-avatar">{initials}</span><span>{userName}</span><Icon name="chevron" size={14} /></button>
              {profileOpen && (
                <div className="notification-popover profile-popover" role="menu" onKeyDown={(event) => { if (event.key === "Escape") setProfileOpen(false); }}>
                  <div className="popover-title"><strong>{userName}</strong><span>Minha conta</span></div>
                  <button role="menuitem" onClick={() => { setProfileOpen(false); navigate("Configurações"); }}><Icon name="settings" size={15} /> Configurações</button>
                  {isSuperAdmin && <button role="menuitem" onClick={() => { setProfileOpen(false); router.push("/admin"); }}><Icon name="settings" size={15} /> Administração da plataforma</button>}
                  <button role="menuitem" className="profile-signout" onClick={async () => { await authClient.signOut(); router.push("/login"); router.refresh(); }}><Icon name="arrow" size={15} /> Sair</button>
                </div>
              )}
            </div>
          </div>
        </header>

        <div className="page-content">
          {active === "Visão geral" ? (
            <>
              <section className="page-heading">
                <div><div className="eyebrow">{longDate(portfolio.today)}</div><h1 suppressHydrationWarning>{greetingFor(new Date())}, {userName.split(" ")[0]} <span className="greeting-mark" aria-hidden="true"><svg viewBox="0 0 26 26" fill="none"><defs><linearGradient id="greetingDollar" x1="7" y1="5" x2="20" y2="22" gradientUnits="userSpaceOnUse"><stop stopColor="#91fff0" /><stop offset="1" stopColor="#39caff" /></linearGradient></defs><path d="M18 7.8c-1-1.2-2.5-1.8-4.6-1.8-2.7 0-4.5 1.3-4.5 3.2 0 2 1.7 2.8 4.6 3.4 2.9.6 4.6 1.4 4.6 3.4 0 2.1-1.9 3.6-4.9 3.6-2.2 0-3.9-.7-5.1-2" stroke="url(#greetingDollar)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /><path d="M13.1 3.8v18.4" stroke="url(#greetingDollar)" strokeWidth="1.8" strokeLinecap="round" /></svg></span></h1><p>Acompanhe o panorama da sua carteira em um só lugar.</p></div>
                <div className="heading-actions"><button className="primary-button" onClick={() => navigate("Operações")}><Icon name="plus" size={17} /> Nova operação</button></div>
              </section>

              {summary.needsInitialCapital && <WalletSetup onSaved={refresh} cycleNumber={summary.cycleNumber} />}

              <section className="metric-grid" aria-label="Indicadores financeiros da carteira">
                <Link prefetch={false} href="/?tela=capital" className="metric-card metric-card-clickable metric-featured" aria-label="Capital disponível, abrir capital da carteira" onClick={(event) => { event.preventDefault(); navigate("Capital"); }}><div className="metric-top"><span>Capital disponível</span><span className="metric-icon metric-icon-dark"><Icon name="wallet" size={17} /></span></div><div className="metric-value"><Money cents={summary.availableCents} /></div><div className="metric-foot"><span className="metric-caption">Disponível para novas operações</span><span className="metric-neutral">Aportado {formatMoney(summary.investedCents)}</span></div><MetricSignal /><div className="metric-accent-line" /></Link>
                <Link prefetch={false} href="/?tela=operacoes" className="metric-card metric-card-clickable" aria-label="Capital emprestado, ver operações que compõem o valor" onClick={(event) => { event.preventDefault(); navigate("Operações", { focus: "lent" }); }}><div className="metric-top"><span>Capital emprestado</span><span className="metric-icon metric-icon-teal"><Icon name="dollar" size={17} /></span></div><div className="metric-value"><Money cents={summary.lentCents} /></div><div className="metric-foot"><span className="metric-caption">Em {counts.active} operaç{counts.active === 1 ? "ão ativa" : "ões ativas"}</span><span className="metric-neutral">Principal a receber</span></div><MetricSignal /></Link>
                <Link prefetch={false} href="/?tela=cobrancas" className="metric-card metric-card-clickable" aria-label="Total a receber, ver saldos em aberto" onClick={(event) => { event.preventDefault(); navigate("Cobranças", { charges: "Em aberto" }); }}><div className="metric-top"><span>Total a receber</span><span className="metric-icon metric-icon-blue"><Icon name="receipt" size={17} /></span></div><div className="metric-value"><Money cents={summary.receivableCents} /></div><div className="metric-foot"><span className="metric-caption">Principal + juros previstos</span><span className="metric-neutral">Em aberto</span></div><MetricSignal variant="blue" /></Link>
                <Link prefetch={false} href="/?tela=operacoes" className="metric-card metric-card-clickable" aria-label="Juros previstos, ver operações que compõem o valor" onClick={(event) => { event.preventDefault(); navigate("Operações", { focus: "interest" }); }}><div className="metric-top"><span>Juros previstos</span><span className="metric-icon metric-icon-purple"><Icon name="chart" size={17} /></span></div><div className="metric-value"><Money cents={summary.expectedInterestCents} /></div><div className="metric-foot"><span className="metric-caption">Ainda a receber</span><span className="metric-neutral">Recebidos {formatMoney(summary.receivedInterestCents)}</span></div><MetricSignal variant="violet" /></Link>
              </section>

              <section className="intelligence-panel" aria-label="Resumo inteligente da carteira">
                <div className="intelligence-orb"><Icon name="sparkles" size={21} /></div>
                <div className="intelligence-copy"><span className="intelligence-kicker">CREDIAI INTELLIGENCE <i /> PRÉVIA</span><h2>Uma visão mais clara da sua carteira.</h2><p>Indicadores calculados com os dados cadastrados na sua carteira. Nenhuma IA está ativa nesta etapa.</p></div>
                <div className="intelligence-stat"><strong>{String(counts.active).padStart(2, "0")}</strong><span>operações ativas</span></div><div className="intelligence-stat"><strong>{String(counts.dueToday).padStart(2, "0")}</strong><span>cobranças hoje</span></div>
                <button className="intelligence-action" onClick={() => navigate("Cobranças")}>Ver cobranças <Icon name="chevron" size={15} /></button>
              </section>

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
                  <WalletChart series={series} />
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
                    {upcoming.map((item) => { const date = dayAndMonth(item.nextDueDate); return <div className="upcoming-row" key={item.id}><span className="next-date-card"><strong>{date.day}</strong><small>{date.month}</small></span><div className="upcoming-copy"><strong>{item.clientName}</strong><small>{item.nextInstallment ? `Parcela ${item.nextInstallment.number}/${item.installments.length}` : "Pagamento único"} · Op. #{item.code}</small></div><div className="upcoming-amount"><strong>{formatMoney(item.nextInstallment ? item.nextInstallment.remainingCents : item.balanceCents)}</strong><small>{item.daysUntilDue === 0 ? "Hoje" : item.daysUntilDue === 1 ? "Amanhã" : `Em ${item.daysUntilDue} dias`}</small></div></div>; })}
                  </div>
                  <button className="activity-link" onClick={() => navigate("Cobranças")}>Ver central de cobranças <Icon name="arrow" size={14} /></button>
                </article>
              </section>

              <footer className="page-footer"><span>CrediAI <i /> Gestão de carteira inteligente</span><span><Icon name="shield" size={13} /> Dados da sua carteira</span></footer>
            </>
          ) : active === "Capital" ? (
            <CapitalPage portfolio={portfolio} onChanged={refresh} />
          ) : active === "Clientes" ? (
            <ClientsPage key={visit} portfolio={portfolio} onChanged={refresh} onNewOperation={() => navigate("Operações")} />
          ) : active === "Operações" ? (
            <OperationsPage portfolio={portfolio} onChanged={refresh} onNewClient={() => navigate("Clientes")} focus={operationsFocus} onClearFocus={() => setOperationsFocus(null)} />
          ) : active === "Pagamentos" ? (
            <PaymentsPage portfolio={portfolio} />
          ) : active === "Cobranças" ? (
            <ChargesPage key={chargesView} portfolio={portfolio} onChanged={refresh} initialFilter={chargesView} />
          ) : active === "Relatórios" ? (
            <ReportsPage portfolio={portfolio} />
          ) : (
            // Todas as áreas do menu já têm tela própria; Configurações é a última.
            <SettingsPage portfolio={portfolio} onChanged={refresh} />
          )}
        </div>
      </main>
    </div>
  );
}
