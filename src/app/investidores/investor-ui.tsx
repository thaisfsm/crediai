"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { SOCIAL_NETWORKS, socialHref, socialLabel, whatsappHref, type SocialNetwork } from "@/lib/contacts";
import { centsToInput, formatCpfCnpj, formatDate, formatMoney, formatPhone, maskCpfCnpj, maskPhone, todayIso } from "@/lib/finance/format";
import { DOCUMENT_KINDS, INVESTMENT_STATUS, INVESTOR_STATUS, RATE_PERIODS, rateLabel, type DocumentKind, type InvestmentStatus, type InvestorStatus } from "@/lib/investors/rules";
import type { InvestmentDetail, InvestorDetail, InvestorsPage } from "@/lib/investors/queries";
import { DateField } from "../date-field";
import { EmptyPanel, Feedback, MaskedInput, PageHeading, formatBytes, useFormAction } from "../portfolio-pages";
import { Icon } from "../ui-icon";
import { createInvestmentAction, createInvestorAction, replaceInvestmentDocumentAction, updateInvestmentAction, updateInvestorAction, uploadInvestmentDocumentAction } from "./actions";

type InvestorRow = InvestorsPage["investors"][number];
type InvestorData = InvestorDetail["investor"];
type InvestmentData = InvestmentDetail["investment"];
type DocumentRow = InvestmentDetail["documents"][number];

const investorTone: Record<InvestorStatus, string> = { ACTIVE: "status-active", INACTIVE: "status-muted" };
const investmentTone: Record<InvestmentStatus, string> = { PENDING_SIGNATURE: "status-due", ACTIVE: "status-active", CLOSED: "status-paid", CANCELED: "status-muted" };
const dateOf = (timestamp: string) => formatDate(todayIso(new Date(timestamp)));
const ACCEPT = ".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp";

function InvestorStatusChip({ status }: { status: InvestorStatus }) {
  return <span className={`status-chip ${investorTone[status]}`}><i />{INVESTOR_STATUS[status]}</span>;
}
function InvestmentStatusChip({ status }: { status: InvestmentStatus }) {
  return <span className={`status-chip ${investmentTone[status]}`}><i />{INVESTMENT_STATUS[status]}</span>;
}

// Perfil de rede social: link quando dá para montar um endereço seguro do próprio Instagram/Facebook; senão, texto.
function SocialLink({ network, value }: { network: SocialNetwork; value: string | null }) {
  if (!value) return <>—</>;
  const href = socialHref(network, value);
  return href ? <a className="text-link inline-link" href={href} target="_blank" rel="noreferrer noopener">{socialLabel(value)}</a> : <>{value}</>;
}

function MetricCard({ label, value, caption, note, icon }: { label: string; value: string; caption: string; note?: string; icon: "briefcase" | "wallet" | "chart" | "check" | "receipt" | "calendar" }) {
  return (
    <article className="metric-card">
      <div className="metric-top"><span>{label}</span><span className="metric-icon metric-icon-teal"><Icon name={icon} size={17} /></span></div>
      <div className={`metric-value${note ? " metric-value-pending" : ""}`}>{value}</div>
      <div className="metric-foot"><span className="metric-caption">{caption}</span>{note && <span className="metric-neutral">{note}</span>}</div>
    </article>
  );
}

