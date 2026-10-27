import { formatMoney, isIsoDate, parseLoanRateToBps, parseMoneyToCents } from "./format";
import { BIWEEKLY_RULE, calculateDaily, calculateFixedInterest, calculateInstallments, calculateOperation, dueDates, installmentDueDate, type Frequency, type InstallmentFrequency } from "./rules";

const text = (data: FormData, key: string, max: number) => String(data.get(key) ?? "").trim().slice(0, max);
const MAX_CENTS = 100_000_000_000; // R$ 1 bilhão: limite técnico contra valores digitados por engano.

// Modalidades (regras em src/lib/finance/rules.ts):
//  • Pagamento único mensal ou quinzenal: principal + taxa do período; pagando só os juros, o período é renovado.
//  • Pagamento único diário: principal + taxa do período, total dividido em N pagamentos diários.
//  • Parcelado: valor emprestado, parcela fixa, primeiro vencimento e prazo em meses (taxa simples calculada pelo sistema).
export function operationTermsFromForm(data: FormData) {
  const loanDate = text(data, "loanDate", 10);
  if (!isIsoDate(loanDate)) return { ok: false as const, error: "Informe a data do empréstimo." };
  if (text(data, "modality", 20) === "INSTALLMENT") {
    const principalCents = parseMoneyToCents(text(data, "loanAmount", 40));
    const installmentCents = parseMoneyToCents(text(data, "installment", 40));
    const termInput = text(data, "term", 10);
    const installmentCount = /^\d+$/.test(termInput) ? Number(termInput) : NaN;
    const firstDueDate = text(data, "firstDueDate", 10);
    // Periodicidade das parcelas: mensal (padrão, como as operações antigas) ou quinzenal.
    const installmentFrequency: InstallmentFrequency = text(data, "installmentFrequency", 20) === "BIWEEKLY" ? "BIWEEKLY" : "MONTHLY";
    if (principalCents === null || principalCents <= 0 || principalCents > MAX_CENTS) return { ok: false as const, error: "Informe o valor emprestado em reais, por exemplo 10.000,00." };
    if (installmentCents === null || installmentCents <= 0 || installmentCents > MAX_CENTS) return { ok: false as const, error: "Informe o valor de cada parcela em reais, por exemplo 1.200,00." };
    if (!Number.isInteger(installmentCount) || installmentCount < 1 || installmentCount > 360) return { ok: false as const, error: installmentFrequency === "BIWEEKLY" ? "Informe a quantidade de parcelas quinzenais, de 1 a 360." : "Informe o prazo total em meses, de 1 a 360." };
    if (!isIsoDate(firstDueDate)) return { ok: false as const, error: "Informe o primeiro vencimento." };
    if (firstDueDate < loanDate) return { ok: false as const, error: "O primeiro vencimento não pode ser antes da data do empréstimo." };
    const calculated = calculateInstallments({ principalCents, installmentCents, count: installmentCount, frequency: installmentFrequency });
    if (calculated.interestCents < 0) return { ok: false as const, error: `As ${installmentCount} parcelas somam ${formatMoney(calculated.totalCents)}, menos que o valor emprestado de ${formatMoney(principalCents)}.` };
    // Vencimentos combinados com o cliente: um por parcela, em ordem crescente, sem ser antes do empréstimo. Só ficam gravados
    // quando diferem da regra mensal/quinzenal; o primeiro vencimento passa a ser o da primeira parcela.
    const standardDates = dueDates(installmentFrequency, firstDueDate, installmentCount);
    let customDates: string[] | null = null;
    const customRaw = text(data, "customDueDates", 8000);
    if (customRaw !== "") {
      let parsed: unknown = null;
      try { parsed = JSON.parse(customRaw); } catch { parsed = null; }
      if (!Array.isArray(parsed) || parsed.length !== installmentCount || !parsed.every((item) => typeof item === "string" && isIsoDate(item))) return { ok: false as const, error: "Os vencimentos ajustados precisam ter uma data válida para cada parcela." };
      const dates = parsed as string[];
      if (dates[0] < loanDate) return { ok: false as const, error: "O primeiro vencimento não pode ser antes da data do empréstimo." };
      if (dates.some((date, index) => index > 0 && date <= dates[index - 1])) return { ok: false as const, error: "Cada vencimento precisa ser depois do anterior." };
      if (dates.some((date, index) => date !== standardDates[index])) customDates = dates;
    }
    const effectiveFirstDue = customDates ? customDates[0] : firstDueDate;
    return {
      ok: true as const, principalCents, loanDate, dueDate: customDates ? customDates[customDates.length - 1] : installmentDueDate(firstDueDate, installmentCount, installmentFrequency),
      values: { modality: "INSTALLMENT", frequency: installmentFrequency, installmentCount, installmentCents, firstDueDate: effectiveFirstDue, installmentDueDates: customDates, interestRateBps: calculated.interestRateBps, interestCents: calculated.interestCents, totalCents: calculated.totalCents, calculationRule: calculated.calculationRule },
    };
  }
  const frequencyInput = text(data, "frequency", 20);
  const frequency: Frequency = frequencyInput === "BIWEEKLY" || frequencyInput === "DAILY" ? frequencyInput : "MONTHLY";
  const principalCents = parseMoneyToCents(text(data, "principal", 40));
  if (principalCents === null || principalCents <= 0 || principalCents > MAX_CENTS) return { ok: false as const, error: "Informe o valor principal em reais, por exemplo 1.000,00." };
  // Quinzenal com valor fixo de juros por quinzena (ex.: R$ 1.200): o sistema calcula a taxa equivalente.
  const fixedInterest = frequency === "BIWEEKLY" && text(data, "interestMode", 10) === "FIXED";
  const fixedInterestCents = fixedInterest ? parseMoneyToCents(text(data, "interestAmount", 40)) : null;
  if (fixedInterest && (fixedInterestCents === null || fixedInterestCents <= 0 || fixedInterestCents > MAX_CENTS)) return { ok: false as const, error: "Informe os juros por quinzena em reais, por exemplo 1.200,00." };
  const interestRateBps = fixedInterest ? 0 : parseLoanRateToBps(text(data, "rate", 20));
  if (interestRateBps === null || interestRateBps > 100_000) return { ok: false as const, error: "Informe a taxa de juros em %, por exemplo 30." };
  if (frequency === "DAILY") {
    const daysInput = text(data, "days", 10);
    const days = /^\d+$/.test(daysInput) ? Number(daysInput) : NaN;
    const firstDueDate = text(data, "firstDueDate", 10);
    if (!Number.isInteger(days) || days < 1 || days > 365) return { ok: false as const, error: "Informe a quantidade de dias (pagamentos), de 1 a 365." };
    if (!isIsoDate(firstDueDate)) return { ok: false as const, error: "Informe o primeiro vencimento." };
    if (firstDueDate < loanDate) return { ok: false as const, error: "O primeiro vencimento não pode ser antes da data do empréstimo." };
    const plan = calculateDaily({ principalCents, interestRateBps, days, loanDate, firstDueDate });
    return {
      ok: true as const, principalCents, loanDate, dueDate: plan.lastDueDate,
      values: { modality: "SINGLE", frequency, interestRateBps, interestCents: plan.interestCents, totalCents: plan.totalCents, calculationRule: plan.calculationRule, installmentCount: plan.installmentCount, installmentCents: plan.installmentCents, firstDueDate: plan.firstDueDate },
    };
  }
  const dueDate = text(data, "dueDate", 10);
  if (!isIsoDate(dueDate)) return { ok: false as const, error: frequency === "BIWEEKLY" ? "Informe o primeiro vencimento." : "Informe a data de vencimento." };
  if (dueDate < loanDate) return { ok: false as const, error: "O vencimento não pode ser antes da data do empréstimo." };
  if (fixedInterestCents !== null) {
    return { ok: true as const, principalCents, loanDate, dueDate, values: { modality: "SINGLE", frequency, ...calculateFixedInterest({ principalCents, interestCents: fixedInterestCents }), firstDueDate: dueDate } };
  }
  const calculated = calculateOperation({ principalCents, interestRateBps });
  return {
    ok: true as const, principalCents, loanDate, dueDate,
    values: { modality: "SINGLE", frequency, interestRateBps, ...calculated, ...(frequency === "BIWEEKLY" ? { calculationRule: BIWEEKLY_RULE } : {}), firstDueDate: dueDate },
  };
}

