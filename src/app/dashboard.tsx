"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { authClient } from "@/lib/auth-client";

type IconName =
  | "grid" | "users" | "wallet" | "receipt" | "calendar" | "chart"
  | "settings" | "help" | "chevron" | "bell" | "search" | "plus"
  | "arrow" | "more" | "clock" | "sparkles" | "shield" | "check"
  | "alert" | "filter" | "close" | "trend" | "dollar";

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const shapes: Record<IconName, ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.4" /><rect x="14" y="3" width="7" height="7" rx="1.4" /><rect x="3" y="14" width="7" height="7" rx="1.4" /><rect x="14" y="14" width="7" height="7" rx="1.4" /></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="10" cy="7" r="4" /><path d="M20 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>,
    wallet: <><rect x="3" y="5" width="18" height="15" rx="2.5" /><path d="M3 9h18M16 15h.01M7 5V3h11" /></>,
    receipt: <><path d="M5 3h14v18l-3-2-4 2-4-2-3 2z" /><path d="M8 8h8M8 12h8M8 16h4" /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></>,
    chart: <><path d="M3 3v18h18" /><path d="m7 14 4-4 4 3 6-7" /><path d="M17 6h4v4" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.7a8 8 0 0 1-1.5.9l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.5-.9l-1.7.7-1.4-2.4 1.4-1.1a7 7 0 0 1 0-1.8L6.9 12l1.4-2.4 1.7.7a8 8 0 0 1 1.5-.9l.3-1.8h2.8l.3 1.8a8 8 0 0 1 1.5.9l1.7-.7 1.4 2.4-1.4 1.1a7 7 0 0 1-.1 1.9Z" transform="translate(-1 -1) scale(1.08)" /></>,
    help: <><circle cx="12" cy="12" r="9" /><path d="M9.6 9a2.5 2.5 0 1 1 4.3 1.8c-1.3 1.2-1.9 1.5-1.9 3.2M12 17.5h.01" /></>,
    chevron: <path d="m9 18 6-6-6-6" />,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></>,
    search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.5 4.5" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    arrow: <><path d="M7 17 17 7M8 7h9v9" /></>,
    more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    sparkles: <><path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3Z" /><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16ZM5 2l.6 1.8L7.5 4.5l-1.9.7L5 7l-.6-1.8-1.9-.7 1.9-.7L5 2Z" /></>,
    shield: <><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" /><path d="m9 12 2 2 4-4" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    alert: <><path d="m10.3 3.9-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3.1l-8-14a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></>,
    filter: <><path d="M4 7h16M7 12h10m-7 5h4" /><circle cx="8" cy="7" r="2" fill="currentColor" stroke="none" /><circle cx="15" cy="12" r="2" fill="currentColor" stroke="none" /></>,
    close: <path d="m18 6-12 12M6 6l12 12" />,
    trend: <><path d="M3 17 9 11l4 4 8-9" /><path d="M15 6h6v6" /></>,
    dollar: <><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></>,
  };

  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {shapes[name]}
    </svg>
  );
}

type NavKey = "Visão geral" | "Clientes" | "Operações" | "Pagamentos" | "Cobranças" | "Relatórios" | "Configurações";

const navGroups: { title: string; items: { label: NavKey; icon: IconName }[] }[] = [
  { title: "VISÃO DA CARTEIRA", items: [{ label: "Visão geral", icon: "grid" }, { label: "Clientes", icon: "users" }, { label: "Operações", icon: "wallet" }] },
  { title: "ACOMPANHAMENTO", items: [{ label: "Pagamentos", icon: "receipt" }, { label: "Cobranças", icon: "calendar" }, { label: "Relatórios", icon: "chart" }] },
  { title: "PREFERÊNCIAS", items: [{ label: "Configurações", icon: "settings" }] },
];

const charges = [
  { initials: "JM", name: "João Martins", detail: "Op. #OP-0248 · 2ª parcela", amount: "R$ 1.300,00", color: "mint", status: "Vence hoje" },
  { initials: "MC", name: "Maria Costa", detail: "Op. #OP-0231 · 1ª parcela", amount: "R$ 650,00", color: "violet", status: "Vence hoje" },
  { initials: "CA", name: "Carlos Almeida", detail: "Op. #OP-0197 · Parcela única", amount: "R$ 2.000,00", color: "peach", status: "Vence hoje" },
];

