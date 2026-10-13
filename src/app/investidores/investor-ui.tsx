"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { SOCIAL_NETWORKS, socialHref, socialLabel, whatsappHref, type SocialNetwork } from "@/lib/contacts";
import { centsToInput, cpfCnpjProblem, formatCpfCnpj, formatDate, formatMoney, formatPhone, maskCpfCnpj, maskPhone, todayIso } from "@/lib/finance/format";
import { addressLine } from "@/lib/investors/address";
import { CONTRACT_STATES, contractState, formatDateTime, type ContractState } from "@/lib/investors/contract";
import {
  DOCUMENT_KINDS, INVESTMENT_STATUS, INVESTOR_STATUS, MAX_SCHEDULE_ITEMS, PAYMENT_FREQUENCIES, RATE_PERIODS, investorAddress, rateLabel, scheduleDates,
  type DocumentKind, type InvestmentStatus, type InvestorStatus, type PaymentFrequency,
} from "@/lib/investors/rules";
import type { InvestmentDetail, InvestorDetail, InvestorsPage } from "@/lib/investors/queries";
import { DateField } from "../date-field";
import { AddressFieldset, BankFieldset, BankSummaryRows, EmptyPanel, Feedback, MaskedInput, PageHeading, formatBytes, useFormAction } from "../portfolio-pages";
import { Icon } from "../ui-icon";
import { registerInvestmentEntryAction } from "../contas-a-pagar/actions";
import { ObligationsTable } from "../contas-a-pagar/payables-ui";
import {
  addInvestmentScheduleItemAction, buildInvestmentScheduleAction, createInvestmentAction, createInvestorAction, deleteInvestmentScheduleItemAction, generateContractAction,
  markContractSentAction, replaceInvestmentDocumentAction, saveContractorAction, updateInvestmentAction, updateInvestmentScheduleItemAction, updateInvestorAction,
  uploadInvestmentDocumentAction,
} from "./actions";

