// Regras puras do módulo Investidores (sem banco): rótulos, validação dos formulários e o resumo do painel.
// Nenhuma regra financeira de investimento está definida: não há cálculo de rendimento, capitalização, saldo, total a
// devolver, resgate, multa ou renovação. O painel só soma e conta o que foi cadastrado.
import { normalizeEmail, normalizeSocial } from "../contacts";
import { addressFields, type Address } from "./address";
import { addressParts, type AddressPart } from "../finance/client-profile";
import type { BankValues } from "../bank-account";
import { addDays, centsToInput, cnpjProblem, cpfProblem, formatDate, formatMoney, isIsoDate, normalizeCpfCnpj, normalizePhone, parseMoneyToCents, parseRateToBps } from "../finance/format";

export const INVESTOR_STATUS = { ACTIVE: "Ativo", INACTIVE: "Inativo" } as const;
export type PersonType = keyof typeof PERSON_TYPES;
export const PERSON_TYPES = { PF: "Pessoa física", PJ: "Pessoa jurídica" } as const;
// Tipo de pessoa para exibir: o gravado ou, para investidor cadastrado antes da migração 0024 (sem tipo), o que o
// documento indica (11 dígitos = PF, 14 = PJ). Nada é gravado a partir dessa leitura.
export const personTypeOf = (row: { personType: string | null; document: string | null }): PersonType | null =>
  row.personType === "PF" || row.personType === "PJ" ? row.personType : row.document?.length === 11 ? "PF" : row.document?.length === 14 ? "PJ" : null;
export type InvestorStatus = keyof typeof INVESTOR_STATUS;

export const INVESTMENT_STATUS = { PENDING_SIGNATURE: "Aguardando assinatura", ACTIVE: "Ativo", CLOSED: "Encerrado", CANCELED: "Cancelado" } as const;
export type InvestmentStatus = keyof typeof INVESTMENT_STATUS;

// O período da taxa é sempre escolhido no contrato: o sistema não presume mensal, anual nem nenhum outro.
export const RATE_PERIODS = { MONTHLY: "ao mês", YEARLY: "ao ano", CONTRACT_TERM: "no prazo total do contrato", OTHER: "outro (descrito nas observações)" } as const;
export type RatePeriod = keyof typeof RATE_PERIODS;

export const DOCUMENT_KINDS = { SIGNED_CONTRACT: "Contrato assinado", ADDENDUM: "Aditivo", TRANSFER_RECEIPT: "Comprovante de transferência", OTHER: "Outro documento" } as const;
export type DocumentKind = keyof typeof DOCUMENT_KINDS;
// Documentos do próprio investidor (migração 0024), separados dos documentos de cada investimento.
export const INVESTOR_DOCUMENT_KINDS = { IDENTITY: "Documento de identificação", PROOF_OF_ADDRESS: "Comprovante de endereço", COMPANY_RECORDS: "Contrato social / documentos da empresa", BANK_PROOF: "Comprovante bancário", OTHER: "Outro documento" } as const;
export type InvestorDocumentKind = keyof typeof INVESTOR_DOCUMENT_KINDS;

// Periodicidade combinada dos pagamentos ao investidor (informativa; o cronograma usa as datas para sugerir a agenda).
export const PAYMENT_FREQUENCIES = {
  MONTHLY: "Mensal", QUARTERLY: "Trimestral", SEMIANNUAL: "Semestral", YEARLY: "Anual",
  AT_MATURITY: "Pagamento único no vencimento", OTHER: "Outra (datas informadas uma a uma)",
} as const;
export type PaymentFrequency = keyof typeof PAYMENT_FREQUENCIES;
// Meses entre uma data e a seguinte no cronograma sugerido (só para as periodicidades regulares).
export const FREQUENCY_MONTHS: Partial<Record<PaymentFrequency, number>> = { MONTHLY: 1, QUARTERLY: 3, SEMIANNUAL: 6, YEARLY: 12 };

// Liquidez: quando o investidor pode resgatar o crédito. Só nesta data combinada; a devolução antes dela é sempre
// facultativa de quem contratou (cláusula do contrato). D+N conta N dias corridos depois do término do contrato.
export const REDEMPTION_RULES = { AT_MATURITY: "Ao término do contrato", D_PLUS: "D+ (dias corridos depois do término)" } as const;
export type RedemptionRule = keyof typeof REDEMPTION_RULES;
export const parseRedemptionRule = (value: string) => (Object.keys(REDEMPTION_RULES) as RedemptionRule[]).find((key) => key === value) ?? null;
export const REDEMPTION_DAYS_MAX = 3650;
export const redemptionLabel = (rule: RedemptionRule | null, days: number | null) =>
  rule === "AT_MATURITY" ? "Ao término do contrato" : rule === "D_PLUS" && days ? `D+${days} (${days} ${days === 1 ? "dia corrido depois" : "dias corridos depois"} do término)` : null;
// Data em que o crédito pode ser resgatado: o vencimento do contrato, ou o vencimento mais N dias. Sem vencimento, null.
export function redemptionDate(maturityDate: string | null, rule: RedemptionRule | null, days: number | null) {
  if (!maturityDate || !isIsoDate(maturityDate) || !rule) return null;
  return rule === "D_PLUS" && days ? addDays(maturityDate, days) : maturityDate;
}
// Ajusta a sugestão do cronograma à liquidez: a devolução do principal vai para a data de resgate (sem mudar valores).
// Se a data de resgate é a da última linha, a linha continua combinada; se for depois, o principal vira uma linha própria.
export function applyRedemptionDate(lines: ScheduleLineInput[], date: string | null): ScheduleLineInput[] {
  if (!date || lines.length === 0) return lines;
  const index = lines.findLastIndex((line) => line.principalAmount.trim() !== "");
  if (index < 0) return lines;
  const line = lines[index];
  if (line.dueDate === date) return lines;
  const rest = lines.map((item, position) => (position === index ? { ...item, principalAmount: "", kind: item.yieldAmount.trim() ? "YIELD" : item.kind } : item)).filter((item, position) => position !== index || item.yieldAmount.trim() !== "");
  return [...rest, { kind: "PRINCIPAL", dueDate: date, yieldAmount: "", principalAmount: line.principalAmount, description: line.description }];
}

