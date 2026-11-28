"use client";

import { useRouter } from "next/navigation";
import { createContext, Fragment, useContext, useState, type FormEvent } from "react";
import { formatMoney, parseMoneyToCents, todayIso } from "@/lib/finance/format";
import type { ManagersPage } from "@/lib/managers/queries";
import { MoneyInput } from "../money-input";
import { EmptyPanel, Feedback, PageHeading, useFormAction } from "../portfolio-pages";
import { Icon } from "../ui-icon";
import type { AccessResult } from "./actions";

type Result = { ok: true; message: string } | { ok: false; error: string };
// As mesmas telas servem ao dono da carteira (ações de /gerentes) e ao MASTER (ações de /admin, com o tenant escolhido).
export type ManagerActions = {
  createManager: (data: FormData) => Promise<Result>;
  updateManager: (data: FormData) => Promise<Result>;
  linkClient: (data: FormData) => Promise<Result>;
  unlinkClient: (data: FormData) => Promise<Result>;
  deleteManager: (data: FormData) => Promise<Result>;
  registerPayout: (data: FormData) => Promise<Result>;
  createAdjustment: (data: FormData) => Promise<Result>;
  deleteAdjustment: (data: FormData) => Promise<Result>;
  createAccess: (data: FormData) => Promise<AccessResult>;
  resetPassword: (data: FormData) => Promise<AccessResult>;
  reverseCommission: (data: FormData) => Promise<Result>;
  // Só na administração (MASTER): registrar a composição confirmada de um fechamento antigo sem composição.
  recordHistorical?: (data: FormData) => Promise<Result>;
};
// canManageAccess: só o MASTER administra logins de gerente; para o dono operacional os controles nem aparecem (e o servidor recusa).
const Scope = createContext<{ actions: ManagerActions; tenantId?: string; canManageAccess: boolean } | null>(null);
function useScope() {
  const scope = useContext(Scope);
  if (!scope) throw new Error("ManagersHome ausente.");
  return scope;
}
const TenantField = () => { const { tenantId } = useScope(); return tenantId ? <input type="hidden" name="tenantId" value={tenantId} /> : null; };

type Manager = ManagersPage["managers"][number];
const percent = (bps: number) => `${(bps / 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;
const percentInput = (bps: number) => (bps / 100).toLocaleString("pt-BR", { maximumFractionDigits: 2, useGrouping: false });
const SITUATION: Record<string, string> = { OVERDUE: "Em atraso", ON_TIME: "Em dia", PAID: "Quitado", NO_OPERATIONS: "Sem operações" };
const dateBr = (iso: string) => iso.split("-").reverse().join("/");
type Adjustment = Manager["adjustments"][number];
const KindChip = ({ kind }: { kind: string }) => <span className={`status-chip ${kind === "CREDIT" ? "status-paid" : "status-late"}`}><i />{kind === "CREDIT" ? "Crédito" : "Débito"}</span>;
const signed = (kind: string, cents: number) => `${kind === "CREDIT" ? "+" : "−"} ${formatMoney(cents)}`;

const CPG_STATUS: Record<string, { label: string; className: string }> = {
  PAID: { label: "CPG · comissão paga", className: "status-paid" }, PARTIAL: { label: "Paga em parte", className: "status-due" }, PENDING: { label: "Pendente", className: "status-late" },
};
const CpgChip = ({ status }: { status: string }) => <span className={`status-chip ${CPG_STATUS[status]?.className ?? "status-muted"}`}><i />{CPG_STATUS[status]?.label ?? status}</span>;
type Payout = Manager["payouts"][number];

// Contratos que compuseram UM fechamento (o que foi gravado nele) e os estornos ligados a ele.
function PayoutComposition({ payout, manager }: { payout: Payout; manager?: Manager }) {
  const { actions } = useScope();
  if (payout.source === "UNREGISTERED") return (
    <>
      <p className="muted"><small>Fechamento anterior ao controle por contrato, sem composição registrada: o valor de {formatMoney(payout.amountCents)} não é dividido entre contratos (nada é estimado).</small></p>
      {actions.recordHistorical && manager && <HistoricalCompositionForm payout={payout} manager={manager} record={actions.recordHistorical} />}
    </>
  );
  const lines = payout.lines.filter((line) => line.operationId);
  return (
    <div className="payout-composition">
      {payout.historical && <p><small>Composição registrada em {dateBr(payout.historical.recordedAt.slice(0, 10))} como reconstrução histórica confirmada: {payout.historical.reason}</small></p>}
      <table className="data-table fit-table">
        <thead><tr><th>Cliente</th><th>Contrato</th><th>Valor emprestado</th><th>Juros recebidos</th><th>% comissão</th><th>Comissão paga</th></tr></thead>
        <tbody>{lines.map((line) => (
          <tr key={line.operationId}>
            <td data-label="Cliente">{line.clientName}</td><td data-label="Contrato">#{line.operationCode}</td><td data-label="Valor emprestado">{formatMoney(line.principalCents)}</td>
            <td data-label="Juros recebidos">{formatMoney(line.interestReceivedCents)}</td><td data-label="% comissão">{percent(line.commissionBps)}</td><td data-label="Comissão paga"><strong>{formatMoney(line.commissionCents)}</strong></td>
          </tr>
        ))}</tbody>
        <tfoot><tr><td colSpan={5}><strong>{lines.length} {lines.length === 1 ? "contrato" : "contratos"} · total</strong></td><td><strong>{formatMoney(lines.reduce((total, line) => total + line.commissionCents, 0))}</strong></td></tr></tfoot>
      </table>
      {payout.reversals.length > 0 && <ul className="adjustment-lines">{payout.reversals.map((item, index) => <li key={index}><span className="status-chip status-late"><i />Estorno</span> {dateBr(item.createdAt.slice(0, 10))} · {item.operationCode ? `#${item.operationCode} · ` : ""}{item.clientName} · {item.reason} <strong>− {formatMoney(item.amountCents)}</strong></li>)}</ul>}
    </div>
  );
}