type InvestorRow = InvestorsPage["investors"][number];
type InvestorData = InvestorDetail["investor"];
type InvestmentData = InvestmentDetail["investment"];
type DocumentRow = InvestmentDetail["documents"][number];
type ContractVersion = InvestmentDetail["contract"]["versions"][number];

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
        <label className="field"><span>CPF ou CNPJ</span><MaskedInput name="document" mask={maskCpfCnpj} validate={cpfCnpjProblem} initial={formatCpfCnpj(editing?.document ?? null) ?? ""} inputMode="numeric" placeholder="000.000.000-00" maxLength={40} /></label>
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
        <AddressFieldset legend="Endereço (opcional; exigido para gerar o contrato)" nameOf={(part) => `address${part}`} initialOf={(part) => editing?.[`address${part}`] ?? ""} />
        <BankFieldset initial={editing} legend="Dados bancários e Pix para os pagamentos (opcionais)" />
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
        <label className="field"><span>Identificação do contrato (opcional)</span><input name="contractNumber" maxLength={40} placeholder="INV-2026/001" defaultValue={editing?.contractNumber ?? ""} /></label>
        <DateField label="Data do investimento (opcional)" name="investedOn" defaultValue={editing?.investedOn ?? ""} />
        <DateField label="Data de início" name="startDate" defaultValue={editing?.startDate ?? today} required />
        <label className="field"><span>Prazo em meses (opcional)</span><input name="termMonths" inputMode="numeric" placeholder="12" maxLength={3} defaultValue={editing?.termMonths ?? ""} /></label>
        <DateField label="Vencimento do contrato (opcional)" name="maturityDate" defaultValue={editing?.maturityDate ?? ""} />
        <label className="field"><span>Dia de vencimento (opcional)</span><input name="dueDay" inputMode="numeric" placeholder="1 a 31" maxLength={2} defaultValue={editing?.dueDay ?? ""} /></label>
        <label className="field"><span>Periodicidade dos pagamentos (opcional)</span><select name="paymentFrequency" defaultValue={editing?.paymentFrequency ?? ""}>
          <option value="">Não informada</option>
          {(Object.keys(PAYMENT_FREQUENCIES) as PaymentFrequency[]).map((frequency) => <option key={frequency} value={frequency}>{PAYMENT_FREQUENCIES[frequency]}</option>)}
        </select></label>
        <label className="field"><span>Quantidade de parcelas (opcional)</span><input name="installmentCount" inputMode="numeric" placeholder="12" maxLength={3} defaultValue={editing?.installmentCount ?? ""} /></label>
        <label className="field"><span>Status</span><select name="status" defaultValue={editing?.status ?? "ACTIVE"}>
          {(Object.keys(INVESTMENT_STATUS) as InvestmentStatus[]).map((status) => <option key={status} value={status}>{INVESTMENT_STATUS[status]}</option>)}
        </select></label>
        <label className="field field-wide"><span>Observações</span><textarea name="notes" maxLength={1000} rows={3} defaultValue={editing?.notes ?? ""} placeholder="Condições combinadas, forma de pagamento, detalhes do período da taxa…" /></label>
        <p className="capital-note field-wide">A taxa, o prazo e as datas ficam só registrados: nenhum rendimento, saldo ou total a devolver é calculado. As datas e os valores de cada pagamento ao investidor são informados no cronograma, na página do investimento.</p>
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
          <div><dt>Endereço</dt><dd>{addressLine(investorAddress(investor)) ?? "—"}</dd></div>
          <BankSummaryRows values={investor} />
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
            <thead><tr><th>Contrato</th><th>Início</th><th>Valor</th><th>Taxa combinada</th><th>Vencimento</th><th>Status</th><th>Contrato assinado</th><th>Documentos</th><th /></tr></thead>
            <tbody>{investments.map((item) => (
              <tr key={item.id}>
                <td>{item.contractNumber ?? "—"}</td>
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
      <section className="panel form-panel" aria-label="Documentos dos investimentos">
        <div className="panel-header"><div><div className="panel-title-row"><h2>Documentos dos investimentos</h2><span className="today-count">{data.documents.length}</span></div><p>Versões vigentes. Cada documento pertence a um investimento: envie ou substitua na página do investimento.</p></div></div>
        {data.documents.length === 0 ? <EmptyPanel icon="file" text="Nenhum documento enviado nos investimentos deste investidor." /> : (
          <ul className="document-list">{data.documents.map((document) => {
            const contract = investments.find((item) => item.id === document.investmentId);
            return (
              <li key={document.id}>
                <div><strong>{DOCUMENT_KINDS[document.kind]}{contract ? ` · investimento de ${formatMoney(contract.amountCents)} (${formatDate(contract.startDate)})` : ""}</strong><small>{document.fileName} · {formatBytes(document.sizeBytes)} · enviado em {dateOf(document.createdAt)}</small></div>
                <span className="row-actions">
                  <a className="outline-button" href={`/investidores/documentos/${document.id}`} target="_blank" rel="noreferrer">Visualizar</a>
                  <a className="outline-button" href={`/investidores/documentos/${document.id}?baixar=1`} download={document.fileName}>Baixar</a>
                  <Link prefetch={false} className="outline-button" href={`/investidores/investimentos/${document.investmentId}`}>Abrir investimento</Link>
                </span>
              </li>
            );
          })}</ul>
        )}
      </section>
      {creating && <InvestmentForm investorId={investor.id} today={today} onDone={() => { setCreating(false); router.refresh(); }} onCancel={() => setCreating(false)} />}
    </div>
  );
}

// Versão do contrato gerado a que o contrato assinado corresponde (ou "não gerado pelo sistema").
function SignedVersionSelect({ versions, defaultValue }: { versions: ContractVersion[]; defaultValue: string }) {
  return (
    <label className="field"><span>Versão assinada</span><select name="contractId" defaultValue={defaultValue}>
      {versions.map((version) => <option key={version.id} value={version.id}>{`Versão ${version.version} (gerada em ${dateOf(version.createdAt)})${version.supersededAt ? " · substituída" : ""}`}</option>)}
      <option value="">Contrato não gerado pelo sistema</option>
    </select></label>
  );
}

// Envio de documento novo (o contrato assinado só uma vez; depois, "Substituir").
function UploadDocumentForm({ investmentId, hasContract, versions, onDone }: { investmentId: string; hasContract: boolean; versions: ContractVersion[]; onDone: () => void }) {
  const { pending, feedback, onSubmit } = useFormAction(uploadInvestmentDocumentAction, onDone);
  const kinds = (Object.keys(DOCUMENT_KINDS) as DocumentKind[]).filter((kind) => !(hasContract && kind === "SIGNED_CONTRACT"));
  const [kind, setKind] = useState<DocumentKind>(kinds[0]);
  const current = versions.find((version) => !version.supersededAt);
  return (
    <>
      <form className="form-grid" onSubmit={onSubmit} aria-label="Enviar documento">
        <input type="hidden" name="investmentId" value={investmentId} />
        <label className="field"><span>Tipo</span><select name="kind" value={kind} onChange={(event) => setKind(event.target.value as DocumentKind)} required>{kinds.map((item) => <option key={item} value={item}>{DOCUMENT_KINDS[item]}</option>)}</select></label>
        {kind === "SIGNED_CONTRACT" && versions.length > 0 && <SignedVersionSelect versions={versions} defaultValue={current?.id ?? ""} />}
        <label className="field"><span>Arquivo</span><input name="file" type="file" accept={ACCEPT} required /></label>
        <div className="form-actions"><button className="primary-button" disabled={pending}><Icon name="plus" size={16} /> {pending ? "Enviando…" : "Enviar documento"}</button></div>
      </form>
      <Feedback feedback={feedback} />
    </>
  );
}

function ReplaceDocumentForm({ document, versions, onDone, onCancel }: { document: DocumentRow; versions: ContractVersion[]; onDone: () => void; onCancel: () => void }) {
  const { pending, feedback, onSubmit } = useFormAction(replaceInvestmentDocumentAction, onDone);
  return (
    <div className="replace-document">
      <form className="form-grid form-grid-inline" onSubmit={onSubmit} aria-label={`Substituir ${document.fileName}`}>
        <input type="hidden" name="documentId" value={document.id} />
        {document.kind === "SIGNED_CONTRACT" && versions.length > 0 && <SignedVersionSelect versions={versions} defaultValue={document.contractId ?? ""} />}
        <label className="field"><span>Nova versão de {DOCUMENT_KINDS[document.kind]}</span><input name="file" type="file" accept={ACCEPT} required /></label>
        <span className="row-actions"><button type="button" className="outline-button" onClick={onCancel}>Cancelar</button><button className="primary-button" disabled={pending}>{pending ? "Enviando…" : "Substituir"}</button></span>
      </form>
      <Feedback feedback={feedback} />
    </div>
  );
}

const contractTone: Record<ContractState, string> = { GENERATED: "status-due", SENT: "status-active", SIGNED: "status-paid", SUPERSEDED: "status-muted" };
const signedNote = (document: DocumentRow) => (document.kind === "SIGNED_CONTRACT" ? (document.contractVersion ? ` · assinatura da versão ${document.contractVersion} do contrato gerado` : " · contrato não gerado pelo sistema") : "");

// Dados da empresa contratante: um cadastro por carteira, usado em todos os contratos. Só gera contrato depois de confirmado.
function ContractorForm({ investmentId, contractor, onDone, onCancel }: { investmentId: string; contractor: InvestmentDetail["contract"]["contractor"]; onDone: () => void; onCancel: () => void }) {
  const { pending, feedback, onSubmit } = useFormAction(saveContractorAction, onDone);
  return (
    <div className="contract-subpanel">
      <form className="form-grid" onSubmit={onSubmit} aria-label="Dados da empresa contratante">
        <input type="hidden" name="investmentId" value={investmentId} />
        <label className="field field-wide"><span>Razão social</span><input name="legalName" maxLength={200} defaultValue={contractor?.legalName ?? ""} placeholder="Razão social completa, como no CNPJ" /></label>
        <label className="field"><span>CNPJ (ou CPF)</span><MaskedInput name="document" mask={maskCpfCnpj} initial={formatCpfCnpj(contractor?.document ?? null) ?? ""} inputMode="numeric" placeholder="12.345.678/0001-90" maxLength={40} /></label>
        <label className="field"><span>Representante legal (opcional)</span><input name="representativeName" maxLength={160} defaultValue={contractor?.representativeName ?? ""} placeholder="Quem assina pela empresa" /></label>
        <label className="field"><span>CPF do representante (opcional)</span><MaskedInput name="representativeDocument" mask={maskCpfCnpj} initial={formatCpfCnpj(contractor?.representativeDocument ?? null) ?? ""} inputMode="numeric" placeholder="000.000.000-00" maxLength={20} /></label>
        <AddressFieldset legend="Endereço da empresa" nameOf={(part) => `address${part}`} initialOf={(part) => contractor?.address[part] ?? ""} />
        <label className="check-field field-wide"><input type="checkbox" name="confirmed" value="1" defaultChecked={Boolean(contractor?.confirmedAt)} /><span>Confirmo que estes dados estão corretos e podem ser usados nos contratos de investimento desta carteira.</span></label>
        <div className="form-actions">
          <button type="button" className="outline-button" onClick={onCancel}>Cancelar</button>
          <button className="primary-button" disabled={pending}><Icon name="check" size={16} /> {pending ? "Salvando…" : "Salvar dados da empresa"}</button>
        </div>
      </form>
      <Feedback feedback={feedback} />
    </div>
  );
}

function MarkSentButton({ contract, onDone }: { contract: ContractVersion; onDone: () => void }) {
  const { pending, feedback, onSubmit } = useFormAction(markContractSentAction, onDone);
  return (
    <form onSubmit={onSubmit} className="inline-form">
      <input type="hidden" name="contractId" value={contract.id} />
      <button className="outline-button" disabled={pending}>{pending ? "Marcando…" : "Marcar como enviado"}</button>
      <Feedback feedback={feedback} />
    </form>
  );
}

// Contrato para assinatura: gerar, visualizar, baixar e gerar nova versão. O PDF gerado não é assinado.
function ContractSection({ data, hasSignedContract, onDone }: { data: InvestmentDetail; hasSignedContract: boolean; onDone: () => void }) {
  const { contract, investment } = data;
  const [editingContractor, setEditingContractor] = useState(false);
  const [includeNotes, setIncludeNotes] = useState(contract.includeNotesDefault);
  const { pending, feedback, onSubmit } = useFormAction(generateContractAction, onDone);
  const current = contract.versions.find((version) => !version.supersededAt) ?? null;
  const missing = includeNotes ? contract.missing.withNotes : contract.missing.withoutNotes;
  const unchanged = Boolean(current && contract.dataChanged === false && includeNotes === current.includesNotes);
  const contractor = contract.contractor;
  return (
    <section className="panel form-panel" aria-label="Contrato para assinatura">
      <div className="panel-header"><div><div className="panel-title-row"><h2>Contrato para assinatura</h2><span className="today-count">{contract.versions.length}</span></div>
        <p>Gere o contrato com os dados cadastrados, baixe o PDF e envie ao investidor. Depois anexe a versão assinada em Documentos, como &quot;Contrato assinado&quot;.</p></div></div>
      <p className="capital-note">O PDF gerado aqui não tem assinaturas e não substitui o contrato assinado. O modelo ainda precisa de revisão jurídica antes do uso real.</p>

      <div className="contract-subpanel">
        <div className="contract-subpanel-head">
          <div><strong>Empresa contratante</strong><small>{contractor?.legalName
            ? `${contractor.legalName} · ${formatCpfCnpj(contractor.document) ?? "sem CNPJ"} · ${contractor.confirmedAt ? `confirmados em ${dateOf(contractor.confirmedAt)}` : "dados não confirmados"}`
            : "Ainda não cadastrada. Vale para todos os contratos desta carteira."}</small></div>
          <button type="button" className="outline-button" onClick={() => setEditingContractor(!editingContractor)}>{editingContractor ? "Fechar" : contractor ? "Editar dados da empresa" : "Cadastrar dados da empresa"}</button>
        </div>
        {editingContractor && <ContractorForm investmentId={investment.id} contractor={contractor} onDone={() => { setEditingContractor(false); onDone(); }} onCancel={() => setEditingContractor(false)} />}
      </div>

      {current && contract.dataChanged && <p className="form-feedback form-feedback-warning" role="status">Os dados do contrato mudaram desde a versão {current.version}. Gere uma nova versão para que o investidor assine o texto atualizado.</p>}
      {missing.length > 0 && (
        <div className="contract-missing" role="status">
          <strong>Para gerar a versão final do contrato, falta:</strong>
          <ul>{missing.map((item) => <li key={`${item.section}-${item.item}`}>{`${item.section}: ${item.item}`}</li>)}</ul>
          <small>Edite o investidor, o investimento ou os dados da empresa contratante. Nada é preenchido com valores fictícios.</small>
        </div>
      )}

      <form className="form-grid" onSubmit={onSubmit} aria-label="Gerar contrato">
        <input type="hidden" name="investmentId" value={investment.id} />
        {contract.hasNotes && (
          <label className="check-field field-wide"><input type="checkbox" name="includeNotes" value="1" checked={includeNotes} onChange={(event) => setIncludeNotes(event.target.checked)} />
            <span>Incluir as observações do investimento no contrato, como condições adicionais (o texto entra exatamente como está cadastrado).</span></label>
        )}
        {hasSignedContract && (
          <label className="check-field field-wide"><input type="checkbox" name="confirmSignedKept" value="1" required />
            <span>Entendo que este investimento já tem contrato assinado: ele continua em Documentos e a nova versão precisa ser assinada à parte.</span></label>
        )}
        <div className="form-actions">
          <button className="primary-button" disabled={pending || missing.length > 0 || unchanged}><Icon name="file" size={16} /> {pending ? "Gerando…" : current ? "Gerar nova versão do contrato" : "Gerar contrato"}</button>
        </div>
        {unchanged && <p className="capital-note field-wide">Os dados não mudaram desde a versão {current?.version}: use a versão atual.</p>}
      </form>
      <Feedback feedback={feedback} />

      {contract.versions.length > 0 && (
        <ul className="document-list" aria-label="Versões do contrato gerado">{contract.versions.map((version) => {
          const state = contractState(version);
          return (
            <li key={version.id}>
              <div>
                <strong>{`Contrato gerado · versão ${version.version}`}{!version.supersededAt && version.version > 1 ? " (nova versão)" : ""} <span className={`status-chip ${contractTone[state]}`}><i />{CONTRACT_STATES[state]}</span></strong>
                <small>{`Gerado em ${formatDateTime(new Date(version.createdAt))}${version.generatedBy ? ` por ${version.generatedBy}` : ""} · ${formatBytes(version.sizeBytes)} · SHA-256 ${version.sha256.slice(0, 12)}…`}
                  {version.sentAt ? ` · enviado em ${dateOf(version.sentAt)}` : ""}{version.supersededAt ? ` · substituído em ${dateOf(version.supersededAt)}` : ""}</small>
              </div>
              <span className="row-actions">
                <a className="outline-button" href={`/investidores/contratos/${version.id}`} target="_blank" rel="noreferrer">Visualizar</a>
                <a className="outline-button" href={`/investidores/contratos/${version.id}?baixar=1`} download={version.fileName}>Baixar PDF</a>
                {!version.supersededAt && !version.sentAt && !version.signed && <MarkSentButton contract={version} onDone={onDone} />}
              </span>
            </li>
          );
        })}</ul>
      )}
    </section>
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
  const versions = data.contract.versions;
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
          <div><dt>Identificação do contrato</dt><dd>{investment.contractNumber ?? "—"}</dd></div>
          <div><dt>Valor investido</dt><dd>{formatMoney(investment.amountCents)}</dd></div>
          <div><dt>Data do investimento</dt><dd>{investment.investedOn ? formatDate(investment.investedOn) : "—"}</dd></div>
          <div><dt>Taxa combinada</dt><dd>{rateLabel(investment.agreedRateBps, investment.ratePeriod)}</dd></div>
          <div><dt>Data de início</dt><dd>{formatDate(investment.startDate)}</dd></div>
          <div><dt>Prazo</dt><dd>{investment.termMonths ? `${investment.termMonths} ${investment.termMonths === 1 ? "mês" : "meses"}` : "—"}</dd></div>
          <div><dt>Vencimento do contrato</dt><dd>{investment.maturityDate ? formatDate(investment.maturityDate) : "—"}</dd></div>
          <div><dt>Dia de vencimento</dt><dd>{investment.dueDay ? `Dia ${investment.dueDay}` : "—"}</dd></div>
          <div><dt>Periodicidade dos pagamentos</dt><dd>{investment.paymentFrequency ? PAYMENT_FREQUENCIES[investment.paymentFrequency] : "—"}</dd></div>
          <div><dt>Quantidade de parcelas</dt><dd>{investment.installmentCount ?? "—"}</dd></div>
          <div><dt>Status</dt><dd>{INVESTMENT_STATUS[investment.status]}</dd></div>
          <div><dt>Cadastrado em</dt><dd>{dateOf(investment.createdAt)}</dd></div>
          <div><dt>Observações</dt><dd className="preserve-lines">{investment.notes ?? "—"}</dd></div>
        </dl>
      </section>

      <ContractSection data={data} hasSignedContract={hasContract} onDone={refresh} />

      <ScheduleSection data={data} onDone={refresh} />

      <CashSection data={data} onDone={refresh} />

      <section className="panel form-panel" aria-label="Cálculos do investimento">
        <div className="panel-header"><div><h2>Rendimento e devolução</h2><p>Estrutura preparada: os valores calculados aparecem quando as regras financeiras dos investimentos forem definidas. Os pagamentos já registrados estão em &ldquo;Capital e pagamentos&rdquo;.</p></div></div>
        <dl className="payment-summary">
          {["Rendimento previsto (cálculo)", "Saldo do investidor", "Total a devolver", "Renovação", "Resgate"].map((label) => (
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
              <div><strong>{DOCUMENT_KINDS[document.kind]}</strong><small>{document.fileName} · {formatBytes(document.sizeBytes)} · enviado em {dateOf(document.createdAt)}{document.uploadedBy ? ` por ${document.uploadedBy}` : ""}{signedNote(document)}</small></div>
              <span className="row-actions">
                <a className="outline-button" href={`/investidores/documentos/${document.id}`} target="_blank" rel="noreferrer">Visualizar</a>
                <a className="outline-button" href={`/investidores/documentos/${document.id}?baixar=1`} download={document.fileName}>Baixar</a>
                <button type="button" className="outline-button" onClick={() => setReplacing(replacing === document.id ? null : document.id)}>Substituir</button>
              </span>
              {replacing === document.id && <ReplaceDocumentForm document={document} versions={versions} onDone={() => { setReplacing(null); refresh(); }} onCancel={() => setReplacing(null)} />}
            </li>
          ))}</ul>
        )}
        <UploadDocumentForm key={String(hasContract)} investmentId={investment.id} hasContract={hasContract} versions={versions} onDone={refresh} />
        {history.length > 0 && (
          <details className="document-history">
            <summary>{`Versões substituídas (${history.length})`}</summary>
            <ul className="document-list">{history.map((document) => (
              <li key={document.id}>
                <div><strong>{DOCUMENT_KINDS[document.kind]}</strong><small>{document.fileName} · enviado em {dateOf(document.createdAt)} · substituído em {dateOf(document.replacedAt as string)}{signedNote(document)}</small></div>
                <span className="row-actions"><a className="outline-button" href={`/investidores/documentos/${document.id}`} target="_blank" rel="noreferrer">Visualizar</a></span>
              </li>
            ))}</ul>
          </details>
        )}
      </section>

      <RevisionsSection revisions={data.revisions} />
    </div>
  );
}

