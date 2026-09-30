"use server";

import { randomUUID } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withTenantContext, type TenantTransaction } from "@/lib/auth/guards";
import { clients, loanOperations, payments, wallets } from "@/lib/db/schema";
import { formatMoney, isIsoDate, parseMoneyToCents, parseRateToBps, todayIso } from "@/lib/finance/format";
import { calculateOperation } from "@/lib/finance/rules";

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

export async function createClientAction(data: FormData): Promise<ActionResult> {
  const name = text(data, "name", 120);
  if (!name) return { ok: false, error: "Informe o nome do cliente." };
  await withTenantContext(async (tx, { tenantId }) => {
    await tx.insert(clients).values({
      id: id("cli"), tenantId, name,
      document: optional(text(data, "document", 40)), phone: optional(text(data, "phone", 40)), notes: optional(text(data, "notes", 500)),
    });
  });
  revalidatePath("/");
  return { ok: true, message: `Cliente ${name} cadastrado.` };
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

// Mesmo cálculo do card "Capital disponível" (src/lib/finance/portfolio.ts): o principal sai do caixa quando a
// operação é criada e volta, com os juros, nos pagamentos recebidos.
async function availableCapitalCents(tx: TenantTransaction, tenantId: string, initialCapitalCents: number) {
  const [{ lent }] = await tx.select({ lent: sql<string>`coalesce(sum(${loanOperations.principalCents}), 0)` }).from(loanOperations)
    .where(and(eq(loanOperations.tenantId, tenantId), ne(loanOperations.status, "CANCELED")));
  const [{ received }] = await tx.select({ received: sql<string>`coalesce(sum(${payments.amountCents}), 0)` }).from(payments)
    .where(eq(payments.tenantId, tenantId));
  return initialCapitalCents - Number(lent) + Number(received);
}

// Registra a quitação total do saldo em aberto. Pagamentos parciais dependem da regra de apropriação, ainda não definida.
export async function settleOperationAction(data: FormData): Promise<ActionResult> {
  const operationId = text(data, "operationId", 80);
  const paidAt = text(data, "paidAt", 10) || todayIso();
  if (!operationId) return { ok: false, error: "Operação inválida." };
  if (!isIsoDate(paidAt)) return { ok: false, error: "Informe a data do pagamento." };
  const result = await withTenantContext(async (tx, { tenantId }) => {
    const [operation] = await tx.select().from(loanOperations)
      .where(and(eq(loanOperations.id, operationId), eq(loanOperations.tenantId, tenantId)))
      .for("update");
    if (!operation) return { ok: false as const, error: "Operação não encontrada nesta carteira." };
    if (operation.status !== "OPEN") return { ok: false as const, error: "Esta operação já não está em aberto." };
    if (paidAt < operation.loanDate) return { ok: false as const, error: "O pagamento não pode ser antes da data do empréstimo." };
    const [{ paid }] = await tx.select({ paid: sql<string>`coalesce(sum(${payments.amountCents}), 0)` }).from(payments)
      .where(and(eq(payments.operationId, operation.id), eq(payments.tenantId, tenantId)));
    const balance = operation.totalCents - Number(paid);
    if (balance > 0) await tx.insert(payments).values({ id: id("pay"), tenantId, operationId: operation.id, amountCents: balance, paidAt, notes: "Quitação total" });
    await tx.update(loanOperations).set({ status: "PAID", settledAt: paidAt, updatedAt: sql`now()` })
      .where(and(eq(loanOperations.id, operation.id), eq(loanOperations.tenantId, tenantId)));
    return { ok: true as const, message: "Quitação registrada." };
  });
  if (result.ok) revalidatePath("/");
  return result;
}