export const INVESTORS_PAGE_SIZE = 25;
const MAX_CENTS = 100_000_000_000; // R$ 1 bilhão: limite técnico contra valores digitados por engano.

const pick = <T extends string>(options: Record<T, string>, value: string) => (Object.keys(options) as T[]).find((key) => key === value) ?? null;
export const parseInvestorStatus = (value: string) => pick(INVESTOR_STATUS, value);
export const parseInvestmentStatus = (value: string) => pick(INVESTMENT_STATUS, value);
export const parseRatePeriod = (value: string) => pick(RATE_PERIODS, value);
export const parseDocumentKind = (value: string) => pick(DOCUMENT_KINDS, value);
export const parseInvestorDocumentKind = (value: string) => pick(INVESTOR_DOCUMENT_KINDS, value);
export const parsePaymentFrequency = (value: string) => pick(PAYMENT_FREQUENCIES, value);

type Failure = { ok: false; error: string };
type Read = (key: string, max: number) => string;
const optional = (value: string) => (value ? value : null);

// Endereço do investidor em colunas address_cep, address_street… (opcional no cadastro; exigido no contrato).
export type InvestorAddressKey = `address${AddressPart}`;
export const investorAddressKeys = addressParts.map((part) => `address${part}` as InvestorAddressKey);
export type InvestorAddress = Record<InvestorAddressKey, string | null>;

// Campos do cadastro do investidor (sem os dados bancários, que ficam em investor_bank_account desde a migração 0024).
export type InvestorValues = {
  personType: PersonType; name: string; tradeName: string | null; document: string; birthDate: string | null;
  phone: string | null; whatsapp: string | null; email: string | null;
  instagram: string | null; facebook: string | null; notes: string | null; status: InvestorStatus;
} & InvestorAddress;
// Colunas bancárias antigas do investidor (formato anterior à 0024): continuam gravadas e visíveis, nunca são apagadas.
export type LegacyInvestorBank = BankValues;

// Endereço como objeto { Cep, Street, … } a partir das colunas do investidor.
export const investorAddress = (row: InvestorAddress): Address => Object.fromEntries(addressParts.map((part) => [part, row[`address${part}`] ?? null])) as Address;

// Campos do investidor. Obrigatórios: tipo de pessoa, nome (ou razão social) e o CPF (PF) ou CNPJ (PJ) com os dígitos
// verificadores. O resto é opcional e tem o formato conferido. O endereço é exigido só para gerar o contrato.
export function investorFields(read: Read, today: string): { ok: true; values: InvestorValues } | Failure {
  const personType = pick(PERSON_TYPES, read("personType", 4));
  if (!personType) return { ok: false, error: "Escolha se o investidor é pessoa física ou pessoa jurídica." };
  const name = read("name", 160);
  if (!name) return { ok: false, error: personType === "PF" ? "Informe o nome completo do investidor." : "Informe a razão social do investidor." };
  const documentInput = read("document", 40);
  const problem = personType === "PF" ? cpfProblem(documentInput) : cnpjProblem(documentInput);
  if (problem) return { ok: false, error: problem };
  const document = normalizeCpfCnpj(documentInput);
  if (!document.ok) return document;
  if (!document.value) return { ok: false, error: personType === "PF" ? "Informe o CPF do investidor." : "Informe o CNPJ do investidor." };
  const tradeName = personType === "PJ" ? optional(read("tradeName", 160)) : null;
  const birthDate = read("birthDate", 10);
  const dateLabel = personType === "PF" ? "Data de nascimento" : "Data de abertura";
  if (birthDate && !isIsoDate(birthDate)) return { ok: false, error: `${dateLabel} inválida.` };
  if (birthDate && (birthDate > today || birthDate < "1900-01-01")) return { ok: false, error: `${dateLabel}: informe uma data entre 01/01/1900 e hoje.` };
  const phone = normalizePhone(read("phone", 40));
  if (!phone.ok) return { ok: false, error: `Telefone: ${phone.error}` };
  const whatsapp = normalizePhone(read("whatsapp", 40));
  if (!whatsapp.ok) return { ok: false, error: `WhatsApp: ${whatsapp.error}` };
  const email = normalizeEmail(read("email", 200));
  if (!email.ok) return email;
  const instagram = normalizeSocial(read("instagram", 250));
  if (!instagram.ok) return { ok: false, error: `Instagram: ${instagram.error}` };
  const facebook = normalizeSocial(read("facebook", 250));
  if (!facebook.ok) return { ok: false, error: `Facebook: ${facebook.error}` };
  const status = parseInvestorStatus(read("status", 20) || "ACTIVE");
  if (!status) return { ok: false, error: "Escolha o status do investidor." };
  const address = addressFields(read, "address");
  if (!address.ok) return { ok: false, error: `Endereço: ${address.error}` };
  return {
    ok: true,
    values: {
      personType, name, tradeName, document: document.value, birthDate: optional(birthDate),
      phone: phone.value, whatsapp: whatsapp.value, email: email.value, instagram: instagram.value, facebook: facebook.value, notes: optional(read("notes", 1000)), status,
      ...(Object.fromEntries(addressParts.map((part) => [`address${part}`, address.value[part]])) as InvestorAddress),
    },
  };
}