const newRequestId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);

// Entrada do dinheiro deste contrato no capital (só com confirmação explícita, uma vez) e as obrigações do cronograma
// com o que já foi pago. Só a carteira dona do contrato registra; o MASTER vendo outra carteira só consulta.
function CashSection({ data, onDone }: { data: InvestmentDetail; onDone: () => void }) {
  const { investment, cash } = data;
  const [confirming, setConfirming] = useState(false);
  const requestId = useRef<string | null>(null);
  const entry = useFormAction(registerInvestmentEntryAction, () => { requestId.current = null; setConfirming(false); onDone(); });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    const input = event.currentTarget.elements.namedItem("requestId") as HTMLInputElement;
    requestId.current ??= newRequestId();
    input.value = requestId.current;
    entry.onSubmit(event);
  };
  const paidYield = cash.payments.filter((payment) => payment.kind === "YIELD").reduce((total, payment) => total + payment.amountCents, 0);
  const paidPrincipal = cash.payments.filter((payment) => payment.kind === "PRINCIPAL").reduce((total, payment) => total + payment.amountCents, 0);
  const open = cash.obligations.reduce((total, obligation) => total + obligation.balanceCents, 0);
  const canRegister = cash.ownWallet && !cash.entry && investment.status !== "CANCELED";
  return (
    <section className="panel form-panel" aria-label="Capital e pagamentos do investimento">
      <div className="panel-header"><div><h2>Capital e pagamentos</h2><p>A entrada do dinheiro no capital só é registrada quando você confirma. Os pagamentos ao investidor são as baixas feitas em Contas a Pagar.</p></div>
        {canRegister && !confirming && <span className="row-actions"><button type="button" className="primary-button" onClick={() => setConfirming(true)}>Registrar a entrada deste investimento no capital</button></span>}
      </div>
      <dl className="payment-summary">
        <div><dt>Entrada no capital</dt><dd>{cash.entry ? <>{formatMoney(cash.entry.amountCents)} em {formatDate(cash.entry.enteredOn)}<small className="admin-cell-note">Registrada em {dateOf(cash.entry.createdAt)}{cash.entry.createdBy ? ` por ${cash.entry.createdBy}` : ""}</small></> : <span className="muted-value">Não registrada</span>}</dd></div>
        <div><dt>Rendimentos pagos</dt><dd>{formatMoney(paidYield)}</dd></div>
        <div><dt>Principal devolvido</dt><dd>{formatMoney(paidPrincipal)}</dd></div>
        <div><dt>Em aberto no cronograma</dt><dd>{formatMoney(open)}</dd></div>
      </dl>
      {!cash.ownWallet && <p className="capital-note">Este contrato é de outra carteira: a entrada no capital e as baixas só podem ser registradas pela própria carteira.</p>}
      {confirming && canRegister && (
        <form className="schedule-form" onSubmit={submit} aria-label="Confirmar entrada no capital">
          <input type="hidden" name="investmentId" value={investment.id} />
          <input type="hidden" name="amountCents" value={investment.amountCents} />
          <input type="hidden" name="enteredOn" value={cash.entryDate} />
          <input type="hidden" name="requestId" defaultValue="" />
          <p><strong>Entrada de {formatMoney(investment.amountCents)} em {formatDate(cash.entryDate)}</strong> ({investment.investedOn ? "data do investimento" : "data de início do contrato"}). Vai aparecer no Financeiro como &ldquo;Entrada de investidor&rdquo; e somar ao capital disponível. Só pode ser registrada uma vez e não se desfaz por aqui.</p>
          <label className="check-field"><input type="checkbox" name="confirm" value="1" required /><span>Confirmo que {formatMoney(investment.amountCents)} entraram na carteira em {formatDate(cash.entryDate)}.</span></label>
          <div className="form-actions">
            <button type="button" className="outline-button" onClick={() => setConfirming(false)}>Cancelar</button>
            <button className="primary-button" disabled={entry.pending}><Icon name="check" size={16} /> {entry.pending ? "Registrando…" : "Confirmar entrada"}</button>
          </div>
        </form>
      )}
      <Feedback feedback={entry.feedback} />
      {cash.obligations.length > 0 && (
        <ObligationsTable obligations={cash.obligations} today={cash.today} cycleStartedOn={cash.cycleStartedOn} availableCents={null} canPay={cash.ownWallet && cash.hasWallet} showInvestor={false} label="Obrigações deste contrato" onDone={onDone} />
      )}
    </section>
  );
}

