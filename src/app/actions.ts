"use server";

import { randomUUID } from "node:crypto";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withTenantContext, type TenantTransaction } from "@/lib/auth/guards";
import { capitalMovements, clients, loanOperations, payments, walletCycles, wallets } from "@/lib/db/schema";
import { formatDate, formatMoney, isIsoDate, normalizeCpf, normalizePhone, parseMoneyToCents, parseRateToBps, todayIso } from "@/lib/finance/format";
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
    await tx.insert(capitalMovements).values({ id: id("cap"), tenantId, kind: "CONTRIBUTION", amountCents, occurredAt, notes, cycleNumber: wallet.cycleNumber });
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
    const client = await tx.query.clients.findFirst({ where: and(eq(clients.id, clientId), eq(clients.tenantId, tenantId), isNull(clients.archivedAt)) });
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
    const client = await tx.query.clients.findFirst({ where: and(eq(clients.id, clientId), eq(clients.tenantId, tenantId), isNull(clients.archivedAt)) });
    if (!client) return { ok: false, error: "Cliente não encontrado nesta carteira." };
    // Trava a carteira do tenant para que duas operações simultâneas não usem o mesmo capital.
    const [wallet] = await tx.select({ initialCapitalCents: wallets.initialCapitalCents, cycleNumber: wallets.cycleNumber }).from(wallets)
      .where(eq(wallets.tenantId, tenantId)).for("update");
    const cycleNumber = wallet?.cycleNumber ?? 1;
    const availableCents = await availableCapitalCents(tx, tenantId, { initialCapitalCents: wallet?.initialCapitalCents ?? 0, cycleNumber });
    if (principalCents > availableCents) {
      return { ok: false, error: `Capital disponível insuficiente. Disponível para novas operações: ${formatMoney(Math.max(availableCents, 0))}.` };
    }
    await tx.insert(loanOperations).values({
      id: id("op"), tenantId, clientId: client.id, principalCents, interestRateBps, loanDate, dueDate, status: "OPEN", cycleNumber, ...calculated,
    });
    return { ok: true, message: `Operação de ${client.name} cadastrada.` };
  });
  if (result.ok) revalidatePath("/");
  return result;
}

// Retirada: dinheiro tirado da carteira. Não pode passar do capital disponível.
export async function registerWithdrawalAction(data: FormData): Promise<ActionResult> {
  const amountCents = parseMoneyToCents(text(data, "amount", 40));
  const occurredAt = text(data, "occurredAt", 10) || todayIso();
  const notes = optional(text(data, "notes", 500));
  if (amountCents === null || amountCents <= 0 || amountCents > MAX_CENTS) return { ok: false, error: "Informe o valor da retirada em reais, por exemplo 2.000,00." };
  if (!isIsoDate(occurredAt)) return { ok: false, error: "Informe a data da retirada." };
  if (occurredAt > todayIso()) return { ok: false, error: "A data da retirada não pode ser depois de hoje." };
  const result = await withTenantContext(async (tx, { tenantId }): Promise<ActionResult> => {
    // Mesma trava da criação de operação: duas saídas simultâneas não usam o mesmo capital.
    const [wallet] = await tx.select({ initialCapitalCents: wallets.initialCapitalCents, cycleNumber: wallets.cycleNumber }).from(wallets).where(eq(wallets.tenantId, tenantId)).for("update");
    if (!wallet) return { ok: false, error: "Defina o capital inicial antes de registrar retiradas." };
    const availableCents = await availableCapitalCents(tx, tenantId, wallet);
    if (amountCents > availableCents) return { ok: false, error: `A retirada não pode ser maior que o capital disponível de ${formatMoney(Math.max(availableCents, 0))}.` };
    await tx.insert(capitalMovements).values({ id: id("cap"), tenantId, kind: "WITHDRAWAL", amountCents, occurredAt, notes, cycleNumber: wallet.cycleNumber });
    return { ok: true, message: `Retirada de ${formatMoney(amountCents)} registrada.` };
  });
  if (result.ok) revalidatePath("/");
  return result;
}

