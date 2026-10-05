"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createSaasClientAction, updateSaasClientAction } from "../actions";
import TemporaryPassword from "./temporary-password";

type Plan = { id: string; name: string; active: boolean };
type Initial = { tenantId: string; name: string; email: string; phone: string; planId: string; tenantName: string };

// Formulário do cliente SaaS. Não existe campo de papel: toda conta criada pela plataforma é TENANT_USER.
export default function SaasClientForm({ plans, initial }: { plans: Plan[]; initial?: Initial }) {
  const router = useRouter();
  const editing = Boolean(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState("ACTIVE");
  const [created, setCreated] = useState<{ email: string; temporaryPassword: string; tenantId: string } | null>(null);
  const activePlans = plans.filter((plan) => plan.active || plan.id === initial?.planId);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    const data = new FormData(event.currentTarget);
    try {
      if (editing) {
        const result = await updateSaasClientAction(data);
        if (result.ok) { setMessage(result.message); router.refresh(); } else setError(result.error);
      } else {
        const result = await createSaasClientAction(data);
        if (result.ok) setCreated(result); else setError(result.error);
      }
    } catch {
      setError("Não foi possível concluir. Tente novamente.");
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <div className="central-created">
        <h2>Cliente SaaS criado</h2>
        <p>O ambiente foi criado com tenant, assinatura, carteira e usuário TENANT_USER.</p>
        <TemporaryPassword email={created.email} password={created.temporaryPassword} />
        <div className="central-form-actions">
          <Link href={`/admin/clientes/${created.tenantId}`} className="central-primary">Ver cliente SaaS</Link>
          <Link href="/admin" className="central-ghost">Voltar à lista</Link>
        </div>
      </div>
    );
  }

  return (
    <form className="central-form" onSubmit={submit}>
      {initial && <input type="hidden" name="tenantId" value={initial.tenantId} />}
      <fieldset>
        <legend>Contato</legend>
        <label>Nome<input name="name" required minLength={2} maxLength={120} defaultValue={initial?.name} autoComplete="off" /></label>
        <label>E-mail de acesso<input name="email" type="email" required maxLength={254} defaultValue={initial?.email} autoComplete="off" /></label>
        <label>Telefone<input name="phone" inputMode="tel" maxLength={30} defaultValue={initial?.phone} placeholder="(11) 99999-9999" /></label>
      </fieldset>
      <fieldset>
        <legend>Ambiente</legend>
        <label>Nome do ambiente (tenant)<input name="tenantName" maxLength={120} defaultValue={initial?.tenantName} placeholder="Padrão: Nome · CrediAI" /></label>
        <label>Plano<select name="planId" required defaultValue={initial?.planId ?? activePlans[0]?.id}>{activePlans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}</select></label>
        {!editing && (
          <div className="central-form-row">
            <label>Status inicial<select name="status" value={status} onChange={(event) => setStatus(event.target.value)}><option value="ACTIVE">Ativo</option><option value="TRIALING">Em teste</option></select></label>
            {status === "TRIALING" && <label>Dias de teste<input name="trialDays" type="number" min={1} max={90} defaultValue={14} required /></label>}
          </div>
        )}
      </fieldset>
      {!editing && <p className="central-hint">Ao salvar, o CrediAI cria o tenant, a assinatura, a carteira (o cliente informa o capital inicial no primeiro acesso) e o usuário com perfil TENANT_USER e uma senha provisória.</p>}
      {error && <div className="auth-error" role="alert">{error}</div>}
      {message && <div className="central-ok" role="status">{message}</div>}
      <div className="central-form-actions">
        <button className="central-primary" disabled={busy}>{busy ? "Salvando…" : editing ? "Salvar alterações" : "Criar cliente SaaS"}</button>
        {!editing && <Link href="/admin" className="central-ghost">Cancelar</Link>}
      </div>
    </form>
  );
}