type ScheduleItem = InvestmentDetail["schedule"]["items"][number];
const moneyInput = (cents: number) => (cents ? centsToInput(cents) : "");

// Cronograma de pagamentos ao investidor: datas e valores digitados pelo usuário. Nada é calculado e nada mexe no capital.
function ScheduleSection({ data, onDone }: { data: InvestmentDetail; onDone: () => void }) {
  const { investment, schedule } = data;
  const editable = investment.status !== "CANCELED" && investment.status !== "CLOSED";
  const [building, setBuilding] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const done = () => { setBuilding(false); setAdding(false); setEditingId(null); onDone(); };
  const { totals, items } = schedule;
  const paid = new Set(data.cash.paidItemIds);
  return (
    <section className="panel form-panel" aria-label="Cronograma de pagamentos ao investidor">
      <div className="panel-header">
        <div><div className="panel-title-row"><h2>Cronograma de pagamentos</h2><span className="today-count">{totals.count}</span></div>
          <p>Datas e valores combinados com {data.investor.name}, digitados por você. O sistema não calcula rendimento e o cronograma não mexe no capital: cada pagamento é registrado (baixa) em Contas a Pagar.</p></div>
        {editable && (
          <span className="row-actions">
            <button type="button" className="outline-button" onClick={() => { setAdding(!adding); setBuilding(false); }}>{adding ? "Fechar" : "Incluir pagamento"}</button>
            {paid.size === 0 && <button type="button" className="primary-button" onClick={() => { setBuilding(!building); setAdding(false); }}>{building ? "Fechar" : items.length ? "Substituir cronograma" : "Montar cronograma"}</button>}
          </span>
        )}
      </div>
      {!editable && <p className="capital-note">Investimento encerrado ou cancelado: o cronograma fica só para consulta.</p>}
      {editable && paid.size > 0 && <p className="capital-note">Linhas com pagamento registrado ficam travadas para preservar o histórico financeiro; o cronograma não pode mais ser substituído.</p>}
      {building && <ScheduleBuildForm data={data} onDone={done} onCancel={() => setBuilding(false)} />}
      {adding && <ScheduleItemForm investmentId={investment.id} onDone={done} onCancel={() => setAdding(false)} />}
      {items.length === 0 ? <EmptyPanel icon="calendar" text="Nenhum pagamento no cronograma ainda." /> : (
        <>
          <dl className="payment-summary">
            <div><dt>Rendimentos informados</dt><dd>{formatMoney(totals.yieldCents)}</dd></div>
            <div><dt>Devolução de principal informada</dt><dd>{formatMoney(totals.principalCents)}</dd></div>
            <div><dt>Total do cronograma</dt><dd>{formatMoney(totals.totalCents)}</dd></div>
          </dl>
          <div className="table-scroll"><table className="data-table">
            <thead><tr><th>#</th><th>Data</th><th>Rendimento</th><th>Devolução do principal</th><th>Total</th><th>Descrição</th>{editable && <th />}</tr></thead>
            <tbody>{items.map((item, index) => (
              <ScheduleRow key={item.id} item={item} position={index + 1} investmentId={investment.id} editable={editable} locked={paid.has(item.id)} editing={editingId === item.id}
                onEdit={() => setEditingId(editingId === item.id ? null : item.id)} onDone={done} />
            ))}</tbody>
          </table></div>
        </>
      )}
    </section>
  );
}

