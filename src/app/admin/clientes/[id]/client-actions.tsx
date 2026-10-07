"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { activateSubscriptionAction, registerSubscriptionPaymentAction, resetSaasClientPasswordAction, setSaasClientAccessAction, setSaasClientStatusAction, updateCommercialTermsAction } from "../../actions";
import TemporaryPassword from "../temporary-password";
import CommercialFields, { type PlanOption, type TermsInitial } from "../commercial-fields";
import { formatDate, formatMoney, parseMoneyToCents } from "@/lib/finance/format";
import { CONDITION_LABEL } from "@/lib/billing/rules";

type Subscription = { activatedAt: string | null; nextDueDate: string | null; contractedPriceCents: number | null; courtesy: boolean; terms: TermsInitial };
type Result = { ok: boolean; message?: string; error?: string; email?: string; temporaryPassword?: string };

// Ações sobre o cliente SaaS. Cada uma é conferida de novo no servidor (SUPER_ADMIN na sessão e no banco).
export default function ClientActions({ tenantId, status, userActive, locked, plans, subscription, today }: {
  tenantId: string; status: string; userActive: boolean; locked: boolean; plans: PlanOption[]; subscription: Subscription; today: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);
  const [panel, setPanel] = useState<"activate" | "terms" | "payment" | null>(null);

  if (locked) return <p className="central-hint">Este é o ambiente da administração da plataforma (SUPER_ADMIN), sem cobrança. Ele não pode ser ativado, suspenso, bloqueado nem ter a senha redefinida por aqui.</p>;

  async function execute(action: () => Promise<Result>) {
    setBusy(true);
    setError("");
    setMessage("");
    setSecret(null);
    try {
      const result = await action();
      if (!result.ok) { setError(result.error ?? "Não foi possível concluir."); return false; }
      setMessage(result.message ?? "");
      if (result.email && result.temporaryPassword) setSecret({ email: result.email, password: result.temporaryPassword });
      setPanel(null);
      router.refresh();
      return true;
    } catch {
      setError("Não foi possível concluir. Tente novamente.");
      return false;
    } finally {
      setBusy(false);
    }
  }
  const run = (question: string, action: () => Promise<Result>) => { if (window.confirm(question)) void execute(action); };
  const form = (entries: Record<string, string>) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(entries)) data.set(key, value);
    return data;
  };
  // Ativar, alterar a condição comercial e registrar mensalidade mudam o que o cliente paga: antes de enviar, o
  // SUPER_ADMIN confirma o resumo do que vai ser gravado (um clique sozinho não ativa nem altera nada).
  const summary = (data: FormData) => {
    const condition = String(data.get("condition") ?? "") as keyof typeof CONDITION_LABEL;
    const plan = plans.find((item) => item.id === data.get("planId"))?.name ?? "—";
    const cents = condition === "COURTESY" ? 0 : parseMoneyToCents(String(data.get("contractedPrice") ?? ""));
    const lines = [`Plano: ${plan}`, `Condição: ${CONDITION_LABEL[condition] ?? "—"}`, `Valor contratado: ${cents === null ? "—" : `${formatMoney(cents)}/mês`}`];
    if (data.get("activatedAt")) lines.push(`Data de ativação: ${formatDate(String(data.get("activatedAt")))}`);
    if (data.get("dueDate") && condition !== "COURTESY") lines.push(`Vencimento: ${formatDate(String(data.get("dueDate")))}`);
    if (data.get("graceDays")) lines.push(`Tolerância: ${data.get("graceDays")} dias`);
    return lines.join("\n");
  };
  const QUESTIONS: Record<"activate" | "terms" | "payment", (data: FormData) => string> = {
    activate: (data) => `Ativar a assinatura deste cliente SaaS?\n\n${summary(data)}\n\nO período de teste termina agora.`,
    terms: (data) => `Salvar a nova condição comercial deste cliente?\n\n${summary(data)}`,
    payment: (data) => `Registrar como paga a mensalidade de ${formatDate(String(data.get("dueDate")))} (${formatMoney(subscription.contractedPriceCents ?? 0)}), paga em ${formatDate(String(data.get("paidAt")))}?`,
  };
  const submitPanel = (kind: "activate" | "terms" | "payment", action: (data: FormData) => Promise<Result>) => (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    data.set("tenantId", tenantId);
    if (!window.confirm(QUESTIONS[kind](data))) return;
    void execute(() => action(data));
  };

  const activated = Boolean(subscription.activatedAt);
  const canActivate = status !== "ACTIVE" && !activated;
  const canReactivate = status !== "ACTIVE" && activated;
  const charges = status === "ACTIVE" && activated && !subscription.courtesy && subscription.nextDueDate;

  return (
    <div className="central-actions">
      <div className="central-actions-row">
        {canActivate && <button className="central-primary" disabled={busy} onClick={() => setPanel(panel === "activate" ? null : "activate")}>Ativar assinatura</button>}
        {canReactivate && <button className="central-primary" disabled={busy} onClick={() => run("Reativar este cliente SaaS? Ele volta a Ativo com a mesma condição comercial que já tinha.", () => setSaasClientStatusAction(form({ tenantId, action: "reactivate" })))}>Reativar</button>}
        {activated && <button className="central-secondary" disabled={busy} onClick={() => setPanel(panel === "terms" ? null : "terms")}>Alterar condição comercial</button>}
        {charges && <button className="central-secondary" disabled={busy} onClick={() => setPanel(panel === "payment" ? null : "payment")}>Registrar mensalidade paga</button>}
        {status !== "SUSPENDED" && <button className="central-danger" disabled={busy} onClick={() => run("Suspender este cliente SaaS? O acesso dele será encerrado agora. Os dados da carteira não são alterados.", () => setSaasClientStatusAction(form({ tenantId, action: "suspend" })))}>Suspender</button>}
        {userActive
          ? <button className="central-ghost" disabled={busy} onClick={() => run("Bloquear o login deste usuário? As sessões abertas serão encerradas.", () => setSaasClientAccessAction(form({ tenantId, action: "block" })))}>Bloquear acesso</button>
          : <button className="central-ghost" disabled={busy} onClick={() => run("Liberar o login deste usuário?", () => setSaasClientAccessAction(form({ tenantId, action: "unblock" })))}>Liberar acesso</button>}
        <button className="central-ghost" disabled={busy} onClick={() => run("Gerar uma nova senha provisória? A senha atual deixa de funcionar e o cliente terá que trocá-la no próximo acesso.", () => resetSaasClientPasswordAction(form({ tenantId })))}>Resetar senha</button>
      </div>

      {panel === "activate" && (
        <form className="central-form commercial-panel" onSubmit={submitPanel("activate", activateSubscriptionAction)} aria-label="Ativar assinatura">
          <h3>Ativar assinatura</h3>
          <CommercialFields plans={plans} initial={subscription.terms} mode="activate" today={today} />
          <p className="central-hint">O tenant e a assinatura passam a Ativo e o período de teste termina. A carteira, os clientes finais, as operações e os pagamentos deste cliente não são alterados.</p>
          <div className="central-form-actions">
            <button type="button" className="central-ghost" onClick={() => setPanel(null)} disabled={busy}>Cancelar</button>
            <button className="central-primary" disabled={busy}>{busy ? "Ativando…" : "Ativar assinatura"}</button>
          </div>
        </form>
      )}

      {panel === "terms" && (
        <form className="central-form commercial-panel" onSubmit={submitPanel("terms", updateCommercialTermsAction)} aria-label="Alterar condição comercial">
          <h3>Alterar condição comercial</h3>
          <CommercialFields plans={plans} initial={subscription.terms} mode="edit" today={today} />
          <p className="central-hint">Muda só este cliente. O preço padrão do plano e os outros clientes não são alterados.</p>
          <div className="central-form-actions">
            <button type="button" className="central-ghost" onClick={() => setPanel(null)} disabled={busy}>Cancelar</button>
            <button className="central-primary" disabled={busy}>{busy ? "Salvando…" : "Salvar condição comercial"}</button>
          </div>
        </form>
      )}

      {panel === "payment" && subscription.nextDueDate && (
        <form className="central-form commercial-panel" onSubmit={submitPanel("payment", registerSubscriptionPaymentAction)} aria-label="Registrar mensalidade paga">
          <h3>Registrar mensalidade paga</h3>
          <input type="hidden" name="dueDate" value={subscription.nextDueDate} />
          <p>Mensalidade com vencimento em <b>{formatDate(subscription.nextDueDate)}</b> · {formatMoney(subscription.contractedPriceCents ?? 0)}</p>
          <label>Data do pagamento<input name="paidAt" type="date" max={today} defaultValue={today} required /></label>
          <p className="central-hint">O próximo vencimento avança um mês, no mesmo dia do primeiro vencimento.</p>
          <div className="central-form-actions">
            <button type="button" className="central-ghost" onClick={() => setPanel(null)} disabled={busy}>Cancelar</button>
            <button className="central-primary" disabled={busy}>{busy ? "Registrando…" : "Registrar pagamento"}</button>
          </div>
        </form>
      )}

      {error && <div className="auth-error" role="alert">{error}</div>}
      {message && <div className="central-ok" role="status">{message}</div>}
      {secret && <TemporaryPassword email={secret.email} password={secret.password} />}
    </div>
  );
}
