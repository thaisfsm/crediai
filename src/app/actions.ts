"use server";

import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withTenantContext, type TenantTransaction } from "@/lib/auth/guards";
import { capitalMovements, clientDocuments, clients, loanOperations, loanRenewals, paymentRevisions, payments, walletCycles, wallets } from "@/lib/db/schema";
import { brazilianStates, clientProfileKeys, type ClientProfile } from "@/lib/finance/client-profile";
import { formatDate, formatMoney, isIsoDate, normalizeCpf, normalizePhone, onlyDigits, parseMoneyToCents, parseRateToBps, todayIso } from "@/lib/finance/format";
import { BIWEEKLY_RULE, calculateDaily, calculateFixedInterest, calculateInstallments, calculateOperation, checkPayment, installmentDueDate, interestModeOf, interestOnlyRenewal, operationLedger, type Frequency, type LedgerPayment, type LedgerTerms } from "@/lib/finance/rules";

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
function clientFields(data: FormData, previous?: { document: string | null; phone: string | null } & Partial<ClientProfile>) {
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
  // Cadastro completo (endereços, referências, avalista): texto livre, CEP e UF conferidos; telefones e CPF do avalista
  // com a mesma regra do cliente.
  const profile = {} as ClientProfile;
  for (const key of clientProfileKeys) profile[key] = optional(text(data, key, key === "guarantorNotes" ? 500 : 160));
  for (const key of ["residentialCep", "businessCep"] as const) {
    const cep = onlyDigits(profile[key] ?? "");
    if (profile[key] && cep.length !== 8) return { ok: false as const, error: "O CEP precisa ter 8 dígitos, por exemplo 01310-100." };
    profile[key] = cep || null;
  }
  for (const key of ["residentialState", "businessState"] as const) {
    const state = profile[key]?.toUpperCase() ?? null;
    if (state && !brazilianStates.includes(state)) return { ok: false as const, error: "Escolha o estado (UF) na lista, por exemplo SP." };
    profile[key] = state;
  }
  for (const key of ["reference1Phone", "reference2Phone", "guarantorPhone"] as const) {
    const checked = keepLegacy(normalizePhone(profile[key] ?? ""), profile[key] ?? "", previous?.[key]);
    if (!checked.ok) return { ok: false as const, error: `${key === "guarantorPhone" ? "Telefone do avalista" : `Telefone da referência ${key[9]}`}: ${checked.error}` };
    profile[key] = checked.value;
  }
  const guarantorDocument = keepLegacy(normalizeCpf(profile.guarantorDocument ?? ""), profile.guarantorDocument ?? "", previous?.guarantorDocument);
  if (!guarantorDocument.ok) return { ok: false as const, error: `CPF do avalista: ${guarantorDocument.error}` };
  profile.guarantorDocument = guarantorDocument.value;
  return { ok: true as const, values: { name, document: document.value, phone: phone.value, notes: optional(text(data, "notes", 500)), ...profile } };
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

// Modalidades (regras em src/lib/finance/rules.ts):
//  • Pagamento único mensal ou quinzenal: principal + taxa do período; pagando só os juros, o período é renovado.
//  • Pagamento único diário: principal + taxa do período, total dividido em N pagamentos diários.
//  • Parcelado: valor emprestado, parcela fixa, primeiro vencimento e prazo em meses (taxa simples calculada pelo sistema).
function operationTermsFromForm(data: FormData) {
  const loanDate = text(data, "loanDate", 10);
  if (!isIsoDate(loanDate)) return { ok: false as const, error: "Informe a data do empréstimo." };
  if (text(data, "modality", 20) === "INSTALLMENT") {
    const principalCents = parseMoneyToCents(text(data, "loanAmount", 40));
    const installmentCents = parseMoneyToCents(text(data, "installment", 40));
    const termInput = text(data, "term", 10);
    const installmentCount = /^\d+$/.test(termInput) ? Number(termInput) : NaN;
    const firstDueDate = text(data, "firstDueDate", 10);
    if (principalCents === null || principalCents <= 0 || principalCents > MAX_CENTS) return { ok: false as const, error: "Informe o valor emprestado em reais, por exemplo 10.000,00." };
    if (installmentCents === null || installmentCents <= 0 || installmentCents > MAX_CENTS) return { ok: false as const, error: "Informe o valor de cada parcela em reais, por exemplo 1.200,00." };
    if (!Number.isInteger(installmentCount) || installmentCount < 1 || installmentCount > 360) return { ok: false as const, error: "Informe o prazo total em meses, de 1 a 360." };
    if (!isIsoDate(firstDueDate)) return { ok: false as const, error: "Informe o primeiro vencimento." };
    if (firstDueDate < loanDate) return { ok: false as const, error: "O primeiro vencimento não pode ser antes da data do empréstimo." };
    const calculated = calculateInstallments({ principalCents, installmentCents, count: installmentCount });
    if (calculated.interestCents < 0) return { ok: false as const, error: `As ${installmentCount} parcelas somam ${formatMoney(calculated.totalCents)}, menos que o valor emprestado de ${formatMoney(principalCents)}.` };
    return {
      ok: true as const, principalCents, loanDate, dueDate: installmentDueDate(firstDueDate, installmentCount),
      values: { modality: "INSTALLMENT", frequency: "MONTHLY", installmentCount, installmentCents, firstDueDate, interestRateBps: calculated.interestRateBps, interestCents: calculated.interestCents, totalCents: calculated.totalCents, calculationRule: calculated.calculationRule },
    };
  }
  const frequencyInput = text(data, "frequency", 20);
  const frequency: Frequency = frequencyInput === "BIWEEKLY" || frequencyInput === "DAILY" ? frequencyInput : "MONTHLY";
  const principalCents = parseMoneyToCents(text(data, "principal", 40));
  if (principalCents === null || principalCents <= 0 || principalCents > MAX_CENTS) return { ok: false as const, error: "Informe o valor principal em reais, por exemplo 1.000,00." };
  // Quinzenal com valor fixo de juros por quinzena (ex.: R$ 1.200): o sistema calcula a taxa equivalente.
  const fixedInterest = frequency === "BIWEEKLY" && text(data, "interestMode", 10) === "FIXED";
  const fixedInterestCents = fixedInterest ? parseMoneyToCents(text(data, "interestAmount", 40)) : null;
  if (fixedInterest && (fixedInterestCents === null || fixedInterestCents <= 0 || fixedInterestCents > MAX_CENTS)) return { ok: false as const, error: "Informe os juros por quinzena em reais, por exemplo 1.200,00." };
  const interestRateBps = fixedInterest ? 0 : parseRateToBps(text(data, "rate", 20));
  if (interestRateBps === null || interestRateBps > 100_000) return { ok: false as const, error: "Informe a taxa de juros em %, por exemplo 30." };
  if (frequency === "DAILY") {
    const daysInput = text(data, "days", 10);
    const days = /^\d+$/.test(daysInput) ? Number(daysInput) : NaN;
    const firstDueDate = text(data, "firstDueDate", 10);
    if (!Number.isInteger(days) || days < 1 || days > 365) return { ok: false as const, error: "Informe a quantidade de dias (pagamentos), de 1 a 365." };
    if (!isIsoDate(firstDueDate)) return { ok: false as const, error: "Informe o primeiro vencimento." };
    if (firstDueDate < loanDate) return { ok: false as const, error: "O primeiro vencimento não pode ser antes da data do empréstimo." };
    const plan = calculateDaily({ principalCents, interestRateBps, days, loanDate, firstDueDate });
    return {
      ok: true as const, principalCents, loanDate, dueDate: plan.lastDueDate,
      values: { modality: "SINGLE", frequency, interestRateBps, interestCents: plan.interestCents, totalCents: plan.totalCents, calculationRule: plan.calculationRule, installmentCount: plan.installmentCount, installmentCents: plan.installmentCents, firstDueDate: plan.firstDueDate },
    };
  }
  const dueDate = text(data, "dueDate", 10);
  if (!isIsoDate(dueDate)) return { ok: false as const, error: frequency === "BIWEEKLY" ? "Informe o primeiro vencimento." : "Informe a data de vencimento." };
  if (dueDate < loanDate) return { ok: false as const, error: "O vencimento não pode ser antes da data do empréstimo." };
  if (fixedInterestCents !== null) {
    return { ok: true as const, principalCents, loanDate, dueDate, values: { modality: "SINGLE", frequency, ...calculateFixedInterest({ principalCents, interestCents: fixedInterestCents }), firstDueDate: dueDate } };
  }
  const calculated = calculateOperation({ principalCents, interestRateBps });
  return {
    ok: true as const, principalCents, loanDate, dueDate,
    values: { modality: "SINGLE", frequency, interestRateBps, ...calculated, ...(frequency === "BIWEEKLY" ? { calculationRule: BIWEEKLY_RULE } : {}), firstDueDate: dueDate },
  };
}

export async function createOperationAction(data: FormData): Promise<ActionResult> {
  const clientId = text(data, "clientId", 80);
  if (!clientId) return { ok: false, error: "Selecione o cliente." };
  const terms = operationTermsFromForm(data);
  if (!terms.ok) return terms;
  const { principalCents, loanDate, dueDate } = terms;
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
      id: id("op"), tenantId, clientId: client.id, principalCents, loanDate, dueDate, status: "OPEN", cycleNumber, ...terms.values,
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

type OperationRow = typeof loanOperations.$inferSelect;
// Termos do extrato da operação (rules.ts → operationLedger), iguais aos que a tela usa.
async function ledgerTermsOf(tx: TenantTransaction, tenantId: string, operation: OperationRow): Promise<LedgerTerms> {
  const renewals = await tx.select().from(loanRenewals)
    .where(and(eq(loanRenewals.operationId, operation.id), eq(loanRenewals.tenantId, tenantId))).orderBy(asc(loanRenewals.periodNumber));
  const modality = operation.modality === "INSTALLMENT" ? "INSTALLMENT" : "SINGLE";
  const frequency: Frequency = operation.frequency === "BIWEEKLY" || operation.frequency === "DAILY" ? operation.frequency : "MONTHLY";
  return {
    modality, frequency, interestMode: interestModeOf(operation.calculationRule), principalCents: operation.principalCents, interestRateBps: operation.interestRateBps, interestCents: operation.interestCents,
    firstDueDate: operation.firstDueDate ?? renewals.find((renewal) => renewal.periodNumber === 2)?.previousDueDate ?? operation.dueDate,
    installmentCount: operation.installmentCount, installmentCents: operation.installmentCents,
    renewals: renewals.map((renewal) => ({ paymentId: renewal.paymentId, periodNumber: renewal.periodNumber, previousDueDate: renewal.previousDueDate, newDueDate: renewal.newDueDate, principalBaseCents: renewal.principalBaseCents, interestCents: renewal.interestCents })),
  };
}

async function operationPayments(tx: TenantTransaction, tenantId: string, operationId: string) {
  const rows = await tx.select({ id: payments.id, amountCents: payments.amountCents, paidAt: payments.paidAt, createdAt: payments.createdAt }).from(payments)
    .where(and(eq(payments.operationId, operationId), eq(payments.tenantId, tenantId)));
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

// Cada centavo pago precisa caber no saldo do momento em que foi pago; senão um pagamento posterior passaria do saldo.
function fitsLedger(terms: LedgerTerms, list: LedgerPayment[], ledger: ReturnType<typeof operationLedger>) {
  const sum = list.reduce((total, payment) => total + payment.amountCents, 0);
  return ledger.paidCents === sum && sum <= terms.principalCents + ledger.interestCents;
}

// Registra um pagamento. A divisão entre juros e principal, o período, o vencimento, o saldo e a quitação vêm de
// operationLedger (rules.ts). Pagamento somente de juros (valor = juros que faltam do período, com principal em aberto),
// no mensal e no quinzenal: renova o período na hora, com o vencimento padrão da periodicidade ou a data informada.
export async function registerPaymentAction(data: FormData): Promise<ActionResult> {
  const operationId = text(data, "operationId", 80);
  const amountCents = parseMoneyToCents(text(data, "amount", 40));
  const paidAt = text(data, "paidAt", 10) || todayIso();
  const notes = optional(text(data, "notes", 500));
  const newDueDateInput = text(data, "newDueDate", 10);
  if (newDueDateInput && !isIsoDate(newDueDateInput)) return { ok: false, error: "Informe o novo vencimento." };
  if (!operationId) return { ok: false, error: "Operação inválida." };
  if (amountCents === null || amountCents <= 0) return { ok: false, error: "Informe o valor recebido, por exemplo 300,00." };
  if (!isIsoDate(paidAt)) return { ok: false, error: "Informe a data do pagamento." };
  const result = await withTenantContext(async (tx, { tenantId, session }): Promise<ActionResult> => {
    // Trava a operação para que dois pagamentos simultâneos não passem do saldo.
    const [operation] = await tx.select().from(loanOperations)
      .where(and(eq(loanOperations.id, operationId), eq(loanOperations.tenantId, tenantId), eq(loanOperations.cycleNumber, await currentCycle(tx, tenantId))))
      .for("update");
    if (!operation) return { ok: false, error: "Operação não encontrada nesta carteira." };
    if (operation.status !== "OPEN") return { ok: false, error: "Esta operação já não está em aberto." };
    if (paidAt < operation.loanDate) return { ok: false, error: "O pagamento não pode ser antes da data do empréstimo." };
    const previous = await operationPayments(tx, tenantId, operation.id);
    const terms = await ledgerTermsOf(tx, tenantId, operation);
    const today = todayIso();
    const paymentId = id("pay");
    const list = [...previous, { id: paymentId, amountCents, paidAt, createdAt: new Date().toISOString() }];
    const after = operationLedger(terms, list, today);
    const item = after.items.find((entry) => entry.id === paymentId)!;
    const check = checkPayment({ amountCents, balanceCents: item.balanceBeforeCents, formatMoney });
    if (!check.ok) return check;
    if (!fitsLedger(terms, list, after)) return { ok: false, error: "Com esta data, os pagamentos registrados depois dela passariam do saldo da operação. Confira a data do pagamento." };
    // Renovação na hora só para o pagamento mais recente (os retroativos renovam no vencimento, pela mesma regra).
    const latest = previous.every((payment) => payment.paidAt <= paidAt);
    const before = operationLedger(terms, previous, paidAt);
    const renewal = latest ? interestOnlyRenewal(terms, before, amountCents) : null;
    if (newDueDateInput && !renewal) {
      return { ok: false, error: `Novo vencimento só vale para o pagamento somente dos juros do período (${formatMoney(before.interestRemainingCents)}).` };
    }
    if (renewal) {
      const newDueDate = newDueDateInput || renewal.defaultNewDueDate;
      if (newDueDate <= renewal.previousDueDate) return { ok: false, error: `O novo vencimento precisa ser depois do vencimento atual (${formatDate(renewal.previousDueDate)}).` };
      await tx.insert(payments).values({ id: paymentId, tenantId, operationId: operation.id, amountCents, paidAt, notes });
      await tx.insert(loanRenewals).values({
        id: id("ren"), tenantId, operationId: operation.id, paymentId, periodNumber: before.periodNumber + 1, previousDueDate: renewal.previousDueDate, newDueDate,
        principalBaseCents: renewal.principalBaseCents, interestCents: renewal.nextInterestCents, createdByUserId: session.user.id,
      });
      // first_due_date guarda o primeiro vencimento combinado (operações antigas não o tinham).
      await tx.update(loanOperations).set({ dueDate: newDueDate, firstDueDate: terms.firstDueDate, updatedAt: sql`now()` })
        .where(and(eq(loanOperations.id, operation.id), eq(loanOperations.tenantId, tenantId)));
      return {
        ok: true,
        message: `Pagamento somente de juros de ${formatMoney(amountCents)} registrado. Período renovado até ${formatDate(newDueDate)}. Valor para quitação: ${formatMoney(renewal.principalBaseCents + renewal.nextInterestCents)}.`,
      };
    }
    await tx.insert(payments).values({ id: paymentId, tenantId, operationId: operation.id, amountCents, paidAt, notes });
    if (after.balanceCents === 0) {
      const settledAt = list.reduce((latestDate, payment) => (payment.paidAt > latestDate ? payment.paidAt : latestDate), paidAt);
      await tx.update(loanOperations).set({ status: "PAID", settledAt, updatedAt: sql`now()` })
        .where(and(eq(loanOperations.id, operation.id), eq(loanOperations.tenantId, tenantId)));
      return { ok: true, message: `Pagamento de ${formatMoney(amountCents)} registrado. Operação quitada.` };
    }
    return { ok: true, message: `Pagamento de ${formatMoney(amountCents)} registrado. Saldo em aberto: ${formatMoney(after.balanceCents)}. Próximo vencimento: ${formatDate(after.nextDueDate)}.` };
  });
  if (result.ok) revalidatePath("/");
  return result;
}

// Correção de um pagamento já registrado (valor, data e observação). O pagamento continua sendo o mesmo (nada é duplicado)
// e os valores de antes ficam em payment_revision. Saldo, juros e principal recebidos, situação da operação e capital
// disponível são recalculados a partir dos pagamentos, pela mesma regra de rules.ts.
export async function editPaymentAction(data: FormData): Promise<ActionResult> {
  const paymentId = text(data, "paymentId", 80);
  const amountCents = parseMoneyToCents(text(data, "amount", 40));
  const paidAt = text(data, "paidAt", 10);
  const notes = optional(text(data, "notes", 500));
  if (!paymentId) return { ok: false, error: "Pagamento inválido." };
  if (amountCents === null || amountCents <= 0) return { ok: false, error: "Informe o valor recebido, por exemplo 300,00." };
  if (!isIsoDate(paidAt)) return { ok: false, error: "Informe a data do pagamento." };
  const result = await withTenantContext(async (tx, { tenantId, session }): Promise<ActionResult> => {
    // Mesma ordem de travas da criação de operação e do pagamento: carteira, depois operação.
    const [wallet] = await tx.select({ initialCapitalCents: wallets.initialCapitalCents, cycleNumber: wallets.cycleNumber }).from(wallets).where(eq(wallets.tenantId, tenantId)).for("update");
    const [payment] = await tx.select().from(payments).where(and(eq(payments.id, paymentId), eq(payments.tenantId, tenantId)));
    if (!wallet || !payment) return { ok: false, error: "Pagamento não encontrado nesta carteira." };
    const [operation] = await tx.select().from(loanOperations)
      .where(and(eq(loanOperations.id, payment.operationId), eq(loanOperations.tenantId, tenantId), eq(loanOperations.cycleNumber, wallet.cycleNumber)))
      .for("update");
    if (!operation || operation.status === "CANCELED") return { ok: false, error: "Pagamento não encontrado nesta carteira." };
    if (paidAt < operation.loanDate) return { ok: false, error: "O pagamento não pode ser antes da data do empréstimo." };
    if (amountCents === payment.amountCents && paidAt === payment.paidAt && notes === payment.notes) return { ok: false, error: "Nada foi alterado neste pagamento." };
    const terms = await ledgerTermsOf(tx, tenantId, operation);
    const renewalPaymentIds = new Set(terms.renewals.map((renewal) => renewal.paymentId));
    // O pagamento que renovou um período pagou os juros daquele período (o valor registrado na época). Pode ser corrigido
    // para mais (o excedente abate o principal) e a renovação continua; para menos, os juros do período ficariam sem pagar.
    if (renewalPaymentIds.has(payment.id)) {
      const [first] = await tx.select({ previousAmountCents: paymentRevisions.previousAmountCents }).from(paymentRevisions)
        .where(and(eq(paymentRevisions.paymentId, payment.id), eq(paymentRevisions.tenantId, tenantId))).orderBy(asc(paymentRevisions.editedAt)).limit(1);
      const renewedInterestCents = first?.previousAmountCents ?? payment.amountCents;
      if (amountCents < renewedInterestCents) {
        return { ok: false, error: `Este pagamento renovou o período pagando ${formatMoney(renewedInterestCents)} de juros; o valor não pode ficar menor que isso.` };
      }
    }
    const all = await operationPayments(tx, tenantId, operation.id);
    const others = all.filter((item) => item.id !== payment.id);
    const list = [...others, { id: payment.id, amountCents, paidAt, createdAt: payment.createdAt.toISOString() }];
    const after = operationLedger(terms, list, todayIso());
    const edited = after.items.find((item) => item.id === payment.id)!;
    if (amountCents > edited.balanceBeforeCents || !fitsLedger(terms, list, after)) {
      return { ok: false, error: `O pagamento não pode ser maior que ${formatMoney(edited.balanceBeforeCents)}, o saldo da operação nessa data sem este pagamento.` };
    }
    // Diminuir um pagamento tira dinheiro do capital disponível; não pode deixá-lo negativo.
    if (amountCents < payment.amountCents) {
      const availableCents = await availableCapitalCents(tx, tenantId, wallet);
      if (availableCents - (payment.amountCents - amountCents) < 0) {
        return { ok: false, error: `Não é possível reduzir este pagamento em ${formatMoney(payment.amountCents - amountCents)}: o capital disponível é ${formatMoney(Math.max(availableCents, 0))} e ficaria negativo.` };
      }
    }
    await tx.insert(paymentRevisions).values({
      id: id("rev"), tenantId, paymentId: payment.id, previousAmountCents: payment.amountCents, previousPaidAt: payment.paidAt, previousNotes: payment.notes,
      amountCents, paidAt, notes, editedByUserId: session.user.id,
    });
    await tx.update(payments).set({ amountCents, paidAt, notes }).where(and(eq(payments.id, payment.id), eq(payments.tenantId, tenantId)));
    // Situação da operação conforme o novo total: quitada (data do último pagamento) ou de volta para em aberto.
    const settles = after.balanceCents === 0;
    const settledAt = settles ? others.reduce((latest, item) => (item.paidAt > latest ? item.paidAt : latest), paidAt) : null;
    await tx.update(loanOperations).set({ status: settles ? "PAID" : "OPEN", settledAt, updatedAt: sql`now()` })
      .where(and(eq(loanOperations.id, operation.id), eq(loanOperations.tenantId, tenantId)));
    const reopened = operation.status === "PAID" && !settles;
    return { ok: true, message: `Pagamento corrigido para ${formatMoney(amountCents)} em ${formatDate(paidAt)}.${settles ? " Operação quitada." : reopened ? " A operação voltou a ficar em aberto." : ` Saldo em aberto: ${formatMoney(after.balanceCents)}.`}` };
  });
  if (result.ok) revalidatePath("/");
  return result;
}

// Documentos do cliente: PDF ou imagem de até 5 MB, gravados ligados ao cliente do mesmo tenant.
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const documentTypes: Record<string, (bytes: Buffer) => boolean> = {
  "application/pdf": (bytes) => bytes.subarray(0, 5).toString("latin1") === "%PDF-",
  "image/jpeg": (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  "image/png": (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/webp": (bytes) => bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP",
};

export async function uploadClientDocumentAction(data: FormData): Promise<ActionResult> {
  const clientId = text(data, "clientId", 80);
  const label = text(data, "label", 120);
  const file = data.get("file");
  if (!clientId) return { ok: false, error: "Cliente inválido." };
  if (!label) return { ok: false, error: "Informe o que é o documento, por exemplo RG ou comprovante de residência." };
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Escolha o arquivo do documento." };
  if (file.size > MAX_DOCUMENT_BYTES) return { ok: false, error: "O arquivo pode ter no máximo 5 MB." };
  const content = Buffer.from(await file.arrayBuffer());
  // O tipo é conferido pelo conteúdo do arquivo, não só pela extensão.
  const contentType = Object.keys(documentTypes).find((type) => documentTypes[type](content));
  if (!contentType) return { ok: false, error: "Envie um PDF ou uma imagem (JPG, PNG ou WEBP)." };
  const fileName = file.name.replace(/[\\/\r\n"]/g, "_").slice(0, 160) || "documento";
  const result = await withTenantContext(async (tx, { tenantId, session }): Promise<ActionResult> => {
    const client = await tx.query.clients.findFirst({ where: and(eq(clients.id, clientId), eq(clients.tenantId, tenantId), isNull(clients.archivedAt)) });
    if (!client) return { ok: false, error: "Cliente não encontrado nesta carteira." };
    await tx.insert(clientDocuments).values({ id: id("doc"), tenantId, clientId: client.id, label, fileName, contentType, sizeBytes: content.length, content, uploadedByUserId: session.user.id });
    return { ok: true, message: `Documento "${label}" anexado ao cadastro de ${client.name}.` };
  });
  if (result.ok) revalidatePath("/");
  return result;
}

export async function deleteClientDocumentAction(data: FormData): Promise<ActionResult> {
  const documentId = text(data, "documentId", 80);
  if (!documentId) return { ok: false, error: "Documento inválido." };
  const result = await withTenantContext(async (tx, { tenantId }): Promise<ActionResult> => {
    const [removed] = await tx.delete(clientDocuments).where(and(eq(clientDocuments.id, documentId), eq(clientDocuments.tenantId, tenantId)))
      .returning({ label: clientDocuments.label });
    if (!removed) return { ok: false, error: "Documento não encontrado nesta carteira." };
    return { ok: true, message: `Documento "${removed.label}" excluído.` };
  });
  if (result.ok) revalidatePath("/");
  return result;
}
