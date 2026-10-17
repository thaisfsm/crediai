// Contrato de investimento gerado pelo sistema: regras puras (sem banco), usadas pelas ações, pela página do
// investimento, pelo gerador de PDF e pelos testes.
//
// O contrato só reproduz o que foi cadastrado e confirmado: partes, valor, taxa e o período da taxa, datas e, se o
// usuário escolher, as observações do investimento como condições adicionais. Nenhum rendimento, juros, amortização,
// resgate, multa, mora, renovação ou devolução do capital é criado aqui. Faltando um dado essencial, o contrato não é
// gerado e a lista do que falta é mostrada. O PDF gerado NÃO é assinado: a versão assinada é anexada depois, em Documentos.
import { formatCpfCnpj, formatDate, formatMoney, normalizeCpf, normalizeCpfCnpj, onlyDigits } from "../finance/format";
import { addressComplete, addressFields, addressLine, type Address } from "./address";
import { PAYMENT_FREQUENCIES, RATE_PERIODS, redemptionDate, type InvestmentStatus, type PaymentFrequency, type RatePeriod, type RedemptionRule } from "./rules";

type Failure = { ok: false; error: string };
type Read = (key: string, max: number) => string;

// Muda quando o texto do modelo mudar: entra no hash dos dados e fica gravado em cada versão gerada.
export const CONTRACT_TEMPLATE_VERSION = "contrato-investimento-v2";

export type ContractorValues = {
  legalName: string | null; document: string | null; address: Address;
  representativeName: string | null; representativeDocument: string | null; confirmed: boolean;
};

// Dados da empresa contratante. Podem ser gravados incompletos (rascunho), mas só confirmados quando completos.
export function contractorFields(read: Read): { ok: true; values: ContractorValues } | Failure {
  const legalName = read("legalName", 200) || null;
  const document = normalizeCpfCnpj(read("document", 40));
  if (!document.ok) return document;
  const address = addressFields(read, "address");
  if (!address.ok) return address;
  const representativeName = read("representativeName", 160) || null;
  const representativeDocument = normalizeCpf(read("representativeDocument", 40));
  if (!representativeDocument.ok) return { ok: false, error: `CPF do representante: ${representativeDocument.error}` };
  if (representativeDocument.value && !representativeName) return { ok: false, error: "Informe o nome do representante legal ou deixe o CPF em branco." };
  const confirmed = read("confirmed", 10) === "1";
  const values = { legalName, document: document.value, address: address.value, representativeName, representativeDocument: representativeDocument.value, confirmed };
  if (confirmed) {
    const missing = missingContractor({ ...values, confirmedAt: "x" });
    if (missing.length) return { ok: false, error: `Para confirmar, preencha: ${missing.join(", ")}.` };
  }
  return { ok: true, values };
}

export type ContractorData = {
  legalName: string | null; document: string | null; address: Address;
  representativeName: string | null; representativeDocument: string | null; confirmedAt: string | null;
};

function missingContractor(contractor: ContractorData | null) {
  if (!contractor) return ["razão social", "CNPJ ou CPF", "endereço completo", "confirmação dos dados"];
  const missing: string[] = [];
  if (!contractor.legalName?.trim()) missing.push("razão social");
  if (!contractor.document) missing.push("CNPJ ou CPF");
  if (!addressComplete(contractor.address)) missing.push("endereço completo (logradouro, número, bairro, cidade, UF e CEP)");
  return missing;
}

export type ContractSource = {
  contractor: ContractorData | null;
  investor: { name: string; document: string | null; address: Address };
  investment: {
    id: string; amountCents: number; agreedRateBps: number; ratePeriod: RatePeriod; startDate: string;
    maturityDate: string | null; dueDay: number | null; notes: string | null; status: InvestmentStatus;
    paymentFrequency: PaymentFrequency | null; yieldPaymentCents: number | null; redemptionRule: RedemptionRule | null; redemptionDays: number | null;
  };
};