// Unidade do prazo (migração 0024). Contratos gravados antes têm só term_months (meses), mostrado como está.
export const TERM_UNITS = { DAYS: ["dia", "dias"], MONTHS: ["mês", "meses"], YEARS: ["ano", "anos"] } as const;
export type TermUnit = keyof typeof TERM_UNITS;
export const TERM_UNIT_LABELS: Record<TermUnit, string> = { DAYS: "Dias", MONTHS: "Meses", YEARS: "Anos" };
// Forma de pagamento ao investidor combinada no contrato (as mesmas opções da baixa em Contas a Pagar).
export const INVESTMENT_PAYMENT_METHODS = { PIX: "Pix", TRANSFER: "Transferência (TED/DOC)", CASH: "Dinheiro", OTHER: "Outra" } as const;
export type InvestmentPaymentMethod = keyof typeof INVESTMENT_PAYMENT_METHODS;
const TERM_MAX: Record<TermUnit, number> = { DAYS: 18250, MONTHS: 600, YEARS: 50 };

// Fórmulas do formulário do contrato (datas, prazo e parcelas): só sugestões, a pessoa pode digitar outro valor.
const isoOf = (year: number, month0: number, day: number) => new Date(Date.UTC(year, month0, day)).toISOString().slice(0, 10);
const daysIn = (year: number, month0: number) => new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
// Soma meses mantendo o dia; mês sem esse dia usa o último dia (31/01 + 1 mês = 28/02).
export function addMonthsIso(iso: string, months: number) {
  const [year, month, day] = iso.split("-").map(Number);
  const total = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(total / 12), targetMonth = total % 12;
  return isoOf(targetYear, targetMonth, Math.min(day, daysIn(targetYear, targetMonth)));
}
// A data de início é a do primeiro pagamento: o último cai (prazo − 1) meses depois (12 meses a partir de 06/08/2026 = 06/07/2027).
export function addTermIso(startIso: string, count: number, unit: TermUnit) {
  if (unit === "MONTHS") return addMonthsIso(startIso, count - 1);
  if (unit === "YEARS") return addMonthsIso(startIso, count * 12 - 1);
  const [year, month, day] = startIso.split("-").map(Number);
  return isoOf(year, month - 1, day + count);
}
// Prazo entre início (primeiro pagamento) e vencimento (último): em meses, contando o mês do início, quando o vencimento cai
// no mesmo dia (ou no último dia do mês); senão em dias.
export function termFromDates(startIso: string, endIso: string): { count: number; unit: TermUnit } | null {
  if (!isIsoDate(startIso) || !isIsoDate(endIso) || endIso < startIso) return null;
  const [sy, sm] = startIso.split("-").map(Number), [ey, em] = endIso.split("-").map(Number);
  const months = (ey - sy) * 12 + (em - sm);
  if (addMonthsIso(startIso, months) === endIso) return { count: months + 1, unit: "MONTHS" };
  return { count: Math.round((Date.parse(endIso) - Date.parse(startIso)) / 86_400_000), unit: "DAYS" };
}
// Parcelas = prazo em meses / meses entre pagamentos (só quando fecha certo); pagamento único = 1.
export function installmentsFor(count: number, unit: TermUnit, frequency: PaymentFrequency | "") {
  if (frequency === "AT_MATURITY") return 1;
  const step = frequency ? FREQUENCY_MONTHS[frequency] : undefined;
  const months = unit === "MONTHS" ? count : unit === "YEARS" ? count * 12 : null;
  return step && months !== null && months % step === 0 ? months / step : null;
}

export function termLabel(values: { termCount: number | null; termUnit: string | null; termMonths: number | null }) {
  const unit = values.termUnit as TermUnit | null;
  if (values.termCount && unit && TERM_UNITS[unit]) return `${values.termCount} ${TERM_UNITS[unit][values.termCount === 1 ? 0 : 1]}`;
  if (values.termMonths) return `${values.termMonths} ${values.termMonths === 1 ? "mês" : "meses"}`;
  return null;
}

export type InvestmentValues = {
  amountCents: number; agreedRateBps: number; ratePeriod: RatePeriod; startDate: string; maturityDate: string | null;
  dueDay: number | null; notes: string | null; status: InvestmentStatus;
  contractNumber: string | null; investedOn: string | null; termMonths: number | null; paymentFrequency: PaymentFrequency | null; installmentCount: number | null;
  contractedOn: string | null; termCount: number | null; termUnit: TermUnit | null; paymentMethod: InvestmentPaymentMethod | null; bankAccountId: string | null;
  yieldTerms: string | null; principalTerms: string | null;
  redemptionRule: RedemptionRule | null; redemptionDays: number | null; yieldPaymentCents: number | null;
};

// Número inteiro opcional entre min e max ("" = null; NaN = inválido).
const optionalInteger = (value: string, min: number, max: number) => (value ? (/^\d{1,5}$/.test(value) && Number(value) >= min && Number(value) <= max ? Number(value) : NaN) : null);
// Identificação do contrato: letras, números, espaço, ponto, barra, hífen e sublinhado (ex.: INV-2026/001).
const CONTRACT_NUMBER = /^[0-9A-Za-z][0-9A-Za-z ./_-]{0,39}$/;

