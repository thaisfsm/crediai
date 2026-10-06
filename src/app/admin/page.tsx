import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { DatabaseErrorState, databaseGate } from "@/app/database-error-state";
import { loadSaasClients, type SaasClient } from "@/lib/admin/queries";
import { formatMoney } from "@/lib/finance/format";
import { AdminShell, CommercialBadge, Kpi, dateLabel, dueLabel, relativeAccess } from "./admin-ui";
import { planLabel } from "@/lib/admin/plan-price";
import { CONDITION_LABEL } from "@/lib/billing/rules";

export const dynamic = "force-dynamic";

type Search = { q?: string; status?: string; plano?: string; ordem?: string; pagina?: string };

export default async function AdminCentralPage({ searchParams }: { searchParams: Promise<Search> }) {
  // Só banco não configurado vai para /setup; instabilidade ou erro mostram "tente novamente" aqui mesmo.
  const gate = await databaseGate();
  if (gate === "not_configured") redirect("/setup");
  if (gate !== "ok") return <DatabaseErrorState kind={gate} />;
  const session = await requireSuperAdmin();
  const data = await loadSaasClients(await searchParams);
  const { kpis, filters } = data;
  const pageHref = (page: number) => `/admin?${new URLSearchParams({ ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)), pagina: String(page) })}`;

  return (
    <AdminShell active="clientes" userName={session.user.name} hasOwnWallet={Boolean(session.user.tenantId)}>
      <section className="central-kpis central-kpis-4" aria-label="Resumo da plataforma">
        <Kpi label="Clientes SaaS" value={kpis.total} hint={<><b className="dot-active" />{kpis.active} ativos · <b className="dot-trial" />{kpis.trialing} em teste · <b className="dot-late" />{kpis.pastDue} vencidos · <b className="dot-suspended" />{kpis.suspended} suspensos</>} tone="cyan" />
        <Kpi label="Receita mensal contratada" value={formatMoney(kpis.monthlyRevenueCents)} hint={`Soma dos valores contratados${kpis.courtesy ? ` · ${kpis.courtesy} em cortesia` : ""} · em teste: ${formatMoney(kpis.trialRevenueCents)} pelo preço padrão`} tone="green" />
        <Kpi label="Clientes finais" value={kpis.finalClients} hint={`${kpis.activeFinalClients} ativos nas carteiras`} />
        <Kpi label="Operações abertas" value={kpis.openOperations} hint={kpis.overdueOperations ? `${kpis.overdueOperations} em atraso` : "Nenhuma em atraso"} tone={kpis.overdueOperations ? "red" : undefined} />
        <Kpi label="Capital emprestado" value={formatMoney(kpis.lentCents)} hint="Principal ainda não devolvido" />
        <Kpi label="Total a receber" value={formatMoney(kpis.receivableCents)} hint="Saldo das operações abertas" />
        <Kpi label="Juros previstos" value={formatMoney(kpis.expectedInterestCents)} hint="Ainda não recebidos" tone="amber" />
        <Kpi label="Recebido" value={formatMoney(kpis.receivedCents)} hint={`${formatMoney(kpis.receivedInterestCents)} de juros`} tone="green" />
      </section>

      {data.attention.length > 0 && (
        <section className="central-panel">
          <header className="central-panel-head"><div><h2>Precisam da sua atenção</h2><p>Clientes SaaS com acesso parado, teste vencendo, senha provisória pendente ou atraso na carteira.</p></div></header>
          <ul className="central-attention">
            {data.attention.map((client) => (
              <li key={client.tenantId}>
                <Link href={`/admin/clientes/${client.tenantId}`}>
                  <span className="central-avatar" aria-hidden>{initials(client.name)}</span>
                  <span className="central-attention-name"><strong>{client.name}</strong><small>{client.email}</small></span>
                  <span className="central-attention-tags">{client.attention.map((reason) => <em key={reason}>{reason}</em>)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="central-panel">
        <header className="central-panel-head">
          <div>
            <h2>Clientes SaaS</h2>
            <p>Quem assina e usa o CrediAI. Os números de cada um vêm da carteira dele (ciclo atual), com o mesmo cálculo do dashboard.</p>
          </div>
          <Link href="/admin/clientes/novo" className="central-primary">+ Novo cliente SaaS</Link>
        </header>

        <form className="central-filters" action="/admin" method="get" role="search">
          <label className="central-search"><span>Buscar</span><input name="q" defaultValue={filters.q} placeholder="Nome ou e-mail" maxLength={120} /></label>
          <label><span>Status</span><select name="status" defaultValue={filters.status}>
            <option value="">Todos</option><option value="ACTIVE">Ativo</option><option value="TRIALING">Em teste</option><option value="PAST_DUE">Vencido</option><option value="SUSPENDED">Suspenso</option><option value="CLOSED">Encerrado</option>
          </select></label>
          <label><span>Plano</span><select name="plano" defaultValue={filters.plano}>
            <option value="">Todos</option>{data.plans.map((plan) => <option key={plan.id} value={plan.id}>{planLabel(plan.name, plan.priceInCents, true)}</option>)}
          </select></label>
          <label><span>Ordenar por</span><select name="ordem" defaultValue={filters.ordem}>
            <option value="nome">Nome</option><option value="emprestado">Capital emprestado</option><option value="clientes">Quantidade de clientes</option><option value="atividade">Atividade recente</option><option value="vencimento">Próximo vencimento</option>
          </select></label>
          <button className="central-secondary">Aplicar</button>
        </form>

        <p className="central-count">{data.matched === 1 ? "1 cliente SaaS encontrado" : `${data.matched} clientes SaaS encontrados`}</p>
        {data.clients.length === 0
          ? <div className="central-empty">Nenhum cliente SaaS com esses filtros.</div>
          : <div className="saas-grid">{data.clients.map((client) => <SaasCard key={client.tenantId} client={client} />)}</div>}

        {data.pages > 1 && (
          <nav className="central-pagination" aria-label="Páginas">
            {data.page > 1 ? <Link href={pageHref(data.page - 1)}>← Anterior</Link> : <span />}
            <span>{`Página ${data.page} de ${data.pages}`}</span>
            {data.page < data.pages ? <Link href={pageHref(data.page + 1)}>Próxima →</Link> : <span />}
          </nav>
        )}
      </section>
    </AdminShell>
  );
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
}

function SaasCard({ client }: { client: SaasClient }) {
  const { money } = client;
  return (
    <article className={`saas-card${client.attention.length ? " saas-card-alert" : ""}`}>
      <header>
        <span className="central-avatar" aria-hidden>{initials(client.name)}</span>
        <div className="saas-card-title">
          <h3><Link href={`/admin/clientes/${client.tenantId}`}>{client.name}</Link></h3>
          <small>{client.email ?? "Sem usuário"}</small>
        </div>
      </header>
      {/* Situação comercial (plano, valor contratado, condição, status, vencimento) separada do uso logo abaixo. */}
      {client.isPlatformOwner
        ? <div className="saas-card-plan"><span className="saas-owner">Conta da administração · sem cobrança</span></div>
        : <CommercialSummary client={client} />}
      <div className="saas-card-meta">
        <span>Último acesso <b>{relativeAccess(client.lastAccessAt)}</b></span>
        <span>Desde <b>{dateLabel(client.createdAt)}</b></span>
      </div>
      <dl className="saas-card-money">
        <div><dt>Capital disponível</dt><dd>{formatMoney(money.availableCents)}</dd></div>
        <div><dt>Emprestado</dt><dd>{formatMoney(money.lentCents)}</dd></div>
        <div><dt>A receber</dt><dd>{formatMoney(money.receivableCents)}</dd></div>
        <div><dt>Recebido</dt><dd>{formatMoney(money.receivedCents)}</dd></div>
        <div><dt>Juros previstos</dt><dd>{formatMoney(money.expectedInterestCents)}</dd></div>
        <div><dt>Juros recebidos</dt><dd>{formatMoney(money.receivedInterestCents)}</dd></div>
      </dl>
      <div className="saas-card-counts">
        <span><b>{client.clients.total}</b> {client.clients.total === 1 ? "cliente final" : "clientes finais"} <small>({client.clients.active} {client.clients.active === 1 ? "ativo" : "ativos"})</small></span>
        <span><b>{client.operations.open}</b> {client.operations.open === 1 ? "aberta" : "abertas"}</span>
        <span><b>{client.operations.paid}</b> {client.operations.paid === 1 ? "quitada" : "quitadas"}</span>
        <span className={client.operations.overdue ? "is-late" : undefined}><b>{client.operations.overdue}</b> em atraso</span>
        <span><b>{client.paymentCount}</b> {client.paymentCount === 1 ? "pagamento" : "pagamentos"}</span>
      </div>
      {client.attention.length > 0 && <div className="saas-card-tags">{client.attention.map((reason) => <em key={reason}>{reason}</em>)}</div>}
      <footer><Link href={`/admin/clientes/${client.tenantId}`} className="central-secondary">Ver detalhes</Link><Link href={`/admin/clientes/${client.tenantId}#carteira`} className="central-ghost">Ver carteira</Link></footer>
    </article>
  );
}

function CommercialSummary({ client }: { client: SaasClient }) {
  const { commercial } = client;
  const trial = commercial.status === "TRIALING" || commercial.status === "TRIAL_EXPIRED";
  const courtesy = commercial.condition === "COURTESY";
  const due = dueLabel(commercial);
  return (
    <div className="saas-card-commercial">
      <div className="saas-card-plan">
        <CommercialBadge status={commercial.status} />
        <span>{trial || commercial.contractedPriceCents === null
          ? planLabel(client.planName, client.planPriceInCents, true)
          : courtesy ? `${client.planName} · Cortesia` : `${client.planName} · ${formatMoney(commercial.contractedPriceCents)}/mês`}</span>
        {commercial.condition && commercial.condition !== "STANDARD" && !courtesy && <small>{CONDITION_LABEL[commercial.condition]} · padrão {formatMoney(client.planPriceInCents)}</small>}
      </div>
      <div className="saas-card-meta">
        {trial
          ? <span>{commercial.status === "TRIAL_EXPIRED" ? "Teste venceu em" : "Teste até"} <b>{dateLabel(client.subscriptionExpiresAt)}</b></span>
          : <>
            <span>Ativação <b>{dateLabel(commercial.activatedAt)}</b></span>
            {!courtesy && <span>Próximo vencimento <b>{dateLabel(commercial.nextDueDate)}</b>{due && <em className={commercial.daysOverdue ? "is-late" : undefined}> · {due}</em>}</span>}
            {!courtesy && <span>Último pagamento <b>{dateLabel(commercial.lastPaidAt)}</b></span>}
          </>}
      </div>
    </div>
  );
}