// Formulário do investidor (cadastro e edição). Só o nome é obrigatório. O MASTER escolhe a carteira ao cadastrar.
function InvestorForm({ editing, tenants = [], defaultTenantId, onDone, onCancel }: {
  editing?: InvestorData; tenants?: { id: string; name: string }[]; defaultTenantId?: string | null; onDone: (id?: string) => void; onCancel?: () => void;
}) {
  const [resetKey, setResetKey] = useState(0);
  const { pending, feedback, onSubmit } = useFormAction(editing ? updateInvestorAction : createInvestorAction, () => { setResetKey((key) => key + 1); onDone(); });
  return (
    <section className="panel form-panel" aria-label={editing ? "Editar investidor" : "Novo investidor"}>
      <div className="panel-header"><div><h2>{editing ? `Editar ${editing.name}` : "Novo investidor"}</h2><p>Somente o nome é obrigatório. Instagram e Facebook aceitam @usuário ou o endereço do perfil.</p></div></div>
      <form className="form-grid" onSubmit={onSubmit} key={resetKey}>
        {editing && <input type="hidden" name="investorId" value={editing.id} />}
        {!editing && tenants.length > 0 && (
          <label className="field field-wide"><span>Carteira</span><select name="tenantId" defaultValue={defaultTenantId ?? ""} required>
            <option value="" disabled>Escolha a carteira</option>{tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}
          </select></label>
        )}
        <label className="field field-wide"><span>Nome ou razão social</span><input name="name" maxLength={160} defaultValue={editing?.name ?? ""} placeholder="Nome completo ou razão social" required /></label>
        <label className="field"><span>CPF ou CNPJ</span><MaskedInput name="document" mask={maskCpfCnpj} initial={formatCpfCnpj(editing?.document ?? null) ?? ""} inputMode="numeric" placeholder="000.000.000-00" maxLength={40} /></label>
        <label className="field"><span>Telefone</span><MaskedInput name="phone" mask={maskPhone} initial={formatPhone(editing?.phone ?? null) ?? ""} inputMode="tel" placeholder="(11) 3456-7890" maxLength={40} /></label>
        <label className="field"><span>WhatsApp</span><MaskedInput name="whatsapp" mask={maskPhone} initial={formatPhone(editing?.whatsapp ?? null) ?? ""} inputMode="tel" placeholder="(11) 98765-4321" maxLength={40} /></label>
        <label className="field"><span>E-mail</span><input name="email" type="email" maxLength={160} defaultValue={editing?.email ?? ""} placeholder="nome@exemplo.com" /></label>
        <label className="field"><span>Instagram</span><input name="instagram" maxLength={200} defaultValue={editing?.instagram ?? ""} placeholder="@usuario ou instagram.com/usuario" /></label>
        <label className="field"><span>Facebook</span><input name="facebook" maxLength={200} defaultValue={editing?.facebook ?? ""} placeholder="@usuario ou facebook.com/usuario" /></label>
        {editing && (
          <label className="field"><span>Status</span><select name="status" defaultValue={editing.status}>
            {(Object.keys(INVESTOR_STATUS) as InvestorStatus[]).map((status) => <option key={status} value={status}>{INVESTOR_STATUS[status]}</option>)}
          </select></label>
        )}
        <label className="field field-wide"><span>Observações</span><textarea name="notes" maxLength={1000} rows={3} defaultValue={editing?.notes ?? ""} placeholder="Opcional" /></label>
        <div className="form-actions">
          {onCancel && <button type="button" className="outline-button" onClick={onCancel}>Cancelar</button>}
          <button className="primary-button" disabled={pending}><Icon name={editing ? "check" : "plus"} size={16} /> {pending ? "Salvando…" : editing ? "Salvar alterações" : "Cadastrar investidor"}</button>
        </div>
      </form>
      <Feedback feedback={feedback} />
    </section>
  );
}