// Campos do contrato de investimento: só o que foi combinado. Nada aqui calcula rendimento ou saldo.
export function investmentFields(read: Read): { ok: true; values: InvestmentValues } | Failure {
  const amountCents = parseMoneyToCents(read("amount", 40));
  if (amountCents === null || amountCents <= 0 || amountCents > MAX_CENTS) return { ok: false, error: "Informe o valor investido em reais, por exemplo 50.000,00." };
  const rateInput = read("rate", 20);
  const agreedRateBps = parseRateToBps(rateInput);
  if (!rateInput || agreedRateBps === null || agreedRateBps > 100_000) return { ok: false, error: "Informe a taxa combinada em %, por exemplo 2 ou 1,5." };
  const ratePeriod = parseRatePeriod(read("ratePeriod", 20));
  if (!ratePeriod) return { ok: false, error: "Escolha a que período a taxa se refere (ao mês, ao ano, no prazo do contrato ou outro)." };
  const startDate = read("startDate", 10);
  if (!isIsoDate(startDate)) return { ok: false, error: "Informe a data de início do investimento." };
  const maturityInput = read("maturityDate", 10);
  if (maturityInput && !isIsoDate(maturityInput)) return { ok: false, error: "Data de vencimento inválida." };
  if (maturityInput && maturityInput < startDate) return { ok: false, error: "O vencimento não pode ser antes da data de início." };
  const dueDayInput = read("dueDay", 4);
  const dueDay = dueDayInput ? (/^\d{1,2}$/.test(dueDayInput) ? Number(dueDayInput) : NaN) : null;
  if (dueDay !== null && (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31)) return { ok: false, error: "O dia de vencimento vai de 1 a 31." };
  const status = parseInvestmentStatus(read("status", 20) || "ACTIVE");
  if (!status) return { ok: false, error: "Escolha o status do investimento." };
  const contractNumber = read("contractNumber", 60).replace(/\s+/g, " ");
  if (contractNumber && !CONTRACT_NUMBER.test(contractNumber)) return { ok: false, error: "Identificação do contrato: até 40 letras, números, espaço, ponto, barra ou hífen, por exemplo INV-2026/001." };
  const contractedOn = read("contractedOn", 10);
  if (contractedOn && !isIsoDate(contractedOn)) return { ok: false, error: "Data da contratação inválida." };
  const investedOn = read("investedOn", 10);
  if (investedOn && !isIsoDate(investedOn)) return { ok: false, error: "Data do recebimento do dinheiro inválida." };
  // Prazo: quantidade e unidade juntas (dias, meses ou anos). Nada é convertido de uma unidade para outra.
  const termInput = read("termCount", 6);
  const termUnitInput = read("termUnit", 10);
  const termUnit = termInput ? pick(TERM_UNIT_LABELS, termUnitInput) : null;
  if (termInput && !termUnit) return { ok: false, error: "Escolha a unidade do prazo (dias, meses ou anos)." };
  const termCount = termUnit ? optionalInteger(termInput, 1, TERM_MAX[termUnit]) : null;
  if (termUnit && (termCount === null || Number.isNaN(termCount))) return { ok: false, error: `O prazo vai de 1 a ${TERM_MAX[termUnit]} ${TERM_UNITS[termUnit][1]}.` };
  const methodInput = read("paymentMethod", 20);
  const paymentMethod = methodInput ? pick(INVESTMENT_PAYMENT_METHODS, methodInput) : null;
  if (methodInput && !paymentMethod) return { ok: false, error: "Escolha a forma de pagamento na lista." };
  const frequencyInput = read("paymentFrequency", 20);
  const paymentFrequency = frequencyInput ? parsePaymentFrequency(frequencyInput) : null;
  if (frequencyInput && !paymentFrequency) return { ok: false, error: "Escolha a periodicidade dos pagamentos na lista." };
  const installmentCount = optionalInteger(read("installmentCount", 6), 1, 600);
  if (Number.isNaN(installmentCount)) return { ok: false, error: "A quantidade de parcelas vai de 1 a 600." };
  const redemptionInput = read("redemptionRule", 20);
  const redemptionRule = redemptionInput ? parseRedemptionRule(redemptionInput) : null;
  if (redemptionInput && !redemptionRule) return { ok: false, error: "Escolha a liquidez na lista (ao término do contrato ou D+ dias)." };
  const redemptionDays = redemptionRule === "D_PLUS" ? optionalInteger(read("redemptionDays", 6), 1, REDEMPTION_DAYS_MAX) : null;
  if (redemptionRule === "D_PLUS" && (redemptionDays === null || Number.isNaN(redemptionDays))) return { ok: false, error: `Informe quantos dias depois do término o crédito pode ser resgatado (1 a ${REDEMPTION_DAYS_MAX}).` };
  const yieldInput = read("yieldPayment", 40);
  const yieldPaymentCents = yieldInput ? parseMoneyToCents(yieldInput) : null;
  if (yieldInput && (yieldPaymentCents === null || yieldPaymentCents <= 0 || yieldPaymentCents > MAX_CENTS)) return { ok: false, error: "Informe o rendimento de cada pagamento em reais, por exemplo 500,00." };
  return {
    ok: true,
    values: {
      redemptionRule, redemptionDays: redemptionDays === null || Number.isNaN(redemptionDays) ? null : redemptionDays, yieldPaymentCents,
      amountCents, agreedRateBps, ratePeriod, startDate, maturityDate: optional(maturityInput), dueDay, notes: optional(read("notes", 1000)), status,
      contractNumber: optional(contractNumber), investedOn: optional(investedOn), termMonths: null, paymentFrequency, installmentCount,
      contractedOn: optional(contractedOn), termCount, termUnit, paymentMethod, bankAccountId: optional(read("bankAccountId", 80)),
      yieldTerms: optional(read("yieldTerms", 1000)), principalTerms: optional(read("principalTerms", 1000)),
    },
  };
}

// Totais por contrato, somados dos registros: rendimento informado no cronograma, rendimento pago e principal devolvido
// (baixas). Nenhum é calculado por taxa.
export type InvestmentSummaryRow = { status: InvestmentStatus; amountCents: number; maturityDate: string | null; scheduledYieldCents: number; paidYieldCents: number; paidPrincipalCents: number };

