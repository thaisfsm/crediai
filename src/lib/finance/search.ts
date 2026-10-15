// Busca global do topo: encontra clientes (nome, CPF, telefone, e-mail) e operações (código ou nome do cliente)
// nos dados já carregados da carteira. Sem acento e sem diferença de maiúsculas; CPF e telefone comparam só dígitos.

export type SearchableClient = { id: string; name: string; document?: string | null; phone?: string | null; email?: string | null };
export type SearchableOperation = { id: string; code: string; clientId: string; clientName: string; status?: string };
export type SearchResult =
  | { kind: "client"; id: string; title: string; detail: string }
  | { kind: "operation"; id: string; clientId: string; title: string; detail: string };

const normalize = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const digits = (value: string) => value.replace(/\D/g, "");

export function searchPortfolio(query: string, clients: SearchableClient[], operations: SearchableOperation[], limit = 8): SearchResult[] {
  const text = normalize(query).replace(/^#/, "");
  if (text.length < 2) return [];
  const numbers = digits(query);
  const results: SearchResult[] = [];

  for (const client of clients) {
    const byText = normalize(client.name).includes(text) || (client.email ? normalize(client.email).includes(text) : false);
    const byDigits = numbers.length >= 3 && [client.document, client.phone].some((field) => field && digits(field).includes(numbers));
    if (byText || byDigits) results.push({ kind: "client", id: client.id, title: client.name, detail: "Cliente" });
  }
  for (const operation of operations) {
    if (normalize(operation.code).includes(text) || normalize(operation.clientName).includes(text)) {
      results.push({ kind: "operation", id: operation.id, clientId: operation.clientId, title: `Op. #${operation.code}`, detail: operation.clientName });
    }
  }
  return results.slice(0, limit);
}
