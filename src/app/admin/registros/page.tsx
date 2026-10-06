import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { loadAdminAuditLog, loadPlatformOverview, type AdminAuditPage } from "@/lib/admin/queries";
import { AUDIT_ACTIONS, AUDIT_ENTITIES, AUDIT_FIELD_LABELS, changedFields, type AuditSnapshot } from "@/lib/admin/audit-rules";
import { formatDate, formatMoney, TIME_ZONE, todayIso } from "@/lib/finance/format";
import { originalDueDateOf } from "@/lib/finance/portfolio";
import { AdminShell, relativeAccess } from "../admin-ui";
import { DatabaseErrorState, databaseGate } from "@/app/database-error-state";

export const dynamic = "force-dynamic";

const TABS = [
  ["relatorio", "Relatório global"],
  ["auditoria", "Auditoria"],
  ["tenants", "Tenants"],
  ["usuarios", "Usuários"],
  ["clientes", "Clientes finais"],
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
const dateTime = (iso: string) => new Intl.DateTimeFormat("pt-BR", { timeZone: TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(iso));
const FREQUENCY_LABEL: Record<string, string> = { MONTHLY: "Mensal", BIWEEKLY: "Quinzenal", DAILY: "Diário" };
const modalityLabel = (modality: string, frequency: string) => (modality === "INSTALLMENT" ? "Parcelado" : `Pagamento único · ${FREQUENCY_LABEL[frequency] ?? frequency}`);
type AuditFilters = { aba?: string; q?: string; acao?: string; tenant?: string; de?: string; ate?: string; ordem?: string; pagina?: string };

export default async function AdminPage({ searchParams }: { searchParams: Promise<AuditFilters> }) {
  const gate = await databaseGate();
  if (gate === "not_configured") redirect("/setup");
  if (gate !== "ok") return <DatabaseErrorState kind={gate} />;
  const session = await requireSuperAdmin();
  const params = await searchParams;
  const tab: Tab = TABS.some(([key]) => key === params.aba) ? (params.aba as Tab) : "relatorio";
  if (tab === "auditoria") {
    const audit = await loadAdminAuditLog(params);
    return (
      <AdminShell active="registros" userName={session.user.name} hasOwnWallet={Boolean(session.user.tenantId)}>
        <p className="admin-note">Registros brutos de toda a plataforma, somente leitura. Clientes aqui são os clientes finais das carteiras.</p>
        <Tabs tab={tab} />
        <AuditLog audit={audit} />
      </AdminShell>
    );
  }
  const data = await loadPlatformOverview();
  const { totals } = data;

  return (
    <AdminShell active="registros" userName={session.user.name} hasOwnWallet={Boolean(session.user.tenantId)}>
      <p className="admin-note">Registros brutos de toda a plataforma, somente leitura. Clientes aqui são os clientes finais das carteiras.</p>

      <Tabs tab={tab} />

      {tab === "relatorio" && (
        <>
          <section className="admin-stats">
            <Stat label="Tenants" value={totals.tenants} />
            <Stat label="Usuários" value={totals.users} hint={`${totals.superAdmins} MASTER`} />
            <Stat label="Clientes" value={totals.clients} />
            <Stat label="Operações" value={totals.operations} hint={`${totals.openOperations} em aberto`} />
            {/* Soma bruta do principal de todas as operações (inclui as quitadas). Não é o "Capital emprestado" do dashboard e da Central, que é o principal ainda em aberto. */}
            <Stat label="Principal contratado (todas as operações)" value={formatMoney(totals.lentCents)} hint="inclui operações quitadas" />
            <Stat label="Pagamentos recebidos" value={formatMoney(totals.receivedCents)} hint={`${totals.payments} pagamentos`} />
            <Stat label="Carteiras" value={totals.wallets} />
          </section>
          <Table head={["Tenant", "Clientes", "Operações em aberto", "Principal contratado", "Recebido"]} empty="Nenhum tenant.">
            {data.tenants.map((tenant) => <tr key={tenant.id}><td>{tenant.name}</td><td>{tenant.clientCount}</td><td>{tenant.openOperationCount}</td><td>{formatMoney(tenant.lentCents)}</td><td>{formatMoney(tenant.receivedCents)}</td></tr>)}
          </Table>
        </>
      )}

      {tab === "tenants" && (
        <Table head={["Tenant", "Usuários", "Status", "Plano", "Assinatura", "Vence em", "Criado em"]} empty="Nenhum tenant.">
          {/* O ambiente da conta MASTER é da própria plataforma: não é cliente SaaS, não está "em teste" e não vence. */}
          {data.tenants.map((tenant) => <tr key={tenant.id}><td>{tenant.name}{tenant.hasSuperAdmin && <span className="admin-badge">MASTER</span>}</td><td>{tenant.owners ?? <span className="admin-muted">Sem usuário</span>}</td>{tenant.hasSuperAdmin
            ? <><td>Conta da plataforma</td><td>—</td><td>Não se aplica</td><td>—</td></>
            : <><td>{label(tenant.status)}</td><td>{tenant.planName}</td><td>{label(tenant.subscriptionStatus)}</td><td>{tenant.subscriptionExpiresAt ? day(tenant.subscriptionExpiresAt) : "—"}</td></>}<td>{day(tenant.createdAt)}</td></tr>)}
        </Table>
      )}

      {tab === "usuarios" && (
        <Table head={["Nome", "E-mail", "Papel", "Tenant", "Situação", "Último acesso", "Criado em"]} empty="Nenhum usuário.">
          {data.users.map((user) => <tr key={user.id}><td>{user.name}</td><td>{user.email}</td><td>{user.role === "SUPER_ADMIN" ? "MASTER" : "Usuário"}</td><td>{user.tenantName ?? "—"}</td><td>{user.active ? "Ativo" : "Desativado"}</td><td>{relativeAccess(user.lastAccessAt)}</td><td>{day(user.createdAt)}</td></tr>)}
        </Table>
      )}

      {tab === "clientes" && (
        <Table head={["Cliente", "Tenant", "Situação", "Criado em"]} empty="Nenhum cliente.">
          {data.clients.map((client) => <tr key={client.id}><td>{client.name}</td><td>{client.tenantName}</td><td>{client.archivedAt ? "Arquivado" : "Ativo"}</td><td>{day(client.createdAt)}</td></tr>)}
        </Table>
      )}

      {tab === "operacoes" && (
        // "Vencimento original" é o primeiro vencimento combinado (mesma regra da carteira). O vencimento gravado na
        // operação muda a cada renovação (pagamento único) e, no parcelado e no diário, é o da última parcela.
        <Table head={["Cliente", "Tenant", "Modalidade", "Principal", "Total contratado", "Status", "Data", "Vencimento original", "Vencimento atual"]} empty="Nenhuma operação.">
          {data.operations.map((operation) => {
            const amortized = operation.modality === "INSTALLMENT" || operation.frequency === "DAILY";
            return <tr key={operation.id}><td>{operation.clientName}</td><td>{operation.tenantName}</td><td>{modalityLabel(operation.modality, operation.frequency)}</td><td>{formatMoney(operation.principalCents)}</td><td>{formatMoney(operation.totalCents)}</td><td>{label(operation.status)}</td><td>{formatDate(operation.loanDate)}</td><td>{formatDate(originalDueDateOf(operation.firstDueDate, operation.firstRenewalPreviousDueDate, operation.dueDate))}</td><td>{amortized ? `Última parcela ${formatDate(operation.dueDate)}` : formatDate(operation.dueDate)}</td></tr>;
          })}
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
    </AdminShell>
  );
}

function Tabs({ tab }: { tab: Tab }) {
  return (
    <nav className="admin-tabs" aria-label="Seções dos registros">
      {TABS.map(([key, name]) => <Link key={key} href={`/admin/registros?aba=${key}`} aria-current={tab === key ? "page" : undefined}>{name}</Link>)}
    </nav>
  );
}

function auditValue(key: string, value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Sim" : "Não";
  if (typeof value === "number" && /Cents$/.test(key)) return formatMoney(value);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return dateTime(value);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDate(value);
  return String(value);
}

function AuditChanges({ before, after }: { before: AuditSnapshot | null; after: AuditSnapshot | null }) {
  const keys = before ? changedFields(before, after) : Object.keys(after ?? {});
  if (keys.length === 0) return <p className="admin-muted">Nenhum campo alterado.</p>;
  return (
    <table className="admin-audit-diff">
      <thead><tr><th>Campo</th>{before && <th>Antes</th>}<th>{before ? "Depois" : "Valor"}</th></tr></thead>
      <tbody>{keys.map((key) => <tr key={key}><td>{AUDIT_FIELD_LABELS[key] ?? key}</td>{before && <td>{auditValue(key, before[key])}</td>}<td>{auditValue(key, after?.[key])}</td></tr>)}</tbody>
    </table>
  );
}

// Auditoria administrativa: só leitura. Nenhum botão de editar ou apagar (o banco também recusa).
function AuditLog({ audit }: { audit: AdminAuditPage }) {
  const { filters } = audit;
  const pageHref = (page: number) => `/admin/registros?${new URLSearchParams({ aba: "auditoria", ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)), pagina: String(page) })}`;
  return (
    <section className="admin-audit" aria-label="Auditoria administrativa">
      <p className="admin-note">Cada alteração feita na administração (clientes SaaS, assinaturas, condição comercial, acesso, senha e planos) fica registrada aqui com quem fez, quando, de onde e o que mudou. Os registros não podem ser editados nem apagados.</p>
      <form className="central-filters admin-audit-filters" method="get" action="/admin/registros">
        <input type="hidden" name="aba" value="auditoria" />
        <label>Buscar<input type="search" name="q" defaultValue={filters.q} placeholder="Descrição, usuário, cliente SaaS…" /></label>
        <label>Ação<select name="acao" defaultValue={filters.acao}><option value="">Todas</option>{Object.entries(AUDIT_ACTIONS).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
        <label>Cliente SaaS<select name="tenant" defaultValue={filters.tenant}><option value="">Todos</option>{audit.tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name ?? tenant.id}</option>)}</select></label>
        <label>De<input type="date" name="de" defaultValue={filters.de} /></label>
        <label>Até<input type="date" name="ate" defaultValue={filters.ate} /></label>
        <label>Ordem<select name="ordem" defaultValue={filters.ordem}><option value="recentes">Mais recentes primeiro</option><option value="antigas">Mais antigas primeiro</option></select></label>
        <div className="admin-audit-filter-actions"><button type="submit" className="central-secondary">Filtrar</button><Link href="/admin/registros?aba=auditoria" className="central-ghost">Limpar</Link></div>
      </form>
      <p className="admin-muted">{audit.matched === 0 ? "Nenhum registro encontrado." : `${audit.matched} ${audit.matched === 1 ? "registro" : "registros"} · página ${audit.page} de ${audit.pages}`}</p>
      <Table head={["Data e hora", "Quem fez", "Ação", "Cliente SaaS", "Descrição", "Detalhes"]} empty={filters.q || filters.acao || filters.tenant || filters.de || filters.ate ? "Nenhum registro com estes filtros." : "Nenhuma ação administrativa registrada ainda. As próximas alterações aparecerão aqui."}>
        {audit.rows.map((row) => (
          <tr key={row.id}>
            <td>{dateTime(row.createdAt)}</td>
            <td>{row.actorName}<small className="admin-cell-note">{row.actorEmail}</small></td>
            <td>{AUDIT_ACTIONS[row.action as keyof typeof AUDIT_ACTIONS] ?? row.action}</td>
            <td>{row.tenantName ?? "—"}</td>
            <td>{row.description}</td>
            <td>
              <details className="admin-audit-details">
                <summary>Ver</summary>
                <AuditChanges before={row.before} after={row.after} />
                <p className="admin-cell-note">{AUDIT_ENTITIES[row.entity] ?? row.entity}{row.entityId ? ` · ${row.entityId}` : ""}</p>
                <p className="admin-cell-note">IP {row.ipAddress ?? "não informado"} · {row.userAgent ?? "navegador não informado"}</p>
              </details>
            </td>
          </tr>
        ))}
      </Table>
      {audit.pages > 1 && (
        <nav className="central-pagination" aria-label="Páginas da auditoria">
          {audit.page > 1 ? <Link href={pageHref(audit.page - 1)}>← Anterior</Link> : <span />}
          <span>Página {audit.page} de {audit.pages}</span>
          {audit.page < audit.pages ? <Link href={pageHref(audit.page + 1)}>Próxima →</Link> : <span />}
        </nav>
      )}
    </section>
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