// Painel da lista: capital dos contratos ativos, quantidade, vencimentos de contrato e as somas dos registros
// (rendimentos informados nos cronogramas, rendimentos pagos e principal ainda não devolvido dos contratos em vigor).
export function summarizeInvestments(rows: InvestmentSummaryRow[], today: string, horizonDays = 30) {
  const active = rows.filter((row) => row.status === "ACTIVE");
  const upcoming = active.filter((row) => row.maturityDate !== null && row.maturityDate >= today).map((row) => row.maturityDate as string).sort();
  const limit = addDays(today, horizonDays);
  return {
    investedCents: active.reduce((total, row) => total + row.amountCents, 0),
    activeCount: active.length,
    pendingSignatureCount: rows.filter((row) => row.status === "PENDING_SIGNATURE").length,
    nextMaturityDate: upcoming[0] ?? null,
    maturingSoonCount: upcoming.filter((date) => date <= limit).length,
    overdueMaturityCount: active.filter((row) => row.maturityDate !== null && row.maturityDate < today).length,
    expectedYieldCents: rows.filter((row) => row.status !== "CANCELED").reduce((total, row) => total + row.scheduledYieldCents, 0),
    paidYieldCents: rows.reduce((total, row) => total + row.paidYieldCents, 0),
    principalToReturnCents: rows.filter((row) => row.status === "ACTIVE" || row.status === "PENDING_SIGNATURE").reduce((total, row) => total + Math.max(row.amountCents - row.paidPrincipalCents, 0), 0),
  };
}

export function rateLabel(agreedRateBps: number, ratePeriod: RatePeriod) {
  return `${(agreedRateBps / 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}% ${RATE_PERIODS[ratePeriod]}`;
}

// Filtros da lista (endereço /investidores?q=…&status=…&carteira=…&pagina=…).
export function investorFilters(search: { q?: string; status?: string; carteira?: string; pagina?: string }) {
  const page = Number(search.pagina);
  return {
    q: (search.q ?? "").trim().slice(0, 120),
    status: (parseInvestorStatus(search.status ?? "") ?? "") as InvestorStatus | "",
    carteira: (search.carteira ?? "").trim().slice(0, 80),
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}

// ── Cronograma de pagamentos ao investidor ──────────────────────────────────────────────────────────────────────────
// Agenda com as datas e os valores que o usuário DIGITA (rendimento e devolução de principal). O sistema não calcula
// rendimento: só sugere as datas pela periodicidade e repete os valores informados. Não mexe no capital.
export const MAX_SCHEDULE_ITEMS = 600;
export type ScheduleItemValues = { dueDate: string; yieldCents: number; principalCents: number; description: string | null };

// Datas sugeridas: a primeira informada (a combinada, livre: não precisa ser um período depois do início nem cair no
// dia do pagamento) e as seguintes de N em N meses no dia do pagamento combinado (dueDay; sem ele, o dia da primeira
// data). Mês sem esse dia (30/31 em fevereiro, 31 em abril…) usa o último dia do mês e volta ao dia combinado no mês
// seguinte. Pagamento único: uma data só.
export function scheduleDates(firstDueDate: string, count: number, frequency: PaymentFrequency, dueDay?: number | null) {
  if (frequency === "AT_MATURITY") return [firstDueDate];
  const step = FREQUENCY_MONTHS[frequency];
  if (!step) return [];
  const anchor = dueDay && Number.isInteger(dueDay) && dueDay >= 1 && dueDay <= 31 ? dueDay : Number(firstDueDate.slice(8, 10));
  const dates = [firstDueDate];
  let monthIndex = Number(firstDueDate.slice(0, 4)) * 12 + Number(firstDueDate.slice(5, 7)) - 1;
  while (dates.length < count) {
    monthIndex += step;
    const year = Math.floor(monthIndex / 12), month = (monthIndex % 12) + 1;
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    dates.push(`${year}-${String(month).padStart(2, "0")}-${String(Math.min(anchor, last)).padStart(2, "0")}`);
  }
  return dates;
}

// Primeira data no dia do pagamento combinado depois do início do contrato (ex.: início 10/10, dia 25 → 25/10; início
// 25/10, dia 25 → 25/11). É só um ponto de partida editável para a sugestão: a primeira data real é a negociada.
export function firstDueOnDay(startDate: string, dueDay: number) {
  if (!isIsoDate(startDate) || !Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) return null;
  const year = Number(startDate.slice(0, 4)), month = Number(startDate.slice(5, 7));
  const day = Math.min(dueDay, new Date(Date.UTC(year, month, 0)).getUTCDate());
  const sameMonth = `${startDate.slice(0, 8)}${String(day).padStart(2, "0")}`;
  return sameMonth > startDate ? sameMonth : scheduleDates(sameMonth, 2, "MONTHLY", dueDay)[1];
}

const amount = (value: string) => (value ? parseMoneyToCents(value) : 0);

// Tipo da obrigação de uma linha: só rendimento, só devolução de principal ou as duas (combinada). Na combinada os dois
// valores continuam separados (cada um tem a sua baixa e a sua saída de capital).
export const LINE_KINDS = { YIELD: "Rendimento", PRINCIPAL: "Devolução de principal", COMBINED: "Rendimento + principal" } as const;
export type LineKind = keyof typeof LINE_KINDS;
export const lineKind = (item: { yieldCents: number; principalCents: number }): LineKind => (item.yieldCents > 0 && item.principalCents > 0 ? "COMBINED" : item.yieldCents > 0 ? "YIELD" : "PRINCIPAL");

// Uma linha do cronograma (inclusão, edição ou linha de um lote revisado). O tipo escolhido precisa bater com os valores:
// rendimento só com rendimento, principal só com principal, combinada com os dois. O total, quando enviado, precisa ser
// a soma exata dos dois.
export function scheduleLineValues(input: { kind?: string; dueDate: string; yieldAmount: string; principalAmount: string; total?: string; description?: string }): { ok: true; values: ScheduleItemValues } | Failure {
  const dueDate = input.dueDate.trim();
  if (!isIsoDate(dueDate)) return { ok: false, error: "Informe a data do pagamento." };
  const yieldCents = amount(input.yieldAmount.trim());
  const principalCents = amount(input.principalAmount.trim());
  if (yieldCents === null || yieldCents < 0 || yieldCents > MAX_CENTS) return { ok: false, error: "Rendimento: informe o valor em reais, por exemplo 1.000,00 (ou deixe em branco)." };
  if (principalCents === null || principalCents < 0 || principalCents > MAX_CENTS) return { ok: false, error: "Devolução do principal: informe o valor em reais, por exemplo 50.000,00 (ou deixe em branco)." };
  if (yieldCents + principalCents <= 0) return { ok: false, error: "Informe o rendimento, a devolução do principal ou os dois." };
  const kind = input.kind ? pick(LINE_KINDS, input.kind) : null;
  if (input.kind && !kind) return { ok: false, error: "Escolha o tipo: rendimento, devolução de principal ou os dois." };
  if (kind === "YIELD" && (yieldCents <= 0 || principalCents > 0)) return { ok: false, error: "Linha de rendimento: informe só o valor do rendimento (principal em branco)." };
  if (kind === "PRINCIPAL" && (principalCents <= 0 || yieldCents > 0)) return { ok: false, error: "Linha de devolução de principal: informe só o valor do principal (rendimento em branco)." };
  if (kind === "COMBINED" && (yieldCents <= 0 || principalCents <= 0)) return { ok: false, error: "Linha combinada: informe o rendimento e o principal, separados." };
  if (input.total?.trim()) {
    const totalCents = parseMoneyToCents(input.total.trim());
    if (totalCents !== yieldCents + principalCents) return { ok: false, error: `O total da linha (${input.total.trim()}) não é a soma do rendimento com o principal (${formatMoney(yieldCents + principalCents)}).` };
  }
  const description = (input.description ?? "").trim().slice(0, 200);
  return { ok: true, values: { dueDate, yieldCents, principalCents, description: description || null } };
}

// Uma linha vinda de um formulário (inclusão ou edição).
export function scheduleItemFields(read: Read): { ok: true; values: ScheduleItemValues } | Failure {
  return scheduleLineValues({ kind: read("kind", 20), dueDate: read("dueDate", 10), yieldAmount: read("yieldAmount", 40), principalAmount: read("principalAmount", 40), total: read("total", 40), description: read("description", 200) });
}

// Lote de linhas revisado na tela (JSON enviado pelo formulário). Cada linha passa pela mesma conferência da inclusão.
export type ScheduleLineInput = { kind?: string; dueDate: string; yieldAmount: string; principalAmount: string; total?: string; description?: string };
export function scheduleLinesFields(raw: string): { ok: true; items: ScheduleItemValues[] } | Failure {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, error: "Lista de pagamentos inválida. Recarregue a página e tente de novo." }; }
  if (!Array.isArray(parsed) || parsed.length === 0) return { ok: false, error: "Inclua pelo menos um pagamento na lista." };
  if (parsed.length > MAX_SCHEDULE_ITEMS) return { ok: false, error: `O cronograma pode ter no máximo ${MAX_SCHEDULE_ITEMS} pagamentos.` };
  const items: ScheduleItemValues[] = [];
  for (const [index, line] of parsed.entries()) {
    const value = (key: string) => (line && typeof line === "object" && typeof (line as Record<string, unknown>)[key] === "string" ? String((line as Record<string, unknown>)[key]).slice(0, 200) : "");
    const result = scheduleLineValues({ kind: value("kind"), dueDate: value("dueDate"), yieldAmount: value("yieldAmount"), principalAmount: value("principalAmount"), total: value("total"), description: value("description") });
    if (!result.ok) return { ok: false, error: `Linha ${index + 1}: ${result.error}` };
    items.push(result.values);
  }
  return { ok: true, items };
}

