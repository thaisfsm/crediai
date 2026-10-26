export type EnginePolicy = { maxExposurePerCpfCents: number | null; maxTermMonths: number | null; maxContractCents: number | null; minRateBps: number | null };
export type EngineRule = { key: string; label: string; status: "PASS" | "FAIL" | "LATER"; detail: string };
export type EngineResult = { rules: EngineRule[]; passed: boolean };

const money = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

// Motor de crédito: confere a proposta contra os limites da Política de crédito. Limite vazio = sem limite (a regra passa).
// Exposição = principal das operações em aberto do mesmo CPF + o valor pedido. A taxa mínima só vale na oferta (fase 6), quando a taxa é definida.
export function evaluateProposal(proposal: { requestedCents: number; termMonths: number }, policy: EnginePolicy, openExposureCents: number): EngineResult {
  const limit = (value: number | null, passes: boolean, label: string, ok: string, bad: string): EngineRule =>
    value === null ? { key: label, label, status: "PASS", detail: "Sem limite definido." } : { key: label, label, status: passes ? "PASS" : "FAIL", detail: passes ? ok : bad };
  const totalExposure = openExposureCents + proposal.requestedCents;
  const rules: EngineRule[] = [
    limit(policy.maxContractCents, proposal.requestedCents <= (policy.maxContractCents ?? 0), "Limite por contrato",
      `${money(proposal.requestedCents)} dentro do limite de ${money(policy.maxContractCents ?? 0)}.`, `${money(proposal.requestedCents)} acima do limite de ${money(policy.maxContractCents ?? 0)}.`),
    limit(policy.maxTermMonths, proposal.termMonths <= (policy.maxTermMonths ?? 0), "Prazo máximo",
      `${proposal.termMonths} meses dentro do limite de ${policy.maxTermMonths} meses.`, `${proposal.termMonths} meses acima do limite de ${policy.maxTermMonths} meses.`),
    limit(policy.maxExposurePerCpfCents, totalExposure <= (policy.maxExposurePerCpfCents ?? 0), "Exposição máxima por CPF",
      `Em aberto ${money(openExposureCents)} + pedido ${money(proposal.requestedCents)} = ${money(totalExposure)}, dentro de ${money(policy.maxExposurePerCpfCents ?? 0)}.`,
      `Em aberto ${money(openExposureCents)} + pedido ${money(proposal.requestedCents)} = ${money(totalExposure)}, acima de ${money(policy.maxExposurePerCpfCents ?? 0)}.`),
    { key: "Taxa de juros mínima", label: "Taxa de juros mínima", status: "LATER", detail: policy.minRateBps === null ? "Sem taxa mínima definida." : `Conferida na oferta (fase 6): a taxa não pode ficar abaixo de ${(policy.minRateBps / 100).toLocaleString("pt-BR", { maximumFractionDigits: 3 })}% ao mês.` },
  ];
  return { rules, passed: rules.every((rule) => rule.status !== "FAIL") };
}