// Contrato de investimento: só o que foi combinado. O período da taxa é escolhido sempre (nenhum é presumido).
function InvestmentForm({ investorId, editing, today, onDone, onCancel }: { investorId: string; editing?: InvestmentData; today: string; onDone: () => void; onCancel?: () => void }) {
  const [resetKey, setResetKey] = useState(0);
  const { pending, feedback, onSubmit } = useFormAction(editing ? updateInvestmentAction : createInvestmentAction, () => { setResetKey((key) => key + 1); onDone(); });
  return (
    <section className="panel form-panel" aria-label={editing ? "Editar investimento" : "Novo investimento"}>
      <div className="panel-header"><div><h2>{editing ? "Editar investimento" : "Novo investimento"}</h2><p>Registre o que foi combinado no contrato. Rendimento, saldo e total a devolver ainda não são calculados.</p></div></div>
      <form className="form-grid" onSubmit={onSubmit} key={resetKey}>
        {editing ? <input type="hidden" name="investmentId" value={editing.id} /> : <input type="hidden" name="investorId" value={investorId} />}
        <label className="field"><span>Valor investido (R$)</span><input name="amount" inputMode="decimal" placeholder="50.000,00" defaultValue={editing ? centsToInput(editing.amountCents) : ""} required /></label>
        <label className="field"><span>Taxa combinada (%)</span><input name="rate" inputMode="decimal" placeholder="1,5" defaultValue={editing ? String(editing.agreedRateBps / 100).replace(".", ",") : ""} required /></label>
        <label className="field"><span>A taxa se refere a</span><select name="ratePeriod" defaultValue={editing?.ratePeriod ?? ""} required>
          <option value="" disabled>Escolha o período da taxa</option>
          {(Object.keys(RATE_PERIODS) as (keyof typeof RATE_PERIODS)[]).map((period) => <option key={period} value={period}>{RATE_PERIODS[period]}</option>)}
        </select></label>
        <DateField label="Data de início" name="startDate" defaultValue={editing?.startDate ?? today} required />
        <DateField label="Vencimento do contrato (opcional)" name="maturityDate" defaultValue={editing?.maturityDate ?? ""} />
        <label className="field"><span>Dia de vencimento (opcional)</span><input name="dueDay" inputMode="numeric" placeholder="1 a 31" maxLength={2} defaultValue={editing?.dueDay ?? ""} /></label>
        <label className="field"><span>Status</span><select name="status" defaultValue={editing?.status ?? "ACTIVE"}>
          {(Object.keys(INVESTMENT_STATUS) as InvestmentStatus[]).map((status) => <option key={status} value={status}>{INVESTMENT_STATUS[status]}</option>)}
        </select></label>
        <label className="field field-wide"><span>Observações</span><textarea name="notes" maxLength={1000} rows={3} defaultValue={editing?.notes ?? ""} placeholder="Condições combinadas, forma de pagamento, detalhes do período da taxa…" /></label>
        <p className="capital-note field-wide">A taxa e as datas ficam só registradas: nenhum rendimento, vencimento de rendimento, saldo ou total a devolver é calculado até as regras do investimento serem definidas.</p>
        <div className="form-actions">
          {onCancel && <button type="button" className="outline-button" onClick={onCancel}>Cancelar</button>}
          <button className="primary-button" disabled={pending}><Icon name={editing ? "check" : "plus"} size={16} /> {pending ? "Salvando…" : editing ? "Salvar alterações" : "Cadastrar investimento"}</button>
        </div>
      </form>
      <Feedback feedback={feedback} />
    </section>
  );
}