// Sugestão de linhas para o usuário revisar ANTES de gravar (nada é gravado por aqui): as datas pela periodicidade a
// partir da primeira data informada, no dia do pagamento escolhido, o rendimento digitado repetido em cada data e a
// devolução do principal digitada na última data. Os valores não são divididos nem calculados; cada linha pode ser
// alterada, retirada ou acrescentada na revisão.
export function suggestScheduleLines({ frequency, firstDueDate, count, yieldAmount, principalAmount, description, dueDay = null }: {
  frequency: PaymentFrequency; firstDueDate: string; count: number; yieldAmount: string; principalAmount: string; description: string; dueDay?: number | null;
}): ScheduleLineInput[] {
  if (!isIsoDate(firstDueDate) || !Number.isInteger(count) || count < 1 || count > MAX_SCHEDULE_ITEMS) return [];
  const dates = scheduleDates(firstDueDate, frequency === "AT_MATURITY" ? 1 : count, frequency, dueDay);
  return dates.map((dueDate, index) => {
    const last = index === dates.length - 1;
    const principal = last ? principalAmount : "";
    const kind = yieldAmount && principal ? "COMBINED" : principal ? "PRINCIPAL" : "YIELD";
    return { kind, dueDate, yieldAmount, principalAmount: principal, description };
  });
}

