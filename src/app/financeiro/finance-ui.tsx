"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { categoriesOf, DESCRIPTION_MAX, directionLabels, manualCategories, NOTES_MAX, statementCategoryLabels, type FinanceDirection, type ManualCategory, type StatementCategory } from "@/lib/finance/cashflow";
import type { FinancePageData } from "@/lib/finance/finance-queries";
import { formatDate, formatMoney, parseMoneyToCents } from "@/lib/finance/format";
import { DateField } from "../date-field";
import { EmptyPanel, Feedback, PageHeading, useFormAction } from "../portfolio-pages";
import { Icon, type IconName } from "../ui-icon";
import { registerFinanceMovementAction } from "./actions";

function MetricCard({ label, value, caption, icon, tone = "teal" }: { label: string; value: string; caption: string; icon: IconName; tone?: "teal" | "blue" | "purple" }) {
  return (
    <article className="metric-card">
      <div className="metric-top"><span>{label}</span><span className={`metric-icon metric-icon-${tone}`}><Icon name={icon} size={17} /></span></div>
      <div className="metric-value">{value}</div>
      <div className="metric-foot"><span className="metric-caption">{caption}</span></div>
    </article>
  );
}

// Chave de cada envio: criada no primeiro clique e repetida em qualquer reenvio do mesmo formulário (clique duplo,
// conexão que caiu depois de gravar). O servidor grava uma única vez por chave. Depois de um envio bem-sucedido, uma
// nova chave é criada no próximo.
const newRequestId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);

// Nova entrada ou nova saída. O valor é sempre positivo; o tipo define se soma ou subtrai do capital disponível.
function MovementForm({ direction, data, onDone, onCancel }: { direction: FinanceDirection; data: FinancePageData; onDone: () => void; onCancel: () => void }) {
  const requestId = useRef<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [amountText, setAmountText] = useState("");
  const { pending, feedback, onSubmit } = useFormAction(registerFinanceMovementAction, () => { requestId.current = null; setResetKey((key) => key + 1); setAmountText(""); onDone(); });
  const amountCents = amountText.trim() ? parseMoneyToCents(amountText) : null;
  const invalidAmount = amountText.trim() !== "" && (amountCents === null || amountCents <= 0);
  const exceeds = direction === "OUT" && amountCents !== null && amountCents > data.availableCents;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    const input = event.currentTarget.elements.namedItem("requestId") as HTMLInputElement;
    requestId.current ??= newRequestId();
    input.value = requestId.current;
    onSubmit(event);
  };
  const categories = categoriesOf(direction);
  return (
    <section className="panel form-panel" aria-label={direction === "IN" ? "Nova entrada" : "Nova saída"}>
      <div className="panel-header"><div><h2>{direction === "IN" ? "Nova entrada" : "Nova saída"}</h2><p>
        {direction === "IN"
          ? "Dinheiro que entra na carteira fora das operações. Recebimentos de clientes continuam sendo registrados em Pagamentos e já aparecem aqui."
          : `Dinheiro que sai da carteira: salário, retirada de sócio, despesas e impostos. Não é empréstimo nem mexe nas operações dos clientes. Limitada ao capital disponível de ${formatMoney(Math.max(data.availableCents, 0))}.`}
      </p></div></div>
      <form className="form-grid" onSubmit={submit} key={resetKey}>
        <input type="hidden" name="direction" value={direction} />
        <input type="hidden" name="requestId" defaultValue="" />
        <label className="field"><span>Categoria</span><select name="category" defaultValue={categories.length === 1 ? categories[0] : ""} required>
          {categories.length > 1 && <option value="" disabled>Escolha a categoria</option>}
          {categories.map((category: ManualCategory) => <option key={category} value={category}>{manualCategories[category].label}</option>)}
        </select></label>
        <label className="field"><span>Valor (R$)</span><input name="amount" inputMode="decimal" placeholder="1.500,00" value={amountText} onChange={(event) => setAmountText(event.target.value)} aria-invalid={invalidAmount || exceeds} required /></label>
        <DateField label="Data da movimentação" name="occurredAt" defaultValue={data.today} min={data.cycleStartedOn ?? undefined} max={data.today} required />
        <label className="field field-wide"><span>Descrição</span><input name="description" maxLength={DESCRIPTION_MAX} placeholder={direction === "IN" ? "Ex.: Aporte do sócio" : "Ex.: Salário de outubro"} required /></label>
        <label className="field field-wide"><span>Observações</span><textarea name="notes" maxLength={NOTES_MAX} rows={2} placeholder="Opcional" /></label>
        {invalidAmount && <p className="form-feedback form-feedback-error field-wide" role="alert">O valor precisa ser maior que zero, sem sinal de menos.</p>}
        {exceeds && <p className="form-feedback form-feedback-error field-wide" role="alert">A saída é maior que o capital disponível de {formatMoney(Math.max(data.availableCents, 0))}.</p>}
        {amountCents !== null && amountCents > 0 && !exceeds && (
          <p className="capital-note field-wide">Capital disponível: {formatMoney(data.availableCents)} → <strong>{formatMoney(data.availableCents + (direction === "IN" ? amountCents : -amountCents))}</strong> depois deste lançamento.</p>
        )}
        <div className="form-actions">
          <button type="button" className="outline-button" onClick={onCancel}>Cancelar</button>
          <button className={`primary-button${direction === "OUT" ? " danger-button" : ""}`} disabled={pending || invalidAmount || exceeds}>
            <Icon name={direction === "IN" ? "plus" : "arrow"} size={16} /> {pending ? "Registrando…" : direction === "IN" ? "Registrar entrada" : "Registrar saída"}
          </button>
        </div>
      </form>
      <Feedback feedback={feedback} />
    </section>
  );
}

