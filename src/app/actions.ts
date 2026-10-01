"use server";

import { randomUUID } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withTenantContext, type TenantTransaction } from "@/lib/auth/guards";
import { capitalMovements, clients, loanOperations, payments, wallets } from "@/lib/db/schema";
import { formatMoney, isIsoDate, normalizeCpf, normalizePhone, parseMoneyToCents, parseRateToBps, todayIso } from "@/lib/finance/format";
import { allocatePayments, calculateOperation, checkPayment } from "@/lib/finance/rules";

export type ActionResult = { ok: true; message: string } | { ok: false; error: string };

const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
const text = (data: FormData, key: string, max: number) => String(data.get(key) ?? "").trim().slice(0, max);
const optional = (value: string) => (value ? value : null);
const MAX_CENTS = 100_000_000_000; // R$ 1 bilhão: limite técnico contra valores digitados por engano.

// O tenant sempre vem da sessão no servidor (withTenantContext); nenhum identificador de tenant é aceito do navegador.

export async function saveWalletAction(data: FormData): Promise<ActionResult> {
  const cents = parseMoneyToCents(text(data, "initialCapital", 40));
  if (cents === null || cents > MAX_CENTS) return { ok: false, error: "Informe o capital inicial em reais, por exemplo 20.000,00." };
  await withTenantContext(async (tx, { tenantId }) => {
    await tx.insert(wallets).values({ id: id("wal"), tenantId, initialCapitalCents: cents })
      .onConflictDoUpdate({ target: wallets.tenantId, set: { initialCapitalCents: cents, updatedAt: sql`now()` } });
  });
  revalidatePath("/");
  return { ok: true, message: "Capital inicial salvo." };
}

// Aporte: dinheiro novo colocado na carteira depois do capital inicial. Entra no capital disponível na hora.
export async function registerContributionAction(data: FormData): Promise<ActionResult> {
  const amountCents = parseMoneyToCents(text(data, "amount", 40));
  const occurredAt = text(data, "occurredAt", 10) || todayIso();
  const notes = optional(text(data, "notes", 500));
  if (amountCents === null || amountCents <= 0 || amountCents > MAX_CENTS) return { ok: false, error: "Informe o valor do aporte em reais, por exemplo 2.000,00." };
  if (!isIsoDate(occurredAt)) return { ok: false, error: "Informe a data do aporte." };
  if (occurredAt > todayIso()) return { ok: false, error: "A data do aporte não pode ser depois de hoje." };
  const result = await withTenantContext(async (tx, { tenantId }): Promise<ActionResult> => {
    const wallet = await tx.query.wallets.findFirst({ where: eq(wallets.tenantId, tenantId) });
    if (!wallet) return { ok: false, error: "Defina o capital inicial antes de registrar aportes." };
    await tx.insert(capitalMovements).values({ id: id("cap"), tenantId, kind: "CONTRIBUTION", amountCents, occurredAt, notes });
    return { ok: true, message: `Aporte de ${formatMoney(amountCents)} registrado.` };
  });
  if (result.ok) revalidatePath("/");
  return result;
}

// CPF e telefone são gravados só com dígitos e formatados na tela. Um valor antigo fora do padrão (por exemplo um RG),
// reenviado sem alteração na edição, é mantido como está para não impedir a edição de clientes cadastrados antes das máscaras.
function clientFields(data: FormData, previous?: { document: string | null; phone: string | null }) {
  const name = text(data, "name", 120);
  if (!name) return { ok: false as const, error: "Informe o nome do cliente." };
  const documentInput = text(data, "document", 40);
  const phoneInput = text(data, "phone", 40);
  const keepLegacy = <T extends { ok: boolean }>(checked: T, input: string, stored: string | null | undefined) =>
    !checked.ok && previous && input === (stored ?? "") ? { ok: true as const, value: stored ?? null } : checked;
  const document = keepLegacy(normalizeCpf(documentInput), documentInput, previous?.document);
  if (!document.ok) return document;
  const phone = keepLegacy(normalizePhone(phoneInput), phoneInput, previous?.phone);
  if (!phone.ok) return phone;
  return { ok: true as const, values: { name, document: document.value, phone: phone.value, notes: optional(text(data, "notes", 500)) } };
}

