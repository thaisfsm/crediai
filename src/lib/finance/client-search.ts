// Busca rápida de clientes (regras puras). A consulta roda no servidor, sempre na carteira da sessão; aqui só se prepara
// o texto digitado: nome sem acentos, em minúsculas e com os espaços normalizados, ou só os dígitos de CPF e telefone.

// Mesma troca feita no SQL (translate antes de lower, para não depender do locale do banco) para que "joão" e "JOAO"
// encontrem "João".
export const ACCENTED = "áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ";
export const PLAIN = "aaaaaeeeeiiiiooooouuuucnAAAAAEEEEIIIIOOOOOUUUUCN";

export function normalizeName(value: string) {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export type ClientSearchTerms = { kind: "name"; words: string[] } | { kind: "digits"; digits: string } | { kind: "none" };

// Com letras: cada palavra precisa aparecer no nome (em qualquer posição: "ana souza" acha "Ana Paula de Souza").
// Só números e sinais (CPF ou telefone, formatados ou não): a partir de 3 dígitos, procura no CPF, telefone e WhatsApp.
export function clientSearchTerms(query: string): ClientSearchTerms {
  const clean = query.slice(0, 120);
  if (/\p{L}/u.test(clean)) {
    const words = normalizeName(clean).split(" ").filter(Boolean).slice(0, 6);
    return words.length ? { kind: "name", words } : { kind: "none" };
  }
  const digits = clean.replace(/\D/g, "");
  return digits.length >= 3 ? { kind: "digits", digits: digits.slice(0, 14) } : { kind: "none" };
}

export type ClientSearchResult = { id: string; name: string; document: string | null; phone: string | null; whatsapp: string | null; archived: boolean };
export const CLIENT_SEARCH_LIMIT = 20;