// MASTER: registrar a composição CONFIRMADA de um fechamento antigo (quais recebimentos e quanto de cada), com motivo. O valor do
// fechamento não muda; a composição tem de somar exatamente o valor gravado e entra uma vez só.
function HistoricalCompositionForm({ payout, manager, record }: { payout: Payout; manager: Manager; record: (data: FormData) => Promise<Result> }) {
  const router = useRouter();
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const form = useFormAction(record, () => router.refresh(), false);
  const receipts = manager.contracts.flatMap((contract) => contract.receipts).filter((receipt) => receipt.pendingCents > 0 && receipt.paidOn <= payout.paidOn);
  const entries = Object.entries(chosen).map(([paymentId, value]) => ({ paymentId, cents: parseMoneyToCents(value) ?? 0 })).filter((entry) => entry.cents > 0);
  const total = entries.reduce((sum, entry) => sum + entry.cents, 0);
  return (
    <form className="form-grid" onSubmit={form.onSubmit}>
      <input type="hidden" name="payoutId" value={payout.id} /><TenantField />
      <input type="hidden" name="entries" value={entries.map((entry) => `${entry.paymentId}:${entry.cents}`).join(",")} />
      <div className="field-wide"><strong>Registrar a composição confirmada deste fechamento</strong>
        <table className="data-table fit-table"><thead><tr><th>Incluir</th><th>Recebimento</th><th>Pendente</th><th>Valor pago neste fechamento</th></tr></thead>
          <tbody>{receipts.map((receipt) => (
            <tr key={receipt.paymentId}>
              <td><input type="checkbox" aria-label={`Incluir ${receipt.clientName} ${dateBr(receipt.paidOn)}`} checked={receipt.paymentId in chosen} onChange={() => setChosen((current) => { const next = { ...current }; if (receipt.paymentId in next) delete next[receipt.paymentId]; else next[receipt.paymentId] = (receipt.pendingCents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 }); return next; })} /></td>
              <td>{receipt.clientName} · #{receipt.operationCode} · {dateBr(receipt.paidOn)}</td><td>{formatMoney(receipt.pendingCents)}</td>
              <td>{receipt.paymentId in chosen && <MoneyInput aria-label={`Valor de ${receipt.clientName} ${dateBr(receipt.paidOn)}`} value={chosen[receipt.paymentId]} onChange={(event) => { const value = event.currentTarget.value; setChosen((current) => ({ ...current, [receipt.paymentId]: value })); }} />}</td>
            </tr>
          ))}</tbody></table>
        <p><small>Soma {formatMoney(total)} de {formatMoney(payout.amountCents)} gravados no fechamento.</small></p>
      </div>
      <label className="field field-wide"><span>Motivo / confirmação</span><input name="reason" required maxLength={300} placeholder="Ex.: composição confirmada pela responsável em 27/11" /></label>
      <div className="form-actions"><button className="primary-button" disabled={form.pending || total !== payout.amountCents}>{form.pending ? "Registrando…" : "Registrar composição"}</button></div>
      <Feedback feedback={form.feedback} />
    </form>
  );
}

// Relatório dos fechamentos: comissão quitada, cada lançamento aplicado (descrição, débito/crédito e valor) e o valor final pago, com o
// PDF de cada fechamento (visualizar ou baixar de novo a qualquer momento; o MASTER abre o da carteira escolhida) e os contratos dele.
export function PayoutReport({ payouts, manager }: { payouts: Manager["payouts"]; manager?: Manager }) {
  const scope = useContext(Scope);
  const [open, setOpen] = useState<string | null>(null);
  if (payouts.length === 0) return <p>Nenhum fechamento de comissão registrado ainda.</p>;
  const pdfHref = (payoutId: string, download: boolean) => {
    const query = new URLSearchParams();
    if (scope?.tenantId) query.set("tenantId", scope.tenantId);
    if (download) query.set("baixar", "1");
    const search = query.toString();
    return `/gerentes/fechamentos/${encodeURIComponent(payoutId)}${search ? `?${search}` : ""}`;
  };
  return (
    <table className="data-table fit-table payout-report">
      <thead><tr><th>Data</th><th>Comissão</th><th>Lançamentos aplicados</th><th>Valor final pago</th><th>Observação</th><th>Relatório</th></tr></thead>
      <tbody>{payouts.map((payout) => (
        <Fragment key={payout.id}>
          <tr>
            <td data-label="Data">{dateBr(payout.paidOn)}</td>
            <td data-label="Comissão">{formatMoney(payout.amountCents)}{payout.reversedCents > 0 && <small> (estornado {formatMoney(payout.reversedCents)})</small>}</td>
            <td data-label="Lançamentos" className="adjustments-cell">{payout.adjustments.length === 0 ? "—" : (
              <ul className="adjustment-lines">{payout.adjustments.map((item) => <li key={item.id}><KindChip kind={item.kind} /> {item.description} <strong>{signed(item.kind, item.amountCents)}</strong></li>)}</ul>
            )}</td>
            <td data-label="Valor final"><strong>{formatMoney(payout.finalCents)}</strong></td>
            <td data-label="Observação">{payout.notes ?? "—"}</td>
            <td data-label="Relatório" className="payout-pdf-links">
              <button type="button" className="outline-button" onClick={() => setOpen(open === payout.id ? null : payout.id)} aria-expanded={open === payout.id} aria-label={`Contratos do fechamento de ${dateBr(payout.paidOn)}`}>{open === payout.id ? "Fechar" : `Contratos (${payout.lines.filter((line) => line.operationId).length})`}</button>
              <a className="outline-button" href={pdfHref(payout.id, false)} target="_blank" rel="noopener" aria-label={`Ver PDF do fechamento de ${dateBr(payout.paidOn)}`}>Ver PDF</a>
              <a className="outline-button" href={pdfHref(payout.id, true)} download aria-label={`Baixar PDF do fechamento de ${dateBr(payout.paidOn)}`}>Baixar</a>
            </td>
          </tr>
          {open === payout.id && <tr className="payout-composition-row"><td colSpan={6}><PayoutComposition payout={payout} manager={manager} /></td></tr>}
        </Fragment>
      ))}</tbody>
    </table>
  );
}

