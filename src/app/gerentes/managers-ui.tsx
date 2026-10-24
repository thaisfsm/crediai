"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { formatMoney, todayIso } from "@/lib/finance/format";
import type { ManagersPage } from "@/lib/managers/queries";
import { MoneyInput } from "../money-input";
import { EmptyPanel, Feedback, PageHeading, useFormAction } from "../portfolio-pages";
import { Icon } from "../ui-icon";
import { createManagerAccessAction, createManagerAction, linkClientAction, registerManagerPayoutAction, resetManagerPasswordAction, unlinkClientAction, updateManagerAction, type AccessResult } from "./actions";

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
        <form onSubmit={run(resetManagerPasswordAction)} className="form-actions">
          <input type="hidden" name="managerId" value={manager.id} />
          <span className="muted">Acesso de leitura: {manager.email} · {manager.loginActive ? (manager.mustChangePassword ? "aguardando 1º acesso" : "ativo") : "bloqueado"}</span>
          <button className="outline-button" disabled={pending}>{pending ? "Gerando…" : "Nova senha"}</button>
        </form>
      ) : manager.active ? (
        <form onSubmit={run(createManagerAccessAction)} className="form-grid">
          <input type="hidden" name="managerId" value={manager.id} />
          <label className="field"><span>E-mail de acesso do gerente</span><input name="email" type="email" defaultValue={manager.email ?? ""} required maxLength={160} placeholder="gerente@email.com" /></label>
          <div className="form-actions"><button className="primary-button" disabled={pending}>{pending ? "Criando…" : "Criar acesso de leitura"}</button></div>
        </form>
      ) : null)}
      {error && <p className="form-feedback form-feedback-error" role="alert">{error}</p>}
    </div>
  );
}

function ManagerEdit({ manager, onDone }: { manager: Manager; onDone: () => void }) {
  const router = useRouter();
  const form = useFormAction(updateManagerAction, () => { router.refresh(); onDone(); }, false);
  return (
    <form className="form-grid" onSubmit={form.onSubmit}>
      <input type="hidden" name="managerId" value={manager.id} />
      <label className="field"><span>Nome</span><input name="name" defaultValue={manager.name} required maxLength={120} /></label>
      <label className="field"><span>Comissão padrão (%)</span><input name="commission" defaultValue={percentInput(manager.commissionBps)} inputMode="decimal" required /></label>
      <label className="field"><span>Situação</span><select name="active" defaultValue={manager.active ? "1" : "0"}><option value="1">Ativo</option><option value="0">Inativo (bloqueia o acesso)</option></select></label>
      <div className="form-actions"><button type="button" className="outline-button" onClick={onDone}>Cancelar</button><button className="primary-button" disabled={form.pending}>{form.pending ? "Salvando…" : "Salvar"}</button></div>
      <Feedback feedback={form.feedback} />
    </form>
  );
}

function PayoutForm({ manager }: { manager: Manager }) {
  const router = useRouter();
  const form = useFormAction(registerManagerPayoutAction, () => router.refresh());
  return (
    <form className="form-grid" onSubmit={form.onSubmit}>
      <input type="hidden" name="managerId" value={manager.id} />
      <label className="field"><span>Valor pago (R$)</span><MoneyInput name="amount" placeholder={(manager.summary.balanceCents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })} required /></label>
      <label className="field"><span>Data</span><input name="paidOn" type="date" defaultValue={todayIso()} max={todayIso()} required /></label>
      <label className="field field-wide"><span>Observação</span><input name="notes" maxLength={300} placeholder="Opcional" /></label>
      <div className="form-actions"><button className="primary-button" disabled={form.pending}><Icon name="check" size={15} /> {form.pending ? "Registrando…" : "Registrar pagamento da comissão"}</button></div>
      <Feedback feedback={form.feedback} />
    </form>
  );
}