const chargeViews = {
  Hoje: {
    heading: "Cobranças de hoje", description: "Operações com vencimento para 28 de setembro.", totalLabel: "Total previsto para hoje", total: "R$ 3.950,00", items: charges,
  },
  Amanhã: {
    heading: "Cobranças de amanhã", description: "Vencimentos previstos para 29 de setembro.", totalLabel: "Total previsto para amanhã", total: "R$ 1.130,00", items: [
      { initials: "MC", name: "Maria Costa", detail: "Op. #OP-0251 · 1ª parcela", amount: "R$ 650,00", color: "violet", status: "Amanhã" },
      { initials: "LS", name: "Luiza Santos", detail: "Op. #OP-0227 · 2ª parcela", amount: "R$ 480,00", color: "sky", status: "Amanhã" },
    ],
  },
  Próximas: {
    heading: "Próximos vencimentos", description: "Operações previstas para os próximos dias.", totalLabel: "Total previsto nos próximos dias", total: "R$ 2.750,00", items: [
      { initials: "MC", name: "Maria Costa", detail: "29 set · Op. #OP-0251", amount: "R$ 650,00", color: "violet", status: "Amanhã" },
      { initials: "MS", name: "Marcos Silva", detail: "30 set · Op. #OP-0214", amount: "R$ 900,00", color: "mint", status: "Em 2 dias" },
      { initials: "JF", name: "Julia Freitas", detail: "01 out · Op. #OP-0260", amount: "R$ 1.200,00", color: "peach", status: "Em 3 dias" },
    ],
  },
  "Em atraso": {
    heading: "Operações em atraso", description: "Vencimentos demonstrativos com saldo pendente.", totalLabel: "Saldo demonstrativo em atraso", total: "R$ 2.800,00", items: [
      { initials: "CA", name: "Carlos Almeida", detail: "Op. #OP-0197 · Parcela única", amount: "R$ 2.000,00", color: "peach", status: "Atrasado há 4 dias", delayed: true },
      { initials: "AR", name: "Ana Ribeiro", detail: "Op. #OP-0203 · 3ª parcela", amount: "R$ 800,00", color: "violet", status: "Atrasado há 1 dia", delayed: true },
    ],
  },
  Histórico: {
    heading: "Histórico de cobranças", description: "Registros ilustrativos de pagamentos recebidos.", totalLabel: "Total recebido nos exemplos", total: "R$ 2.050,00", items: [
      { initials: "AF", name: "Ana Ferreira", detail: "Op. #OP-0219 · 2ª parcela", amount: "R$ 850,00", color: "sky", status: "Recebido hoje", received: true },
      { initials: "PM", name: "Paula Mendes", detail: "Op. #OP-0188 · 4ª parcela", amount: "R$ 420,00", color: "mint", status: "Recebido ontem", received: true },
      { initials: "RL", name: "Rafael Lima", detail: "Op. #OP-0204 · 1ª parcela", amount: "R$ 780,00", color: "violet", status: "Recebido em 26 set", received: true },
    ],
  },
} as const;
type ChargeFilter = keyof typeof chargeViews;

const upcoming = [
  { day: "29", month: "SET", name: "Maria Costa", detail: "1ª parcela · Op. #OP-0251", amount: "R$ 650,00", when: "Amanhã" },
  { day: "30", month: "SET", name: "Marcos Silva", detail: "3ª parcela · Op. #OP-0214", amount: "R$ 900,00", when: "Em 2 dias" },
  { day: "01", month: "OUT", name: "Julia Freitas", detail: "Parcela única · Op. #OP-0260", amount: "R$ 1.200,00", when: "Em 3 dias" },
];

const chartSeries: Record<string, { labels: string[]; values: number[] }> = {
  "7D": { labels: ["22 set", "23", "24", "25", "26", "27", "28 set"], values: [104, 108, 106, 119, 122, 131, 138] },
  "30D": { labels: ["01 set", "06", "11", "16", "21", "26", "28 set"], values: [96, 104, 101, 116, 119, 132, 138] },
  "90D": { labels: ["jul", "ago", "set"], values: [82, 101, 138] },
};