// Controle CPG (Comissão Paga) por contrato e recebimento de juros: o que cada recebimento gerou, quanto já foi pago (em qual fechamento)
// e quanto está pendente, com filtros separados. Recebimento novo de um contrato já pago aparece como pendente de novo (só ele).
type CpgFilter = "PENDING" | "PAID" | "PARTIAL" | "ALL";
function CommissionControl({ manager }: { manager: Manager }) {
  const [filter, setFilter] = useState<CpgFilter>("PENDING");
  const [expanded, setExpanded] = useState<string | null>(null);
  const counts = { PENDING: 0, PAID: 0, PARTIAL: 0, ALL: manager.contracts.length };
  for (const contract of manager.contracts) counts[contract.status] += 1;
  const shown = manager.contracts.filter((contract) => filter === "ALL" || contract.status === filter);
  const paidOn = new Map(manager.payouts.map((payout) => [payout.id, payout.paidOn]));
  const labels: [CpgFilter, string][] = [["PENDING", "Pendentes"], ["PAID", "Pagas (CPG)"], ["PARTIAL", "Pagas em parte"], ["ALL", "Todas"]];
  return (
    <div className="payout-review commission-control">
      <h3>Comissões por contrato (CPG)</h3>
      <p><small>Comissão = juros efetivamente recebidos × % do contrato, recebimento a recebimento. CPG = comissão paga: o recebimento já entrou num fechamento e não é pago de novo. Juros recebidos depois geram comissão nova normalmente.</small></p>
      <div className="segmented" role="tablist" aria-label="Filtrar comissões">
        {labels.map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={filter === key} className={filter === key ? "primary-button" : "outline-button"} onClick={() => setFilter(key)}>{label} ({counts[key]})</button>)}
      </div>
      {shown.length === 0 ? <p>Nenhum contrato neste filtro.</p> : (
        <table className="data-table fit-table cpg-table">
          <thead><tr><th>Cliente / contrato</th><th>Valor emprestado</th><th>Juros recebidos</th><th>% comissão</th><th>Comissão gerada</th><th>Paga</th><th>Pendente</th><th>Situação</th></tr></thead>
          <tbody>{shown.map((contract) => (
            <Fragment key={contract.operationId}>
              <tr>
                <td data-label="Contrato"><button type="button" className="link-button" onClick={() => setExpanded(expanded === contract.operationId ? null : contract.operationId)} aria-expanded={expanded === contract.operationId}><strong>{contract.clientName}</strong> · #{contract.operationCode}</button></td>
                <td data-label="Valor emprestado">{formatMoney(contract.principalCents)}</td><td data-label="Juros recebidos">{formatMoney(contract.interestCents)}</td><td data-label="% comissão">{percent(contract.commissionBps)}</td>
                <td data-label="Comissão gerada">{formatMoney(contract.commissionDueCents)}</td><td data-label="Paga">{formatMoney(contract.paidCents)}</td><td data-label="Pendente"><strong>{formatMoney(contract.pendingCents)}</strong></td>
                <td data-label="Situação"><CpgChip status={contract.status} /></td>
              </tr>
              {expanded === contract.operationId && contract.receipts.map((receipt) => (
                <tr key={receipt.paymentId} className="muted-row">
                  <td data-label="Recebimento"><small>Recebimento de {dateBr(receipt.paidOn)}</small></td><td /><td data-label="Juros"><small>{formatMoney(receipt.interestCents)}</small></td><td><small>{percent(receipt.commissionBps)}</small></td>
                  <td data-label="Comissão"><small>{formatMoney(receipt.commissionDueCents)}</small></td><td data-label="Paga"><small>{formatMoney(receipt.paidCents)}{receipt.payoutIds.length > 0 && ` · fechamento ${receipt.payoutIds.map((id) => dateBr(paidOn.get(id) ?? "")).join(", ")}`}</small></td>
                  <td data-label="Pendente"><small>{formatMoney(receipt.pendingCents)}</small></td><td><CpgChip status={receipt.status} /></td>
                </tr>
              ))}
            </Fragment>
          ))}</tbody>
        </table>
      )}
      <CommissionHistory manager={manager} />
    </div>
  );
}

// Histórico do CPG: cada comissão paga por recebimento (com o fechamento) e cada estorno. Estornar exige motivo; o fechamento não muda e
// o valor estornado volta a ficar pendente.
function CommissionHistory({ manager }: { manager: Manager }) {
  const { actions } = useScope();
  const router = useRouter();
  const [reversing, setReversing] = useState<string | null>(null);
  const reverse = useFormAction(actions.reverseCommission, () => { setReversing(null); router.refresh(); }, false);
  if (manager.commissionHistory.length === 0) return <p><small>Nenhuma comissão paga registrada por recebimento ainda.</small></p>;
  return (
    <>
      <h3>Histórico de comissões pagas e estornos</h3>
      <table className="data-table fit-table cpg-history">
        <thead><tr><th>Fechamento</th><th>Cliente / contrato</th><th>Recebimento</th><th>Juros</th><th>Valor</th><th>Tipo</th><th /></tr></thead>
        <tbody>{manager.commissionHistory.map((row) => (
          <Fragment key={row.id}>
            <tr>
              <td data-label="Fechamento">{row.payoutPaidOn ? dateBr(row.payoutPaidOn) : "—"}</td><td data-label="Contrato">{row.clientName} · #{row.operationCode}</td><td data-label="Recebimento">{dateBr(row.receiptPaidOn)}</td>
              <td data-label="Juros">{formatMoney(row.interestCents)}</td><td data-label="Valor"><strong>{row.kind === "REVERSAL" ? "− " : ""}{formatMoney(row.commissionCents)}</strong></td>
              <td data-label="Tipo">{row.kind === "REVERSAL" ? <span className="status-chip status-late"><i />Estorno · {row.reason}</span> : <span className="status-chip status-paid"><i />{row.source === "HISTORICAL" ? "CPG (composição histórica)" : "CPG"}</span>}</td>
              <td>{row.kind === "PAID" && row.reversibleCents > 0 && <button type="button" className="outline-button" onClick={() => setReversing(reversing === row.id ? null : row.id)} aria-label={`Estornar comissão de ${row.clientName} do recebimento de ${dateBr(row.receiptPaidOn)}`}>{reversing === row.id ? "Cancelar" : "Estornar"}</button>}</td>
            </tr>
            {reversing === row.id && (
              <tr><td colSpan={7}>
                <form className="form-grid" onSubmit={reverse.onSubmit}>
                  <input type="hidden" name="commissionPaidId" value={row.id} /><TenantField />
                  <label className="field"><span>Valor do estorno (R$)</span><MoneyInput name="amount" defaultValue={(row.reversibleCents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })} required /></label>
                  <label className="field field-wide"><span>Motivo</span><input name="reason" required maxLength={300} placeholder="Ex.: gerente devolveu o valor" /></label>
                  <div className="form-actions"><button className="primary-button" disabled={reverse.pending}>{reverse.pending ? "Registrando…" : "Confirmar estorno"}</button></div>
                </form>
              </td></tr>
            )}
          </Fragment>
        ))}</tbody>
      </table>
      <Feedback feedback={reverse.feedback} />
    </>
  );
}