export type MissingItem = { section: "Empresa contratante" | "Investidor" | "Investimento"; item: string };

// O que falta para gerar a versão final. Lista vazia = pode gerar.
export function missingContractData(source: ContractSource, includeNotes: boolean): MissingItem[] {
  const missing: MissingItem[] = [];
  const contractorMissing = missingContractor(source.contractor);
  for (const item of contractorMissing) missing.push({ section: "Empresa contratante", item });
  if (source.contractor && !contractorMissing.length && !source.contractor.confirmedAt) missing.push({ section: "Empresa contratante", item: "confirmação dos dados" });
  const { investor, investment } = source;
  if (!investor.name.trim()) missing.push({ section: "Investidor", item: "nome ou razão social" });
  if (!investor.document) missing.push({ section: "Investidor", item: "CPF ou CNPJ" });
  if (!addressComplete(investor.address)) missing.push({ section: "Investidor", item: "endereço completo (logradouro, número, bairro, cidade, UF e CEP)" });
  if (investment.status === "CANCELED") missing.push({ section: "Investimento", item: "investimento cancelado não gera contrato" });
  if (!(investment.amountCents > 0)) missing.push({ section: "Investimento", item: "valor investido" });
  if (!investment.startDate) missing.push({ section: "Investimento", item: "data de início" });
  if (!investment.maturityDate && !investment.dueDay) missing.push({ section: "Investimento", item: "vencimento do contrato ou dia de vencimento" });
  if (!investment.redemptionRule) missing.push({ section: "Investimento", item: "liquidez (ao término do contrato ou D+ dias)" });
  if (investment.ratePeriod === "OTHER" && !(includeNotes && investment.notes?.trim())) {
    missing.push({ section: "Investimento", item: "período da taxa \"outro\": descreva o período nas observações e inclua as observações no contrato" });
  }
  return missing;
}

// Tudo o que entra no texto do contrato, numa ordem estável. Igual entre duas versões = os dados não mudaram.
export function contractFingerprint(source: ContractSource, includeNotes: boolean) {
  const { contractor, investor, investment } = source;
  return JSON.stringify({
    template: CONTRACT_TEMPLATE_VERSION,
    contractor: contractor && { legalName: contractor.legalName, document: contractor.document, address: contractor.address, representativeName: contractor.representativeName, representativeDocument: contractor.representativeDocument },
    investor: { name: investor.name, document: investor.document, address: investor.address },
    investment: {
      id: investment.id, amountCents: investment.amountCents, agreedRateBps: investment.agreedRateBps, ratePeriod: investment.ratePeriod, startDate: investment.startDate,
      maturityDate: investment.maturityDate, dueDay: investment.dueDay, notes: includeNotes ? investment.notes : null,
      paymentFrequency: investment.paymentFrequency, yieldPaymentCents: investment.yieldPaymentCents, redemptionRule: investment.redemptionRule, redemptionDays: investment.redemptionDays,
    },
    includeNotes,
  });
}

