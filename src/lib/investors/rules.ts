// Regras puras do módulo Investidores (sem banco): rótulos, validação dos formulários e o resumo do painel.
// Nenhuma regra financeira de investimento está definida: não há cálculo de rendimento, capitalização, saldo, total a
// devolver, resgate, multa ou renovação. O painel só soma e conta o que foi cadastrado.
import { normalizeEmail, normalizeSocial } from "../contacts";
import { addressFields, type Address } from "./address";
import { addressParts, type AddressPart } from "../finance/client-profile";
import { bankFields, type BankValues } from "../bank-account";
import { addDays, formatDate, formatMoney, isIsoDate, normalizeCpfCnpj, normalizePhone, parseMoneyToCents, parseRateToBps } from "../finance/format";
import { dueDates } from "../finance/rules";

export const INVESTOR_STATUS = { ACTIVE: "Ativo", INACTIVE: "Inativo" } as const;
export type InvestorStatus = keyof typeof INVESTOR_STATUS;

export const INVESTMENT_STATUS = { PENDING_SIGNATURE: "Aguardando assinatura", ACTIVE: "Ativo", CLOSED: "Encerrado", CANCELED: "Cancelado" } as const;
export type InvestmentStatus = keyof typeof INVESTMENT_STATUS;

// O período da taxa é sempre escolhido no contrato: o sistema não presume mensal, anual nem nenhum outro.
export const RATE_PERIODS = { MONTHLY: "ao mês", YEARLY: "ao ano", CONTRACT_TERM: "no prazo total do contrato", OTHER: "outro (descrito nas observações)" } as const;
export type RatePeriod = keyof typeof RATE_PERIODS;

export const DOCUMENT_KINDS = { SIGNED_CONTRACT: "Contrato assinado", ADDENDUM: "Aditivo", TRANSFER_RECEIPT: "Comprovante de transferência", OTHER: "Outro documento" } as const;
export type DocumentKind = keyof typeof DOCUMENT_KINDS;

// Periodicidade combinada dos pagamentos ao investidor (informativa; o cronograma usa as datas para sugerir a agenda).
export const PAYMENT_FREQUENCIES = {
  MONTHLY: "Mensal", QUARTERLY: "Trimestral", SEMIANNUAL: "Semestral", YEARLY: "Anual",
  AT_MATURITY: "Pagamento único no vencimento", OTHER: "Outra (datas informadas uma a uma)",
} as const;
export type PaymentFrequency = keyof typeof PAYMENT_FREQUENCIES;
// Meses entre uma data e a seguinte no cronograma sugerido (só para as periodicidades regulares).
export const FREQUENCY_MONTHS: Partial<Record<PaymentFrequency, number>> = { MONTHLY: 1, QUARTERLY: 3, SEMIANNUAL: 6, YEARLY: 12 };

export const INVESTORS_PAGE_SIZE = 25;
const MAX_CENTS = 100_000_000_000; // R$ 1 bilhão: limite técnico contra valores digitados por engano.

const pick = <T extends string>(options: Record<T, string>, value: string) => (Object.keys(options) as T[]).find((key) => key === value) ?? null;
export const parseInvestorStatus = (value: string) => pick(INVESTOR_STATUS, value);
export const parseInvestmentStatus = (value: string) => pick(INVESTMENT_STATUS, value);
export const parseRatePeriod = (value: string) => pick(RATE_PERIODS, value);
export const parseDocumentKind = (value: string) => pick(DOCUMENT_KINDS, value);
export const parsePaymentFrequency = (value: string) => pick(PAYMENT_FREQUENCIES, value);

type Failure = { ok: false; error: string };
type Read = (key: string, max: number) => string;
const optional = (value: string) => (value ? value : null);

// Endereço do investidor em colunas address_cep, address_street… (opcional no cadastro; exigido no contrato).
export type InvestorAddressKey = `address${AddressPart}`;
export const investorAddressKeys = addressParts.map((part) => `address${part}` as InvestorAddressKey);
export type InvestorAddress = Record<InvestorAddressKey, string | null>;

export type InvestorValues = {
  name: string; document: string | null; phone: string | null; whatsapp: string | null; email: string | null;
  instagram: string | null; facebook: string | null; notes: string | null; status: InvestorStatus;
} & InvestorAddress & BankValues;

// Endereço como objeto { Cep, Street, … } a partir das colunas do investidor.
export const investorAddress = (row: InvestorAddress): Address => Object.fromEntries(addressParts.map((part) => [part, row[`address${part}`] ?? null])) as Address;