export async function createClientAction(data: FormData): Promise<ActionResult> {
  const fields = clientFields(data);
  if (!fields.ok) return fields;
  await withTenantContext(async (tx, { tenantId }) => {
    await tx.insert(clients).values({ id: id("cli"), tenantId, ...fields.values });
  });
  revalidatePath("/");
  return { ok: true, message: `Cliente ${fields.values.name} cadastrado.` };
}

export async function updateClientAction(data: FormData): Promise<ActionResult> {
  const clientId = text(data, "clientId", 80);
  if (!clientId) return { ok: false, error: "Cliente inválido." };
  const result = await withTenantContext(async (tx, { tenantId }): Promise<ActionResult> => {
    const client = await tx.query.clients.findFirst({ where: and(eq(clients.id, clientId), eq(clients.tenantId, tenantId)) });
    if (!client) return { ok: false, error: "Cliente não encontrado nesta carteira." };
    const fields = clientFields(data, client);
    if (!fields.ok) return fields;
    await tx.update(clients).set({ ...fields.values, updatedAt: sql`now()` }).where(and(eq(clients.id, client.id), eq(clients.tenantId, tenantId)));
    return { ok: true, message: `Cliente ${fields.values.name} atualizado.` };
  });
  if (result.ok) revalidatePath("/");
  return result;
}

export async function createOperationAction(data: FormData): Promise<ActionResult> {
  const clientId = text(data, "clientId", 80);
  const principalCents = parseMoneyToCents(text(data, "principal", 40));
  const interestRateBps = parseRateToBps(text(data, "rate", 20));
  const loanDate = text(data, "loanDate", 10);
  const dueDate = text(data, "dueDate", 10);
  if (!clientId) return { ok: false, error: "Selecione o cliente." };
  if (principalCents === null || principalCents <= 0 || principalCents > MAX_CENTS) return { ok: false, error: "Informe o valor principal em reais, por exemplo 1.000,00." };
  if (interestRateBps === null || interestRateBps > 100_000) return { ok: false, error: "Informe a taxa de juros em %, por exemplo 30." };
  if (!isIsoDate(loanDate)) return { ok: false, error: "Informe a data do empréstimo." };
  if (!isIsoDate(dueDate)) return { ok: false, error: "Informe a data de vencimento." };
  if (dueDate < loanDate) return { ok: false, error: "O vencimento não pode ser antes da data do empréstimo." };

  const calculated = calculateOperation({ principalCents, interestRateBps });
  const result = await withTenantContext(async (tx, { tenantId }): Promise<ActionResult> => {
    const client = await tx.query.clients.findFirst({ where: and(eq(clients.id, clientId), eq(clients.tenantId, tenantId)) });
    if (!client) return { ok: false, error: "Cliente não encontrado nesta carteira." };
    // Trava a carteira do tenant para que duas operações simultâneas não usem o mesmo capital.
    const [wallet] = await tx.select({ initialCapitalCents: wallets.initialCapitalCents }).from(wallets)
      .where(eq(wallets.tenantId, tenantId)).for("update");
    const availableCents = await availableCapitalCents(tx, tenantId, wallet?.initialCapitalCents ?? 0);
    if (principalCents > availableCents) {
      return { ok: false, error: `Capital disponível insuficiente. Disponível para novas operações: ${formatMoney(Math.max(availableCents, 0))}.` };
    }
    await tx.insert(loanOperations).values({
      id: id("op"), tenantId, clientId: client.id, principalCents, interestRateBps, loanDate, dueDate, status: "OPEN", ...calculated,
    });
    return { ok: true, message: `Operação de ${client.name} cadastrada.` };
  });
  if (result.ok) revalidatePath("/");
  return result;
}

