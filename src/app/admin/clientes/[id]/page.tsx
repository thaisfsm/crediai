import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { databaseAvailable } from "@/lib/db";
import { loadSaasClientDetail } from "@/lib/admin/queries";
import { formatMoney, formatPhone } from "@/lib/finance/format";
import { AdminShell, Kpi, StatusBadge, dateLabel, relativeAccess } from "../../admin-ui";
import SaasClientForm from "../saas-client-form";
import ClientActions from "./client-actions";
import { AreaChart, BarChart } from "./charts";

export const dynamic = "force-dynamic";

export default async function SaasClientPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await databaseAvailable())) redirect("/setup");
  const session = await requireSuperAdmin();
  const { id } = await params;
  const detail = await loadSaasClientDetail(id.slice(0, 80));
  if (!detail) notFound();
  const { client, profitability } = detail;
  const { money } = client;
  const subscriptionNote = client.subscriptionExpiresAt
    ? `${client.subscriptionValid ? "Vence" : "Venceu"} em ${dateLabel(client.subscriptionExpiresAt)}`
    : "Sem vencimento";

  return (
    <AdminShell active="clientes" userName={session.user.name} hasOwnWallet={Boolean(session.user.tenantId)}>
      <Link href="/admin" className="central-back">← Clientes SaaS</Link>
      <section className="central-hero">
        <div>
          <div className="auth-kicker"><i /> CLIENTE SaaS</div>
          <h2>{client.name}</h2>
          <p>{client.email ?? "Sem usuário"}{client.contactPhone ? ` · ${formatPhone(client.contactPhone)}` : ""} · Ambiente “{client.tenantName}”</p>
          <div className="central-hero-meta">
            <StatusBadge status={client.status} />
            <span>Plano <b>{client.planName}</b></span>
            <span>Assinatura <b>{subscriptionNote}</b></span>
            <span>Cadastro <b>{dateLabel(client.createdAt)}</b></span>
            <span>Último acesso <b>{relativeAccess(client.lastAccessAt)}</b></span>
            <span className={client.canAccess ? "is-ok" : "is-late"}>{client.canAccess ? "Acesso liberado" : "Sem acesso no momento"}</span>
          </div>
          {client.attention.length > 0 && <div className="saas-card-tags">{client.attention.map((reason) => <em key={reason}>{reason}</em>)}</div>}
        </div>
      </section>

      <section className="central-panel" id="carteira">
        <header className="central-panel-head"><div><h2>Carteira</h2><p>Ciclo {client.cycleNumber} da carteira deste cliente SaaS, com o mesmo cálculo que ele vê no dashboard.{client.needsInitialCapital ? " O capital inicial ainda não foi informado." : ""}</p></div></header>
        <div className="central-kpis central-kpis-3">
          <Kpi label="Capital disponível" value={formatMoney(money.availableCents)} hint={`Capital investido ${formatMoney(detail.investedCents)}`} tone="cyan" />
          <Kpi label="Capital emprestado" value={formatMoney(money.lentCents)} hint="Principal ainda não devolvido" />
          <Kpi label="Total a receber" value={formatMoney(money.receivableCents)} hint="Principal + juros em aberto" />
          <Kpi label="Juros previstos" value={formatMoney(money.expectedInterestCents)} hint="Ainda não recebidos" tone="amber" />
          <Kpi label="Juros recebidos" value={formatMoney(money.receivedInterestCents)} tone="green" />
          <Kpi label="Total recebido" value={formatMoney(money.receivedCents)} hint={client.paymentCount === 1 ? "1 pagamento" : `${client.paymentCount} pagamentos`} tone="green" />
        </div>
      </section>

      <div className="central-columns">
        <section className="central-panel">
          <header className="central-panel-head"><div><h2>Clientes finais</h2><p>Pessoas cadastradas na carteira deste cliente SaaS.</p></div></header>
          <div className="central-mini">
            <Kpi label="Total" value={client.clients.total} />
            <Kpi label="Ativos" value={client.clients.active} />
            <Kpi label="Arquivados" value={client.clients.archived} />
          </div>
        </section>
        <section className="central-panel">
          <header className="central-panel-head"><div><h2>Operações</h2><p>Ciclo atual da carteira.</p></div></header>
          <div className="central-mini">
            <Kpi label="Abertas" value={client.operations.open} />
            <Kpi label="Quitadas" value={client.operations.paid} />
            <Kpi label="Em atraso" value={client.operations.overdue} tone={client.operations.overdue ? "red" : undefined} />
          </div>
          <p className="central-hint">Emprestado no ciclo: {formatMoney(profitability.principalCents)} · Juros contratados: {formatMoney(profitability.interestCents)}</p>
        </section>
      </div>

      <div className="central-columns">
        <section className="central-panel">
          <header className="central-panel-head"><div><h2>Saldo a receber</h2><p>Últimos 90 dias, a partir das datas registradas.</p></div></header>
          <AreaChart labels={detail.receivableChart.labels} values={detail.receivableChart.values} title="Saldo a receber nos últimos 90 dias" />
        </section>
        <section className="central-panel">
          <header className="central-panel-head"><div><h2>Recebido por mês</h2><p>Pagamentos registrados nos últimos 6 meses.</p></div></header>
          <BarChart items={detail.receivedByMonth} title="Recebido por mês nos últimos 6 meses" />
        </section>
      </div>

      <div className="central-columns">
        <section className="central-panel">
          <header className="central-panel-head"><div><h2>Últimos pagamentos</h2></div></header>
          {detail.recentPayments.length === 0 ? <p className="central-empty">Nenhum pagamento neste ciclo.</p> : (
            <ul className="central-list">{detail.recentPayments.map((item) => <li key={item.key}><span><strong>{item.clientName}</strong><small>{item.detail}</small></span><b>{formatMoney(item.amountCents)}</b></li>)}</ul>
          )}
        </section>
        <section className="central-panel">
          <header className="central-panel-head"><div><h2>Em atraso</h2></div></header>
          {detail.overdue.length === 0 ? <p className="central-empty">Nenhuma operação em atraso.</p> : (
            <ul className="central-list">{detail.overdue.map((item) => <li key={item.key}><span><strong>{item.clientName}</strong><small>{item.detail} · {item.status}</small></span><b className="is-late">{formatMoney(item.amountCents)}</b></li>)}</ul>
          )}
        </section>
      </div>

      <section className="central-panel">
        <header className="central-panel-head"><div><h2>Gerenciar acesso</h2><p>Usuários deste ambiente. Toda conta criada pela plataforma é TENANT_USER.</p></div></header>
        <ul className="central-list">
          {detail.users.map((user) => (
            <li key={user.id}>
              <span><strong>{user.name}</strong><small>{user.email} · {user.role === "SUPER_ADMIN" ? "SUPER_ADMIN" : "TENANT_USER"} · último acesso {relativeAccess(user.lastLoginAt)}</small></span>
              <b className={user.active ? "is-ok" : "is-late"}>{user.active ? (user.mustChangePassword ? "Senha provisória" : "Ativo") : "Bloqueado"}</b>
            </li>
          ))}
        </ul>
        <ClientActions tenantId={client.tenantId} status={client.status} userActive={client.userActive} locked={client.isPlatformOwner} />
      </section>

      {!client.isPlatformOwner && client.email && (
        <section className="central-panel">
          <header className="central-panel-head"><div><h2>Editar cliente SaaS</h2></div></header>
          <SaasClientForm plans={detail.plans} initial={{ tenantId: client.tenantId, name: client.name, email: client.email, phone: formatPhone(client.contactPhone) ?? "", planId: client.planId, tenantName: client.tenantName }} />
        </section>
      )}
    </AdminShell>
  );
}