function WalletChart({ period }: { period: string }) {
  const series = chartSeries[period];
  const coords = series.values.map((value, index) => ({
    x: 96 + (index / (series.values.length - 1)) * 592,
    y: 176 - ((value - 75) / 75) * 146,
  }));
  const line = coords.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
  const area = `${line} L 688 190 L 96 190 Z`;

  return (
    <div className="chart-visual">
      <svg className="wallet-chart" viewBox="0 0 700 220" role="img" aria-labelledby="chart-title chart-description" preserveAspectRatio="none">
        <title id="chart-title">Evolução demonstrativa da carteira</title>
        <desc id="chart-description">A linha mostra crescimento ilustrativo de 82 mil reais em julho para 138 mil reais em setembro.</desc>
        <defs>
          <linearGradient id="chartFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#36b9ad" stopOpacity=".20" />
            <stop offset="100%" stopColor="#36b9ad" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[28, 77, 126, 175].map((y) => <line key={y} x1="90" x2="688" y1={y} y2={y} className="chart-gridline" />)}
        {["R$ 150 mil", "R$ 125 mil", "R$ 100 mil", "R$ 75 mil"].map((label, index) => <text key={label} x="0" y={31 + index * 49} className="chart-axis">{label}</text>)}
        <path d={area} fill="url(#chartFill)" />
        <path d={line} fill="none" className="chart-line" />
        {coords.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r={index === coords.length - 1 ? 5 : 3.5} className={index === coords.length - 1 ? "chart-dot chart-dot-current" : "chart-dot"} />)}
      </svg>
      <div className="chart-labels" aria-hidden="true">{series.labels.map((label) => <span key={label}>{label}</span>)}</div>
      <div className="chart-summary"><span><i className="legend-dot" /> Carteira total</span><span className="chart-current">R$ 138.420,00 <small>ilustrativo</small></span></div>
    </div>
  );
}

