"use client";

import { useRouter } from "next/navigation";
import { createContext, Fragment, useContext, useState, type FormEvent } from "react";
import { formatMoney, todayIso } from "@/lib/finance/format";
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
  createAccess: (data: FormData) => Promise<AccessResult>;
  resetPassword: (data: FormData) => Promise<AccessResult>;
};
const Scope = createContext<{ actions: ManagerActions; tenantId?: string } | null>(null);
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
  const { actions } = useScope();
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
  const { actions } = useScope();
  const router = useRouter();
  const form = useFormAction(actions.updateManager, () => { router.refresh(); onDone(); }, false);
  return (
    <form className="form-grid" onSubmit={form.onSubmit}>
      <input type="hidden" name="managerId" value={manager.id} /><TenantField />
      <label className="field"><span>Nome</span><input name="name" defaultValue={manager.name} required maxLength={120} /></label>
      <label className="field"><span>Comissão sugerida (%) — opcional</span><input name="commission" defaultValue={manager.commissionBps > 0 ? percentInput(manager.commissionBps) : ""} inputMode="decimal" placeholder="Em branco: você define por cliente" /></label>
      <label className="field"><span>Caixa disponibilizado (R$)</span><MoneyInput name="cashLimit" defaultValue={manager.cash.limitCents > 0 ? (manager.cash.limitCents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 }) : ""} placeholder="20.000,00" /></label>
      <label className="field"><span>Situação</span><select name="active" defaultValue={manager.active ? "1" : "0"}><option value="1">Ativo</option><option value="0">Inativo (bloqueia o acesso)</option></select></label>
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
  const form = useFormAction(actions.registerPayout, () => router.refresh());
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const toggle = (clientId: string) => setExcluded((current) => { const next = new Set(current); if (next.has(clientId)) next.delete(clientId); else next.add(clientId); return next; });
  const payable = manager.clients
    .map((client) => ({ ...client, contracts: client.contracts.filter((contract) => contract.commissionCents > 0) }))
    .filter((client) => client.commissionCents > 0 && client.contracts.length > 0);
  const hidden = manager.clients.length - payable.length;
  const included = payable.filter((client) => !excluded.has(client.id));
  const selectedCents = included.reduce((total, client) => total + client.commissionCents, 0);
  const balanceCents = manager.summary.balanceCents;
  const suggestedCents = Math.min(balanceCents, Math.max(0, selectedCents - manager.summary.paidOutCents));
  const blocked = payable.length === 0 ? "Nenhum contrato deste gerente tem comissão gerada ainda (sem juros recebidos). Não há o que pagar."
    : balanceCents <= 0 ? "Toda a comissão gerada deste gerente já foi paga. Não há o que pagar agora." : null;
  return (
    <form className="form-grid" onSubmit={form.onSubmit}>
      <input type="hidden" name="managerId" value={manager.id} /><TenantField />
      <div className="field-wide payout-review">
        <h3>Conferir antes de pagar</h3>
        {payable.length === 0 ? <p>{manager.clients.length === 0 ? "Nenhum cliente indicado ainda." : "Nenhum contrato com comissão gerada."}</p> : (
          <table className="data-table fit-table">
            <thead><tr><th>Incluir</th><th>Cliente / contrato</th><th>Situação</th><th>Comissão</th><th>Juros recebidos</th><th>Comissão gerada</th></tr></thead>
            <tbody>{payable.map((client) => (
              <Fragment key={client.id}>
                <tr>
                  <td><input type="checkbox" aria-label={`Incluir ${client.name} no pagamento`} checked={!excluded.has(client.id)} onChange={() => toggle(client.id)} /></td>
                  <td><strong>{client.name}</strong></td><td>{SITUATION[client.situation] ?? client.situation}</td><td>{percent(client.commissionBps)}</td><td>{formatMoney(client.interestReceivedCents)}</td><td><strong>{formatMoney(client.commissionCents)}</strong></td>
                </tr>
                {client.contracts.map((contract) => (
                  <tr key={contract.id} className={excluded.has(client.id) ? "muted-row" : undefined}>
                    <td /><td><small>#{contract.code} · {contract.loanDate.split("-").reverse().join("/")} · principal {formatMoney(contract.principalCents)}</small></td>
                    <td><small>{contract.status === "OPEN" ? "Em aberto" : "Quitado"}</small></td><td><small>{percent(contract.commissionBps)}</small></td><td><small>{formatMoney(contract.interestPaidCents)}</small></td><td><small>{formatMoney(contract.commissionCents)}</small></td>
                  </tr>
                ))}
              </Fragment>
            ))}</tbody>
          </table>
        )}
        {hidden > 0 && payable.length > 0 && <p><small>{hidden} {hidden === 1 ? "cliente sem comissão gerada não aparece" : "clientes sem comissão gerada não aparecem"} aqui (ainda sem juros recebidos).</small></p>}
        <h3>Comissões já pagas</h3>
        {manager.payouts.length === 0 ? <p>Nenhum pagamento de comissão registrado ainda.</p> : (
          <table className="data-table fit-table">
            <thead><tr><th>Data</th><th>Valor</th><th>Observação</th></tr></thead>
            <tbody>{manager.payouts.map((payout) => <tr key={payout.id}><td>{payout.paidOn.split("-").reverse().join("/")}</td><td>{formatMoney(payout.amountCents)}</td><td>{payout.notes ?? "—"}</td></tr>)}</tbody>
          </table>
        )}
        {blocked ? <p className="form-feedback form-feedback-error" role="status">{blocked}</p> : (
          <p><small>Marcados: {included.length} de {payable.length} · comissão gerada {formatMoney(selectedCents)} − já paga {formatMoney(manager.summary.paidOutCents)} = <strong>{formatMoney(suggestedCents)}</strong> a pagar (máximo {formatMoney(balanceCents)}). Desmarcar um cliente só tira ele da conta sugerida; nada é gravado até você confirmar.</small></p>
        )}
      </div>
      <label className="field"><span>Valor pago (R$)</span><MoneyInput key={suggestedCents} name="amount" defaultValue={suggestedCents > 0 ? (suggestedCents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 }) : ""} placeholder={(balanceCents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })} required disabled={Boolean(blocked)} /></label>
      <label className="field"><span>Data</span><input name="paidOn" type="date" defaultValue={todayIso()} max={todayIso()} required disabled={Boolean(blocked)} /></label>
      <label className="field field-wide"><span>Observação</span><input name="notes" maxLength={300} placeholder="Opcional" disabled={Boolean(blocked)} /></label>
      <div className="form-actions"><button className="primary-button" disabled={form.pending || Boolean(blocked)}><Icon name="check" size={15} /> {form.pending ? "Registrando…" : "Registrar pagamento da comissão"}</button></div>
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
  const { actions } = useScope();
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const form = useFormAction(actions.deleteManager, () => router.refresh(), false);
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
  const { summary } = manager;
  return (
    <section className="panel form-panel" aria-label={`Gerente ${manager.name}`}>
      <div className="panel-header">
        <div>
          <div className="panel-title-row"><h2>{manager.name}</h2><span className={`status-chip ${manager.active ? "status-active" : "status-muted"}`}><i />{manager.active ? "Ativo" : "Inativo"}</span></div>
          <p>Comissão sobre os juros recebidos, definida por cliente · {manager.clients.length} {manager.clients.length === 1 ? "cliente indicado" : "clientes indicados"}</p>
        </div>
        <div className="heading-actions">
          <button type="button" className="outline-button" onClick={() => { setEditing(!editing); setPaying(false); }}>{editing ? "Fechar" : "Editar"}</button>
          <button type="button" className="outline-button" onClick={() => { setPaying(!paying); setEditing(false); }}>{paying ? "Fechar" : "Pagar comissão"}</button>
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
      </dl>
      {editing && <ManagerEdit manager={manager} onDone={() => setEditing(false)} />}
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

export function ManagersHome({ data, actions, tenantId, standalone = true }: { data: ManagersPage; actions: ManagerActions; tenantId?: string; standalone?: boolean }) {
  return <Scope.Provider value={{ actions, tenantId }}><ManagersBody data={data} standalone={standalone} /></Scope.Provider>;
}

function ManagersBody({ data, standalone }: { data: ManagersPage; standalone: boolean }) {
  const { actions } = useScope();
  const router = useRouter();
  const create = useFormAction(actions.createManager, () => router.refresh());
  return (
    <div className={standalone ? "workspace-page" : "managers-embedded"}>
      {standalone && <PageHeading eyebrow="CREDIAI · INDICAÇÕES" title="Gerentes de contas" description="Quem indica clientes para você. Defina a comissão de cada cliente indicado na hora de vincular e dê a ele um acesso só de leitura." />}
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
    </div>
  );
}
