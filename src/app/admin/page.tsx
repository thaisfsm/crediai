import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { databaseAvailable } from "@/lib/db";
import { loadPlatformOverview } from "@/lib/admin/queries";
import { formatDate, formatMoney, todayIso } from "@/lib/finance/format";
import SignOutButton from "@/app/sign-out-button";

export const dynamic = "force-dynamic";

const TABS = [
  ["relatorio", "Relatório global"],
  ["tenants", "Tenants"],
  ["usuarios", "Usuários"],
  ["clientes", "Clientes"],
  ["operacoes", "Operações"],
  ["pagamentos", "Pagamentos"],
  ["carteiras", "Carteiras"],
] as const;
type Tab = (typeof TABS)[number][0];

const STATUS_LABEL: Record<string, string> = {
  TRIALING: "Teste", ACTIVE: "Ativo", SUSPENDED: "Suspenso", CLOSED: "Encerrado", PAST_DUE: "Em atraso", EXPIRED: "Expirado", CANCELED: "Cancelado",
  OPEN: "Em aberto", PAID: "Quitada",
};
const label = (status: string | null) => (status ? STATUS_LABEL[status] ?? status : "—");
const day = (value: Date | string) => formatDate(typeof value === "string" ? value.slice(0, 10) : todayIso(value));