// Campos do investidor. Só o nome é obrigatório; o endereço é opcional, mas é exigido para gerar o contrato; telefone, WhatsApp e e-mail têm o formato conferido; redes sociais
// aceitam @usuário ou endereço sem outra validação.
export function investorFields(read: Read): { ok: true; values: InvestorValues } | Failure {
  const name = read("name", 160);
  if (!name) return { ok: false, error: "Informe o nome ou a razão social do investidor." };
  const document = normalizeCpfCnpj(read("document", 40));
  if (!document.ok) return document;
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
  const bank = bankFields(read);
  if (!bank.ok) return bank;
  return {
    ok: true,
    values: {
      name, document: document.value, phone: phone.value, whatsapp: whatsapp.value, email: email.value, instagram: instagram.value, facebook: facebook.value, notes: optional(read("notes", 1000)), status,
      ...(Object.fromEntries(addressParts.map((part) => [`address${part}`, address.value[part]])) as InvestorAddress),
      ...bank.values,
    },
  };
}

export type InvestmentValues = {
  amountCents: number; agreedRateBps: number; ratePeriod: RatePeriod; startDate: string; maturityDate: string | null;
  dueDay: number | null; notes: string | null; status: InvestmentStatus;
  contractNumber: string | null; investedOn: string | null; termMonths: number | null; paymentFrequency: PaymentFrequency | null; installmentCount: number | null;
};

// Número inteiro opcional entre min e max ("" = null; NaN = inválido).
const optionalInteger = (value: string, min: number, max: number) => (value ? (/^\d{1,4}$/.test(value) && Number(value) >= min && Number(value) <= max ? Number(value) : NaN) : null);
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
  const investedOn = read("investedOn", 10);
  if (investedOn && !isIsoDate(investedOn)) return { ok: false, error: "Data do investimento inválida." };
  const termMonths = optionalInteger(read("termMonths", 6), 1, 600);
  if (Number.isNaN(termMonths)) return { ok: false, error: "O prazo vai de 1 a 600 meses." };
  const frequencyInput = read("paymentFrequency", 20);
  const paymentFrequency = frequencyInput ? parsePaymentFrequency(frequencyInput) : null;
  if (frequencyInput && !paymentFrequency) return { ok: false, error: "Escolha a periodicidade dos pagamentos na lista." };
  const installmentCount = optionalInteger(read("installmentCount", 6), 1, 600);
  if (Number.isNaN(installmentCount)) return { ok: false, error: "A quantidade de parcelas vai de 1 a 600." };
  return {
    ok: true,
    values: {
      amountCents, agreedRateBps, ratePeriod, startDate, maturityDate: optional(maturityInput), dueDay, notes: optional(read("notes", 1000)), status,
      contractNumber: optional(contractNumber), investedOn: optional(investedOn), termMonths, paymentFrequency, installmentCount,
    },
  };
}

export type InvestmentSummaryRow = { status: InvestmentStatus; amountCents: number; maturityDate: string | null };

// Painel: capital dos contratos ativos, quantidade e os vencimentos de contrato cadastrados. Rendimentos previstos,
// rendimentos pagos e total a devolver ficam null: dependem das regras de investimento ainda não definidas.
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
    expectedYieldCents: null,
    paidYieldCents: null,
    totalToReturnCents: null,
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

// Datas sugeridas: a primeira informada e as seguintes de N em N meses, mantendo o dia (fim de mês curto volta ao dia
// combinado, pela mesma função de vencimentos das operações). Pagamento único: uma data só.
export function scheduleDates(firstDueDate: string, count: number, frequency: PaymentFrequency) {
  if (frequency === "AT_MATURITY") return [firstDueDate];
  const step = FREQUENCY_MONTHS[frequency];
  if (!step) return [];
  return dueDates("MONTHLY", firstDueDate, (count - 1) * step + 1).filter((_, index) => index % step === 0);
}

const amount = (value: string) => (value ? parseMoneyToCents(value) : 0);