function ScheduleRow({ item, position, investmentId, editable, locked, editing, onEdit, onDone }: { item: ScheduleItem; position: number; investmentId: string; editable: boolean; locked: boolean; editing: boolean; onEdit: () => void; onDone: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const remove = useFormAction(deleteInvestmentScheduleItemAction, onDone);
  return (
    <>
      <tr>
        <td>{position}</td>
        <td>{formatDate(item.dueDate)}</td>
        <td>{item.yieldCents ? formatMoney(item.yieldCents) : "—"}</td>
        <td>{item.principalCents ? formatMoney(item.principalCents) : "—"}</td>
        <td><strong>{formatMoney(item.yieldCents + item.principalCents)}</strong></td>
        <td>{item.description ?? "—"}</td>
        {editable && locked && <td className="actions-cell"><span className="status-chip status-paid"><i />Com pagamento</span></td>}
        {editable && !locked && (
          <td className="actions-cell">
            <form className="row-actions" onSubmit={remove.onSubmit}>
              <input type="hidden" name="investmentId" value={investmentId} /><input type="hidden" name="itemId" value={item.id} />
              <button type="button" className="outline-button" onClick={onEdit}>{editing ? "Fechar" : "Editar"}</button>
              {confirming
                ? <><button className="primary-button danger-button" disabled={remove.pending}>{remove.pending ? "Retirando…" : "Confirmar retirada"}</button><button type="button" className="text-link" onClick={() => setConfirming(false)}>Manter</button></>
                : <button type="button" className="outline-button" onClick={() => setConfirming(true)}>Retirar</button>}
            </form>
            <Feedback feedback={remove.feedback} />
          </td>
        )}
      </tr>
      {editing && <tr><td colSpan={7}><ScheduleItemForm investmentId={investmentId} item={item} onDone={onDone} onCancel={onEdit} /></td></tr>}
    </>
  );
}

// Inclusão ou edição de uma linha do cronograma.
function ScheduleItemForm({ investmentId, item, onDone, onCancel }: { investmentId: string; item?: ScheduleItem; onDone: () => void; onCancel: () => void }) {
  const { pending, feedback, onSubmit } = useFormAction(item ? updateInvestmentScheduleItemAction : addInvestmentScheduleItemAction, onDone);
  return (
    <div className="schedule-form">
      <form className="form-grid" onSubmit={onSubmit}>
        <input type="hidden" name="investmentId" value={investmentId} />
        {item && <input type="hidden" name="itemId" value={item.id} />}
        <DateField label="Data do pagamento" name="dueDate" defaultValue={item?.dueDate ?? ""} required />
        <label className="field"><span>Rendimento (R$)</span><input name="yieldAmount" inputMode="decimal" placeholder="1.000,00" defaultValue={item ? moneyInput(item.yieldCents) : ""} /></label>
        <label className="field"><span>Devolução do principal (R$)</span><input name="principalAmount" inputMode="decimal" placeholder="0,00" defaultValue={item ? moneyInput(item.principalCents) : ""} /></label>
        <label className="field"><span>Descrição (opcional)</span><input name="description" maxLength={200} placeholder="Ex.: rendimento de março" defaultValue={item?.description ?? ""} /></label>
        <div className="form-actions">
          <button type="button" className="outline-button" onClick={onCancel}>Cancelar</button>
          <button className="primary-button" disabled={pending}><Icon name="check" size={16} /> {pending ? "Salvando…" : item ? "Salvar pagamento" : "Incluir pagamento"}</button>
        </div>
      </form>
      <Feedback feedback={feedback} />
    </div>
  );
}

// Montagem do cronograma pelas datas da periodicidade, com prévia antes de gravar. Os valores são os digitados.
function ScheduleBuildForm({ data, onDone, onCancel }: { data: InvestmentDetail; onDone: () => void; onCancel: () => void }) {
  const { investment, schedule } = data;
  const initialFrequency = investment.paymentFrequency && investment.paymentFrequency !== "OTHER" ? investment.paymentFrequency : "MONTHLY";
  const [frequency, setFrequency] = useState<PaymentFrequency>(initialFrequency);
  const [firstDueDate, setFirstDueDate] = useState("");
  const [count, setCount] = useState(String(investment.installmentCount ?? ""));
  const { pending, feedback, onSubmit } = useFormAction(buildInvestmentScheduleAction, onDone);
  const total = frequency === "AT_MATURITY" ? 1 : Number(count);
  const dates = firstDueDate && Number.isInteger(total) && total >= 1 && total <= MAX_SCHEDULE_ITEMS ? scheduleDates(firstDueDate, total, frequency) : [];
  const options = (Object.keys(PAYMENT_FREQUENCIES) as PaymentFrequency[]).filter((key) => key !== "OTHER");
  return (
    <div className="schedule-form">
      <form className="form-grid" onSubmit={onSubmit}>
        <input type="hidden" name="investmentId" value={investment.id} />
        <label className="field"><span>Periodicidade</span><select name="frequency" value={frequency} onChange={(event) => setFrequency(event.target.value as PaymentFrequency)}>
          {options.map((key) => <option key={key} value={key}>{PAYMENT_FREQUENCIES[key]}</option>)}
        </select></label>
        <DateField label={frequency === "AT_MATURITY" ? "Data do pagamento" : "Data do primeiro pagamento"} name="firstDueDate" defaultValue={firstDueDate} onChange={setFirstDueDate} required />
        {frequency !== "AT_MATURITY" && <label className="field"><span>Quantidade de pagamentos</span><input name="count" inputMode="numeric" maxLength={3} placeholder="12" value={count} onChange={(event) => setCount(event.target.value.replace(/\D/g, ""))} required /></label>}
        <label className="field"><span>{frequency === "AT_MATURITY" ? "Rendimento (R$)" : "Rendimento de cada pagamento (R$)"}</span><input name="yieldAmount" inputMode="decimal" placeholder="1.000,00" /></label>
        <label className="field"><span>{frequency === "AT_MATURITY" ? "Devolução do principal (R$)" : "Devolução do principal na última data (R$)"}</span><input name="principalAmount" inputMode="decimal" placeholder={centsToInput(investment.amountCents)} /></label>
        <label className="field"><span>Descrição (opcional)</span><input name="description" maxLength={200} placeholder="Ex.: rendimento mensal" /></label>
        <p className="capital-note field-wide">Os valores são exatamente os que você digitar: o sistema não calcula rendimento. Depois de gravado, cada pagamento pode ser editado ou retirado, e datas irregulares podem ser incluídas uma a uma.</p>
        {dates.length > 0 && (
          <div className="schedule-preview field-wide" aria-label="Prévia das datas">
            <p>Prévia das datas</p>
            <ol>{dates.map((date, index) => <li key={date}><span>{`${index + 1}º pagamento${index === dates.length - 1 && dates.length > 1 ? " (último)" : ""}`}</span><strong>{formatDate(date)}</strong></li>)}</ol>
          </div>
        )}
        {schedule.items.length > 0 && (
          <label className="check-field field-wide"><input type="checkbox" name="replace" value="1" required /><span>{`Substituir o cronograma atual (${schedule.items.length} ${schedule.items.length === 1 ? "pagamento" : "pagamentos"}). Fica registrado no histórico.`}</span></label>
        )}
        <div className="form-actions">
          <button type="button" className="outline-button" onClick={onCancel}>Cancelar</button>
          <button className="primary-button" disabled={pending}><Icon name="check" size={16} /> {pending ? "Gravando…" : "Gravar cronograma"}</button>
        </div>
      </form>
      <Feedback feedback={feedback} />
    </div>
  );
}

// Histórico de alterações do contrato e do cronograma, visível para o próprio tenant.
function RevisionsSection({ revisions }: { revisions: InvestmentDetail["revisions"] }) {
  return (
    <section className="panel form-panel" aria-label="Histórico de alterações do investimento">
      <div className="panel-header"><div><div className="panel-title-row"><h2>Histórico de alterações</h2><span className="today-count">{revisions.length}</span></div><p>O que mudou no contrato e no cronograma, quando e por quem.</p></div></div>
      {revisions.length === 0 ? <EmptyPanel icon="clock" text="Nenhuma alteração depois do cadastro." /> : (
        <ul className="document-list">{revisions.map((revision) => (
          <li key={revision.id}>
            <div>
              <strong>{revision.description}</strong>
              <small>{formatDateTime(new Date(revision.createdAt))}{revision.changedBy ? ` · ${revision.changedBy}` : ""}</small>
              <ul className="revision-changes">{revision.changes.map((change) => (
                <li key={change.field}>{`${change.field}: de ${change.before ?? "vazio"} para ${change.after ?? "vazio"}`}</li>
              ))}</ul>
            </div>
          </li>
        ))}</ul>
      )}
    </section>
  );
}
