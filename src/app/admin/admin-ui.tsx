import Link from "next/link";
import type { ReactNode } from "react";
import SignOutButton from "@/app/sign-out-button";
import { formatDate, todayIso } from "@/lib/finance/format";

// Peças visuais compartilhadas pela Central de Gestão (somente servidor).

export const STATUS_INFO: Record<string, { label: string; tone: "active" | "trial" | "suspended" | "closed" }> = {
  ACTIVE: { label: "Ativo", tone: "active" },
  TRIALING: { label: "Em teste", tone: "trial" },
  SUSPENDED: { label: "Suspenso", tone: "suspended" },
  CLOSED: { label: "Encerrado", tone: "closed" },
};

export function StatusBadge({ status }: { status: string }) {
  const info = STATUS_INFO[status] ?? { label: status, tone: "closed" as const };
  return <span className={`saas-status saas-status-${info.tone}`}><i aria-hidden />{info.label}</span>;
}

export function dateLabel(value: string | Date | null) {
  if (!value) return "—";
  return formatDate(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : todayIso(new Date(value)));
}

export function relativeAccess(value: string | null) {
  if (!value) return "Nunca acessou";
  const days = Math.floor((Date.now() - new Date(value).getTime()) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "Hoje";
  if (days === 1) return "Ontem";
  if (days < 30) return `Há ${days} dias`;
  return dateLabel(value);
}

const NAV = [
  ["clientes", "/admin", "Clientes SaaS"],
  ["registros", "/admin/registros", "Registros da plataforma"],
] as const;

export function AdminShell({ active, userName, hasOwnWallet, children }: { active: "clientes" | "registros"; userName: string; hasOwnWallet: boolean; children: ReactNode }) {
  return (
    <main className="admin-page central">
      <header className="central-header">
        <div className="central-brand">
          <span className="central-mark" aria-hidden>C<b>AI</b></span>
          <div>
            <div className="auth-kicker"><i /> CENTRAL DE GESTÃO · SUPER_ADMIN</div>
            <h1>CrediAI Plataforma</h1>
            <p>Olá, {userName}. Aqui você administra quem usa o CrediAI.</p>
          </div>
        </div>
        <div className="admin-header-actions">
          {hasOwnWallet && <Link href="/" className="admin-link">Minha carteira</Link>}
          <SignOutButton label="Sair" />
        </div>
      </header>
      <nav className="central-nav" aria-label="Seções da administração">
        {NAV.map(([key, href, name]) => <Link key={key} href={href} aria-current={active === key ? "page" : undefined}>{name}</Link>)}
      </nav>
      {children}
    </main>
  );
}

export function Kpi({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "cyan" | "green" | "amber" | "red" }) {
  return <div className={`central-kpi${tone ? ` central-kpi-${tone}` : ""}`}><span>{label}</span><strong>{value}</strong>{hint && <small>{hint}</small>}</div>;
}
