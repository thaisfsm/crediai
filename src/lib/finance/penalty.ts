// Multa recebida junto com um pagamento de operação.
//
// Classificação: a multa é receita própria (receita de multa). Ela NÃO entra no extrato da operação (operationLedger):
// não é principal, não é juros contratual, não reduz o saldo devedor e não gera comissão de gerente (que é sobre juros).
// O dinheiro entra no caixa como uma linha em capital_movement (tipo OTHER_INCOME, origem FINANCE, o mesmo padrão da taxa
// de resgate dos investidores), ligada ao pagamento pela chave de idempotência `pen-<id do pagamento>`. O índice único
// (tenant, idempotency_key) do banco garante no máximo uma multa por pagamento: registrar, corrigir ou reenviar nunca
// duplica a receita. Sem migração.
import { formatMoney, parseMoneyToCents } from "./format";

export const PENALTY_KEY_PREFIX = "pen-";
export const PENALTY_LABEL = "Multa recebida";
export const PENALTY_MAX_CENTS = 100_000_000_000; // mesmo limite técnico dos demais valores (R$ 1 bilhão)

// Retirar uma multa já lançada: dinheiro do caixa não se apaga (o banco só deixa a administração excluir movimentos). A
// receita é marcada como estornada (a chave muda para pen-void-in-…, liberando pen-<id> para uma multa nova) e entra uma
// saída "Estorno de multa" de mesmo valor e data (pen-void-out-…). As duas se anulam no caixa e ficam no histórico.
export const PENALTY_VOID_IN_PREFIX = `${PENALTY_KEY_PREFIX}void-in-`;
export const PENALTY_VOID_OUT_PREFIX = `${PENALTY_KEY_PREFIX}void-out-`;
export const PENALTY_REVERSAL_LABEL = "Estorno de multa";
export const penaltyKey = (paymentId: string) => `${PENALTY_KEY_PREFIX}${paymentId}`;
export const penaltyVoidKeys = (paymentId: string, stamp: string) => ({ income: `${PENALTY_VOID_IN_PREFIX}${paymentId}-${stamp}`, reversal: `${PENALTY_VOID_OUT_PREFIX}${paymentId}-${stamp}` });
const isVoidKey = (key: string) => key.startsWith(PENALTY_VOID_IN_PREFIX) || key.startsWith(PENALTY_VOID_OUT_PREFIX);
// Pagamento da multa ATIVA (só a chave pen-<id>; as estornadas não contam como multa do pagamento).
export const penaltyPaymentIdOf = (idempotencyKey: string | null | undefined) =>
  idempotencyKey && idempotencyKey.startsWith(PENALTY_KEY_PREFIX) && !isVoidKey(idempotencyKey) && idempotencyKey.length > PENALTY_KEY_PREFIX.length ? idempotencyKey.slice(PENALTY_KEY_PREFIX.length) : null;
// Papel de um movimento de capital ligado a multa: ativa, estornada (receita que foi retirada) ou o estorno (saída).
export type PenaltyRole = "PENALTY" | "PENALTY_VOIDED" | "PENALTY_REVERSAL";
export function penaltyRoleOf(kind: string, idempotencyKey: string | null | undefined): PenaltyRole | null {
  if (!idempotencyKey) return null;
  if (kind === "OTHER_INCOME" && idempotencyKey.startsWith(PENALTY_VOID_IN_PREFIX)) return "PENALTY_VOIDED";
  if (kind === "WITHDRAWAL" && idempotencyKey.startsWith(PENALTY_VOID_OUT_PREFIX)) return "PENALTY_REVERSAL";
  if (kind === "OTHER_INCOME" && penaltyPaymentIdOf(idempotencyKey)) return "PENALTY";
  return null;
}

// Campo "Multa recebida (R$)": vazio ou zero = sem multa (o pagamento funciona como antes). Negativo, texto inválido ou
// acima do limite técnico são recusados.
export function parsePenalty(input: string | null | undefined): { ok: true; cents: number } | { ok: false; error: string } {
  const raw = String(input ?? "").trim();
  if (!raw) return { ok: true, cents: 0 };
  if (raw.startsWith("-")) return { ok: false, error: "A multa recebida não pode ser negativa. Deixe em branco ou 0,00 se não houve multa." };
  const cents = parseMoneyToCents(raw);
  if (cents === null) return { ok: false, error: "Informe a multa recebida em reais, por exemplo 100,00 (ou deixe 0,00)." };
  if (cents > PENALTY_MAX_CENTS) return { ok: false, error: "Multa acima do limite permitido. Confira o número digitado." };
  return { ok: true, cents };
}

// Descrição da receita no Financeiro: identifica a natureza, o cliente e a operação.
export const penaltyDescription = (clientName: string, code: string) => `${PENALTY_LABEL} · ${clientName} · Op. #${code}`;

// Total recebido na tela: parcela (valor destinado ao contrato) + multa.
export const totalReceivedCents = (amountCents: number | null, penaltyCents: number | null) => (amountCents ?? 0) + (penaltyCents ?? 0);

// O que fazer com a linha da multa numa correção de pagamento: nada, criar, atualizar ou retirar.
export type PenaltyChange = { action: "NONE" } | { action: "INSERT"; cents: number } | { action: "UPDATE"; cents: number } | { action: "DELETE" };
export function penaltyChange(previousCents: number, nextCents: number, dateChanged: boolean): PenaltyChange {
  if (previousCents === 0 && nextCents === 0) return { action: "NONE" };
  if (previousCents === 0) return { action: "INSERT", cents: nextCents };
  if (nextCents === 0) return { action: "DELETE" };
  if (previousCents === nextCents && !dateChanged) return { action: "NONE" };
  return { action: "UPDATE", cents: nextCents };
}

// Trecho da observação da receita com o histórico das correções (antes e depois), já que a linha é atualizada no lugar.
export const penaltyRevisionNote = (previousCents: number, nextCents: number, when: string, by: string | null) =>
  `Corrigida em ${when}${by ? ` por ${by}` : ""}: antes ${formatMoney(previousCents)}, depois ${formatMoney(nextCents)}.`;