// Modelo padrão (conveniência, nunca obrigatório): pagamentos periódicos de rendimento (a periodicidade do contrato, ou
// mensal se não houver uma regular) e o principal integral na última data. Não impõe a primeira data: usa a que o
// usuário já digitou; sem ela, a primeira data no dia do pagamento combinado depois do início (só como ponto de partida
// editável); sem dia combinado, deixa a primeira data em branco para o usuário informar a negociada. A quantidade vai
// até o vencimento final do contrato (ou pelo prazo). O rendimento é o valor combinado, digitado pelo usuário, e as
// linhas ainda passam pela revisão antes de gravar.
export function defaultModelPlan(investment: {
  startDate: string; maturityDate: string | null; termCount: number | null; termUnit: string | null; termMonths: number | null; paymentFrequency: string | null; amountCents: number; dueDay?: number | null; yieldPaymentCents?: number | null;
}, typed: { firstDueDate?: string; dueDay?: number | null } = {}) {
  const own = investment.paymentFrequency as PaymentFrequency | null;
  const frequency: PaymentFrequency = own && FREQUENCY_MONTHS[own] ? own : "MONTHLY";
  const step = FREQUENCY_MONTHS[frequency] as number;
  const dueDay = typed.dueDay ?? investment.dueDay ?? null;
  const firstDueDate = typed.firstDueDate && isIsoDate(typed.firstDueDate) ? typed.firstDueDate : dueDay ? firstDueOnDay(investment.startDate, dueDay) : null;
  const principalAmount = centsToInput(investment.amountCents);
  const yieldAmount = investment.yieldPaymentCents ? centsToInput(investment.yieldPaymentCents) : "";
  if (!firstDueDate) return { frequency, firstDueDate: null, dueDay, count: null, principalAmount, yieldAmount };
  let count: number | null = null;
  if (investment.maturityDate && investment.maturityDate >= firstDueDate) {
    count = scheduleDates(firstDueDate, MAX_SCHEDULE_ITEMS, frequency, dueDay).filter((date) => date <= (investment.maturityDate as string)).length || null;
  } else if (!investment.maturityDate) {
    const months = investment.termCount && investment.termUnit === "MONTHS" ? investment.termCount
      : investment.termCount && investment.termUnit === "YEARS" ? investment.termCount * 12
      : !investment.termCount ? investment.termMonths : null;
    count = months && months % step === 0 ? months / step : null;
  }
  return { frequency, firstDueDate, dueDay, count: count && count <= MAX_SCHEDULE_ITEMS ? count : null, principalAmount, yieldAmount };
}

// Cronograma montado sozinho a partir do contrato (sem digitar nada): a data de início é a do primeiro pagamento, as
// demais seguem a periodicidade no dia combinado, o rendimento de cada pagamento é o do contrato e a devolução do
// principal vai para a data de resgate (a última linha, ou uma linha própria se a liquidez for D+N). Sem periodicidade,
// quantidade de pagamentos ou rendimento de cada pagamento o contrato não diz o bastante: devolve null (nada é inventado).
// Datas de pagamento que o contrato define (primeiro ao último), sem precisar do rendimento: usadas no PDF quando o
// investimento ainda não tem cronograma gravado. Sem periodicidade, início válido ou quantidade de pagamentos, devolve null.
export function contractPaymentDates(values: {
  startDate: string; maturityDate: string | null; dueDay: number | null; paymentFrequency: string | null; installmentCount: number | null;
  termCount: number | null; termUnit: string | null;
}): string[] | null {
  const frequency = values.paymentFrequency as PaymentFrequency | null;
  if (!frequency || !(frequency === "AT_MATURITY" || FREQUENCY_MONTHS[frequency]) || !isIsoDate(values.startDate)) return null;
  if (frequency === "AT_MATURITY") return values.maturityDate && isIsoDate(values.maturityDate) ? [values.maturityDate] : null;
  const count = values.installmentCount ?? (values.termCount && values.termUnit ? installmentsFor(values.termCount, values.termUnit as TermUnit, frequency) : null);
  if (count && count >= 1 && count <= MAX_SCHEDULE_ITEMS) return scheduleDates(values.startDate, count, frequency, values.dueDay);
  // Sem quantidade nem prazo: os pagamentos vão da data de início até o vencimento do contrato, na periodicidade combinada.
  if (!values.maturityDate || !isIsoDate(values.maturityDate)) return null;
  const upTo = scheduleDates(values.startDate, MAX_SCHEDULE_ITEMS, frequency, values.dueDay).filter((date) => date <= values.maturityDate!);
  return upTo.length > 0 ? upTo : null;
}

export function contractScheduleItems(values: {
  startDate: string; maturityDate: string | null; dueDay: number | null; paymentFrequency: string | null; installmentCount: number | null;
  termCount: number | null; termUnit: string | null; yieldPaymentCents: number | null; amountCents: number; redemptionRule: string | null; redemptionDays: number | null;
}): ScheduleItemValues[] | null {
  const frequency = values.paymentFrequency as PaymentFrequency | null;
  if (!frequency || !(frequency === "AT_MATURITY" || FREQUENCY_MONTHS[frequency]) || !values.yieldPaymentCents || values.yieldPaymentCents <= 0 || !isIsoDate(values.startDate)) return null;
  let dates: string[];
  if (frequency === "AT_MATURITY") {
    if (!values.maturityDate || !isIsoDate(values.maturityDate)) return null;
    dates = [values.maturityDate];
  } else {
    const count = values.installmentCount ?? (values.termCount && values.termUnit ? installmentsFor(values.termCount, values.termUnit as TermUnit, frequency) : null);
    if (!count || count < 1 || count > MAX_SCHEDULE_ITEMS) return null;
    dates = scheduleDates(values.startDate, count, frequency, values.dueDay);
  }
  const yieldAmount = centsToInput(values.yieldPaymentCents), principalAmount = centsToInput(values.amountCents);
  const lines: ScheduleLineInput[] = dates.map((dueDate, index) => {
    const last = index === dates.length - 1;
    return { kind: last ? "COMBINED" : "YIELD", dueDate, yieldAmount, principalAmount: last ? principalAmount : "" };
  });
  const rule = values.redemptionRule as RedemptionRule | null;
  const adjusted = applyRedemptionDate(lines, redemptionDate(values.maturityDate ?? dates[dates.length - 1], rule, values.redemptionDays));
  const items: ScheduleItemValues[] = [];
  for (const line of adjusted) {
    const result = scheduleLineValues(line);
    if (!result.ok) return null;
    items.push(result.values);
  }
  return items;
}

