// Busca rápida de clientes (regras puras). A consulta roda no servidor, sempre na carteira da sessão; aqui só se prepara
// o texto digitado: nome sem acentos, em minúsculas e com os espaços normalizados, ou só os dígitos de CPF e telefone.

// Mesma troca feita no SQL (translate antes de lower, para não depender do locale do banco) para que "joão" e "JOAO"
// encontrem "João".
export const ACCENTED = "áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ";
export const PLAIN = "aaaaaeeeeiiiiooooouuuucnAAAAAEEEEIIIIOOOOOUUUUCN";

export function normalizeName(value: string) {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export type ClientSearchTerms = { kind: "name"; words: string[]; email: string } | { kind: "email"; email: string } | { kind: "digits"; digits: string } | { kind: "none" };

// Com "@": procura no e-mail (qualquer parte do endereço). Com letras: cada palavra precisa aparecer no nome (em qualquer
// posição: "ana souza" acha "Ana Paula de Souza") ou o texto digitado aparecer no e-mail ("joao" acha joao@exemplo.com).
// Só números e sinais (CPF ou telefone, formatados ou não): a partir de 3 dígitos, procura no CPF, telefone e WhatsApp.
export function clientSearchTerms(query: string): ClientSearchTerms {
  const clean = query.slice(0, 120);
  const email = clean.trim().toLowerCase();
  if (clean.includes("@")) return email.replace(/@/g, "").length >= 2 ? { kind: "email", email } : { kind: "none" };
  if (/\p{L}/u.test(clean)) {
    const words = normalizeName(clean).split(" ").filter(Boolean).slice(0, 6);
    return words.length ? { kind: "name", words, email } : { kind: "none" };
  }
  const digits = clean.replace(/\D/g, "");
  return digits.length >= 3 ? { kind: "digits", digits: digits.slice(0, 14) } : { kind: "none" };
}

export type ClientSearchResult = { id: string; name: string; document: string | null; phone: string | null; whatsapp: string | null; email: string | null; archived: boolean };
export const CLIENT_SEARCH_LIMIT = 20;

// Lista do avalista (cadastro do cliente): filtra na hora, no navegador, os clientes da carteira já carregados.
// Vazio mostra todos (em ordem alfabética); letras procuram cada palavra no nome (sem acentos) ou o texto no e-mail;
// números procuram no CPF, telefone e WhatsApp. O próprio cliente em edição fica de fora.
type GuarantorCandidate = { id: string; name: string; document: string | null; phone: string | null; whatsapp: string | null; email?: string | null };
export function filterGuarantorCandidates<T extends GuarantorCandidate>(clients: T[], query: string, excludeId?: string): T[] {
  const words = normalizeName(query).split(" ").filter(Boolean);
  const digits = query.replace(/\D/g, "");
  const hasLetters = /\p{L}/u.test(query);
  return clients
    .filter((client) => client.id !== excludeId)
    .filter((client) => {
      if (words.length === 0) return true;
      if (hasLetters || query.includes("@")) {
        const name = normalizeName(client.name);
        return words.every((word) => name.includes(word)) || (client.email ?? "").toLowerCase().includes(query.trim().toLowerCase());
      }
      return digits.length > 0 && [client.document, client.phone, client.whatsapp].some((value) => (value ?? "").replace(/\D/g, "").includes(digits));
    })
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}