// /investidores: painel, filtros, lista paginada e cadastro.
export function InvestorsHome({ data }: { data: InvestorsPage }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const { summary, filters } = data;
  const filtered = Boolean(filters.q || filters.status || filters.carteira);
  const pageHref = (page: number) => `/investidores?${new URLSearchParams({ ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)), pagina: String(page) })}`;
  const pending = "Aguardando regra";
  return (
    <div className="workspace-page">
      <PageHeading eyebrow="CREDIAI · INVESTIDORES" title="Investidores" description={data.isMaster ? "Investidores e contratos de todas as carteiras (visão MASTER)." : "Quem investe na sua carteira e os contratos de cada um."}>
        <button className="primary-button" onClick={() => setCreating(!creating)}><Icon name={creating ? "close" : "plus"} size={17} /> {creating ? "Fechar cadastro" : "Novo investidor"}</button>
      </PageHeading>

      <section className="metric-grid metric-grid-3" aria-label="Resumo dos investimentos">
        <MetricCard icon="briefcase" label="Capital investido" value={formatMoney(summary.investedCents)} caption="Soma dos contratos ativos" />
        <MetricCard icon="wallet" label="Investimentos ativos" value={String(summary.activeCount)} caption={summary.pendingSignatureCount ? `${summary.pendingSignatureCount} aguardando assinatura` : "Contratos com status Ativo"} />
        <MetricCard icon="calendar" label="Próximos vencimentos" value={summary.nextMaturityDate ? formatDate(summary.nextMaturityDate) : "—"}
          caption={summary.nextMaturityDate ? `${summary.maturingSoonCount} contrato${summary.maturingSoonCount === 1 ? "" : "s"} vence${summary.maturingSoonCount === 1 ? "" : "m"} em 30 dias` : "Nenhum vencimento de contrato cadastrado"}
          note={summary.overdueMaturityCount ? `${summary.overdueMaturityCount} vencido${summary.overdueMaturityCount === 1 ? "" : "s"}` : undefined} />
        <MetricCard icon="chart" label="Rendimentos previstos" value="—" caption="Depende da regra de rendimento" note={pending} />
        <MetricCard icon="check" label="Rendimentos pagos" value="—" caption="Pagamentos de rendimento ainda não registrados" note={pending} />
        <MetricCard icon="receipt" label="Total a devolver" value="—" caption="Depende da regra de rendimento e resgate" note={pending} />
      </section>
      <p className="capital-note">Rendimentos previstos, rendimentos pagos e total a devolver aparecem quando as regras financeiras dos investimentos forem definidas. Hoje nada disso é calculado.</p>

      {creating && <InvestorForm tenants={data.tenants} defaultTenantId={data.ownTenantId} onDone={() => { setCreating(false); router.refresh(); }} onCancel={() => setCreating(false)} />}

      {data.upcoming.length > 0 && (
        <section className="panel form-panel" aria-label="Próximos vencimentos de contrato">
          <div className="panel-header"><div><h2>Próximos vencimentos de contrato</h2><p>Data de vencimento cadastrada nos contratos ativos.</p></div></div>
          <ul className="document-list">{data.upcoming.map((item) => (
            <li key={item.id}>
              <div><strong>{formatDate(item.maturityDate)} · {item.investorName}</strong><small>{formatMoney(item.amountCents)} investidos</small></div>
              <span className="row-actions"><Link prefetch={false} className="outline-button" href={`/investidores/investimentos/${item.id}`}>Abrir contrato</Link></span>
            </li>
          ))}</ul>
        </section>
      )}

      <section className="panel table-panel" aria-label="Lista de investidores">
        <div className="panel-header"><div><div className="panel-title-row"><h2>Investidores</h2><span className="today-count">{data.matched}</span></div><p>Busque por nome, CPF/CNPJ, telefone, e-mail ou rede social.</p></div></div>
        <form className="investor-filters" action="/investidores" method="get" role="search">
          <label className="field"><span>Buscar</span><input name="q" defaultValue={filters.q} placeholder="Nome, CPF/CNPJ, telefone…" maxLength={120} /></label>
          <label className="field"><span>Status</span><select name="status" defaultValue={filters.status}>
            <option value="">Todos</option>{(Object.keys(INVESTOR_STATUS) as InvestorStatus[]).map((status) => <option key={status} value={status}>{INVESTOR_STATUS[status]}</option>)}
          </select></label>
          {data.isMaster && (
            <label className="field"><span>Carteira</span><select name="carteira" defaultValue={filters.carteira}>
              <option value="">Todas</option>{data.tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}
            </select></label>
          )}
          <div className="investor-filter-actions"><button className="outline-button">Aplicar</button>{filtered && <Link prefetch={false} className="text-link" href="/investidores">Limpar</Link>}</div>
        </form>
        {data.investors.length === 0 ? (
          <EmptyPanel icon="briefcase" text={filtered ? "Nenhum investidor com esses filtros." : "Nenhum investidor cadastrado ainda."}
            action={!filtered && !creating ? <button className="primary-button" onClick={() => setCreating(true)}><Icon name="plus" size={16} /> Cadastrar o primeiro investidor</button> : undefined} />
        ) : (
          <div className="table-scroll"><table className="data-table">
            <thead><tr><th>Nome</th>{data.isMaster && <th>Carteira</th>}<th>CPF/CNPJ</th><th>Telefone/WhatsApp</th><th>E-mail</th><th>Instagram</th><th>Facebook</th><th>Status</th><th>Investimentos</th><th>Cadastro</th><th /></tr></thead>
            <tbody>{data.investors.map((investor: InvestorRow) => (
              <tr key={investor.id}>
                <td><Link prefetch={false} className="text-link client-link" href={`/investidores/${investor.id}`}><strong>{investor.name}</strong></Link></td>
                {data.isMaster && <td>{investor.tenantName}</td>}
                <td>{formatCpfCnpj(investor.document) ?? "—"}</td>
                <td>{[formatPhone(investor.phone), investor.whatsapp && `WhatsApp ${formatPhone(investor.whatsapp)}`].filter(Boolean).join(" · ") || "—"}</td>
                <td>{investor.email ?? "—"}</td>
                <td><SocialLink network="instagram" value={investor.instagram} /></td>
                <td><SocialLink network="facebook" value={investor.facebook} /></td>
                <td><InvestorStatusChip status={investor.status} /></td>
                <td>{investor.investmentCount}</td>
                <td>{dateOf(investor.createdAt)}</td>
                <td className="actions-cell"><span className="row-actions"><Link prefetch={false} className="outline-button" href={`/investidores/${investor.id}`}>Ver</Link></span></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        {data.pages > 1 && (
          <nav className="investor-pagination" aria-label="Páginas">
            {data.page > 1 ? <Link prefetch={false} className="outline-button" href={pageHref(data.page - 1)}>← Anterior</Link> : <span />}
            <span>{`Página ${data.page} de ${data.pages}`}</span>
            {data.page < data.pages ? <Link prefetch={false} className="outline-button" href={pageHref(data.page + 1)}>Próxima →</Link> : <span />}
          </nav>
        )}
      </section>
    </div>
  );
}

// /investidores/[id]: dados, contatos, redes sociais, observações e o histórico de investimentos.
export function InvestorDetailView({ data, today }: { data: InvestorDetail; today: string }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const { investor, investments } = data;
  const activeCents = investments.filter((item) => item.status === "ACTIVE").reduce((total, item) => total + item.amountCents, 0);
  const whatsapp = whatsappHref(investor.whatsapp);
  return (
    <div className="workspace-page">
      <Link prefetch={false} className="text-link back-link" href="/investidores">← Investidores</Link>
      <PageHeading eyebrow={data.isMaster ? `INVESTIDOR · ${investor.tenantName.toUpperCase()}` : "INVESTIDOR"} title={investor.name} description={`Cadastrado em ${dateOf(investor.createdAt)}.`}>
        <InvestorStatusChip status={investor.status} />
        <button className="outline-button" onClick={() => setEditing(!editing)}>{editing ? "Fechar edição" : "Editar"}</button>
      </PageHeading>
      {editing && <InvestorForm editing={investor} onDone={() => { setEditing(false); router.refresh(); }} onCancel={() => setEditing(false)} />}

      <section className="panel form-panel" aria-label={`Dados de ${investor.name}`}>
        <div className="panel-header"><div><h2>Dados e contatos</h2><p>Use &quot;Editar&quot; para alterar.</p></div></div>
        <dl className="payment-summary profile-summary">
          <div><dt>CPF/CNPJ</dt><dd>{formatCpfCnpj(investor.document) ?? "—"}</dd></div>
          <div><dt>Telefone</dt><dd>{formatPhone(investor.phone) ?? "—"}</dd></div>
          <div><dt>WhatsApp</dt><dd>{investor.whatsapp ? (whatsapp ? <a className="text-link inline-link" href={whatsapp} target="_blank" rel="noreferrer noopener">{formatPhone(investor.whatsapp)}</a> : formatPhone(investor.whatsapp)) : "—"}</dd></div>
          <div><dt>E-mail</dt><dd>{investor.email ? <a className="text-link inline-link" href={`mailto:${investor.email}`}>{investor.email}</a> : "—"}</dd></div>
          {(Object.keys(SOCIAL_NETWORKS) as SocialNetwork[]).map((network) => <div key={network}><dt>{SOCIAL_NETWORKS[network]}</dt><dd><SocialLink network={network} value={investor[network]} /></dd></div>)}
          {data.isMaster && <div><dt>Carteira</dt><dd>{investor.tenantName}</dd></div>}
          <div><dt>Status</dt><dd>{INVESTOR_STATUS[investor.status]}</dd></div>
          <div><dt>Observações</dt><dd className="preserve-lines">{investor.notes ?? "—"}</dd></div>
        </dl>
      </section>

      <section className="panel table-panel" aria-label="Investimentos">
        <div className="panel-header">
          <div><div className="panel-title-row"><h2>Investimentos</h2><span className="today-count">{investments.length}</span></div><p>Contratos ativos somam {formatMoney(activeCents)}. Os documentos ficam em cada investimento.</p></div>
          {investor.status === "ACTIVE" && <button className="primary-button" onClick={() => setCreating(!creating)}><Icon name={creating ? "close" : "plus"} size={16} /> {creating ? "Fechar" : "Novo investimento"}</button>}
        </div>
        {investor.status !== "ACTIVE" && <p className="capital-note">Investidor inativo: reative-o em &quot;Editar&quot; para cadastrar novos investimentos.</p>}
        {investments.length === 0 ? <EmptyPanel icon="wallet" text="Nenhum investimento cadastrado para este investidor." /> : (
          <div className="table-scroll"><table className="data-table">
            <thead><tr><th>Início</th><th>Valor</th><th>Taxa combinada</th><th>Vencimento</th><th>Status</th><th>Contrato assinado</th><th>Documentos</th><th /></tr></thead>
            <tbody>{investments.map((item) => (
              <tr key={item.id}>
                <td>{formatDate(item.startDate)}</td>
                <td><strong>{formatMoney(item.amountCents)}</strong></td>
                <td>{rateLabel(item.agreedRateBps, item.ratePeriod)}</td>
                <td>{item.maturityDate ? formatDate(item.maturityDate) : item.dueDay ? `Todo dia ${item.dueDay}` : "—"}</td>
                <td><InvestmentStatusChip status={item.status} /></td>
                <td>{item.hasSignedContract ? <span className="status-chip status-paid"><i />Enviado</span> : <span className="status-chip status-due"><i />Pendente</span>}</td>
                <td>{item.documentCount}</td>
                <td className="actions-cell"><span className="row-actions"><Link prefetch={false} className="outline-button" href={`/investidores/investimentos/${item.id}`}>Abrir</Link></span></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      {creating && <InvestmentForm investorId={investor.id} today={today} onDone={() => { setCreating(false); router.refresh(); }} onCancel={() => setCreating(false)} />}
    </div>
  );
}

// Envio de documento novo (o contrato assinado só uma vez; depois, "Substituir").
function UploadDocumentForm({ investmentId, hasContract, onDone }: { investmentId: string; hasContract: boolean; onDone: () => void }) {
  const { pending, feedback, onSubmit } = useFormAction(uploadInvestmentDocumentAction, onDone);
  const kinds = (Object.keys(DOCUMENT_KINDS) as DocumentKind[]).filter((kind) => !(hasContract && kind === "SIGNED_CONTRACT"));
  return (
    <>
      <form className="form-grid" onSubmit={onSubmit} aria-label="Enviar documento">
        <input type="hidden" name="investmentId" value={investmentId} />
        <label className="field"><span>Tipo</span><select name="kind" defaultValue={kinds[0]} required>{kinds.map((kind) => <option key={kind} value={kind}>{DOCUMENT_KINDS[kind]}</option>)}</select></label>
        <label className="field"><span>Arquivo</span><input name="file" type="file" accept={ACCEPT} required /></label>
        <div className="form-actions"><button className="primary-button" disabled={pending}><Icon name="plus" size={16} /> {pending ? "Enviando…" : "Enviar documento"}</button></div>
      </form>
      <Feedback feedback={feedback} />
    </>
  );
}

function ReplaceDocumentForm({ document, onDone, onCancel }: { document: DocumentRow; onDone: () => void; onCancel: () => void }) {
  const { pending, feedback, onSubmit } = useFormAction(replaceInvestmentDocumentAction, onDone);
  return (
    <div className="replace-document">
      <form className="form-grid form-grid-inline" onSubmit={onSubmit} aria-label={`Substituir ${document.fileName}`}>
        <input type="hidden" name="documentId" value={document.id} />
        <label className="field"><span>Nova versão de {DOCUMENT_KINDS[document.kind]}</span><input name="file" type="file" accept={ACCEPT} required /></label>
        <span className="row-actions"><button type="button" className="outline-button" onClick={onCancel}>Cancelar</button><button className="primary-button" disabled={pending}>{pending ? "Enviando…" : "Substituir"}</button></span>
      </form>
      <Feedback feedback={feedback} />
    </div>
  );
}

// /investidores/investimentos/[id]: dados do contrato, estrutura preparada para os cálculos futuros e documentos.
export function InvestmentDetailView({ data }: { data: InvestmentDetail }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [replacing, setReplacing] = useState<string | null>(null);
  const { investment, investor } = data;
  const current = data.documents.filter((document) => !document.replacedAt);
  const history = data.documents.filter((document) => document.replacedAt);
  const hasContract = current.some((document) => document.kind === "SIGNED_CONTRACT");
  const refresh = () => router.refresh();
  return (
    <div className="workspace-page">
      <Link prefetch={false} className="text-link back-link" href={`/investidores/${investor.id}`}>← {investor.name}</Link>
      <PageHeading eyebrow={data.isMaster ? `INVESTIMENTO · ${data.tenantName.toUpperCase()}` : "INVESTIMENTO"} title={`${formatMoney(investment.amountCents)} · ${investor.name}`} description={`Início em ${formatDate(investment.startDate)}.`}>
        <InvestmentStatusChip status={investment.status} />
        <button className="outline-button" onClick={() => setEditing(!editing)}>{editing ? "Fechar edição" : "Editar"}</button>
      </PageHeading>
      {editing && <InvestmentForm investorId={investor.id} editing={investment} today={investment.startDate} onDone={() => { setEditing(false); refresh(); }} onCancel={() => setEditing(false)} />}

      <section className="panel form-panel" aria-label="Dados do investimento">
        <div className="panel-header"><div><h2>Contrato</h2><p>O que foi combinado com {investor.name}.</p></div></div>
        <dl className="payment-summary profile-summary">
          <div><dt>Investidor</dt><dd><Link prefetch={false} className="text-link inline-link" href={`/investidores/${investor.id}`}>{investor.name}</Link></dd></div>
          <div><dt>Valor investido</dt><dd>{formatMoney(investment.amountCents)}</dd></div>
          <div><dt>Taxa combinada</dt><dd>{rateLabel(investment.agreedRateBps, investment.ratePeriod)}</dd></div>
          <div><dt>Data de início</dt><dd>{formatDate(investment.startDate)}</dd></div>
          <div><dt>Vencimento do contrato</dt><dd>{investment.maturityDate ? formatDate(investment.maturityDate) : "—"}</dd></div>
          <div><dt>Dia de vencimento</dt><dd>{investment.dueDay ? `Dia ${investment.dueDay}` : "—"}</dd></div>
          <div><dt>Status</dt><dd>{INVESTMENT_STATUS[investment.status]}</dd></div>
          <div><dt>Cadastrado em</dt><dd>{dateOf(investment.createdAt)}</dd></div>
          <div><dt>Observações</dt><dd className="preserve-lines">{investment.notes ?? "—"}</dd></div>
        </dl>
      </section>

      <section className="panel form-panel" aria-label="Cálculos do investimento">
        <div className="panel-header"><div><h2>Rendimento e devolução</h2><p>Estrutura preparada: os valores aparecem quando as regras financeiras dos investimentos forem definidas.</p></div></div>
        <dl className="payment-summary">
          {["Rendimento previsto", "Rendimentos pagos", "Saldo", "Total a devolver", "Próximo vencimento de rendimento", "Renovação", "Resgate"].map((label) => (
            <div key={label}><dt>{label}</dt><dd className="muted-value">Aguardando regra</dd></div>
          ))}
        </dl>
      </section>

      <section className="panel form-panel" aria-label="Documentos do investimento">
        <div className="panel-header"><div><div className="panel-title-row"><h2>Documentos</h2><span className="today-count">{current.length}</span></div><p>Contrato assinado, aditivos e comprovantes deste investimento. PDF, JPG, PNG ou WEBP de até 5 MB.</p></div></div>
        {!hasContract && <p className="form-feedback form-feedback-warning">Contrato assinado ainda não enviado.</p>}
        {current.length > 0 && (
          <ul className="document-list">{current.map((document) => (
            <li key={document.id}>
              <div><strong>{DOCUMENT_KINDS[document.kind]}</strong><small>{document.fileName} · {formatBytes(document.sizeBytes)} · enviado em {dateOf(document.createdAt)}{document.uploadedBy ? ` por ${document.uploadedBy}` : ""}</small></div>
              <span className="row-actions">
                <a className="outline-button" href={`/investidores/documentos/${document.id}`} target="_blank" rel="noreferrer">Visualizar</a>
                <a className="outline-button" href={`/investidores/documentos/${document.id}?baixar=1`} download={document.fileName}>Baixar</a>
                <button type="button" className="outline-button" onClick={() => setReplacing(replacing === document.id ? null : document.id)}>Substituir</button>
              </span>
              {replacing === document.id && <ReplaceDocumentForm document={document} onDone={() => { setReplacing(null); refresh(); }} onCancel={() => setReplacing(null)} />}
            </li>
          ))}</ul>
        )}
        <UploadDocumentForm key={String(hasContract)} investmentId={investment.id} hasContract={hasContract} onDone={refresh} />
        {history.length > 0 && (
          <details className="document-history">
            <summary>Versões substituídas ({history.length})</summary>
            <ul className="document-list">{history.map((document) => (
              <li key={document.id}>
                <div><strong>{DOCUMENT_KINDS[document.kind]}</strong><small>{document.fileName} · enviado em {dateOf(document.createdAt)} · substituído em {dateOf(document.replacedAt as string)}</small></div>
                <span className="row-actions"><a className="outline-button" href={`/investidores/documentos/${document.id}`} target="_blank" rel="noreferrer">Visualizar</a></span>
              </li>
            ))}</ul>
          </details>
        )}
      </section>
    </div>
  );
}