// Mesmo cálculo do card "Capital disponível" (src/lib/finance/portfolio.ts): capital inicial + aportes − principal das
// operações + pagamentos recebidos.
async function availableCapitalCents(tx: TenantTransaction, tenantId: string, initialCapitalCents: number) {
  const [{ contributed }] = await tx.select({ contributed: sql<string>`coalesce(sum(${capitalMovements.amountCents}), 0)` }).from(capitalMovements)
    .where(and(eq(capitalMovements.tenantId, tenantId), eq(capitalMovements.kind, "CONTRIBUTION")));
  const [{ lent }] = await tx.select({ lent: sql<string>`coalesce(sum(${loanOperations.principalCents}), 0)` }).from(loanOperations)
    .where(and(eq(loanOperations.tenantId, tenantId), ne(loanOperations.status, "CANCELED")));
  const [{ received }] = await tx.select({ received: sql<string>`coalesce(sum(${payments.amountCents}), 0)` }).from(payments)
    .where(eq(payments.tenantId, tenantId));
  return initialCapitalCents + Number(contributed) - Number(lent) + Number(received);
}

// Registra um pagamento (juros, parcial ou quitação). A divisão entre juros e principal e o limite do saldo
// vêm das regras centrais em src/lib/finance/rules.ts. Pagar exatamente o saldo quita a operação.
export async function registerPaymentAction(data: FormData): Promise<ActionResult> {
  const operationId = text(data, "operationId", 80);
  const amountCents = parseMoneyToCents(text(data, "amount", 40));
  const paidAt = text(data, "paidAt", 10) || todayIso();
  const notes = optional(text(data, "notes", 500));
  if (!operationId) return { ok: false, error: "Operação inválida." };
  if (amountCents === null || amountCents <= 0) return { ok: false, error: "Informe o valor recebido, por exemplo 300,00." };
  if (!isIsoDate(paidAt)) return { ok: false, error: "Informe a data do pagamento." };
  if (paidAt > todayIso()) return { ok: false, error: "A data do pagamento não pode ser depois de hoje." };
  const result = await withTenantContext(async (tx, { tenantId }): Promise<ActionResult> => {
    // Trava a operação para que dois pagamentos simultâneos não passem do saldo.
    const [operation] = await tx.select().from(loanOperations)
      .where(and(eq(loanOperations.id, operationId), eq(loanOperations.tenantId, tenantId)))
      .for("update");
    if (!operation) return { ok: false, error: "Operação não encontrada nesta carteira." };
    if (operation.status !== "OPEN") return { ok: false, error: "Esta operação já não está em aberto." };
    if (paidAt < operation.loanDate) return { ok: false, error: "O pagamento não pode ser antes da data do empréstimo." };
    const previous = await tx.select({ id: payments.id, amountCents: payments.amountCents, paidAt: payments.paidAt }).from(payments)
      .where(and(eq(payments.operationId, operation.id), eq(payments.tenantId, tenantId)));
    const before = allocatePayments(operation, previous);
    const check = checkPayment({ amountCents, balanceCents: before.balanceCents, formatMoney });
    if (!check.ok) return check;
    await tx.insert(payments).values({ id: id("pay"), tenantId, operationId: operation.id, amountCents, paidAt, notes });
    if (check.settles) {
      const settledAt = previous.reduce((latest, payment) => (payment.paidAt > latest ? payment.paidAt : latest), paidAt);
      await tx.update(loanOperations).set({ status: "PAID", settledAt, updatedAt: sql`now()` })
        .where(and(eq(loanOperations.id, operation.id), eq(loanOperations.tenantId, tenantId)));
      return { ok: true, message: `Pagamento de ${formatMoney(amountCents)} registrado. Operação quitada.` };
    }
    return { ok: true, message: `Pagamento de ${formatMoney(amountCents)} registrado. Saldo em aberto: ${formatMoney(before.balanceCents - amountCents)}.` };
  });
  if (result.ok) revalidatePath("/");
  return result;
}