// Estorno de aporte: o aporte original continua no histórico e ganha um movimento de estorno ligado a ele.
export async function reverseContributionAction(data: FormData): Promise<ActionResult> {
  const movementId = text(data, "movementId", 80);
  if (!movementId) return { ok: false, error: "Aporte inválido." };
  const result = await withTenantContext(async (tx, { tenantId }): Promise<ActionResult> => {
    const [wallet] = await tx.select({ initialCapitalCents: wallets.initialCapitalCents, cycleNumber: wallets.cycleNumber }).from(wallets).where(eq(wallets.tenantId, tenantId)).for("update");
    const contribution = wallet && await tx.query.capitalMovements.findFirst({
      where: and(eq(capitalMovements.id, movementId), eq(capitalMovements.tenantId, tenantId), eq(capitalMovements.kind, "CONTRIBUTION"), eq(capitalMovements.cycleNumber, wallet.cycleNumber)),
    });
    if (!wallet || !contribution) return { ok: false, error: "Aporte não encontrado nesta carteira." };
    const existing = await tx.query.capitalMovements.findFirst({ where: and(eq(capitalMovements.tenantId, tenantId), eq(capitalMovements.reversedMovementId, contribution.id)) });
    if (existing) return { ok: false, error: "Este aporte já foi estornado." };
    const availableCents = await availableCapitalCents(tx, tenantId, wallet);
    if (contribution.amountCents > availableCents) {
      return { ok: false, error: `Não é possível estornar ${formatMoney(contribution.amountCents)}: o capital disponível é ${formatMoney(Math.max(availableCents, 0))} e ficaria negativo.` };
    }
    await tx.insert(capitalMovements).values({
      id: id("cap"), tenantId, kind: "CONTRIBUTION_REVERSAL", amountCents: contribution.amountCents, occurredAt: todayIso(), reversedMovementId: contribution.id, cycleNumber: wallet.cycleNumber,
      notes: `Estorno do aporte de ${formatDate(contribution.occurredAt)}${contribution.notes ? ` (${contribution.notes})` : ""}`,
    });
    return { ok: true, message: `Aporte de ${formatMoney(contribution.amountCents)} estornado.` };
  });
  if (result.ok) revalidatePath("/");
  return result;
}

// Exclusão de operação cadastrada por engano ou desistência: só sem pagamentos. Vira CANCELED (exclusão lógica), sai de
// todas as telas e cálculos e devolve o principal ao capital disponível. Com pagamento, fica bloqueada para preservar o histórico.
export async function cancelOperationAction(data: FormData): Promise<ActionResult> {
  const operationId = text(data, "operationId", 80);
  if (!operationId) return { ok: false, error: "Operação inválida." };
  const result = await withTenantContext(async (tx, { tenantId }): Promise<ActionResult> => {
    const [operation] = await tx.select().from(loanOperations)
      .where(and(eq(loanOperations.id, operationId), eq(loanOperations.tenantId, tenantId), eq(loanOperations.cycleNumber, await currentCycle(tx, tenantId))))
      .for("update");
    if (!operation || operation.status === "CANCELED") return { ok: false, error: "Operação não encontrada nesta carteira." };
    const [{ count, paid }] = await tx.select({ count: sql<string>`count(*)`, paid: sql<string>`coalesce(sum(${payments.amountCents}), 0)` }).from(payments)
      .where(and(eq(payments.operationId, operation.id), eq(payments.tenantId, tenantId)));
    if (Number(count) > 0) {
      return { ok: false, error: `Esta operação tem ${formatMoney(Number(paid))} em ${count} pagamento${Number(count) === 1 ? "" : "s"} registrado${Number(count) === 1 ? "" : "s"} e não pode ser excluída.` };
    }
    await tx.update(loanOperations).set({ status: "CANCELED", updatedAt: sql`now()` })
      .where(and(eq(loanOperations.id, operation.id), eq(loanOperations.tenantId, tenantId)));
    return { ok: true, message: `Operação excluída. ${formatMoney(operation.principalCents)} voltaram para o capital disponível.` };
  });
  if (result.ok) revalidatePath("/");
  return result;
}

// Exclusão de cliente: sem nenhuma operação (nem excluída) é apagado de vez; com histórico é arquivado, desde que não
// tenha operação em aberto. A FK RESTRICT de loan_operation impede apagar um cliente com operações.
export async function deleteClientAction(data: FormData): Promise<ActionResult> {
  const clientId = text(data, "clientId", 80);
  if (!clientId) return { ok: false, error: "Cliente inválido." };
  const result = await withTenantContext(async (tx, { tenantId }): Promise<ActionResult> => {
    const [client] = await tx.select().from(clients).where(and(eq(clients.id, clientId), eq(clients.tenantId, tenantId), isNull(clients.archivedAt))).for("update");
    if (!client) return { ok: false, error: "Cliente não encontrado nesta carteira." };
    const rows = await tx.select({ status: loanOperations.status, cycleNumber: loanOperations.cycleNumber }).from(loanOperations)
      .where(and(eq(loanOperations.clientId, client.id), eq(loanOperations.tenantId, tenantId)));
    if (rows.length === 0) {
      await tx.delete(clients).where(and(eq(clients.id, client.id), eq(clients.tenantId, tenantId)));
      return { ok: true, message: `Cliente ${client.name} excluído.` };
    }
    // Operações de ciclos encerrados contam só como histórico.
    const cycleNumber = await currentCycle(tx, tenantId);
    const open = rows.filter((row) => row.status === "OPEN" && row.cycleNumber === cycleNumber).length;
    if (open > 0) return { ok: false, error: `${client.name} tem ${open} operaç${open === 1 ? "ão" : "ões"} em aberto. Registre a quitação ou exclua a operação antes.` };
    await tx.update(clients).set({ archivedAt: sql`now()`, updatedAt: sql`now()` }).where(and(eq(clients.id, client.id), eq(clients.tenantId, tenantId)));
    return { ok: true, message: `Cliente ${client.name} arquivado. O histórico das operações foi mantido.` };
  });
  if (result.ok) revalidatePath("/");
  return result;
}

