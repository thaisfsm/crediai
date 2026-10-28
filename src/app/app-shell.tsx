"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { authClient } from "@/lib/auth-client";
import { Icon, type IconName } from "./ui-icon";

// Menu lateral do app, usado pelo dashboard (telas em /?tela=…) e pelas páginas próprias (/investidores, /financeiro, /contas-a-pagar).
export type NavKey = "Visão geral" | "Comissão" | "Capital" | "Clientes" | "Operações" | "Aprovações" | "Esteira de Crédito" | "Política de crédito" | "Pagamentos" | "Cobranças" | "Renegociação" | "Relatórios" | "Configurações" | "Gestão de inadimplência";
export type NavLabel = NavKey | "Investidores" | "Financeiro" | "Contas a pagar" | "Gerentes";
// Itens do menu que são páginas próprias (com endereço e dados do servidor), não telas do dashboard.
const PAGE_ROUTES: Partial<Record<NavLabel, string>> = { Investidores: "/investidores", Financeiro: "/financeiro", "Contas a pagar": "/contas-a-pagar", Gerentes: "/gerentes" };

// Cada tela do menu tem um endereço (/?tela=…). Os itens do menu são links de verdade: um clique dado antes de o
// JavaScript terminar de carregar (hidratação) abre a tela pelo servidor, em vez de se perder. Depois de carregado,
// o clique troca a tela na hora, sem recarregar, e só atualiza o endereço.
export const NAV_SLUGS: Record<NavKey, string> = {
  "Visão geral": "visao-geral", Comissão: "comissao", Capital: "capital", Clientes: "clientes", Operações: "operacoes", Aprovações: "aprovacoes", "Política de crédito": "politica-de-credito", "Esteira de Crédito": "esteira-de-credito",
  Pagamentos: "pagamentos", Cobranças: "cobrancas", Renegociação: "renegociacao", Relatórios: "relatorios", Configurações: "configuracoes",
  "Gestão de inadimplência": "gestao-de-inadimplencia",
};
export function navKeyFromSlug(slug: string | undefined): NavKey {
  return (Object.keys(NAV_SLUGS) as NavKey[]).find((key) => NAV_SLUGS[key] === slug) ?? "Visão geral";
}
export const navHref = (label: NavKey, base = "/") => (label === "Visão geral" ? base : `${base}?tela=${NAV_SLUGS[label]}`);
const itemHref = (label: NavLabel, base = "/") => PAGE_ROUTES[label] ?? navHref(label as NavKey, base);

// Menu do gerente de contas (só leitura): as mesmas telas do dono que mostram clientes e cobranças, sem capital, financeiro nem cadastros.
const managerNavGroups: { title: string; items: { label: NavLabel; icon: IconName }[] }[] = [
  { title: "MEUS CLIENTES", items: [{ label: "Visão geral", icon: "grid" }, { label: "Clientes", icon: "users" }, { label: "Operações", icon: "wallet" }] },
  { title: "ACOMPANHAMENTO", items: [{ label: "Cobranças", icon: "calendar" }] },
  { title: "MINHA COMISSÃO", items: [{ label: "Comissão", icon: "dollar" }] },
];

const navGroups: { title: string; items: { label: NavLabel; icon: IconName }[] }[] = [
  { title: "VISÃO DA CARTEIRA", items: [{ label: "Visão geral", icon: "grid" }, { label: "Capital", icon: "dollar" }, { label: "Clientes", icon: "users" }, { label: "Operações", icon: "wallet" }, { label: "Aprovações", icon: "check" }, { label: "Esteira de Crédito", icon: "sparkles" }, { label: "Financeiro", icon: "trend" }, { label: "Contas a pagar", icon: "file" }, { label: "Investidores", icon: "briefcase" }, { label: "Gerentes", icon: "users" }] },
  { title: "DASHBOARD", items: [{ label: "Gestão de inadimplência", icon: "alert" }] },
  { title: "ACOMPANHAMENTO", items: [{ label: "Pagamentos", icon: "receipt" }, { label: "Cobranças", icon: "calendar" }, { label: "Renegociação", icon: "sparkles" }, { label: "Relatórios", icon: "chart" }] },
  { title: "PREFERÊNCIAS", items: [{ label: "Política de crédito", icon: "shield" }, { label: "Configurações", icon: "settings" }] },
];

export const initialsOfUser = (userName: string) => userName.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");

