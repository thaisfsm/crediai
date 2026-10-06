"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { centsToInput } from "@/lib/finance/format";
import { createPlanAction, updatePlanAction } from "./actions";

type Initial = { planId: string; name: string; description: string; priceInCents: number; active: boolean };

export default function PlanForm({ initial }: { initial?: Initial }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const data = new FormData(formElement);
    if (initial && data.get("price") !== centsToInput(initial.priceInCents)
      && !window.confirm("Alterar o preço padrão deste plano? Vale para novas ativações. Os clientes que já têm assinatura continuam pagando o valor contratado deles.")) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = initial ? await updatePlanAction(data) : await createPlanAction(data);
      if (!result.ok) { setError(result.error); return; }
      setMessage(result.message);
      if (!initial) formElement.reset();
      router.refresh();
    } catch {
      setError("Não foi possível concluir. Tente novamente.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="central-form" onSubmit={submit} aria-label={initial ? `Editar plano ${initial.name}` : "Novo plano"}>
      {initial && <input type="hidden" name="planId" value={initial.planId} />}
      <label>Nome<input name="name" required minLength={2} maxLength={60} defaultValue={initial?.name} /></label>
      <label>Descrição<textarea name="description" maxLength={300} defaultValue={initial?.description} /></label>
      <label>Preço padrão (R$/mês)<input name="price" inputMode="decimal" defaultValue={centsToInput(initial?.priceInCents ?? 0)} required /></label>
      <label className="central-check"><input name="active" type="checkbox" defaultChecked={initial?.active ?? true} /> Disponível para novos clientes</label>
      {error && <div className="auth-error" role="alert">{error}</div>}
      {message && <div className="central-ok" role="status">{message}</div>}
      <div className="central-form-actions"><button className="central-primary" disabled={busy}>{busy ? "Salvando…" : initial ? "Salvar plano" : "Criar plano"}</button></div>
    </form>
  );
}
