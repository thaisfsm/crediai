import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { databaseAvailable } from "@/lib/db";
import { loadSaasClientDetail } from "@/lib/admin/queries";
import { formatMoney, formatPhone, todayIso } from "@/lib/finance/format";
import { AdminShell, CommercialBadge, Kpi, dateLabel, dueLabel, relativeAccess } from "../../admin-ui";
import SaasClientForm from "../saas-client-form";
import ClientActions from "./client-actions";
import { planPriceLabel } from "@/lib/admin/plan-price";
import { CONDITION_LABEL } from "@/lib/billing/rules";
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
  const { commercial } = client;
  const today = todayIso();
  const trial = commercial.status === "TRIALING" || commercial.status === "TRIAL_EXPIRED";
  const due = dueLabel(commercial);
  return (
    <AdminShell active="clientes" userName={session.user.name} hasOwnWallet={Boolean(session.user.tenantId)}>
      <Link href="/admin" className="central-back">← Clientes SaaS</Link>
      <section className="central-hero">
        <div>
          <div className="auth-kicker"><i /> CLIENTE SaaS</div>
          <h2>{client.name}</h2>
          <p>{client.email ?? "Sem usuário"}{client.contactPhone ? ` · ${formatPhone(client.contactPhone)}` : ""} · Ambiente “{client.tenantName}”</p>
          {/* Situação comercial e uso ficam separados: um cliente Ativo pode estar sem acessar há dias, e um cliente
              Em teste pode estar usando muito. */}
          <div className="central-hero-meta" aria-label="Situação comercial">
            {client.isPlatformOwner ? <span className="saas-owner">Conta da administração (SUPER_ADMIN) · sem cobrança</span> : <CommercialBadge status={commercial.status} />}
            {!client.isPlatformOwner && <span>Plano <b>{client.planName}</b></span>}
            {!client.isPlatformOwner && commercial.condition && <span>Condição <b>{CONDITION_LABEL[commercial.condition]}</b></span>}
          </div>
          <div className="central-hero-meta" aria-label="Uso da plataforma">
            <span>Cadastro <b>{dateLabel(client.createdAt)}</b></span>
            <span>Último acesso <b>{relativeAccess(client.lastAccessAt)}</b></span>
            <span className={client.canAccess ? "is-ok" : "is-late"}>{client.canAccess ? "Acesso liberado" : "Sem acesso no momento"}</span>
          </div>
          {client.attention.length > 0 && <div className="saas-card-tags">{client.attention.map((reason) => <em key={reason}>{reason}</em>)}</div>}
        </div>
      </section>

      {!client.isPlatformOwner && (
        <section className="central-panel" id="assinatura">
          <header className="central-panel-head"><div><h2>Assinatura</h2><p>Condição comercial deste cliente. O preço padrão é do plano; o valor contratado é deste cliente e não muda quando o plano muda.</p></div></header>
          <dl className="commercial-grid">
            <div><dt>Plano</dt><dd>{client.planName}</dd></div>
            <div><dt>Preço padrão</dt><dd>{planPriceLabel(client.planPriceInCents)}</dd></div>
            <div><dt>Valor contratado</dt><dd>{commercial.contractedPriceCents === null ? "—" : `${formatMoney(commercial.contractedPriceCents)}/mês`}</dd></div>
            <div><dt>Condição</dt><dd>{commercial.condition ? CONDITION_LABEL[commercial.condition] : "—"}</dd></div>
            <div><dt>Status</dt><dd><CommercialBadge status={commercial.status} /></dd></div>
            {trial
              ? <div><dt>Fim do teste</dt><dd>{dateLabel(client.subscriptionExpiresAt)}</dd></div>
              : <div><dt>Ativação</dt><dd>{dateLabel(commercial.activatedAt)}</dd></div>}
            <div><dt>Próximo vencimento</dt><dd>{commercial.condition === "COURTESY" ? "Sem cobrança" : dateLabel(commercial.nextDueDate)}{due && <small>{due}</small>}</dd></div>
            <div><dt>Ciclo</dt><dd>{trial ? "—" : "Mensal"}</dd></div>
            <div><dt>Tolerância</dt><dd>{commercial.graceDays} dias</dd></div>
            <div><dt>Último pagamento</dt><dd>{dateLabel(commercial.lastPaidAt)}</dd></div>
          </dl>
          {detail.charges.length > 0 && (
            <ul className="central-list">{detail.charges.map((charge) => (
              <li key={charge.id}><span><strong>Mensalidade de {dateLabel(charge.dueDate)}</strong><small>{charge.status === "PAID" ? `Paga em ${dateLabel(charge.paidAt)}` : charge.status} · {charge.provider === "MANUAL" ? "registro manual" : charge.provider}</small></span><b>{formatMoney(charge.amountCents)}</b></li>
            ))}</ul>
          )}
        </section>
      )}

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
          <p className="central-hint">{client.paymentCount === 1 ? "1 pagamento" : `${client.paymentCount} pagamentos`} · Último acesso: {relativeAccess(client.lastAccessAt)}</p>
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
        <ClientActions tenantId={client.tenantId} status={client.status} userActive={client.userActive} locked={client.isPlatformOwner} plans={detail.plans} today={today}
          subscription={{
            activatedAt: commercial.activatedAt, nextDueDate: commercial.nextDueDate, contractedPriceCents: commercial.contractedPriceCents, courtesy: commercial.condition === "COURTESY",
            terms: { planId: client.planId, condition: commercial.condition, contractedCents: commercial.contractedPriceCents, dueDate: commercial.nextDueDate, graceDays: commercial.graceDays },
          }} />
      </section>

      {!client.isPlatformOwner && client.email && (
        <section className="central-panel">
          <header className="central-panel-head"><div><h2>Editar cliente SaaS</h2></div></header>
          <SaasClientForm plans={detail.plans} today={today} initial={{ tenantId: client.tenantId, name: client.name, email: client.email, phone: formatPhone(client.contactPhone) ?? "", planId: client.planId, tenantName: client.tenantName }} />
        </section>
      )}
    </AdminShell>
  );
}