export default async function AdminPage({ searchParams }: { searchParams: Promise<{ aba?: string }> }) {
  if (!(await databaseAvailable())) redirect("/setup");
  const session = await requireSuperAdmin();
  const { aba } = await searchParams;
  const tab: Tab = TABS.some(([key]) => key === aba) ? (aba as Tab) : "relatorio";
  const data = await loadPlatformOverview();
  const { totals } = data;

  return (
    <main className="admin-page">
      <header className="admin-header">
        <div>
          <div className="auth-kicker"><i /> CREDIAI · PLATAFORMA</div>
          <h1>Administração da plataforma</h1>
          <p>Olá, {session.user.name}. Visão global somente leitura de todos os tenants.</p>
        </div>
        <div className="admin-header-actions">
          {session.user.tenantId && <Link href="/" className="admin-link">Minha carteira</Link>}
          <SignOutButton label="Sair" />
        </div>
      </header>

      <nav className="admin-tabs" aria-label="Seções da administração">
        {TABS.map(([key, name]) => <Link key={key} href={`/admin?aba=${key}`} aria-current={tab === key ? "page" : undefined}>{name}</Link>)}
      </nav>

      {tab === "relatorio" && (
        <>
          <section className="admin-stats">
            <Stat label="Tenants" value={totals.tenants} />
            <Stat label="Usuários" value={totals.users} hint={`${totals.superAdmins} MASTER`} />
            <Stat label="Clientes" value={totals.clients} />
            <Stat label="Operações" value={totals.operations} hint={`${totals.openOperations} em aberto`} />
            <Stat label="Capital emprestado" value={formatMoney(totals.lentCents)} />
            <Stat label="Pagamentos recebidos" value={formatMoney(totals.receivedCents)} hint={`${totals.payments} pagamentos`} />
            <Stat label="Carteiras" value={totals.wallets} />
          </section>
          <Table head={["Tenant", "Clientes", "Operações em aberto", "Emprestado", "Recebido"]} empty="Nenhum tenant.">
            {data.tenants.map((tenant) => <tr key={tenant.id}><td>{tenant.name}</td><td>{tenant.clientCount}</td><td>{tenant.openOperationCount}</td><td>{formatMoney(tenant.lentCents)}</td><td>{formatMoney(tenant.receivedCents)}</td></tr>)}
          </Table>
        </>
      )}

      {tab === "tenants" && (
        <Table head={["Tenant", "Usuários", "Status", "Plano", "Assinatura", "Vence em", "Criado em"]} empty="Nenhum tenant.">
          {data.tenants.map((tenant) => <tr key={tenant.id}><td>{tenant.name}{tenant.hasSuperAdmin && <span className="admin-badge">MASTER</span>}</td><td>{tenant.owners ?? "—"}</td><td>{label(tenant.status)}</td><td>{tenant.planName}</td><td>{label(tenant.subscriptionStatus)}</td><td>{tenant.subscriptionExpiresAt ? day(tenant.subscriptionExpiresAt) : "—"}</td><td>{day(tenant.createdAt)}</td></tr>)}
        </Table>
      )}

      {tab === "usuarios" && (
        <Table head={["Nome", "E-mail", "Papel", "Tenant", "Situação", "Criado em"]} empty="Nenhum usuário.">
          {data.users.map((user) => <tr key={user.id}><td>{user.name}</td><td>{user.email}</td><td>{user.role === "SUPER_ADMIN" ? "MASTER" : "Usuário"}</td><td>{user.tenantName ?? "—"}</td><td>{user.active ? "Ativo" : "Desativado"}</td><td>{day(user.createdAt)}</td></tr>)}
        </Table>
      )}

      {tab === "clientes" && (
        <Table head={["Cliente", "Tenant", "Situação", "Criado em"]} empty="Nenhum cliente.">
          {data.clients.map((client) => <tr key={client.id}><td>{client.name}</td><td>{client.tenantName}</td><td>{client.archivedAt ? "Arquivado" : "Ativo"}</td><td>{day(client.createdAt)}</td></tr>)}
        </Table>
      )}

      {tab === "operacoes" && (
        <Table head={["Cliente", "Tenant", "Modalidade", "Principal", "Total", "Status", "Data", "Vencimento"]} empty="Nenhuma operação.">
          {data.operations.map((operation) => <tr key={operation.id}><td>{operation.clientName}</td><td>{operation.tenantName}</td><td>{operation.modality === "INSTALLMENT" ? "Parcelado" : "Pagamento único"}</td><td>{formatMoney(operation.principalCents)}</td><td>{formatMoney(operation.totalCents)}</td><td>{label(operation.status)}</td><td>{formatDate(operation.loanDate)}</td><td>{formatDate(operation.dueDate)}</td></tr>)}
        </Table>
      )}

      {tab === "pagamentos" && (
        <Table head={["Cliente", "Tenant", "Valor", "Data"]} empty="Nenhum pagamento.">
          {data.payments.map((payment) => <tr key={payment.id}><td>{payment.clientName}</td><td>{payment.tenantName}</td><td>{formatMoney(payment.amountCents)}</td><td>{formatDate(payment.paidAt)}</td></tr>)}
        </Table>
      )}

      {tab === "carteiras" && (
        <Table head={["Tenant", "Capital inicial", "Ciclo atual", "Criada em"]} empty="Nenhuma carteira.">
          {data.wallets.map((wallet) => <tr key={wallet.id}><td>{wallet.tenantName}</td><td>{formatMoney(wallet.initialCapitalCents)}</td><td>{wallet.cycleNumber}</td><td>{day(wallet.createdAt)}</td></tr>)}
        </Table>
      )}

      {tab !== "relatorio" && tab !== "tenants" && <p className="admin-note">Mostrando os 100 registros mais recentes.</p>}
    </main>
  );
}

function Stat({ label: name, value, hint }: { label: string; value: string | number; hint?: string }) {
  return <div className="admin-stat"><span>{name}</span><strong>{value}</strong>{hint && <small>{hint}</small>}</div>;
}

function Table({ head, empty, children }: { head: string[]; empty: string; children: React.ReactNode[] }) {
  return (
    <div className="admin-table-wrap">
      <table className="admin-table">
        <thead><tr>{head.map((title) => <th key={title}>{title}</th>)}</tr></thead>
        <tbody>{children.length ? children : <tr><td colSpan={head.length}>{empty}</td></tr>}</tbody>
      </table>
    </div>
  );
}