// Lançamentos do gerente: novo débito/crédito (fica pendente para o próximo fechamento) e o histórico com a situação de cada um.
function AdjustmentsPanel({ manager }: { manager: Manager }) {
  const { actions } = useScope();
  const router = useRouter();
  const create = useFormAction(actions.createAdjustment, () => router.refresh());
  const remove = useFormAction(actions.deleteAdjustment, () => router.refresh(), false);
  const paidOn = new Map(manager.payouts.map((payout) => [payout.id, payout.paidOn]));
  const pending = manager.adjustments.filter((item) => !item.payoutId);
  return (
    <div className="adjustments-panel">
      <h3>Lançamentos do fechamento</h3>
      <p><small>Débito abate e crédito soma ao valor pago no fechamento. Cada lançamento fica pendente e entra sozinho no próximo fechamento de comissão deste gerente (uma vez só).</small></p>
      <form className="form-grid" onSubmit={create.onSubmit}>
        <input type="hidden" name="managerId" value={manager.id} /><TenantField />
        <label className="field"><span>Tipo</span><select name="kind" defaultValue="DEBIT" required><option value="DEBIT">Débito (abate)</option><option value="CREDIT">Crédito (soma)</option></select></label>
        <label className="field"><span>Valor (R$)</span><MoneyInput name="amount" required placeholder="200,00" /></label>
        <label className="field"><span>Data</span><input name="entryDate" type="date" defaultValue={todayIso()} required /></label>
        <label className="field field-wide"><span>Descrição</span><input name="description" required maxLength={200} placeholder="Ex.: adiantamento, bônus" /></label>
        <div className="form-actions"><button className="primary-button" disabled={create.pending}><Icon name="check" size={15} /> {create.pending ? "Registrando…" : "Registrar lançamento"}</button></div>
        <Feedback feedback={create.feedback} />
      </form>
      {manager.adjustments.length === 0 ? <p>Nenhum lançamento registrado para este gerente.</p> : (
        <table className="data-table fit-table">
          <thead><tr><th>Data</th><th>Descrição</th><th>Tipo</th><th>Valor</th><th>Situação</th><th /></tr></thead>
          <tbody>{manager.adjustments.map((item: Adjustment) => (
            <tr key={item.id}>
              <td data-label="Data">{dateBr(item.entryDate)}</td><td data-label="Descrição">{item.description}</td><td data-label="Tipo"><KindChip kind={item.kind} /></td>
              <td data-label="Valor"><strong>{signed(item.kind, item.amountCents)}</strong></td>
              <td data-label="Situação">{item.payoutId
                ? <span className="status-chip status-active"><i />Aplicado no fechamento de {dateBr(paidOn.get(item.payoutId) ?? "")}</span>
                : <span className="status-chip status-due"><i />Pendente · próximo fechamento</span>}</td>
              <td>{!item.payoutId && (
                <form onSubmit={remove.onSubmit} className="inline-form">
                  <input type="hidden" name="adjustmentId" value={item.id} /><TenantField />
                  <button className="outline-button" disabled={remove.pending} aria-label={`Excluir lançamento ${item.description}`}>Excluir</button>
                </form>
              )}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {pending.length > 0 && <p><small>Pendentes: {pending.length} · débitos {formatMoney(manager.pending.debitCents)} · créditos {formatMoney(manager.pending.creditCents)}.</small></p>}
      <Feedback feedback={remove.feedback} />
    </div>
  );
}

type ExtraRow = { key: number; kind: "DEBIT" | "CREDIT"; description: string; amount: string };

function TemporaryPassword({ result, onClose }: { result: Extract<AccessResult, { ok: true }>; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="capital-note" role="status">
      <strong>Passe estes dados ao gerente agora. A senha provisória não será mostrada de novo.</strong>
      <p>E-mail: <b>{result.email}</b><br />Senha provisória: <b style={{ fontFamily: "monospace" }}>{result.temporaryPassword}</b></p>
      <div className="form-actions">
        <button type="button" className="outline-button" onClick={() => { void navigator.clipboard?.writeText(`E-mail: ${result.email}\nSenha provisória: ${result.temporaryPassword}`).then(() => setCopied(true)); }}>{copied ? "Copiado" : "Copiar"}</button>
        <button type="button" className="outline-button" onClick={onClose}>Já anotei</button>
      </div>
    </div>
  );
}

function AccessBox({ manager }: { manager: Manager }) {
  const { actions, canManageAccess } = useScope();
  const router = useRouter();
  const [result, setResult] = useState<Extract<AccessResult, { ok: true }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const run = (action: (data: FormData) => Promise<AccessResult>) => (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const data = new FormData(event.currentTarget);
    setPending(true); setError(null);
    void action(data).then((response) => { if (response.ok) { setResult(response); router.refresh(); } else setError(response.error); }).catch(() => setError("Não foi possível concluir. Tente novamente.")).finally(() => setPending(false));
  };
  if (!canManageAccess) return (
    <div className="manager-access">
      <span className="muted">{manager.hasLogin ? `Acesso de leitura: ${manager.email} · ${manager.loginActive ? (manager.mustChangePassword ? "aguardando 1º acesso" : "ativo") : "bloqueado"} · ` : "Sem acesso de leitura · "}administrado pelo MASTER</span>
    </div>
  );
  return (
    <div className="manager-access">
      {result && <TemporaryPassword result={result} onClose={() => setResult(null)} />}
      {!result && (manager.hasLogin ? (
        <form onSubmit={run(actions.resetPassword)} className="form-actions">
          <input type="hidden" name="managerId" value={manager.id} /><TenantField />
          <span className="muted">Acesso de leitura: {manager.email} · {manager.loginActive ? (manager.mustChangePassword ? "aguardando 1º acesso" : "ativo") : "bloqueado"}</span>
          <button className="outline-button" disabled={pending}>{pending ? "Gerando…" : "Nova senha"}</button>
        </form>
      ) : manager.active ? (
        <form onSubmit={run(actions.createAccess)} className="form-grid">
          <input type="hidden" name="managerId" value={manager.id} /><TenantField />
          <label className="field"><span>E-mail de acesso do gerente</span><input name="email" type="email" defaultValue={manager.email ?? ""} required maxLength={160} placeholder="gerente@email.com" /></label>
          <div className="form-actions"><button className="primary-button" disabled={pending}>{pending ? "Criando…" : "Criar acesso de leitura"}</button></div>
        </form>
      ) : null)}
      {error && <p className="form-feedback form-feedback-error" role="alert">{error}</p>}
    </div>
  );
}

function ManagerEdit({ manager, onDone }: { manager: Manager; onDone: () => void }) {
  const { actions, canManageAccess } = useScope();
  // Com login criado, ativar/desativar liga/desliga o acesso: só o MASTER vê a escolha; para os demais a situação vai como está.
  const lockedSituation = manager.hasLogin && !canManageAccess;
  const router = useRouter();
  const form = useFormAction(actions.updateManager, () => { router.refresh(); onDone(); }, false);
  return (
    <form className="form-grid" onSubmit={form.onSubmit}>
      <input type="hidden" name="managerId" value={manager.id} /><TenantField />
      <label className="field"><span>Nome</span><input name="name" defaultValue={manager.name} required maxLength={120} /></label>
      <label className="field"><span>Comissão sugerida (%) — opcional</span><input name="commission" defaultValue={manager.commissionBps > 0 ? percentInput(manager.commissionBps) : ""} inputMode="decimal" placeholder="Em branco: você define por cliente" /></label>
      <label className="field"><span>Caixa disponibilizado (R$)</span><MoneyInput name="cashLimit" defaultValue={manager.cash.limitCents > 0 ? (manager.cash.limitCents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 }) : ""} placeholder="20.000,00" /></label>
      {lockedSituation ? <input type="hidden" name="active" value={manager.active ? "1" : "0"} /> : <label className="field"><span>Situação</span><select name="active" defaultValue={manager.active ? "1" : "0"}><option value="1">Ativo</option><option value="0">Inativo (bloqueia o acesso)</option></select></label>}
      <div className="form-actions"><button type="button" className="outline-button" onClick={onDone}>Cancelar</button><button className="primary-button" disabled={form.pending}>{form.pending ? "Salvando…" : "Salvar"}</button></div>
      <Feedback feedback={form.feedback} />
    </form>
  );
}

// Antes de pagar: lista SÓ os contratos com comissão gerada (juros já recebidos × percentual > 0) e os pagamentos já feitos. A caixa de
// cada cliente tira ele do cálculo (sugestão = comissão dos clientes marcados − o que já foi pago, nunca acima do saldo). O valor continua
// editável, o servidor confere de novo o saldo e nada é gravado até confirmar.
function PayoutForm({ manager }: { manager: Manager }) {
  const { actions } = useScope();
  const router = useRouter();
  const [typed, setTyped] = useState<{ base: number; value: string } | null>(null);
  const [extras, setExtras] = useState<ExtraRow[]>([]);
  const form = useFormAction(actions.registerPayout, () => { setExtras([]); setTyped(null); router.refresh(); });
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const toggle = (operationId: string) => setExcluded((current) => { const next = new Set(current); if (next.has(operationId)) next.delete(operationId); else next.add(operationId); return next; });
  // Só contratos com comissão PENDENTE (recebimentos de juros ainda não pagos); o que já é CPG não aparece para pagar de novo.
  const payable = manager.contracts.filter((contract) => contract.pendingCents > 0);
  const included = payable.filter((contract) => !excluded.has(contract.operationId));
  const selectedCents = included.reduce((total, contract) => total + contract.pendingCents, 0);
  const balanceCents = manager.summary.balanceCents;
  const suggestedCents = Math.min(balanceCents, selectedCents);
  const blocked = payable.length === 0 ? (manager.contracts.length === 0 ? "Nenhum contrato deste gerente tem comissão gerada ainda (sem juros recebidos). Não há o que pagar." : "Toda a comissão gerada deste gerente já foi paga (CPG). Não há o que pagar agora.")
    : balanceCents <= 0 ? "Toda a comissão gerada deste gerente já foi paga. Não há o que pagar agora." : null;
  // Valor da comissão digitado (acompanha a sugestão até a pessoa mudar) e lançamentos só deste fechamento, para mostrar o valor final.
  const suggestedInput = suggestedCents > 0 ? (suggestedCents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 }) : "";
  const amountValue = typed && typed.base === suggestedCents ? typed.value : suggestedInput;
  const setExtra = (key: number, patch: Partial<ExtraRow>) => setExtras((rows) => rows.map((row) => row.key === key ? { ...row, ...patch } : row));
  const pending = manager.adjustments.filter((item) => !item.payoutId);
  const commissionCents = parseMoneyToCents(amountValue) ?? 0;
  const lines = [...pending.map((item) => ({ kind: item.kind, amountCents: item.amountCents })), ...extras.map((row) => ({ kind: row.kind, amountCents: parseMoneyToCents(row.amount) ?? 0 }))];
  const debitCents = lines.filter((line) => line.kind === "DEBIT").reduce((total, line) => total + line.amountCents, 0);
  const creditCents = lines.filter((line) => line.kind === "CREDIT").reduce((total, line) => total + line.amountCents, 0);
  const finalCents = commissionCents - debitCents + creditCents;
  return (
    <form className="form-grid" onSubmit={form.onSubmit}>
      <input type="hidden" name="managerId" value={manager.id} /><TenantField />
      <input type="hidden" name="pendingIds" value={pending.map((item) => item.id).join(",")} />
      <input type="hidden" name="includedOperationIds" value={included.map((contract) => contract.operationId).join(",")} />
      <div className="field-wide payout-review">
        <h3>Conferir antes de pagar</h3>
        {payable.length === 0 ? <p>{manager.clients.length === 0 ? "Nenhum cliente indicado ainda." : "Nenhum contrato com comissão pendente."}</p> : (
          <table className="data-table fit-table">
            <thead><tr><th>Incluir</th><th>Cliente / contrato</th><th>Valor emprestado</th><th>Juros recebidos</th><th>% comissão</th><th>Comissão gerada</th><th>Já paga (CPG)</th><th>Pendente</th></tr></thead>
            <tbody>{payable.map((contract) => (
              <tr key={contract.operationId} className={excluded.has(contract.operationId) ? "muted-row" : undefined}>
                <td><input type="checkbox" aria-label={`Incluir ${contract.clientName} #${contract.operationCode} no pagamento`} checked={!excluded.has(contract.operationId)} onChange={() => toggle(contract.operationId)} /></td>
                <td><strong>{contract.clientName}</strong> <small>#{contract.operationCode} · {dateBr(contract.loanDate)}</small></td>
                <td>{formatMoney(contract.principalCents)}</td><td>{formatMoney(contract.interestCents)}</td><td>{percent(contract.commissionBps)}</td>
                <td>{formatMoney(contract.commissionDueCents)}</td><td>{formatMoney(contract.paidCents)}</td><td><strong>{formatMoney(contract.pendingCents)}</strong></td>
              </tr>
            ))}</tbody>
          </table>
        )}
        <h3>Relatório dos fechamentos</h3>
        <PayoutReport payouts={manager.payouts} />
        {blocked ? <p className="form-feedback form-feedback-error" role="status">{blocked}</p> : (
          <p><small>Marcados: {included.length} de {payable.length} contratos · comissão pendente deles <strong>{formatMoney(suggestedCents)}</strong> (saldo total a pagar {formatMoney(balanceCents)}). Só os contratos marcados entram neste fechamento e ficam como CPG. Valor menor que o pendente = pagamento parcial (entram primeiro os recebimentos mais antigos). Nada é gravado até você confirmar.</small></p>
        )}
      </div>
      <label className="field"><span>Comissão deste fechamento (R$)</span><MoneyInput name="amount" value={amountValue} onChange={(event) => setTyped({ base: suggestedCents, value: event.currentTarget.value })} placeholder={(balanceCents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })} required disabled={Boolean(blocked)} /></label>
      <label className="field"><span>Data</span><input name="paidOn" type="date" defaultValue={todayIso()} max={todayIso()} required disabled={Boolean(blocked)} /></label>
      <label className="field field-wide"><span>Observação</span><input name="notes" maxLength={300} placeholder="Opcional" disabled={Boolean(blocked)} /></label>
      <div className="field-wide payout-review closing-adjustments">
        <h3>Lançamentos deste fechamento</h3>
        {pending.length === 0 ? <p><small>Nenhum lançamento pendente para este gerente.</small></p> : (
          <>
            <p><small>Todos os pendentes entram automaticamente neste fechamento:</small></p>
            <ul className="adjustment-lines">{pending.map((item) => <li key={item.id}><KindChip kind={item.kind} /> {dateBr(item.entryDate)} · {item.description} <strong>{signed(item.kind, item.amountCents)}</strong></li>)}</ul>
          </>
        )}
        {extras.map((row, index) => (
          <div key={row.key} className="closing-extra-row">
            <label className="field"><span>Tipo</span><select name="extraKind" value={row.kind} onChange={(event) => setExtra(row.key, { kind: event.currentTarget.value === "CREDIT" ? "CREDIT" : "DEBIT" })} disabled={Boolean(blocked)}><option value="DEBIT">Débito (abate)</option><option value="CREDIT">Crédito (soma)</option></select></label>
            <label className="field"><span>Descrição</span><input name="extraDescription" value={row.description} onChange={(event) => setExtra(row.key, { description: event.currentTarget.value })} maxLength={200} placeholder="Ex.: bônus" required disabled={Boolean(blocked)} /></label>
            <label className="field"><span>Valor (R$)</span><MoneyInput name="extraAmount" value={row.amount} onChange={(event) => setExtra(row.key, { amount: event.currentTarget.value })} placeholder="100,00" required disabled={Boolean(blocked)} /></label>
            <button type="button" className="outline-button" onClick={() => setExtras((rows) => rows.filter((item) => item.key !== row.key))} aria-label={`Remover lançamento ${index + 1} deste fechamento`}>Remover</button>
          </div>
        ))}
        {!blocked && <button type="button" className="outline-button" onClick={() => setExtras((rows) => [...rows, { key: Date.now() + rows.length, kind: "DEBIT", description: "", amount: "" }])}>+ Lançamento só neste fechamento</button>}
        <dl className="detail-grid closing-totals">
          <div><dt>Comissão</dt><dd>{formatMoney(commissionCents)}</dd></div>
          <div><dt>Débitos</dt><dd>− {formatMoney(debitCents)}</dd></div>
          <div><dt>Créditos</dt><dd>+ {formatMoney(creditCents)}</dd></div>
          <div><dt>Valor final a pagar</dt><dd><strong>{formatMoney(finalCents)}</strong></dd></div>
        </dl>
        {finalCents < 0 && !blocked && <p className="form-feedback form-feedback-error" role="status">Os débitos passam da comissão mais os créditos: o valor final não pode ficar negativo.</p>}
      </div>
      <div className="form-actions"><button className="primary-button" disabled={form.pending || Boolean(blocked) || finalCents < 0}><Icon name="check" size={15} /> {form.pending ? "Registrando…" : "Registrar pagamento da comissão"}</button></div>
      <Feedback feedback={form.feedback} />
    </form>
  );
}

function LinkForm({ manager, unassigned }: { manager: Manager; unassigned: ManagersPage["unassigned"] }) {
  const { actions } = useScope();
  const router = useRouter();
  const form = useFormAction(actions.linkClient, () => router.refresh());
  if (!manager.active) return null;
  return (
    <form className="form-grid" onSubmit={form.onSubmit}>
      <input type="hidden" name="managerId" value={manager.id} /><TenantField />
      <label className="field"><span>Cliente indicado</span><select name="clientId" required defaultValue=""><option value="" disabled>Escolha um cliente sem gerente</option>{unassigned.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label>
      <label className="field"><span>Comissão deste cliente (%)</span><input name="commission" inputMode="decimal" required defaultValue={manager.commissionBps > 0 ? percentInput(manager.commissionBps) : ""} placeholder="Ex.: 10 ou 7,5" /></label>
      <div className="form-actions"><button className="primary-button" disabled={form.pending || unassigned.length === 0}>{form.pending ? "Vinculando…" : "Vincular cliente"}</button></div>
      <Feedback feedback={form.feedback} />
    </form>
  );
}

function ClientRow({ manager, client }: { manager: Manager; client: Manager["clients"][number] }) {
  const { actions } = useScope();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const rate = useFormAction(actions.linkClient, () => { setEditing(false); router.refresh(); }, false);
  const unlink = useFormAction(actions.unlinkClient, () => router.refresh());
  return (
    <tr>
      <td data-label="Cliente"><strong>{client.name}</strong></td>
      <td data-label="Situação">{SITUATION[client.situation]}</td>
      <td data-label="Comissão">
        {editing ? (
          <form className="inline-form" onSubmit={rate.onSubmit}>
            <input type="hidden" name="managerId" value={manager.id} /><input type="hidden" name="clientId" value={client.id} /><TenantField />
            <input name="commission" aria-label={`Comissão de ${client.name} (%)`} inputMode="decimal" required defaultValue={percentInput(client.commissionBps)} size={8} />
            <button className="outline-button" disabled={rate.pending}>Salvar</button><button type="button" className="outline-button" onClick={() => setEditing(false)}>Cancelar</button>
            <Feedback feedback={rate.feedback} />
          </form>
        ) : percent(client.commissionBps)}
      </td>
      <td data-label="Juros recebidos">{formatMoney(client.interestReceivedCents)}</td>
      <td data-label="Comissão gerada"><strong>{formatMoney(client.commissionCents)}</strong></td>
      <td data-label="Ações" className="actions-cell">
        <button type="button" className="outline-button" onClick={() => setEditing(!editing)}>Mudar %</button>
        <form onSubmit={unlink.onSubmit} style={{ display: "inline" }}><input type="hidden" name="clientId" value={client.id} /><TenantField /><button className="outline-button" disabled={unlink.pending}>Desvincular</button></form>
      </td>
    </tr>
  );
}

function DeleteManager({ manager }: { manager: Manager }) {
  const { actions, canManageAccess } = useScope();
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const form = useFormAction(actions.deleteManager, () => router.refresh(), false);
  // Excluir gerente com login revoga o acesso: só o MASTER.
  if (manager.hasLogin && !canManageAccess) return null;
  if (!confirming) return <button type="button" className="outline-button" onClick={() => setConfirming(true)}>Excluir</button>;
  return (
    <form onSubmit={form.onSubmit} className="capital-note" role="alert">
      <input type="hidden" name="managerId" value={manager.id} /><TenantField />
      <strong>Excluir {manager.name}?</strong>
      <p>{manager.clients.length > 0 ? `Os ${manager.clients.length} clientes indicados ficam sem gerente (os clientes e as operações não mudam). ` : ""}{manager.hasLogin ? "O acesso de leitura do gerente será apagado. " : ""}Não dá para desfazer. Com comissão já paga registrada, só é possível desativar.</p>
      <div className="form-actions">
        <button type="button" className="outline-button" onClick={() => setConfirming(false)}>Cancelar</button>
        <button className="primary-button" disabled={form.pending}>{form.pending ? "Excluindo…" : "Sim, excluir"}</button>
      </div>
      <Feedback feedback={form.feedback} />
    </form>
  );
}

function ManagerPanel({ manager, unassigned }: { manager: Manager; unassigned: ManagersPage["unassigned"] }) {
  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState(false);
  const [entries, setEntries] = useState(false);
  const [closings, setClosings] = useState(false);
  const [cpg, setCpg] = useState(false);
  const { summary } = manager;
  return (
    <section className="panel form-panel" aria-label={`Gerente ${manager.name}`}>
      <div className="panel-header">
        <div>
          <div className="panel-title-row"><h2>{manager.name}</h2><span className={`status-chip ${manager.active ? "status-active" : "status-muted"}`}><i />{manager.active ? "Ativo" : "Inativo"}</span></div>
          <p>Comissão sobre os juros recebidos, definida por cliente · {manager.clients.length} {manager.clients.length === 1 ? "cliente indicado" : "clientes indicados"}</p>
        </div>
        <div className="heading-actions">
          <button type="button" className="outline-button" onClick={() => { setEditing(!editing); setPaying(false); setEntries(false); setClosings(false); setCpg(false); }}>{editing ? "Fechar" : "Editar"}</button>
          <button type="button" className="outline-button" onClick={() => { setEntries(!entries); setEditing(false); setPaying(false); setClosings(false); setCpg(false); }}>{entries ? "Fechar" : `Lançamentos${manager.pending.count > 0 ? ` (${manager.pending.count})` : ""}`}</button>
          <button type="button" className="outline-button" onClick={() => { setCpg(!cpg); setEditing(false); setPaying(false); setEntries(false); setClosings(false); }}>{cpg ? "Fechar" : "Comissões (CPG)"}</button>
          <button type="button" className="outline-button" onClick={() => { setClosings(!closings); setEditing(false); setPaying(false); setEntries(false); setCpg(false); }}>{closings ? "Fechar" : `Fechamentos (${manager.payouts.length})`}</button>
          <button type="button" className="outline-button" onClick={() => { setPaying(!paying); setEditing(false); setEntries(false); setClosings(false); setCpg(false); }}>{paying ? "Fechar" : "Pagar comissão"}</button>
          <DeleteManager manager={manager} />
        </div>
      </div>
      <dl className="detail-grid manager-summary">
        <div><dt>Caixa combinado</dt><dd>{formatMoney(manager.cash.limitCents)}</dd></div>
        <div><dt>Em uso (aberto + pedidos)</dt><dd>{formatMoney(manager.cash.inUseCents + manager.cash.reservedCents)}</dd></div>
        <div><dt>Caixa disponível</dt><dd><strong>{formatMoney(manager.cash.availableCents)}</strong></dd></div>
        <div><dt>Juros recebidos dos indicados</dt><dd>{formatMoney(summary.interestReceivedCents)}</dd></div>
        <div><dt>Comissão gerada</dt><dd>{formatMoney(summary.earnedCents)}</dd></div>
        <div><dt>Já paga</dt><dd>{formatMoney(summary.paidOutCents)}</dd></div>
        <div><dt>A pagar agora</dt><dd><strong>{formatMoney(summary.balanceCents)}</strong>{summary.advanceCents > 0 && <small> (adiantado {formatMoney(summary.advanceCents)})</small>}</dd></div>
        <div><dt>Prevista (juros a receber)</dt><dd>{formatMoney(summary.expectedCents)}</dd></div>
        <div><dt>Lançamentos pendentes</dt><dd>{manager.pending.count === 0 ? "Nenhum" : <>{manager.pending.netCents < 0 ? "−" : "+"} {formatMoney(Math.abs(manager.pending.netCents))} <small>({manager.pending.count})</small></>}</dd></div>
      </dl>
      {editing && <ManagerEdit manager={manager} onDone={() => setEditing(false)} />}
      {entries && <AdjustmentsPanel manager={manager} />}
      {closings && (
        <div className="payout-review closings-panel">
          <h3>Fechamentos de comissão</h3>
          <p><small>Cada fechamento mostra os contratos que o compuseram (cliente, contrato, valor emprestado, juros recebidos, percentual e comissão) e tem o seu relatório em PDF só com eles. Pode ser aberto e baixado de novo quando quiser.</small></p>
          <PayoutReport payouts={manager.payouts} manager={manager} />
        </div>
      )}
      {cpg && <CommissionControl manager={manager} />}
      {paying && <PayoutForm manager={manager} />}
      <AccessBox manager={manager} />
      {manager.clients.length === 0 ? <EmptyPanel icon="users" text="Nenhum cliente indicado por este gerente ainda." /> : (
        <table className="data-table">
          <thead><tr><th>Cliente</th><th>Situação</th><th>Comissão</th><th>Juros recebidos</th><th>Comissão gerada</th><th /></tr></thead>
          <tbody>{manager.clients.map((client) => <ClientRow key={client.id} manager={manager} client={client} />)}</tbody>
        </table>
      )}
      <LinkForm manager={manager} unassigned={unassigned} />
    </section>
  );
}

// Relatório consolidado por data: todos os fechamentos do dia num PDF só, agrupados por gerente (total de cada um e total geral).
function ConsolidatedReports({ managers }: { managers: Manager[] }) {
  const { tenantId } = useScope();
  const byDate = new Map<string, { count: number; finalCents: number }>();
  for (const payout of managers.flatMap((manager) => manager.payouts)) {
    const entry = byDate.get(payout.paidOn) ?? { count: 0, finalCents: 0 };
    byDate.set(payout.paidOn, { count: entry.count + 1, finalCents: entry.finalCents + payout.finalCents });
  }
  if (byDate.size === 0) return null;
  const href = (date: string, download: boolean) => {
    const query = new URLSearchParams();
    if (tenantId) query.set("tenantId", tenantId);
    if (download) query.set("baixar", "1");
    const search = query.toString();
    return `/gerentes/fechamentos/data/${date}${search ? `?${search}` : ""}`;
  };
  return (
    <section className="panel form-panel" aria-label="Relatórios de fechamento por data">
      <div className="panel-header"><div><h2>Relatórios de fechamento por data</h2><p>Todos os fechamentos de comissão do dia num PDF só, agrupados por gerente, com o total de cada um e o total geral. O relatório de cada fechamento fica em “Fechamentos” de cada gerente.</p></div></div>
      <table className="data-table fit-table payout-report">
        <thead><tr><th>Data</th><th>Fechamentos</th><th>Total pago</th><th>Relatório</th></tr></thead>
        <tbody>{[...byDate].sort(([a], [b]) => b.localeCompare(a)).map(([date, entry]) => (
          <tr key={date}>
            <td data-label="Data">{dateBr(date)}</td>
            <td data-label="Fechamentos">{entry.count}</td>
            <td data-label="Total pago"><strong>{formatMoney(entry.finalCents)}</strong></td>
            <td data-label="Relatório" className="payout-pdf-links">
              <a className="outline-button" href={href(date, false)} target="_blank" rel="noopener" aria-label={`Ver PDF consolidado de ${dateBr(date)}`}>Ver PDF</a>
              <a className="outline-button" href={href(date, true)} download aria-label={`Baixar PDF consolidado de ${dateBr(date)}`}>Baixar</a>
            </td>
          </tr>
        ))}</tbody>
      </table>
    </section>
  );
}

export function ManagersHome({ data, actions, tenantId, standalone = true, canManageAccess }: { data: ManagersPage; actions: ManagerActions; tenantId?: string; standalone?: boolean; canManageAccess: boolean }) {
  return <Scope.Provider value={{ actions, tenantId, canManageAccess }}><ManagersBody data={data} standalone={standalone} /></Scope.Provider>;
}

function ManagersBody({ data, standalone }: { data: ManagersPage; standalone: boolean }) {
  const { actions } = useScope();
  const router = useRouter();
  const create = useFormAction(actions.createManager, () => router.refresh());
  return (
    <div className={standalone ? "workspace-page" : "managers-embedded"}>
      {standalone && <PageHeading eyebrow="CREDIAI · INDICAÇÕES" title="Gerentes de contas" description="Quem indica clientes para você. Defina a comissão de cada cliente indicado na hora de vincular e acompanhe a comissão de cada um." />}
      <section className="panel form-panel" aria-label="Novo gerente de contas">
        <div className="panel-header"><div><h2>Novo gerente de contas</h2><p>A comissão é um percentual sobre os juros que o cliente indicado realmente pagar. O percentual é digitado por você, cliente a cliente, na hora de vincular.</p></div></div>
        <form className="form-grid" onSubmit={create.onSubmit}>
          <TenantField />
          <label className="field"><span>Nome</span><input name="name" required maxLength={120} placeholder="Ex.: Gabrielle" /></label>
          <label className="field"><span>E-mail (para o acesso)</span><input name="email" type="email" maxLength={160} placeholder="Opcional agora" /></label>
          <label className="field"><span>Caixa disponibilizado (R$)</span><MoneyInput name="cashLimit" placeholder="20.000,00" /></label>
                    <div className="form-actions"><button className="primary-button" disabled={create.pending}>{create.pending ? "Cadastrando…" : "Cadastrar gerente"}</button></div>
          <Feedback feedback={create.feedback} />
        </form>
      </section>
      {data.managers.length === 0 ? <EmptyPanel icon="users" text="Nenhum gerente de contas cadastrado ainda." /> : data.managers.map((manager) => <ManagerPanel key={manager.id} manager={manager} unassigned={data.unassigned} />)}
      <ConsolidatedReports managers={data.managers} />
    </div>
  );
}