// Datas das linhas comparadas com o contrato: antes do início é recusado na gravação; depois do vencimento do contrato
// é apenas apontado (pode ser combinado assim), nunca corrigido.
export function scheduleDateProblem(dueDate: string, investment: { startDate: string }) {
  return dueDate < investment.startDate ? `A data do pagamento (${formatDate(dueDate)}) é anterior ao início do contrato (${formatDate(investment.startDate)}).` : null;
}

// Versão do cronograma gravado: muda quando qualquer linha é incluída, alterada, retirada ou substituída. A tela envia a
// versão que viu; se o cronograma mudou desde então (outro envio, outra aba, clique repetido), nada é gravado.
export function scheduleVersion(items: { id: string; updatedAt: Date | string }[]) {
  const text = items.map((item) => `${item.id}@${typeof item.updatedAt === "string" ? item.updatedAt : item.updatedAt.toISOString()}`).sort().join("|");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  return `${items.length}-${hash.toString(36)}`;
}

// Totais do cronograma (só soma o que foi digitado).
export function scheduleTotals(items: { yieldCents: number; principalCents: number }[]) {
  const yieldCents = items.reduce((total, item) => total + item.yieldCents, 0);
  const principalCents = items.reduce((total, item) => total + item.principalCents, 0);
  return { yieldCents, principalCents, totalCents: yieldCents + principalCents, count: items.length };
}

// Histórico visível do contrato: lista dos campos alterados com o valor antes e depois, já escritos para leitura.
const investmentFieldLabels: [keyof InvestmentValues, string, (value: InvestmentValues) => string | null][] = [
  ["contractNumber", "Identificação do contrato", (v) => v.contractNumber],
  ["amountCents", "Valor investido", (v) => formatMoney(v.amountCents)],
  ["agreedRateBps", "Taxa combinada", (v) => rateLabel(v.agreedRateBps, v.ratePeriod)],
  ["ratePeriod", "Período da taxa", (v) => RATE_PERIODS[v.ratePeriod]],
  ["contractedOn", "Data da contratação", (v) => v.contractedOn && formatDate(v.contractedOn)],
  ["investedOn", "Data do recebimento do dinheiro", (v) => v.investedOn && formatDate(v.investedOn)],
  ["startDate", "Data de início", (v) => formatDate(v.startDate)],
  ["termCount", "Prazo", (v) => termLabel(v)],
  ["maturityDate", "Vencimento do contrato", (v) => v.maturityDate && formatDate(v.maturityDate)],
  ["dueDay", "Dia do pagamento", (v) => (v.dueDay ? `Dia ${v.dueDay}` : null)],
  ["paymentFrequency", "Periodicidade dos pagamentos", (v) => v.paymentFrequency && PAYMENT_FREQUENCIES[v.paymentFrequency]],
  ["installmentCount", "Quantidade de parcelas", (v) => (v.installmentCount ? String(v.installmentCount) : null)],
  ["redemptionRule", "Liquidez (resgate do crédito)", (v) => redemptionLabel(v.redemptionRule, v.redemptionDays)],
  ["yieldPaymentCents", "Rendimento de cada pagamento", (v) => (v.yieldPaymentCents ? formatMoney(v.yieldPaymentCents) : null)],
  ["paymentMethod", "Forma de pagamento", (v) => v.paymentMethod && INVESTMENT_PAYMENT_METHODS[v.paymentMethod]],
  ["bankAccountId", "Conta bancária para os pagamentos", (v) => (v.bankAccountId ? "conta do investidor" : null)],
  ["yieldTerms", "Condições do rendimento", (v) => v.yieldTerms],
  ["principalTerms", "Regras de devolução do principal", (v) => v.principalTerms],
  ["status", "Status", (v) => INVESTMENT_STATUS[v.status]],
  ["notes", "Observações", (v) => v.notes],
];
export function investmentChanges(before: InvestmentValues, after: InvestmentValues, accountLabel: (id: string) => string = () => "conta do investidor") {
  const changes: { field: string; before: string | null; after: string | null }[] = [];
  for (const [key, label, baseShow] of investmentFieldLabels) {
    const show = key === "bankAccountId" ? (v: InvestmentValues) => (v.bankAccountId ? accountLabel(v.bankAccountId) : null) : baseShow;
    // A taxa aparece uma vez só ("2% ao mês"), mesmo quando só o período muda.
    if (key === "ratePeriod") continue;
    // O prazo é comparado pelo texto ("12 meses"), para que o formato anterior (term_months) igual ao novo não conte como mudança;
    // a conta bancária, pelo id (o texto não diz qual conta).
    const changed = key === "agreedRateBps" ? before.agreedRateBps !== after.agreedRateBps || before.ratePeriod !== after.ratePeriod
      : key === "termCount" ? termLabel(before) !== termLabel(after)
      : key === "redemptionRule" ? redemptionLabel(before.redemptionRule, before.redemptionDays) !== redemptionLabel(after.redemptionRule, after.redemptionDays) : before[key] !== after[key];
    if (changed) changes.push({ field: label, before: show(before) || null, after: show(after) || null });
  }
  return changes;
}

// Resumo do cronograma para o histórico (antes e depois de uma alteração).
export function scheduleSummary(items: { dueDate: string; yieldCents: number; principalCents: number }[]) {
  if (items.length === 0) return null;
  const totals = scheduleTotals(items);
  const dates = items.map((item) => item.dueDate).sort();
  return `${items.length} ${items.length === 1 ? "pagamento" : "pagamentos"} de ${formatDate(dates[0])} a ${formatDate(dates[dates.length - 1])}: rendimento ${formatMoney(totals.yieldCents)}, principal ${formatMoney(totals.principalCents)}`;
}
