"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { resetSaasClientPasswordAction, setSaasClientAccessAction, setSaasClientStatusAction } from "../../actions";
import TemporaryPassword from "../temporary-password";
import { planPriceLabel } from "@/lib/admin/plan-price";

// Ações sobre o cliente SaaS. Cada uma é conferida de novo no servidor (SUPER_ADMIN na sessão e no banco).
type Plan = { id: string; name: string; priceInCents: number };

export default function ClientActions({ tenantId, status, userActive, locked, plan }: { tenantId: string; status: string; userActive: boolean; locked: boolean; plan: Plan }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);

  if (locked) return <p className="central-hint">Este é o ambiente da administração da plataforma (SUPER_ADMIN). Ele não pode ser suspenso, bloqueado nem ter a senha redefinida por aqui.</p>;

  async function run(question: string, action: () => Promise<{ ok: boolean; message?: string; error?: string; email?: string; temporaryPassword?: string }>) {
    if (!window.confirm(question)) return;
    setBusy(true);
    setError("");
    setMessage("");
    setSecret(null);
    try {
      const result = await action();
      if (!result.ok) { setError(result.error ?? "Não foi possível concluir."); return; }
      setMessage(result.message ?? "");
      if (result.email && result.temporaryPassword) setSecret({ email: result.email, password: result.temporaryPassword });
      router.refresh();
    } catch {
      setError("Não foi possível concluir. Tente novamente.");
    } finally {
      setBusy(false);
    }
  }
  const form = (entries: Record<string, string>) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(entries)) data.set(key, value);
    return data;
  };

  // A confirmação mostra o plano e o valor lidos do banco; o servidor confere que continuam os mesmos antes de ativar.
  const priced = plan.priceInCents > 0;
  const activateQuestion = [
    "Ativar cliente SaaS?",
    "",
    `O cliente será ativado no plano ${plan.name}, no valor de ${planPriceLabel(plan.priceInCents)}.`,
    "A assinatura ficará ativa sem data de vencimento, conforme a regra atual de ativação.",
    "",
    "A carteira, os clientes, as operações e os pagamentos deste cliente SaaS não são alterados.",
  ].join("\n");

  return (
    <div className="central-actions">
      <div className="central-actions-row">
        {status === "ACTIVE"
          ? <button className="central-danger" disabled={busy} onClick={() => run("Suspender este cliente SaaS? O acesso dele será encerrado agora. Os dados da carteira não são alterados.", () => setSaasClientStatusAction(form({ tenantId, action: "suspend" })))}>Suspender</button>
          : <>
            <button className="central-primary" disabled={busy || !priced} title={priced ? undefined : "Configure o valor mensal do plano antes de ativar."} onClick={() => run(activateQuestion, () => setSaasClientStatusAction(form({ tenantId, action: "activate", planId: plan.id, priceInCents: String(plan.priceInCents) })))}>Ativar</button>
            {status !== "SUSPENDED" && <button className="central-danger" disabled={busy} onClick={() => run("Suspender este cliente SaaS? O acesso dele será encerrado agora.", () => setSaasClientStatusAction(form({ tenantId, action: "suspend" })))}>Suspender</button>}
          </>}
        {userActive
          ? <button className="central-ghost" disabled={busy} onClick={() => run("Bloquear o login deste usuário? As sessões abertas serão encerradas.", () => setSaasClientAccessAction(form({ tenantId, action: "block" })))}>Bloquear acesso</button>
          : <button className="central-ghost" disabled={busy} onClick={() => run("Liberar o login deste usuário?", () => setSaasClientAccessAction(form({ tenantId, action: "unblock" })))}>Liberar acesso</button>}
        <button className="central-ghost" disabled={busy} onClick={() => run("Gerar uma nova senha provisória? A senha atual deixa de funcionar e o cliente terá que trocá-la no próximo acesso.", () => resetSaasClientPasswordAction(form({ tenantId })))}>Resetar senha</button>
      </div>
      {status !== "ACTIVE" && !priced && <p className="central-hint">O plano {plan.name} ainda não tem valor mensal configurado. A ativação fica disponível depois que o valor for definido.</p>}
      {error && <div className="auth-error" role="alert">{error}</div>}
      {message && <div className="central-ok" role="status">{message}</div>}
      {secret && <TemporaryPassword email={secret.email} password={secret.password} />}
    </div>
  );
}