const directionSlug: Record<FinanceDirection, string> = { IN: "entrada", OUT: "saida" };

// /financeiro: saldo atual, totais do período, filtros, resumo por categoria e histórico.
export function FinanceHome({ data }: { data: FinancePageData }) {
  const router = useRouter();
  const [creating, setCreating] = useState<FinanceDirection | null>(null);
  const { filters, statement } = data;
  const query = (changes: Record<string, string | null>) => {
    const params = new URLSearchParams({ de: filters.from, ate: filters.to, ...(filters.direction ? { tipo: directionSlug[filters.direction] } : {}), ...(filters.category ? { categoria: filters.category } : {}) });
    for (const [key, value] of Object.entries(changes)) if (value) params.set(key, value); else params.delete(key);
    return `/financeiro?${params}`;
  };
  const filtered = Boolean(filters.direction || filters.category);
  const period = `${formatDate(filters.from)} a ${formatDate(filters.to)}`;
  return (
    <div className="workspace-page">
      <PageHeading eyebrow="CREDIAI · FINANCEIRO" title="Financeiro" description={`Entradas e saídas da carteira no ciclo ${data.cycleNumber}: aportes, empréstimos, recebimentos, retiradas e despesas, todos sobre o mesmo capital disponível.`}>
        <button className="outline-button" disabled={!data.hasWallet} onClick={() => setCreating(creating === "IN" ? null : "IN")}><Icon name="plus" size={17} /> Nova entrada</button>
        <button className="primary-button" disabled={!data.hasWallet} onClick={() => setCreating(creating === "OUT" ? null : "OUT")}><Icon name="arrow" size={17} /> Nova saída</button>
      </PageHeading>

      {!data.hasWallet && <EmptyPanel icon="wallet" text="Defina o capital inicial da carteira na tela Capital para começar a registrar movimentações." action={<Link prefetch={false} className="primary-button" href="/?tela=capital">Ir para Capital</Link>} />}

      <section className="metric-grid" aria-label="Resumo financeiro">
        <MetricCard icon="dollar" label="Saldo disponível atual" value={formatMoney(data.availableCents)} caption="Mesmo valor do card Capital disponível" />
        <MetricCard icon="trend" label="Entradas no período" value={formatMoney(statement.inflowsCents)} caption={period} />
        <MetricCard icon="receipt" tone="blue" label="Saídas no período" value={formatMoney(statement.outflowsCents)} caption={period} />
        <MetricCard icon="chart" tone="purple" label="Saldo líquido do período" value={`${statement.netCents < 0 ? "− " : ""}${formatMoney(Math.abs(statement.netCents))}`} caption="Entradas − saídas (não é lucro)" />
      </section>

      {creating && <MovementForm key={creating} direction={creating} data={data} onDone={() => { setCreating(null); router.refresh(); }} onCancel={() => setCreating(null)} />}

      <section className="panel table-panel" aria-label="Movimentações">
        <div className="panel-header"><div><div className="panel-title-row"><h2>Movimentações</h2><span className="today-count">{statement.rows.length}</span></div><p>Período de {period}{filtered ? ", com filtros" : ""}. O saldo após cada linha é o do extrato completo do ciclo.</p></div></div>
        <nav className="charge-tabs" aria-label="Períodos prontos">
          {Object.entries(data.presets).map(([key, preset]) => {
            const active = preset.from === filters.from && preset.to === filters.to;
            return <Link prefetch={false} key={key} className={active ? "charge-tab-active" : ""} aria-current={active ? "true" : undefined} href={query({ de: preset.from, ate: preset.to })}>{preset.label}</Link>;
          })}
        </nav>
        <form className="investor-filters" action="/financeiro" method="get" role="search" key={`${filters.from}-${filters.to}-${filters.direction}-${filters.category}`}>
          <DateField label="De" name="de" defaultValue={filters.from} max={data.today} />
          <DateField label="Até" name="ate" defaultValue={filters.to} />
          <label className="field"><span>Tipo</span><select name="tipo" defaultValue={filters.direction ? directionSlug[filters.direction] : ""}>
            <option value="">Entradas e saídas</option><option value="entrada">Entradas</option><option value="saida">Saídas</option>
          </select></label>
          <label className="field"><span>Categoria</span><select name="categoria" defaultValue={filters.category ?? ""}>
            <option value="">Todas</option>
            {(Object.keys(statementCategoryLabels) as StatementCategory[]).map((category) => <option key={category} value={category}>{statementCategoryLabels[category]}</option>)}
          </select></label>
          <div className="investor-filter-actions"><button className="outline-button"><Icon name="filter" size={15} /> Aplicar</button>{filtered && <Link prefetch={false} className="text-link" href={query({ tipo: null, categoria: null })}>Limpar filtros</Link>}</div>
        </form>

        {statement.categories.length > 0 && (
          <div className="table-scroll"><table className="data-table" aria-label="Resumo por categoria">
            <thead><tr><th>Resumo por categoria</th><th>Tipo</th><th>Lançamentos</th><th>Valor</th></tr></thead>
            <tbody>{statement.categories.map((category) => (
              <tr key={category.key}><td>{category.label}</td><td>{directionLabels[category.direction]}</td><td>{category.count}</td><td><strong>{category.direction === "OUT" ? "− " : "+ "}{formatMoney(category.amountCents)}</strong></td></tr>
            ))}</tbody>
            <tfoot><tr><td><strong>Saldo líquido do período</strong></td><td /><td /><td><strong>{statement.netCents < 0 ? "− " : "+ "}{formatMoney(Math.abs(statement.netCents))}</strong></td></tr></tfoot>
          </table></div>
        )}

        {statement.rows.length === 0 ? <EmptyPanel icon="receipt" text={filtered ? "Nenhuma movimentação com esses filtros no período." : "Nenhuma movimentação neste período."} /> : (
          <div className="table-scroll"><table className="data-table" aria-label="Histórico de movimentações">
            <thead><tr><th>Data</th><th>Tipo</th><th>Categoria</th><th>Descrição</th><th>Valor</th><th>Saldo após</th><th>Responsável</th><th>Origem</th></tr></thead>
            <tbody>{statement.rows.map((row) => (
              <tr key={row.key}>
                <td>{formatDate(row.date)}</td>
                <td><span className={`status-chip ${row.direction === "OUT" ? "status-due" : "status-active"}`}><i />{directionLabels[row.direction]}</span></td>
                <td>{row.categoryLabel}</td>
                <td>{row.description}
                  {row.principalCents !== undefined && <small className="admin-cell-note">Principal {formatMoney(row.principalCents)} · Juros {formatMoney(row.interestCents ?? 0)}</small>}
                  {row.notes && <small className="admin-cell-note">{row.notes}</small>}
                </td>
                <td><strong>{row.direction === "OUT" ? "− " : "+ "}{formatMoney(row.amountCents)}</strong></td>
                <td>{formatMoney(row.balanceCents)}</td>
                <td>{row.responsible}</td>
                <td>{row.origin}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      <p className="capital-note">Recebimentos de clientes, empréstimos e exclusões de operação vêm dos módulos Operações e Pagamentos e só aparecem aqui; não são lançados de novo. Lucro, DRE e obrigações fiscais não são calculados.</p>
    </div>
  );
}