// Mesmo cálculo do card "Capital disponível" (src/lib/finance/portfolio.ts): capital inicial + aportes − retiradas −
// estornos de aporte − principal das operações + pagamentos recebidos.
// Só o ciclo atual da carteira conta.
async function availableCapitalCents(tx: TenantTransaction, tenantId: string, { initialCapitalCents, cycleNumber }: { initialCapitalCents: number; cycleNumber: number }) {
  // Aporte soma; retirada e estorno de aporte subtraem.
  const [{ movements }] = await tx.select({
    movements: sql<string>`coalesce(sum(case when ${capitalMovements.kind} = 'CONTRIBUTION' then ${capitalMovements.amountCents} else -${capitalMovements.amountCents} end), 0)`,
  }).from(capitalMovements).where(and(eq(capitalMovements.tenantId, tenantId), eq(capitalMovements.cycleNumber, cycleNumber)));
  const [{ lent }] = await tx.select({ lent: sql<string>`coalesce(sum(${loanOperations.principalCents}), 0)` }).from(loanOperations)
    .where(and(eq(loanOperations.tenantId, tenantId), eq(loanOperations.cycleNumber, cycleNumber), ne(loanOperations.status, "CANCELED")));
  const [{ received }] = await tx.select({ received: sql<string>`coalesce(sum(${payments.amountCents}), 0)` }).from(payments)
    .innerJoin(loanOperations, eq(loanOperations.id, payments.operationId))
    .where(and(eq(payments.tenantId, tenantId), eq(loanOperations.cycleNumber, cycleNumber)));
  return initialCapitalCents + Number(movements) - Number(lent) + Number(received);
}

async function currentCycle(tx: TenantTransaction, tenantId: string) {
  const [wallet] = await tx.select({ cycleNumber: wallets.cycleNumber }).from(wallets).where(eq(wallets.tenantId, tenantId));
  return wallet?.cycleNumber ?? 1;
}

const RESET_CONFIRMATION = "ZERAR CARTEIRA"; // mesmo texto pedido na tela de Configurações

// "Zerar carteira": encerra o ciclo financeiro atual e abre o seguinte com capital inicial R$ 0,00. Nada é apagado:
// operações, pagamentos e movimentos de capital ficam no ciclo encerrado e saem dos cards e telas. Clientes, usuários,
// plano e configurações não são tocados. Só afeta a carteira do tenant da sessão.
export async function resetWalletAction(data: FormData): Promise<ActionResult> {
  if (text(data, "confirmation", 40) !== RESET_CONFIRMATION) return { ok: false, error: `Digite ${RESET_CONFIRMATION} para confirmar.` };
  const result = await withTenantContext(async (tx, { tenantId, session }): Promise<ActionResult> => {
    const [wallet] = await tx.select().from(wallets).where(eq(wallets.tenantId, tenantId)).for("update");
    if (!wallet) return { ok: false, error: "Esta carteira ainda não tem capital inicial; não há nada para zerar." };
    await tx.insert(walletCycles).values({
      id: id("cyc"), tenantId, cycleNumber: wallet.cycleNumber, initialCapitalCents: wallet.initialCapitalCents,
      startedAt: wallet.cycleStartedAt ?? wallet.createdAt, closedByUserId: session.user.id,
    });
    await tx.update(wallets).set({ cycleNumber: wallet.cycleNumber + 1, initialCapitalCents: 0, cycleStartedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(wallets.id, wallet.id), eq(wallets.tenantId, tenantId)));
    return { ok: true, message: `Carteira zerada. O ciclo ${wallet.cycleNumber} foi encerrado e guardado; informe o capital inicial do ciclo ${wallet.cycleNumber + 1}.` };
  });
  if (result.ok) revalidatePath("/");
  return result;
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
      .where(and(eq(loanOperations.id, operationId), eq(loanOperations.tenantId, tenantId), eq(loanOperations.cycleNumber, await currentCycle(tx, tenantId))))
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