function LinkForm({ manager, unassigned }: { manager: Manager; unassigned: ManagersPage["unassigned"] }) {
  const router = useRouter();
  const form = useFormAction(linkClientAction, () => router.refresh());
  if (!manager.active) return null;
  return (
    <form className="form-grid" onSubmit={form.onSubmit}>
      <input type="hidden" name="managerId" value={manager.id} />
      <label className="field"><span>Cliente indicado</span><select name="clientId" required defaultValue=""><option value="" disabled>Escolha um cliente sem gerente</option>{unassigned.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label>
      <label className="field"><span>Comissão deste cliente (%)</span><input name="commission" inputMode="decimal" placeholder={`Vazio = padrão (${percent(manager.commissionBps)})`} /></label>
      <div className="form-actions"><button className="primary-button" disabled={form.pending || unassigned.length === 0}>{form.pending ? "Vinculando…" : "Vincular cliente"}</button></div>
      <Feedback feedback={form.feedback} />
    </form>
  );
}

function ClientRow({ manager, client }: { manager: Manager; client: Manager["clients"][number] }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const rate = useFormAction(linkClientAction, () => { setEditing(false); router.refresh(); }, false);
  const unlink = useFormAction(unlinkClientAction, () => router.refresh());
  return (
    <tr>
      <td data-label="Cliente"><strong>{client.name}</strong></td>
      <td data-label="Situação">{SITUATION[client.situation]}</td>
      <td data-label="Comissão">
        {editing ? (
          <form className="inline-form" onSubmit={rate.onSubmit}>
            <input type="hidden" name="managerId" value={manager.id} /><input type="hidden" name="clientId" value={client.id} />
            <input name="commission" aria-label={`Comissão de ${client.name} (%)`} inputMode="decimal" defaultValue={client.customBps === null ? "" : percentInput(client.customBps)} placeholder={`padrão ${percent(manager.commissionBps)}`} size={8} />
            <button className="outline-button" disabled={rate.pending}>Salvar</button><button type="button" className="outline-button" onClick={() => setEditing(false)}>Cancelar</button>
            <Feedback feedback={rate.feedback} />
          </form>
        ) : <>{percent(client.commissionBps)}{client.customBps === null && <small> (padrão)</small>}</>}
      </td>
      <td data-label="Juros recebidos">{formatMoney(client.interestReceivedCents)}</td>
      <td data-label="Comissão gerada"><strong>{formatMoney(client.commissionCents)}</strong></td>
      <td data-label="Ações" className="actions-cell">
        <button type="button" className="outline-button" onClick={() => setEditing(!editing)}>Mudar %</button>
        <form onSubmit={unlink.onSubmit} style={{ display: "inline" }}><input type="hidden" name="clientId" value={client.id} /><button className="outline-button" disabled={unlink.pending}>Desvincular</button></form>
      </td>
    </tr>
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
          <p>Comissão padrão {percent(manager.commissionBps)} sobre os juros recebidos · {manager.clients.length} {manager.clients.length === 1 ? "cliente indicado" : "clientes indicados"}</p>
        </div>
        <div className="heading-actions">
          <button type="button" className="outline-button" onClick={() => { setEditing(!editing); setPaying(false); }}>{editing ? "Fechar" : "Editar"}</button>
          <button type="button" className="outline-button" onClick={() => { setPaying(!paying); setEditing(false); }}>{paying ? "Fechar" : "Pagar comissão"}</button>
        </div>
      </div>
      <dl className="detail-grid manager-summary">
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

export function ManagersHome({ data }: { data: ManagersPage }) {
  const router = useRouter();
  const create = useFormAction(createManagerAction, () => router.refresh());
  return (
    <div className="workspace-page">
      <PageHeading eyebrow="CREDIAI · INDICAÇÕES" title="Gerentes de contas" description="Quem indica clientes para você. Defina a comissão de cada cliente indicado e dê a ele um acesso só de leitura." />
      <section className="panel form-panel" aria-label="Novo gerente de contas">
        <div className="panel-header"><div><h2>Novo gerente de contas</h2><p>A comissão é um percentual sobre os juros que o cliente indicado realmente pagar. Você pode definir um percentual diferente para cada cliente.</p></div></div>
        <form className="form-grid" onSubmit={create.onSubmit}>
          <label className="field"><span>Nome</span><input name="name" required maxLength={120} placeholder="Ex.: Gabrielle" /></label>
          <label className="field"><span>E-mail (para o acesso)</span><input name="email" type="email" maxLength={160} placeholder="Opcional agora" /></label>
          <label className="field"><span>Comissão padrão (%)</span><input name="commission" inputMode="decimal" required placeholder="Ex.: 10" /></label>
          <div className="form-actions"><button className="primary-button" disabled={create.pending}>{create.pending ? "Cadastrando…" : "Cadastrar gerente"}</button></div>
          <Feedback feedback={create.feedback} />
        </form>
      </section>
      {data.managers.length === 0 ? <EmptyPanel icon="users" text="Nenhum gerente de contas cadastrado ainda." /> : data.managers.map((manager) => <ManagerPanel key={manager.id} manager={manager} unassigned={data.unassigned} />)}
    </div>
  );
}
