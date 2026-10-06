"use client";

import { useState } from "react";
import { centsToInput, formatMoney, parseMoneyToCents } from "@/lib/finance/format";
import { CONDITION_LABEL, DEFAULT_GRACE_DAYS, addMonthsAnchored, type CommercialCondition } from "@/lib/billing/rules";

export type PlanOption = { id: string; name: string; priceInCents: number; active: boolean };
export type TermsInitial = { planId: string; condition: CommercialCondition | null; contractedCents: number | null; dueDate: string | null; graceDays: number };

// Campos da condição comercial: plano (preço padrão) x valor contratado deste cliente. Usado em Ativar assinatura,
// Alterar condição comercial e no cadastro de cliente já ativo. Os nomes dos campos são lidos por readTerms no servidor.
export default function CommercialFields({ plans, initial, mode, today }: { plans: PlanOption[]; initial?: TermsInitial; mode: "activate" | "edit"; today: string }) {
  const options = plans.filter((plan) => plan.active || plan.id === initial?.planId);
  const [planId, setPlanId] = useState(initial?.planId && options.some((plan) => plan.id === initial.planId) ? initial.planId : options[0]?.id ?? "");
  const plan = options.find((item) => item.id === planId);
  const standard = plan?.priceInCents ?? 0;
  const startCondition: CommercialCondition = initial?.condition ?? (standard > 0 ? "STANDARD" : "CUSTOM");
  const [condition, setCondition] = useState<CommercialCondition>(startCondition);
  const [price, setPrice] = useState(centsToInput(initial?.contractedCents ?? standard));
  const [activatedAt, setActivatedAt] = useState(today);
  const [dueDate, setDueDate] = useState(initial?.dueDate ?? addMonthsAnchored(today, 1));

  function choosePlan(id: string) {
    setPlanId(id);
    const next = options.find((item) => item.id === id)?.priceInCents ?? 0;
    // Trocar de plano sugere o preço padrão do novo plano; condições personalizadas mantêm o valor digitado.
    if (condition === "STANDARD") { if (next > 0) setPrice(centsToInput(next)); else setCondition("CUSTOM"); }
  }
  function chooseCondition(value: CommercialCondition) {
    setCondition(value);
    if (value === "STANDARD") setPrice(centsToInput(standard));
    if (value === "COURTESY") setPrice(centsToInput(0));
  }
  const typed = parseMoneyToCents(price);
  const difference = typed !== null && condition === "CUSTOM" && standard > 0 ? typed - standard : 0;

  return (
    <div className="commercial-fields">
      <label>Plano<select name="planId" value={planId} onChange={(event) => choosePlan(event.target.value)} required>
        {options.map((item) => <option key={item.id} value={item.id}>{item.name}{item.active ? "" : " (inativo)"}</option>)}
      </select></label>
      <label>Preço padrão<input value={standard > 0 ? `${formatMoney(standard)}/mês` : "Não definido"} readOnly tabIndex={-1} /></label>
      <label>Condição<select name="condition" value={condition} onChange={(event) => chooseCondition(event.target.value as CommercialCondition)}>
        {(Object.keys(CONDITION_LABEL) as CommercialCondition[]).map((key) => <option key={key} value={key} disabled={key === "STANDARD" && standard <= 0}>{CONDITION_LABEL[key]}</option>)}
      </select></label>
      <label>Valor contratado (R$/mês)<input name="contractedPrice" inputMode="decimal" value={price} onChange={(event) => { setPrice(event.target.value); if (condition === "STANDARD") setCondition("CUSTOM"); }} readOnly={condition === "COURTESY"} required /></label>
      {mode === "activate" && <label>Data de ativação<input name="activatedAt" type="date" value={activatedAt} onChange={(event) => setActivatedAt(event.target.value)} required /></label>}
      {condition !== "COURTESY" && <label>{mode === "activate" ? "Primeiro vencimento" : "Próximo vencimento"}<input name="dueDate" type="date" value={dueDate} min={mode === "activate" ? activatedAt : undefined} onChange={(event) => setDueDate(event.target.value)} required /></label>}
      <label>Ciclo<input value="Mensal" readOnly tabIndex={-1} /></label>
      <label>Tolerância (dias)<input name="graceDays" type="number" min={0} max={60} defaultValue={initial?.graceDays ?? DEFAULT_GRACE_DAYS} required /></label>
      <p className="central-hint commercial-hint">
        {condition === "COURTESY" ? "Cortesia: o cliente usa os recursos do plano sem cobrança e sem vencimento."
          : difference < 0 ? `Desconto de ${formatMoney(-difference)} em relação ao preço padrão.`
          : difference > 0 ? `${formatMoney(difference)} acima do preço padrão.`
          : "O valor contratado fica guardado nesta assinatura: mudar o preço padrão do plano depois não altera este cliente."}
      </p>
    </div>
  );
}