// Valor por extenso em reais, como se escreve em contratos: 150.050 centavos -> "mil e quinhentos reais e cinquenta centavos".
const UNITS = ["", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "onze", "doze", "treze", "quatorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove"];
const TENS = ["", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"];
const HUNDREDS = ["", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos", "setecentos", "oitocentos", "novecentos"];

function below1000(value: number) {
  if (value === 100) return "cem";
  const parts: string[] = [];
  const hundreds = Math.floor(value / 100);
  const rest = value % 100;
  if (hundreds) parts.push(HUNDREDS[hundreds]);
  if (rest < 20) { if (rest) parts.push(UNITS[rest]); }
  else parts.push(TENS[Math.floor(rest / 10)] + (rest % 10 ? ` e ${UNITS[rest % 10]}` : ""));
  return parts.join(" e ");
}

export function integerInWords(value: number) {
  if (!Number.isInteger(value) || value < 0 || value >= 1e12) throw new RangeError("valor fora do intervalo");
  if (value === 0) return "zero";
  const scales: [number, string, string][] = [[1e9, "bilhão", "bilhões"], [1e6, "milhão", "milhões"], [1e3, "mil", "mil"], [1, "", ""]];
  const groups: { amount: number; words: string }[] = [];
  let rest = value;
  for (const [size, singular, plural] of scales) {
    const amount = Math.floor(rest / size);
    rest %= size;
    if (!amount) continue;
    if (size === 1e3) groups.push({ amount, words: amount === 1 ? "mil" : `${below1000(amount)} mil` });
    else if (size === 1) groups.push({ amount, words: below1000(amount) });
    else groups.push({ amount, words: `${below1000(amount)} ${amount === 1 ? singular : plural}` });
  }
  // "e" antes do último grupo quando ele é menor que 100 ou centena redonda; vírgula nos demais.
  return groups.map((group, index) => {
    if (index === 0) return group.words;
    const last = index === groups.length - 1;
    return `${last && (group.amount < 100 || group.amount % 100 === 0) ? " e " : ", "}${group.words}`;
  }).join("");
}

export function moneyInWords(cents: number) {
  const reais = Math.floor(cents / 100);
  const centavos = cents % 100;
  const parts: string[] = [];
  if (reais) {
    // "um milhão de reais", "dois bilhões de reais"; "um milhão e quinhentos mil reais" não leva "de".
    const exactMillions = reais >= 1e6 && reais % 1e6 === 0;
    parts.push(`${integerInWords(reais)}${exactMillions ? " de" : ""} ${reais === 1 ? "real" : "reais"}`);
  }
  if (centavos) parts.push(`${integerInWords(centavos)} ${centavos === 1 ? "centavo" : "centavos"}`);
  return parts.join(" e ") || "zero real";
}

const documentLabel = (document: string) => (onlyDigits(document).length === 14 ? "CNPJ" : "CPF");

// Taxa como registrada. Para o período "outro", o texto remete às condições adicionais (onde o período é descrito).
export function contractRateText(agreedRateBps: number, ratePeriod: RatePeriod) {
  const rate = `${(agreedRateBps / 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;
  return ratePeriod === "OTHER" ? `${rate}, no período descrito nas condições adicionais deste instrumento` : `${rate} ${RATE_PERIODS[ratePeriod]}`;
}

// Texto do contrato em blocos (o PDF só desenha). Cada trecho vem do cadastro; nada é presumido.
export type Run = { text: string; bold?: boolean };
export type ContractBlock =
  | { type: "title"; text: string }
  | { type: "subtitle"; text: string }
  | { type: "heading"; text: string }
  | { type: "paragraph"; runs: Run[] }
  | { type: "quote"; text: string }
  | { type: "place-date"; text: string }
  | { type: "signatures"; parties: { role: string; lines: string[] }[]; witnesses: number };

export type ContractMeta = { version: number; generatedAt: Date };

export function buildContract(source: ContractSource, includeNotes: boolean, meta: ContractMeta) {
  const contractor = source.contractor as ContractorData;
  const { investor, investment } = source;
  const contractorDocument = contractor.document as string;
  const investorDocument = investor.document as string;
  const notes = includeNotes && investment.notes?.trim() ? investment.notes.trim() : null;
  const blocks: ContractBlock[] = [];
  const paragraph = (...runs: Run[]) => blocks.push({ type: "paragraph", runs });
  let clause = 0;
  const heading = (title: string) => { clause += 1; blocks.push({ type: "heading", text: `CLÁUSULA ${ORDINALS[clause - 1]} – ${title}` }); return clause; };

  blocks.push({ type: "title", text: "INSTRUMENTO PARTICULAR DE CONTRATO DE INVESTIMENTO" });
  blocks.push({ type: "subtitle", text: `Versão ${meta.version} · Referência do investimento ${investment.id}` });

  blocks.push({ type: "heading", text: "QUALIFICAÇÃO DAS PARTES" });
  paragraph(
    { text: "CONTRATANTE: ", bold: true },
    { text: `${contractor.legalName}, ${documentLabel(contractorDocument)} nº ${formatCpfCnpj(contractorDocument)}, com endereço em ${addressLine(contractor.address)}` },
    { text: contractor.representativeName ? `, representante legal: ${contractor.representativeName}${contractor.representativeDocument ? `, CPF nº ${formatCpfCnpj(contractor.representativeDocument)}` : ""}.` : "." },
  );
  paragraph(
    { text: "INVESTIDOR: ", bold: true },
    { text: `${investor.name}, ${documentLabel(investorDocument)} nº ${formatCpfCnpj(investorDocument)}, com endereço em ${addressLine(investor.address)}.` },
  );
  paragraph({ text: "As partes acima identificadas celebram o presente instrumento, que registra exclusivamente as condições cadastradas e confirmadas pelas partes, nos termos das cláusulas seguintes." });

  let n = heading("DO OBJETO");
  paragraph({ text: `${n}.1. O presente instrumento registra o investimento realizado pelo INVESTIDOR junto à CONTRATANTE no valor de ` }, { text: formatMoney(investment.amountCents), bold: true }, { text: ` (${moneyInWords(investment.amountCents)}).` });

  n = heading("DA TAXA COMBINADA");
  paragraph({ text: `${n}.1. As partes registram a taxa combinada de ` }, { text: contractRateText(investment.agreedRateBps, investment.ratePeriod), bold: true }, { text: "." });
  if (investment.paymentFrequency || investment.yieldPaymentCents) {
    const periodicity = investment.paymentFrequency ? PAYMENT_FREQUENCIES[investment.paymentFrequency].toLowerCase() : null;
    const parts: Run[] = [{ text: `${n}.2. A remuneração será paga` }];
    if (periodicity) parts.push({ text: ` com periodicidade ` }, { text: periodicity, bold: true });
    if (investment.yieldPaymentCents) parts.push({ text: `${periodicity ? ", no valor de " : " no valor de "}` }, { text: formatMoney(investment.yieldPaymentCents), bold: true }, { text: ` (${moneyInWords(investment.yieldPaymentCents)}) a cada pagamento` });
    if (investment.dueDay) parts.push({ text: `, no dia ${investment.dueDay} de cada mês` });
    parts.push({ text: ", nas datas combinadas entre as partes." });
    paragraph(...parts);
    paragraph({ text: `${n}.3. Este instrumento não estabelece outra forma de cálculo, capitalização ou data de pagamento de rendimentos além do que estiver expressamente registrado neste contrato.` });
  } else {
    paragraph({ text: `${n}.2. Este instrumento não estabelece forma de cálculo, capitalização, periodicidade ou data de pagamento de rendimentos além do que estiver expressamente registrado neste contrato.` });
  }

  n = heading("DO PRAZO E DO VENCIMENTO");
  let item = 0;
  const sub = () => `${n}.${++item}. `;
  paragraph({ text: `${sub()}Data de início: ` }, { text: formatDate(investment.startDate), bold: true }, { text: "." });
  if (investment.maturityDate) paragraph({ text: `${sub()}Vencimento do contrato: ` }, { text: formatDate(investment.maturityDate), bold: true }, { text: "." });
  if (investment.dueDay) paragraph({ text: `${sub()}Dia de vencimento combinado: ` }, { text: `dia ${investment.dueDay}`, bold: true }, { text: "." });

  if (investment.redemptionRule) {
    n = heading("DA LIQUIDEZ E DO RESGATE");
    const liquidityDate = redemptionDate(investment.maturityDate, investment.redemptionRule, investment.redemptionDays);
    const days = investment.redemptionDays;
    const when = investment.redemptionRule === "D_PLUS" && days
      ? `D+${days}, isto é, ${days} ${days === 1 ? "dia corrido" : "dias corridos"} após o término do contrato`
      : "ao término do contrato";
    paragraph({ text: `${n}.1. A liquidez do crédito investido é: ` }, { text: when, bold: true }, { text: liquidityDate ? `, em ` : "." }, ...(liquidityDate ? [{ text: formatDate(liquidityDate), bold: true }, { text: "." }] : []));
    paragraph({ text: `${n}.2. O INVESTIDOR somente poderá resgatar o crédito investido na data de liquidez prevista nesta cláusula, não havendo direito a resgate antecipado.` });
    paragraph({ text: `${n}.3. A CONTRATANTE poderá, a seu exclusivo critério, devolver o crédito investido, total ou parcialmente, a qualquer momento antes da data de liquidez, sem que isso a obrigue a fazê-lo e sem que o INVESTIDOR possa exigir a devolução antecipada.` });
  }

  if (notes) {
    n = heading("DAS CONDIÇÕES ADICIONAIS");
    paragraph({ text: `${n}.1. As partes registram as seguintes condições adicionais, conforme cadastradas:` });
    blocks.push({ type: "quote", text: notes });
  }

  n = heading("DAS DISPOSIÇÕES GERAIS");
  paragraph({ text: `${n}.1. Rendimentos, resgate, devolução do capital, multas, encargos por atraso e renovação não estão definidos neste instrumento além do que estiver expressamente registrado nas cláusulas anteriores.` });
  paragraph({ text: `${n}.2. Este documento foi gerado a partir dos dados cadastrados e não contém assinaturas. Ele só produz efeitos depois de assinado pelas partes.` });

  const place = [contractor.address.City, contractor.address.State].filter(Boolean).join("/");
  blocks.push({ type: "place-date", text: `${place}, ____ de ______________________ de ________.` });
  blocks.push({
    type: "signatures",
    witnesses: 2,
    parties: [
      { role: "CONTRATANTE", lines: [contractor.legalName as string, `${documentLabel(contractorDocument)} ${formatCpfCnpj(contractorDocument)}`, ...(contractor.representativeName ? [`Representante: ${contractor.representativeName}`] : [])] },
      { role: "INVESTIDOR", lines: [investor.name, `${documentLabel(investorDocument)} ${formatCpfCnpj(investorDocument)}`] },
    ],
  });
  return {
    blocks,
    title: `Contrato de investimento – ${investor.name} – versão ${meta.version}`,
    author: contractor.legalName as string,
    footer: `Contrato de investimento · Versão ${meta.version} · Gerado em ${formatDateTime(meta.generatedAt)} pelo CrediAI · Documento sem assinaturas`,
  };
}

export type ContractDocument = ReturnType<typeof buildContract>;

const ORDINALS = ["PRIMEIRA", "SEGUNDA", "TERCEIRA", "QUARTA", "QUINTA", "SEXTA", "SÉTIMA", "OITAVA", "NONA", "DÉCIMA"];

export function formatDateTime(date: Date) {
  return date.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).replace(",", " às");
}

// Nome do arquivo: contrato-investimento-ana-souza-v2.pdf (sem acentos nem caracteres especiais).
export function contractFileName(investorName: string, version: number) {
  const slug = investorName.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "investidor";
  return `contrato-investimento-${slug}-v${version}.pdf`;
}

// Situação de cada versão gerada. "Assinado" só quando um documento assinado foi anexado apontando para ela.
export const CONTRACT_STATES = {
  GENERATED: "Gerado, ainda não enviado",
  SENT: "Enviado para assinatura",
  SIGNED: "Assinado (documento anexado)",
  SUPERSEDED: "Substituído por nova versão",
} as const;
export type ContractState = keyof typeof CONTRACT_STATES;

export function contractState(contract: { sentAt: string | null; supersededAt: string | null; signed: boolean }): ContractState {
  if (contract.signed) return "SIGNED";
  if (contract.supersededAt) return "SUPERSEDED";
  if (contract.sentAt) return "SENT";
  return "GENERATED";
}