// Uma linha do cronograma (inclusão ou edição).
export function scheduleItemFields(read: Read): { ok: true; values: ScheduleItemValues } | Failure {
  const dueDate = read("dueDate", 10);
  if (!isIsoDate(dueDate)) return { ok: false, error: "Informe a data do pagamento." };
  const yieldCents = amount(read("yieldAmount", 40));
  const principalCents = amount(read("principalAmount", 40));
  if (yieldCents === null || yieldCents < 0 || yieldCents > MAX_CENTS) return { ok: false, error: "Rendimento: informe o valor em reais, por exemplo 1.000,00 (ou deixe em branco)." };
  if (principalCents === null || principalCents < 0 || principalCents > MAX_CENTS) return { ok: false, error: "Devolução do principal: informe o valor em reais, por exemplo 50.000,00 (ou deixe em branco)." };
  if (yieldCents + principalCents <= 0) return { ok: false, error: "Informe o rendimento, a devolução do principal ou os dois." };
  return { ok: true, values: { dueDate, yieldCents, principalCents, description: optional(read("description", 200)) } };
}

// Montagem do cronograma inteiro: primeira data, quantidade, periodicidade, rendimento de cada data e devolução do
// principal na última data (os dois digitados). Depois de gravado, cada linha pode ser editada.
export function scheduleBuildFields(read: Read): { ok: true; frequency: PaymentFrequency; items: ScheduleItemValues[] } | Failure {
  const frequency = parsePaymentFrequency(read("frequency", 20));
  if (!frequency || frequency === "OTHER") return { ok: false, error: "Escolha uma periodicidade (mensal, trimestral, semestral, anual ou pagamento único). Para datas irregulares, inclua as linhas uma a uma." };
  const firstDueDate = read("firstDueDate", 10);
  if (!isIsoDate(firstDueDate)) return { ok: false, error: "Informe a data do primeiro pagamento." };
  const count = frequency === "AT_MATURITY" ? 1 : optionalInteger(read("count", 6), 1, MAX_SCHEDULE_ITEMS);
  if (count === null || Number.isNaN(count)) return { ok: false, error: `Informe a quantidade de pagamentos (1 a ${MAX_SCHEDULE_ITEMS}).` };
  const yieldCents = amount(read("yieldAmount", 40));
  const principalCents = amount(read("principalAmount", 40));
  if (yieldCents === null || yieldCents < 0 || yieldCents > MAX_CENTS) return { ok: false, error: "Rendimento de cada pagamento: informe o valor em reais (ou deixe em branco)." };
  if (principalCents === null || principalCents < 0 || principalCents > MAX_CENTS) return { ok: false, error: "Devolução do principal: informe o valor em reais (ou deixe em branco)." };
  if (yieldCents <= 0 && (count > 1 || principalCents <= 0)) return { ok: false, error: count > 1 ? "Informe o rendimento de cada pagamento (só a última data pode ter apenas a devolução do principal)." : "Informe o rendimento, a devolução do principal ou os dois." };
  const description = optional(read("description", 200));
  const dates = scheduleDates(firstDueDate, count, frequency);
  return {
    ok: true, frequency,
    items: dates.map((dueDate, index) => ({ dueDate, yieldCents, principalCents: index === dates.length - 1 ? principalCents : 0, description })),
  };
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
  ["investedOn", "Data do investimento", (v) => v.investedOn && formatDate(v.investedOn)],
  ["startDate", "Data de início", (v) => formatDate(v.startDate)],
  ["termMonths", "Prazo", (v) => (v.termMonths ? `${v.termMonths} ${v.termMonths === 1 ? "mês" : "meses"}` : null)],
  ["maturityDate", "Vencimento do contrato", (v) => v.maturityDate && formatDate(v.maturityDate)],
  ["dueDay", "Dia de vencimento", (v) => (v.dueDay ? `Dia ${v.dueDay}` : null)],
  ["paymentFrequency", "Periodicidade dos pagamentos", (v) => v.paymentFrequency && PAYMENT_FREQUENCIES[v.paymentFrequency]],
  ["installmentCount", "Quantidade de parcelas", (v) => (v.installmentCount ? String(v.installmentCount) : null)],
  ["status", "Status", (v) => INVESTMENT_STATUS[v.status]],
  ["notes", "Observações", (v) => v.notes],
];
export function investmentChanges(before: InvestmentValues, after: InvestmentValues) {
  const changes: { field: string; before: string | null; after: string | null }[] = [];
  for (const [key, label, show] of investmentFieldLabels) {
    // A taxa aparece uma vez só ("2% ao mês"), mesmo quando só o período muda.
    if (key === "ratePeriod") continue;
    const changed = key === "agreedRateBps" ? before.agreedRateBps !== after.agreedRateBps || before.ratePeriod !== after.ratePeriod : before[key] !== after[key];
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