// Em telas estreitas as tabelas viram cartões (CSS): cada célula recebe o título da sua coluna em data-label.
// Observa a página porque as tabelas mudam a cada navegação e atualização dos dados.
export function useTableLabels() {
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

// Com onNavigate (dashboard), as telas do dashboard trocam sem recarregar; sem ele, todo item é um link normal.
export function Sidebar({ active, initials, mobileOpen, pendingCharges = 0, pendingApprovals = 0, onNavigate, manager = false }: {
  active: NavLabel; initials: string; mobileOpen: boolean; pendingCharges?: number; pendingApprovals?: number; onNavigate?: (label: NavKey) => void; manager?: boolean;
}) {
  const base = manager ? "/gerente" : "/";
  const groups = manager ? managerNavGroups : navGroups;
  const intercept = (label: NavLabel) => (event: MouseEvent) => {
    if (!onNavigate || PAGE_ROUTES[label] || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    onNavigate(label as NavKey);
  };
  return (
    <aside className={`sidebar ${mobileOpen ? "sidebar-open" : ""}`} aria-label="Navegação principal">
      <Link prefetch={false} className="brand" href={base} onClick={intercept("Visão geral")} aria-label="CrediAI, início">
        <span className="brand-logo-image" role="img" aria-label="CrediAI — Crédito + Inteligência" />
      </Link>
      <div className="workspace-switcher">
        <div className="workspace-avatar">{initials}</div>
        <div className="workspace-copy"><span>{manager ? "Painel da gerente" : "Minha carteira"}</span><small>{manager ? "Somente leitura" : "Espaço de trabalho"}</small></div>
        <Icon name="chevron" size={15} />
      </div>
      <nav className="side-nav">
        {groups.map((group) => (
          <div className="nav-group" key={group.title}>
            <p className="nav-heading">{group.title}</p>
            {group.items.map((item) => (
              <Link prefetch={false} key={item.label} href={itemHref(item.label, base)} className={`nav-item ${active === item.label ? "nav-item-active" : ""}`} onClick={intercept(item.label)} aria-current={active === item.label ? "page" : undefined}>
                <Icon name={item.icon} size={18} /><span>{item.label}</span>
                {item.label === "Cobranças" && pendingCharges > 0 && <span className="nav-count">{pendingCharges}</span>}
                {item.label === "Aprovações" && pendingApprovals > 0 && <span className="nav-count">{pendingApprovals}</span>}
              </Link>
            ))}
          </div>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <div className="security-note"><span className="security-icon"><Icon name="shield" size={15} /></span><span><strong>Ambiente isolado</strong><small>Separação reforçada por tenant</small></span></div>
        {!manager && <Link prefetch={false} className="nav-item help-link" href={navHref("Configurações")} onClick={intercept("Configurações")}><Icon name="help" size={18} /><span>Central de ajuda</span><Icon name="arrow" size={14} /></Link>}
      </div>
    </aside>
  );
}

// Moldura das páginas próprias (fora do dashboard): o mesmo menu lateral e uma barra superior com o caminho e a conta.
export function AppShell({ userName, isSuperAdmin, active, trail, children }: {
  userName: string; isSuperAdmin: boolean; active: NavLabel; trail: { label: string; href?: string }[]; children: ReactNode;
}) {
  const router = useRouter();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const initials = initialsOfUser(userName);
  useTableLabels();
  return (
    <div className="app-shell">
      {mobileMenuOpen && <button className="mobile-scrim" aria-label="Fechar menu" onClick={() => setMobileMenuOpen(false)} />}
      <Sidebar active={active} initials={initials} mobileOpen={mobileMenuOpen} />
      <main className="main-area">
        <header className="topbar">
          <button className="mobile-menu-button icon-button" aria-label={mobileMenuOpen ? "Fechar menu" : "Abrir menu"} onClick={() => setMobileMenuOpen(!mobileMenuOpen)}><span className="hamburger"><i /><i /><i /></span></button>
          <div className="breadcrumbs">
            <span>CrediAI</span>
            {trail.map((item, index) => (
              <span key={index} className="breadcrumb-step">
                <Icon name="chevron" size={14} />
                {item.href ? <Link prefetch={false} href={item.href}>{item.label}</Link> : <strong>{item.label}</strong>}
              </span>
            ))}
          </div>
          <div className="topbar-actions">
            <span className="topbar-divider" />
            <div className="top-action-wrap">
              <button className="top-profile" aria-label={`Menu da conta de ${userName}`} aria-expanded={profileOpen} onClick={() => setProfileOpen(!profileOpen)}><span className="profile-avatar">{initials}</span><span>{userName}</span><Icon name="chevron" size={14} /></button>
              {profileOpen && (
                <div className="notification-popover profile-popover" role="menu" onKeyDown={(event) => { if (event.key === "Escape") setProfileOpen(false); }}>
                  <div className="popover-title"><strong>{userName}</strong><span>Minha conta</span></div>
                  <button role="menuitem" onClick={() => { setProfileOpen(false); router.push(navHref("Configurações")); }}><Icon name="settings" size={15} /> Configurações</button>
                  {isSuperAdmin && <button role="menuitem" onClick={() => { setProfileOpen(false); router.push("/admin"); }}><Icon name="settings" size={15} /> Administração da plataforma</button>}
                  <button role="menuitem" className="profile-signout" onClick={async () => { await authClient.signOut(); router.push("/login"); router.refresh(); }}><Icon name="arrow" size={15} /> Sair</button>
                </div>
              )}
            </div>
          </div>
        </header>
        <div className="page-content">{children}</div>
      </main>
    </div>
  );
}