function DemoTag() {
  return <span className="demo-tag"><span className="demo-dot" /> Dados ilustrativos</span>;
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

export default function Dashboard({ userName }: { userName: string }) {
  const router = useRouter();
  const initials = userName.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
  const [active, setActive] = useState<NavKey>("Visão geral");
  const [period, setPeriod] = useState("30D");
  const [chargeFilter, setChargeFilter] = useState<ChargeFilter>("Hoje");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [intelligenceCoreOpen, setIntelligenceCoreOpen] = useState(false);
  const [intelligenceCoreHovered, setIntelligenceCoreHovered] = useState(false);
  const visibleCharges = chargeViews[chargeFilter];

  const navigate = (label: NavKey) => {
    setActive(label);
    setMobileMenuOpen(false);
  };

  return (
    <div className="app-shell">
      {mobileMenuOpen && <button className="mobile-scrim" aria-label="Fechar menu" onClick={() => setMobileMenuOpen(false)} />}
      <aside className={`sidebar ${mobileMenuOpen ? "sidebar-open" : ""}`} aria-label="Navegação principal">
        <a className="brand" href="#inicio" onClick={(event) => { event.preventDefault(); navigate("Visão geral"); }} aria-label="CrediAI, início">
          <span className="brand-logo-image" role="img" aria-label="CrediAI — Crédito + Inteligência" />
        </a>
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
                <button key={item.label} className={`nav-item ${active === item.label ? "nav-item-active" : ""}`} onClick={() => navigate(item.label)} aria-current={active === item.label ? "page" : undefined}>
                  <Icon name={item.icon} size={18} /><span>{item.label}</span>
                  {item.label === "Cobranças" && <span className="nav-count">3</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="security-note"><span className="security-icon"><Icon name="shield" size={15} /></span><span><strong>Ambiente isolado</strong><small>Separação reforçada por tenant</small></span></div>
          <button className="nav-item help-link" onClick={() => navigate("Configurações")}><Icon name="help" size={18} /><span>Central de ajuda</span><Icon name="arrow" size={14} /></button>
          <div className="profile-button">
            <span className="profile-avatar">{initials}</span><span className="profile-copy"><strong>{userName}</strong><small>Minha conta</small></span><button className="signout-button" aria-label="Sair da conta" onClick={async () => { await authClient.signOut(); router.push("/login"); router.refresh(); }}>Sair</button>
          </div>
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
              <button className={`icon-button notification-button ${notificationsOpen ? "icon-button-selected" : ""}`} aria-label="Notificações" aria-expanded={notificationsOpen} onClick={() => setNotificationsOpen(!notificationsOpen)}><Icon name="bell" size={18} /><span className="notification-dot" /></button>
              {notificationsOpen && <div className="notification-popover"><div className="popover-title"><strong>Notificações</strong><span>2 novas</span></div><p><i className="notification-mark amber-mark" />Você tem <strong>3 cobranças</strong> para hoje.</p><p><i className="notification-mark teal-mark" />Sua carteira demonstrativa está atualizada.</p><button onClick={() => setNotificationsOpen(false)}>Entendi</button></div>}
            </div>
            <span className="topbar-divider" />
            <button className="top-profile" onClick={() => navigate("Configurações")}><span className="profile-avatar">{initials}</span><span>{userName}</span><Icon name="chevron" size={14} /></button>
          </div>
        </header>

        <div className="page-content">
          <div className="demo-banner"><span className="demo-banner-icon"><Icon name="sparkles" size={15} /></span><span><strong>Ambiente de demonstração</strong><i />Valores e movimentações desta tela são ilustrativos.</span><button aria-label="Fechar aviso" onClick={(event) => event.currentTarget.parentElement?.remove()}><Icon name="close" size={15} /></button></div>

          {active === "Visão geral" ? (
            <>
              <section className="page-heading">
                <div><div className="eyebrow">SEGUNDA-FEIRA, 28 DE SETEMBRO DE 2026</div><h1>Bom dia, {userName.split(" ")[0]} <span className="greeting-mark" aria-hidden="true"><svg viewBox="0 0 26 26" fill="none"><defs><linearGradient id="greetingDollar" x1="7" y1="5" x2="20" y2="22" gradientUnits="userSpaceOnUse"><stop stopColor="#91fff0" /><stop offset="1" stopColor="#39caff" /></linearGradient></defs><path d="M18 7.8c-1-1.2-2.5-1.8-4.6-1.8-2.7 0-4.5 1.3-4.5 3.2 0 2 1.7 2.8 4.6 3.4 2.9.6 4.6 1.4 4.6 3.4 0 2.1-1.9 3.6-4.9 3.6-2.2 0-3.9-.7-5.1-2" stroke="url(#greetingDollar)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /><path d="M13.1 3.8v18.4" stroke="url(#greetingDollar)" strokeWidth="1.8" strokeLinecap="round" /></svg></span></h1><p>Acompanhe o panorama da sua carteira em um só lugar.</p></div>
                <div className="heading-actions"><DemoTag /><button className="primary-button" onClick={() => navigate("Operações")}><Icon name="plus" size={17} /> Nova operação</button></div>
              </section>

              <section className="metric-grid" aria-label="Indicadores financeiros demonstrativos">
                <a href="#operacoes" className="metric-card metric-card-clickable metric-featured" aria-label="Capital disponível, abrir planejamento de novas operações" onClick={(event) => { event.preventDefault(); navigate("Operações"); }}><div className="metric-top"><span>Capital disponível</span><span className="metric-icon metric-icon-dark"><Icon name="wallet" size={17} /></span></div><div className="metric-value">R$ 48.250<span>,00</span></div><div className="metric-foot"><span className="metric-caption">Disponível para novas operações</span><span className="metric-trend"><Icon name="trend" size={13} /> 8,2%</span></div><MetricSignal /><div className="metric-accent-line" /></a>
                <a href="#operacoes" className="metric-card metric-card-clickable" aria-label="Capital emprestado, abrir operações" onClick={(event) => { event.preventDefault(); navigate("Operações"); }}><div className="metric-top"><span>Capital emprestado</span><span className="metric-icon metric-icon-teal"><Icon name="dollar" size={17} /></span></div><div className="metric-value">R$ 126.800<span>,00</span></div><div className="metric-foot"><span className="metric-caption">Em 18 operações ativas</span><span className="metric-trend"><Icon name="trend" size={13} /> 12,4%</span></div><MetricSignal /></a>
                <a href="#pagamentos" className="metric-card metric-card-clickable" aria-label="Total a receber, abrir pagamentos" onClick={(event) => { event.preventDefault(); navigate("Pagamentos"); }}><div className="metric-top"><span>Total a receber</span><span className="metric-icon metric-icon-blue"><Icon name="receipt" size={17} /></span></div><div className="metric-value">R$ 148.960<span>,00</span></div><div className="metric-foot"><span className="metric-caption">Principal + juros previstos</span><span className="metric-neutral">Em aberto</span></div><MetricSignal variant="blue" /></a>
                <a href="#relatorios" className="metric-card metric-card-clickable" aria-label="Juros previstos, abrir relatórios financeiros" onClick={(event) => { event.preventDefault(); navigate("Relatórios"); }}><div className="metric-top"><span>Juros previstos</span><span className="metric-icon metric-icon-purple"><Icon name="chart" size={17} /></span></div><div className="metric-value">R$ 22.160<span>,00</span></div><div className="metric-foot"><span className="metric-caption">Nesta carteira demonstrativa</span><span className="metric-neutral">Projeção</span></div><MetricSignal variant="violet" /></a>
              </section>

              <section className="intelligence-panel" aria-label="Demonstração visual de análise inteligente">
                <div className="intelligence-orb"><Icon name="sparkles" size={21} /></div>
                <div className="intelligence-copy"><span className="intelligence-kicker">CREDIAI INTELLIGENCE <i /> DEMONSTRAÇÃO</span><h2>Uma visão mais clara da sua carteira.</h2><p>Indicadores ilustrativos preparados para futuras análises automatizadas. Nenhuma IA está ativa nesta demonstração.</p></div>
                <div className="intelligence-stat"><strong>+14,8%</strong><span>evolução ilustrativa</span></div><div className="intelligence-stat"><strong>03</strong><span>cobranças hoje</span></div>
                <button className="intelligence-action" onClick={() => navigate("Relatórios")}>Ver análise <Icon name="chevron" size={15} /></button>
              </section>

              <section className="secondary-metrics" aria-label="Situação das operações">
                <div className="secondary-title"><span className="secondary-title-mark" />Resumo das operações</div>
                <div className="secondary-stat"><span className="secondary-icon active-icon"><Icon name="wallet" size={16} /></span><span className="secondary-label">Ativas</span><strong>18</strong></div>
                <span className="stat-separator" />
                <div className="secondary-stat"><span className="secondary-icon paid-icon"><Icon name="check" size={16} /></span><span className="secondary-label">Quitadas</span><strong>42</strong></div>
                <span className="stat-separator" />
                <div className="secondary-stat"><span className="secondary-icon due-icon"><Icon name="clock" size={16} /></span><span className="secondary-label">Vencendo hoje</span><strong>3</strong></div>
                <span className="stat-separator" />
                <div className="secondary-stat"><span className="secondary-icon late-icon"><Icon name="alert" size={16} /></span><span className="secondary-label">Em atraso</span><strong>2</strong></div>
                <button className="text-link" onClick={() => navigate("Operações")}>Ver operações <Icon name="chevron" size={14} /></button>
              </section>

              <section className="dashboard-grid">
                <article className="panel portfolio-panel">
                  <div className="panel-header"><div><div className="panel-title-row"><h2>Evolução da carteira</h2><span className="info-dot" title="Dados demonstrativos">i</span></div><p>Acompanhe o crescimento do seu capital ao longo do tempo.</p></div><div className="period-switch" aria-label="Período do gráfico">{["7D", "30D", "90D"].map((item) => <button key={item} className={period === item ? "period-active" : ""} onClick={() => setPeriod(item)} aria-pressed={period === item}>{item}</button>)}</div></div>
                  <div className="chart-stats"><div><span>Carteira total</span><strong>R$ 138.420,00</strong></div><span className="chart-change"><Icon name="trend" size={14} /> 14,8% <small>no período</small></span></div>
                  <WalletChart period={period} />
                </article>

                <article className="panel yield-panel">
                  <div className="panel-header"><div><div className="panel-title-row"><h2>Resultados</h2><span className="info-dot" title="Dados demonstrativos">i</span></div><p>Juros da carteira</p></div><button className="more-button" aria-label="Mais opções"><Icon name="more" size={18} /></button></div>
                  <div className="yield-total">R$ 8.420<span>,00</span><small>recebidos</small></div>
                  <div className="yield-chart-wrap"><div className="yield-donut"><div><strong>38%</strong><small>da projeção</small></div></div><div className="yield-legend"><div><i className="legend-received" /><span>Recebidos</span><strong>R$ 8.420</strong></div><div><i className="legend-pending" /><span>A receber</span><strong>R$ 13.740</strong></div></div></div>
                  <div className="yield-foot"><span><Icon name="trend" size={14} /> Resultado acumulado</span><strong>R$ 8.420,00</strong></div>
                </article>
              </section>

              <section className="bottom-grid">
                <article className="panel charges-panel">
                  <div className="panel-header charges-header"><div><div className="panel-title-row"><h2>{visibleCharges.heading}</h2><span className="today-count">{visibleCharges.items.length}</span></div><p>{visibleCharges.description}</p></div><button className="outline-button" onClick={() => navigate("Cobranças")}>Ver central <Icon name="arrow" size={14} /></button></div>
                  <div className="charge-tabs" role="tablist" aria-label="Período das cobranças">{(Object.keys(chargeViews) as ChargeFilter[]).map((filter) => <button key={filter} role="tab" aria-selected={chargeFilter === filter} className={chargeFilter === filter ? "charge-tab-active" : ""} onClick={() => setChargeFilter(filter)}>{filter}</button>)}</div>
                  <div className="charge-list" role="tabpanel" aria-label={visibleCharges.heading}>{visibleCharges.items.map((charge) => <div className="charge-row" key={charge.name}><span className={`person-avatar ${charge.color}`}>{charge.initials}</span><div className="charge-person"><strong>{charge.name}</strong><small>{charge.detail}</small></div><span className={`charge-status ${"delayed" in charge && charge.delayed ? "charge-status-late" : ""} ${"received" in charge && charge.received ? "charge-status-received" : ""}`}><i />{charge.status}</span><strong className="charge-amount">{charge.amount}</strong><button className="row-more" aria-label={`Opções para ${charge.name}`}><Icon name="more" size={17} /></button></div>)}</div>
                  <div className="charges-total"><span>{visibleCharges.totalLabel}</span><strong>{visibleCharges.total}</strong></div>
                </article>

                <article className="panel upcoming-panel">
                  <div className="panel-header"><div><h2>Próximos vencimentos</h2><p>Agenda demonstrativa de cobranças</p></div><button className="more-button" aria-label="Mais opções"><Icon name="more" size={18} /></button></div>
                  <div className="upcoming-list">{upcoming.map((item) => <div className="upcoming-row" key={item.name}><span className="next-date-card"><strong>{item.day}</strong><small>{item.month}</small></span><div className="upcoming-copy"><strong>{item.name}</strong><small>{item.detail}</small></div><div className="upcoming-amount"><strong>{item.amount}</strong><small>{item.when}</small></div></div>)}</div>
                  <button className="activity-link" onClick={() => navigate("Cobranças")}>Ver central de cobranças <Icon name="arrow" size={14} /></button>
                </article>
              </section>

              <footer className="page-footer"><span>CrediAI <i /> Gestão de carteira inteligente</span><span><Icon name="chart" size={13} /> Dados somente demonstrativos</span></footer>
            </>
          ) : (
            <section className="coming-page">
              <div className="coming-icon"><Icon name={navGroups.flatMap((group) => group.items).find((item) => item.label === active)?.icon ?? "grid"} size={27} /></div>
              <span className="eyebrow">CREDIAI · {active.toUpperCase()}</span>
              <h1>{active}</h1>
              <p>Esta área está prevista para uma próxima etapa do CrediAI. Por enquanto, você pode explorar o dashboard com dados demonstrativos.</p>
              <button className="primary-button" onClick={() => navigate("Visão geral")}><Icon name="arrow" size={16} /> Voltar para visão geral</button>
              <div className="coming-note"><Icon name="sparkles" size={16} /> A estrutura visual está preparada para este módulo.</div>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
