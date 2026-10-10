// Regras puras do módulo Investidores (sem banco): rótulos, validação dos formulários e o resumo do painel.
// Nenhuma regra financeira de investimento está definida: não há cálculo de rendimento, capitalização, saldo, total a
// devolver, resgate, multa ou renovação. O painel só soma e conta o que foi cadastrado.
import { normalizeEmail, normalizeSocial } from "../contacts";
import { addDays, isIsoDate, normalizeCpfCnpj, normalizePhone, parseMoneyToCents, parseRateToBps } from "../finance/format";

export const INVESTOR_STATUS = { ACTIVE: "Ativo", INACTIVE: "Inativo" } as const;
export type InvestorStatus = keyof typeof INVESTOR_STATUS;

export const INVESTMENT_STATUS = { PENDING_SIGNATURE: "Aguardando assinatura", ACTIVE: "Ativo", CLOSED: "Encerrado", CANCELED: "Cancelado" } as const;
export type InvestmentStatus = keyof typeof INVESTMENT_STATUS;

// O período da taxa é sempre escolhido no contrato: o sistema não presume mensal, anual nem nenhum outro.
export const RATE_PERIODS = { MONTHLY: "ao mês", YEARLY: "ao ano", CONTRACT_TERM: "no prazo total do contrato", OTHER: "outro (descrito nas observações)" } as const;
export type RatePeriod = keyof typeof RATE_PERIODS;

export const DOCUMENT_KINDS = { SIGNED_CONTRACT: "Contrato assinado", ADDENDUM: "Aditivo", TRANSFER_RECEIPT: "Comprovante de transferência", OTHER: "Outro documento" } as const;
export type DocumentKind = keyof typeof DOCUMENT_KINDS;

export const INVESTORS_PAGE_SIZE = 25;
const MAX_CENTS = 100_000_000_000; // R$ 1 bilhão: limite técnico contra valores digitados por engano.

const pick = <T extends string>(options: Record<T, string>, value: string) => (Object.keys(options) as T[]).find((key) => key === value) ?? null;
export const parseInvestorStatus = (value: string) => pick(INVESTOR_STATUS, value);
export const parseInvestmentStatus = (value: string) => pick(INVESTMENT_STATUS, value);
export const parseRatePeriod = (value: string) => pick(RATE_PERIODS, value);
export const parseDocumentKind = (value: string) => pick(DOCUMENT_KINDS, value);

type Failure = { ok: false; error: string };
type Read = (key: string, max: number) => string;
const optional = (value: string) => (value ? value : null);

export type InvestorValues = {
  name: string; document: string | null; phone: string | null; whatsapp: string | null; email: string | null;
  instagram: string | null; facebook: string | null; notes: string | null; status: InvestorStatus;
};

// Campos do investidor. Só o nome é obrigatório; telefone, WhatsApp e e-mail têm o formato conferido; redes sociais
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
  return {
    ok: true,
    values: { name, document: document.value, phone: phone.value, whatsapp: whatsapp.value, email: email.value, instagram: instagram.value, facebook: facebook.value, notes: optional(read("notes", 1000)), status },
  };
}

export type InvestmentValues = {
  amountCents: number; agreedRateBps: number; ratePeriod: RatePeriod; startDate: string; maturityDate: string | null;
  dueDay: number | null; notes: string | null; status: InvestmentStatus;
};

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
  return { ok: true, values: { amountCents, agreedRateBps, ratePeriod, startDate, maturityDate: optional(maturityInput), dueDay, notes: optional(read("notes", 1000)), status } };
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
    status: parseInvestorStatus(search.status ?? "") ?? "",
    carteira: (search.carteira ?? "").trim().slice(0, 80),
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}
