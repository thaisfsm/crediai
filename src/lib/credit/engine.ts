export type EnginePolicy = { maxExposurePerCpfCents: number | null; maxTermMonths: number | null; maxContractCents: number | null; minRateBps: number | null; maxNewClientCents?: number | null };
export type EngineRule = { key: string; label: string; status: "PASS" | "FAIL" | "LATER"; detail: string };
export type EngineResult = { rules: EngineRule[]; passed: boolean };

const money = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const percent = (bps: number) => `${(bps / 100).toLocaleString("pt-BR", { maximumFractionDigits: 3 })}%`;
function minRateRule(minRateBps: number | null, rateBps: number | null): EngineRule {
  const label = "Taxa de juros mínima";
  if (minRateBps === null) return { key: label, label, status: "PASS", detail: "Sem taxa mínima definida." };
  if (rateBps === null) return { key: label, label, status: "LATER", detail: `Conferida na oferta (fase 6): a taxa não pode ficar abaixo de ${percent(minRateBps)} ao mês.` };
  return rateBps >= minRateBps ? { key: label, label, status: "PASS", detail: `${percent(rateBps)} ao mês, acima do mínimo de ${percent(minRateBps)}.` } : { key: label, label, status: "FAIL", detail: `${percent(rateBps)} ao mês, abaixo do mínimo de ${percent(minRateBps)}.` };
}

// Resumo da oferta (juros simples ao mês sobre o valor aprovado): total e parcela mensal arredondada para cima.
export function offerSummary(offerCents: number, termMonths: number, rateBps: number) {
  const interestCents = Math.round(offerCents * (rateBps / 10000) * termMonths);
  const totalCents = offerCents + interestCents;
  return { interestCents, totalCents, installmentCents: Math.ceil(totalCents / termMonths) };
}

// Motor de crédito: confere a proposta contra os limites da Política de crédito. Limite vazio = sem limite (a regra passa).
// Exposição = principal das operações em aberto do mesmo CPF + o valor pedido. A taxa mínima só vale na oferta (fase 6), quando a taxa é definida.
export function evaluateProposal(proposal: { requestedCents: number; termMonths: number; rateBps?: number | null }, policy: EnginePolicy, openExposureCents: number, isNewClient = false): EngineResult {
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
    minRateRule(policy.minRateBps, proposal.rateBps ?? null),
  ];
  // Cliente novo (sem nenhuma operação anterior): o primeiro empréstimo respeita o limite próprio da política.
  if (isNewClient && policy.maxNewClientCents != null) {
    const passes = proposal.requestedCents <= policy.maxNewClientCents;
    rules.push({ key: "Limite para cliente novo", label: "Limite para cliente novo", status: passes ? "PASS" : "FAIL",
      detail: `${money(proposal.requestedCents)} ${passes ? "dentro" : "acima"} do limite de ${money(policy.maxNewClientCents)} para o primeiro empréstimo.` });
  }
  return { rules, passed: rules.every((rule) => rule.status !== "FAIL") };
}

// Taxa mensal equivalente (juros simples) de uma parcela negociada: (parcela × prazo − valor) ÷ valor ÷ prazo, em pontos-base com uma casa decimal.
export function impliedRateBps(requestedCents: number, installmentCents: number, termMonths: number) {
  return Math.round(((installmentCents * termMonths - requestedCents) / requestedCents / termMonths) * 100_000) / 10;
}
