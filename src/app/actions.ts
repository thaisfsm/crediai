"use server";

import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, ne, or, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withTenantContext, type TenantTransaction } from "@/lib/auth/guards";
import { capitalMovements, clientDocuments, investmentPriorContributions, investors, clients, loanOperationRevisions, loanOperations, loanRenewals, paymentRevisions, payments, tenants, walletCycles, wallets } from "@/lib/db/schema";
import { normalizeEmail, normalizeSocial } from "@/lib/contacts";
import { bankFields, bankKeys } from "@/lib/bank-account";
import { brazilianStates, clientProfileKeys, type ClientProfile } from "@/lib/finance/client-profile";
import { ACCENTED, CLIENT_SEARCH_LIMIT, PLAIN, clientSearchTerms, type ClientSearchResult } from "@/lib/finance/client-search";
import { formatCpf, isValidCpf, formatDate, formatMoney, isIsoDate, normalizeCnpj, normalizeCpf, normalizePhone, onlyDigits, parseMoneyToCents, parseRateToBps, todayIso } from "@/lib/finance/format";
import { recordAdminAudit } from "@/lib/admin/audit";
import { loadAllCyclesOperations } from "@/lib/finance/queries";
import type { OperationView } from "@/lib/finance/portfolio";
import { INFLOW_KINDS, checkInitialCapitalChange, checkOutflow, negativeAfterChange } from "@/lib/finance/cashflow";
import { editReason, operationChanges, type OperationChange, type OperationEditSnapshot } from "@/lib/finance/operation-edit";
import { cycleStartedOn, tenantCapital } from "@/lib/finance/finance-queries";
import { BIWEEKLY_RULE, calculateDaily, calculateFixedInterest, calculateInstallments, calculateOperation, checkPayment, installmentDueDate, interestModeOf, interestOnlyRenewal, operationLedger, type Frequency, type InstallmentFrequency, type LedgerPayment, type LedgerTerms } from "@/lib/finance/rules";

export type ActionResult = { ok: true; message: string } | { ok: false; error: string };

const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
const text = (data: FormData, key: string, max: number) => String(data.get(key) ?? "").trim().slice(0, max);
const optional = (value: string) => (value ? value : null);
const MAX_CENTS = 100_000_000_000; // R$ 1 bilhão: limite técnico contra valores digitados por engano.

// O tenant sempre vem da sessão no servidor (withTenantContext); nenhum identificador de tenant é aceito do navegador.

// Capital inicial: abre o extrato do capital, então mudá-lo desloca todos os saldos. Trava a carteira (como as saídas e
// as operações), recusa uma redução que deixaria algum saldo negativo e registra o antes e o depois na auditoria.
export async function saveWalletAction(data: FormData): Promise<ActionResult> {
  const cents = parseMoneyToCents(text(data, "initialCapital", 40));
  if (cents === null || cents > MAX_CENTS) return { ok: false, error: "Informe o capital inicial em reais, por exemplo 20.000,00." };
  const result = await withTenantContext(async (tx, { tenantId, session }): Promise<ActionResult> => {
    const [wallet] = await tx.select().from(wallets).where(eq(wallets.tenantId, tenantId)).for("update");
    if (wallet && wallet.initialCapitalCents === cents) return { ok: true, message: "Capital inicial salvo." };
    if (wallet && cents < wallet.initialCapitalCents) {
      const capital = await tenantCapital(tx, tenantId);
      const check = checkInitialCapitalChange({ ledger: capital.capitalLedger, previousCents: wallet.initialCapitalCents, nextCents: cents });
      if (!check.ok) return check;
    }
    await tx.insert(wallets).values({ id: id("wal"), tenantId, initialCapitalCents: cents })
      .onConflictDoUpdate({ target: wallets.tenantId, set: { initialCapitalCents: cents, updatedAt: sql`now()` } });
    const tenant = await tx.query.tenants.findFirst({ where: eq(tenants.id, tenantId), columns: { name: true } });
    await recordAdminAudit(tx, session, {
      action: "WALLET_INITIAL_CAPITAL_CHANGED", entity: "wallet", entityId: wallet?.id ?? null, tenantId, tenantName: tenant?.name ?? null,
      before: wallet ? { initialCapitalCents: wallet.initialCapitalCents, cycleNumber: wallet.cycleNumber } : null,
      after: { initialCapitalCents: cents, cycleNumber: wallet?.cycleNumber ?? 1 },
    });
    return { ok: true, message: "Capital inicial salvo." };
  });
  if (result.ok) revalidatePath("/");
  return result;
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
  for (const key of clientProfileKeys) profile[key] = optional(text(data, key, key === "guarantorNotes" ? 500 : key === "instagram" || key === "facebook" ? 250 : 160));
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
  // Contatos: WhatsApp com a regra do telefone, e-mail só no formato básico, redes sociais com @usuário ou endereço.
  const whatsapp = keepLegacy(normalizePhone(profile.whatsapp ?? ""), profile.whatsapp ?? "", previous?.whatsapp);
  if (!whatsapp.ok) return { ok: false as const, error: `WhatsApp: ${whatsapp.error}` };
  profile.whatsapp = whatsapp.value;
  const email = normalizeEmail(profile.email ?? "");
  if (!email.ok) return email;
  profile.email = email.value;
  for (const key of ["instagram", "facebook"] as const) {
    const social = normalizeSocial(profile[key] ?? "");
    if (!social.ok) return { ok: false as const, error: `${key === "instagram" ? "Instagram" : "Facebook"}: ${social.error}` };
    profile[key] = social.value;
  }
  const guarantorDocument = keepLegacy(normalizeCpf(profile.guarantorDocument ?? ""), profile.guarantorDocument ?? "", previous?.guarantorDocument);
  if (!guarantorDocument.ok) return { ok: false as const, error: `CPF do avalista: ${guarantorDocument.error}` };
  profile.guarantorDocument = guarantorDocument.value;
  // Empresa do endereço comercial: CNPJ com dígitos verificadores (vários clientes podem trabalhar na mesma empresa).
  const businessCnpj = normalizeCnpj(profile.businessCnpj ?? "");
  if (!businessCnpj.ok) return { ok: false as const, error: `CNPJ da empresa: ${businessCnpj.error}` };
  profile.businessCnpj = businessCnpj.value;
  // Dados bancários e chave Pix (src/lib/bank-account.ts).
  const bank = bankFields((key, max) => text(data, key, max));
  if (!bank.ok) return bank;
  for (const key of bankKeys) profile[key] = bank.values[key];
  return { ok: true as const, values: { name, document: document.value, phone: phone.value, notes: optional(text(data, "notes", 500)), ...profile } };
}

// O mesmo CPF uma só vez por carteira (clientes arquivados contam). A consulta dá a mensagem com o nome; o índice único
// client_tenant_document_unique garante a regra mesmo com dois cadastros simultâneos.
async function duplicateCpfError(tx: TenantTransaction, tenantId: string, document: string | null, exceptClientId?: string) {
  if (!document) return null;
  const [other] = await tx.select({ name: clients.name, archivedAt: clients.archivedAt }).from(clients)
    .where(and(eq(clients.tenantId, tenantId), eq(clients.document, document), exceptClientId ? ne(clients.id, exceptClientId) : undefined)).limit(1);
  if (!other) return null;
  return `Já existe um cliente com o CPF ${formatCpf(document)} nesta carteira: ${other.name}${other.archivedAt ? " (arquivado)" : ""}.`;
}
const isDuplicateCpf = (error: unknown) => {
  const cause = (error as { cause?: { code?: string; constraint_name?: string } })?.cause ?? (error as { code?: string; constraint_name?: string });
  return cause?.code === "23505" && cause?.constraint_name === "client_tenant_document_unique";
};

export async function createClientAction(data: FormData): Promise<ActionResult> {
  const fields = clientFields(data);
  if (!fields.ok) return fields;
  try {
    const result = await withTenantContext(async (tx, { tenantId }): Promise<ActionResult> => {
      const duplicate = await duplicateCpfError(tx, tenantId, fields.values.document);
      if (duplicate) return { ok: false, error: duplicate };
      await tx.insert(clients).values({ id: id("cli"), tenantId, ...fields.values });
      return { ok: true, message: `Cliente ${fields.values.name} cadastrado.` };
    });
    if (result.ok) revalidatePath("/");
    return result;
  } catch (error) {
    if (isDuplicateCpf(error)) return { ok: false, error: `Já existe um cliente com o CPF ${formatCpf(fields.values.document)} nesta carteira.` };
    throw error;
  }
}

export async function updateClientAction(data: FormData): Promise<ActionResult> {
  const clientId = text(data, "clientId", 80);
  if (!clientId) return { ok: false, error: "Cliente inválido." };
  const result = await withTenantContext(async (tx, { tenantId }): Promise<ActionResult> => {
    const client = await tx.query.clients.findFirst({ where: and(eq(clients.id, clientId), eq(clients.tenantId, tenantId), isNull(clients.archivedAt)) });
    if (!client) return { ok: false, error: "Cliente não encontrado nesta carteira." };
    const fields = clientFields(data, client);
    if (!fields.ok) return fields;
    const duplicate = await duplicateCpfError(tx, tenantId, fields.values.document, client.id);
    if (duplicate) return { ok: false, error: duplicate };
    await tx.update(clients).set({ ...fields.values, updatedAt: sql`now()` }).where(and(eq(clients.id, client.id), eq(clients.tenantId, tenantId)));
    return { ok: true, message: `Cliente ${fields.values.name} atualizado.` };
  }).catch((error: unknown): ActionResult => {
    if (isDuplicateCpf(error)) return { ok: false, error: "Já existe um cliente com este CPF nesta carteira." };
    throw error;
  });
  if (result.ok) revalidatePath("/");
  return result;
}

// Relatório "Todos os ciclos": operações de todos os ciclos da carteira da sessão, já calculadas. Só leitura.
export async function loadAllCyclesReportAction(): Promise<{ ok: true; operations: OperationView[] } | { ok: false; error: string }> {
  return { ok: true, operations: await loadAllCyclesOperations() };
}

// Busca rápida de clientes por nome (sem acentos, partes do nome), CPF ou telefone, formatados ou não. Roda no servidor e
// só na carteira da sessão (tenant_id explícito além do RLS); arquivados aparecem marcados. Não grava nada.
export async function searchClientsAction(query: string): Promise<{ ok: true; results: ClientSearchResult[] } | { ok: false; error: string }> {
  const terms = clientSearchTerms(String(query ?? ""));
  if (terms.kind === "none") return { ok: true, results: [] };
  return withTenantContext(async (tx, { tenantId }) => {
    const plainName = sql`lower(translate(regexp_replace(${clients.name}, '\\s+', ' ', 'g'), ${ACCENTED}, ${PLAIN}))`;
    const escape = (value: string) => value.replace(/[\\%_]/g, (match) => `\\${match}`);
    const match = terms.kind === "name"
      ? and(...terms.words.map((word) => sql`${plainName} like ${`%${escape(word)}%`}`))
      : or(sql`${clients.document} like ${`%${terms.digits}%`}`, sql`${clients.phone} like ${`%${terms.digits}%`}`, sql`${clients.whatsapp} like ${`%${terms.digits}%`}`);
    const rows = await tx.select({ id: clients.id, name: clients.name, document: clients.document, phone: clients.phone, whatsapp: clients.whatsapp, archivedAt: clients.archivedAt })
      .from(clients).where(and(eq(clients.tenantId, tenantId), match))
      .orderBy(sql`${clients.archivedAt} is not null`, asc(clients.name), asc(clients.id)).limit(CLIENT_SEARCH_LIMIT);
    return { ok: true as const, results: rows.map(({ archivedAt, ...row }) => ({ ...row, archived: archivedAt !== null })) };
  });
}

// Preenchimento pelo CPF: procura o CPF digitado nos cadastros da PRÓPRIA carteira (clientes e investidores) e devolve os
// dados de contato e endereço para o formulário preencher só os campos vazios. Não consulta serviço externo e não grava nada.
export type RegisteredPerson = { source: "client" | "investor"; id: string; name: string; values: Record<string, string> };
export async function lookupRegisteredPersonAction(document: string): Promise<{ ok: true; people: RegisteredPerson[] } | { ok: false }> {
  const digits = onlyDigits(String(document ?? ""));
  if (digits.length !== 11 || !isValidCpf(digits)) return { ok: true, people: [] };
  return withTenantContext(async (tx, { tenantId }) => {
    const clean = (entries: Record<string, string | null | undefined>) => Object.fromEntries(Object.entries(entries).filter(([, value]) => value)) as Record<string, string>;
    const clientRows = await tx.select().from(clients).where(and(eq(clients.tenantId, tenantId), eq(clients.document, digits), isNull(clients.archivedAt))).limit(1);
    const investorRows = await tx.select().from(investors).where(and(eq(investors.tenantId, tenantId), eq(investors.document, digits))).limit(1);
    const people: RegisteredPerson[] = [
      ...clientRows.map((row) => ({ source: "client" as const, id: row.id, name: row.name, values: clean({
        name: row.name, phone: row.phone, whatsapp: row.whatsapp, email: row.email, instagram: row.instagram, facebook: row.facebook,
        Cep: row.residentialCep, Street: row.residentialStreet, Number: row.residentialNumber, Complement: row.residentialComplement, District: row.residentialDistrict, City: row.residentialCity, State: row.residentialState }) })),
      ...investorRows.map((row) => ({ source: "investor" as const, id: row.id, name: row.name, values: clean({
        name: row.name, phone: row.phone, whatsapp: row.whatsapp, email: row.email, instagram: row.instagram, facebook: row.facebook,
        Cep: row.addressCep, Street: row.addressStreet, Number: row.addressNumber, Complement: row.addressComplement, District: row.addressDistrict, City: row.addressCity, State: row.addressState }) })),
    ];
    return { ok: true as const, people };
  });
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
    // Periodicidade das parcelas: mensal (padrão, como as operações antigas) ou quinzenal.
    const installmentFrequency: InstallmentFrequency = text(data, "installmentFrequency", 20) === "BIWEEKLY" ? "BIWEEKLY" : "MONTHLY";
    if (principalCents === null || principalCents <= 0 || principalCents > MAX_CENTS) return { ok: false as const, error: "Informe o valor emprestado em reais, por exemplo 10.000,00." };
    if (installmentCents === null || installmentCents <= 0 || installmentCents > MAX_CENTS) return { ok: false as const, error: "Informe o valor de cada parcela em reais, por exemplo 1.200,00." };
    if (!Number.isInteger(installmentCount) || installmentCount < 1 || installmentCount > 360) return { ok: false as const, error: installmentFrequency === "BIWEEKLY" ? "Informe a quantidade de parcelas quinzenais, de 1 a 360." : "Informe o prazo total em meses, de 1 a 360." };
    if (!isIsoDate(firstDueDate)) return { ok: false as const, error: "Informe o primeiro vencimento." };
    if (firstDueDate < loanDate) return { ok: false as const, error: "O primeiro vencimento não pode ser antes da data do empréstimo." };
    const calculated = calculateInstallments({ principalCents, installmentCents, count: installmentCount, frequency: installmentFrequency });
    if (calculated.interestCents < 0) return { ok: false as const, error: `As ${installmentCount} parcelas somam ${formatMoney(calculated.totalCents)}, menos que o valor emprestado de ${formatMoney(principalCents)}.` };
    return {
      ok: true as const, principalCents, loanDate, dueDate: installmentDueDate(firstDueDate, installmentCount, installmentFrequency),
      values: { modality: "INSTALLMENT", frequency: installmentFrequency, installmentCount, installmentCents, firstDueDate, interestRateBps: calculated.interestRateBps, interestCents: calculated.interestCents, totalCents: calculated.totalCents, calculationRule: calculated.calculationRule },
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
    // Empréstimo retroativo: o dinheiro sai na data do empréstimo, então nenhum saldo do extrato a partir dela pode
    // ficar negativo (mesma regra das retiradas e das saídas do Financeiro).
    const negative = negativeAfterChange([...(await tenantCapital(tx, tenantId)).capitalLedger].reverse(), { add: { date: loanDate, amountCents: -principalCents } });
    if (negative) return { ok: false, error: capitalGapError("este empréstimo", loanDate, negative) };
    await tx.insert(loanOperations).values({
      id: id("op"), tenantId, clientId: client.id, principalCents, loanDate, dueDate, status: "OPEN", cycleNumber, ...terms.values,
    });
    return { ok: true, message: `Operação de ${client.name} cadastrada.` };
  });
  if (result.ok) revalidatePath("/");
  return result;
}

// ── Correção de operação (Etapa G, parte 1) ──────────────────────────────────────────────────────────────────────────
// Só operação em aberto, do ciclo atual, sem pagamentos e sem renovações (D-G1, opção a): nenhum valor já recebido muda.
// Os termos novos passam pela mesma leitura e pelas mesmas regras do cadastro (operationTermsFromForm); modalidade e
// periodicidade não mudam. Primeiro a prévia (antes e depois, sem gravar); depois a confirmação, com motivo, que grava
// a operação, o histórico (loan_operation_revision) e a auditoria na mesma transação.
export type OperationEditPreview = { ok: true; changes: OperationChange[]; version: string; availableAfterCents: number } | { ok: false; error: string };

const editSnapshot = (operation: typeof loanOperations.$inferSelect, clientName: string): OperationEditSnapshot => ({
  clientId: operation.clientId, clientName, principalCents: operation.principalCents, interestRateBps: operation.interestRateBps, interestCents: operation.interestCents,
  totalCents: operation.totalCents, loanDate: operation.loanDate, dueDate: operation.dueDate, firstDueDate: operation.firstDueDate, installmentCount: operation.installmentCount,
  installmentCents: operation.installmentCents, calculationRule: operation.calculationRule, modality: operation.modality, frequency: operation.frequency,
});

async function planOperationEdit(tx: TenantTransaction, tenantId: string, data: FormData, lock: boolean) {
  const operationId = text(data, "operationId", 80);
  if (!operationId) return { ok: false as const, error: "Operação inválida." };
  const query = tx.select().from(loanOperations)
    .where(and(eq(loanOperations.id, operationId), eq(loanOperations.tenantId, tenantId), eq(loanOperations.cycleNumber, await currentCycle(tx, tenantId))));
  const [operation] = lock ? await query.for("update") : await query;
  if (!operation) return { ok: false as const, error: "Operação não encontrada nesta carteira." };
  if (operation.status !== "OPEN") return { ok: false as const, error: "Só operações em aberto podem ser corrigidas." };
  if (await isRenegotiationContract(tx, tenantId, operation.id)) return { ok: false as const, error: RENEGOTIATION_LOCKED };
  const [paid] = await tx.select({ count: sql<number>`count(*)::int` }).from(payments).where(and(eq(payments.operationId, operation.id), eq(payments.tenantId, tenantId)));
  const [renewed] = await tx.select({ count: sql<number>`count(*)::int` }).from(loanRenewals).where(and(eq(loanRenewals.operationId, operation.id), eq(loanRenewals.tenantId, tenantId)));
  if (paid.count > 0 || renewed.count > 0) return { ok: false as const, error: "Correção bloqueada para preservar o histórico financeiro: esta operação já tem pagamento ou renovação registrados." };
  const terms = operationTermsFromForm(data);
  if (!terms.ok) return terms;
  if (terms.values.modality !== operation.modality || terms.values.frequency !== operation.frequency) {
    return { ok: false as const, error: "A modalidade e a periodicidade não mudam na correção. Para isso, exclua a operação e cadastre de novo." };
  }
  const clientId = text(data, "clientId", 80) || operation.clientId;
  const [client] = await tx.select({ id: clients.id, name: clients.name, archivedAt: clients.archivedAt }).from(clients).where(and(eq(clients.id, clientId), eq(clients.tenantId, tenantId)));
  if (!client || (client.archivedAt && client.id !== operation.clientId)) return { ok: false as const, error: "Cliente não encontrado nesta carteira." };
  const [currentClient] = client.id === operation.clientId ? [client] : await tx.select({ name: clients.name }).from(clients).where(and(eq(clients.id, operation.clientId), eq(clients.tenantId, tenantId)));
  const before = editSnapshot(operation, currentClient?.name ?? "");
  const next = {
    clientId: client.id, principalCents: terms.principalCents, loanDate: terms.loanDate, dueDate: terms.dueDate,
    installmentCount: null, installmentCents: null, ...terms.values,
  };
  const after: OperationEditSnapshot = { ...before, ...next, clientName: client.name, firstDueDate: next.firstDueDate ?? null };
  const [wallet] = await tx.select({ initialCapitalCents: wallets.initialCapitalCents, cycleNumber: wallets.cycleNumber }).from(wallets).where(eq(wallets.tenantId, tenantId));
  // O principal antigo volta ao disponível e o novo sai: só a diferença precisa caber no capital.
  const availableCents = await availableCapitalCents(tx, tenantId, { initialCapitalCents: wallet?.initialCapitalCents ?? 0, cycleNumber: wallet?.cycleNumber ?? 1 });
  const availableAfterCents = availableCents + operation.principalCents - next.principalCents;
  // Valor maior ou data mais antiga: o empréstimo corrigido não pode deixar nenhum saldo do extrato negativo.
  if (next.principalCents > operation.principalCents || next.loanDate < operation.loanDate) {
    const negative = negativeAfterChange([...(await tenantCapital(tx, tenantId)).capitalLedger].reverse(), { removeKey: operation.id, add: { date: next.loanDate, amountCents: -next.principalCents } });
    if (negative && availableAfterCents >= 0) return { ok: false as const, error: capitalGapError("a operação corrigida", next.loanDate, negative) };
  }
  return { ok: true as const, operation, before, after, next, changes: operationChanges(before, after), availableCents, availableAfterCents };
}

export async function previewOperationEditAction(data: FormData): Promise<OperationEditPreview> {
  return withTenantContext(async (tx, { tenantId }): Promise<OperationEditPreview> => {
    const plan = await planOperationEdit(tx, tenantId, data, false);
    if (!plan.ok) return plan;
    if (plan.next.principalCents > plan.operation.principalCents && plan.availableAfterCents < 0) {
      return { ok: false, error: `Capital disponível insuficiente para aumentar o valor. Disponível hoje: ${formatMoney(Math.max(plan.availableCents, 0))}.` };
    }
    return { ok: true, changes: plan.changes, version: plan.operation.updatedAt.toISOString(), availableAfterCents: plan.availableAfterCents };
  });
}

export async function updateOperationAction(data: FormData): Promise<ActionResult> {
  const reason = editReason(text(data, "reason", 400));
  if (!reason.ok) return reason;
  if (text(data, "confirmed", 4) !== "1") return { ok: false, error: "Revise as alterações e confirme." };
  const version = text(data, "version", 40);
  const result = await withTenantContext(async (tx, { tenantId, session }): Promise<ActionResult> => {
    // Mesma trava do cadastro (capital) e a da operação (pagamentos simultâneos esperam esta correção terminar).
    await tx.select({ id: wallets.id }).from(wallets).where(eq(wallets.tenantId, tenantId)).for("update");
    const plan = await planOperationEdit(tx, tenantId, data, true);
    if (!plan.ok) return plan;
    if (plan.operation.updatedAt.toISOString() !== version) return { ok: false, error: "A operação mudou depois da prévia. Revise as alterações de novo." };
    if (plan.changes.length === 0) return { ok: false, error: "Nada foi alterado." };
    if (plan.next.principalCents > plan.operation.principalCents && plan.availableAfterCents < 0) {
      return { ok: false, error: `Capital disponível insuficiente para aumentar o valor. Disponível hoje: ${formatMoney(Math.max(plan.availableCents, 0))}.` };
    }
    const { operation } = plan;
    await tx.update(loanOperations).set({ ...plan.next, updatedAt: sql`now()` }).where(and(eq(loanOperations.id, operation.id), eq(loanOperations.tenantId, tenantId)));
    // Colunas da operação antes e depois (o nome do cliente fica só nos campos alterados).
    const columns = (snapshot: OperationEditSnapshot) => Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== "clientName"));
    const beforeColumns = columns(plan.before);
    const afterColumns = columns(plan.after);
    await tx.insert(loanOperationRevisions).values({
      id: id("opr"), tenantId, operationId: operation.id, reason: reason.value, changes: plan.changes, before: beforeColumns, after: afterColumns, editedByUserId: session.user.id,
    });
    const tenant = await tx.query.tenants.findFirst({ where: eq(tenants.id, tenantId), columns: { name: true } });
    await recordAdminAudit(tx, session, {
      action: "OPERATION_UPDATED", entity: "loan_operation", entityId: operation.id, tenantId, tenantName: tenant?.name ?? null,
      before: beforeColumns, after: afterColumns, description: `Operação corrigida: ${reason.value}`,
    });
    return { ok: true, message: `Operação corrigida (${plan.changes.length} ${plan.changes.length === 1 ? "campo" : "campos"}).` };
  });
  if (result.ok) revalidatePath("/");
  return result;
}

// Retirada (tela Capital, sem categoria): dinheiro tirado da carteira. Mesmas regras de saldo e de data das saídas do
// Financeiro: não pode deixar o capital disponível negativo nem hoje nem em nenhum saldo depois da data escolhida.
export async function registerWithdrawalAction(data: FormData): Promise<ActionResult> {
  const amountCents = parseMoneyToCents(text(data, "amount", 40));
  const occurredAt = text(data, "occurredAt", 10) || todayIso();
  const notes = optional(text(data, "notes", 500));
  if (amountCents === null || amountCents <= 0 || amountCents > MAX_CENTS) return { ok: false, error: "Informe o valor da retirada em reais, por exemplo 2.000,00." };
  if (!isIsoDate(occurredAt)) return { ok: false, error: "Informe a data da retirada." };
  if (occurredAt > todayIso()) return { ok: false, error: "A data da retirada não pode ser depois de hoje." };
  const result = await withTenantContext(async (tx, { tenantId, session }): Promise<ActionResult> => {
    // Mesma trava da criação de operação: duas saídas simultâneas não usam o mesmo capital.
    const [wallet] = await tx.select().from(wallets).where(eq(wallets.tenantId, tenantId)).for("update");
    if (!wallet) return { ok: false, error: "Defina o capital inicial antes de registrar retiradas." };
    const startedOn = cycleStartedOn(wallet);
    if (startedOn && occurredAt < startedOn) return { ok: false, error: `A data da retirada não pode ser anterior ao início do ciclo atual da carteira (${formatDate(startedOn)}).` };
    const availableCents = await availableCapitalCents(tx, tenantId, wallet);
    if (amountCents > availableCents) return { ok: false, error: `A retirada não pode ser maior que o capital disponível de ${formatMoney(Math.max(availableCents, 0))}.` };
    const capital = await tenantCapital(tx, tenantId);
    const check = checkOutflow({ ledger: [...capital.capitalLedger].reverse(), amountCents, occurredAt, availableCents: capital.summary.availableCents });
    if (!check.ok) return check;
    await tx.insert(capitalMovements).values({ id: id("cap"), tenantId, kind: "WITHDRAWAL", amountCents, occurredAt, notes, cycleNumber: wallet.cycleNumber, createdByUserId: session.user.id });
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
    // A entrada de um contrato de investimento não é um aporte comum: fica ligada ao contrato e não se estorna aqui.
    if (contribution.source === "INVESTOR") return { ok: false, error: "Esta entrada pertence a um contrato de investimento e não pode ser estornada como aporte. Nada foi alterado." };
    const existing = await tx.query.capitalMovements.findFirst({ where: and(eq(capitalMovements.tenantId, tenantId), eq(capitalMovements.reversedMovementId, contribution.id)) });
    if (existing) return { ok: false, error: "Este aporte já foi estornado." };
    // Aporte indicado como a entrada do dinheiro de um contrato antigo de investidor: as baixas do contrato dependem dele.
    const [linked] = await tx.select({ id: investmentPriorContributions.id }).from(investmentPriorContributions)
      .where(and(eq(investmentPriorContributions.tenantId, tenantId), eq(investmentPriorContributions.capitalMovementId, contribution.id)));
    if (linked) return { ok: false, error: "Este aporte foi indicado como a entrada do dinheiro de um contrato de investidor e não pode ser estornado. Nada foi alterado." };
    const availableCents = await availableCapitalCents(tx, tenantId, wallet);
    if (contribution.amountCents > availableCents) {
      return { ok: false, error: `Não é possível estornar ${formatMoney(contribution.amountCents)}: o capital disponível é ${formatMoney(Math.max(availableCents, 0))} e ficaria negativo.` };
    }
    // O estorno sai com a data de hoje; operações com data futura também precisam continuar cobertas.
    const capital = await tenantCapital(tx, tenantId);
    const check = checkOutflow({ ledger: [...capital.capitalLedger].reverse(), amountCents: contribution.amountCents, occurredAt: todayIso(), availableCents: capital.summary.availableCents });
    if (!check.ok) return check;
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
    if (operation.status === "RENEGOTIATED" || await isRenegotiationContract(tx, tenantId, operation.id)) return { ok: false, error: RENEGOTIATION_LOCKED };
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

// Mesmo cálculo do card "Capital disponível" (src/lib/finance/portfolio.ts): capital inicial + aportes + outras entradas
// − retiradas e saídas − estornos de aporte − principal das operações + pagamentos recebidos.
// Só o ciclo atual da carteira conta.
async function availableCapitalCents(tx: TenantTransaction, tenantId: string, { initialCapitalCents, cycleNumber }: { initialCapitalCents: number; cycleNumber: number }) {
  // Aporte e outras entradas somam; retiradas (inclusive as saídas do Financeiro) e estorno de aporte subtraem.
  // O sinal de cada tipo vem de INFLOW_KINDS (src/lib/finance/cashflow.ts), o mesmo usado na tela.
  const inflow = sql.join(INFLOW_KINDS.map((kind) => sql`${kind}`), sql`, `);
  const [{ movements }] = await tx.select({
    movements: sql<string>`coalesce(sum(case when ${capitalMovements.kind} in (${inflow}) then ${capitalMovements.amountCents} else -${capitalMovements.amountCents} end), 0)`,
  }).from(capitalMovements).where(and(eq(capitalMovements.tenantId, tenantId), eq(capitalMovements.cycleNumber, cycleNumber)));
  const [{ lent, renegotiated }] = await tx.select({ lent: sql<string>`coalesce(sum(${loanOperations.principalCents}), 0)`, renegotiated: sql<string>`coalesce(sum(${loanOperations.renegotiatedPrincipalCents}), 0)` }).from(loanOperations)
    .where(and(eq(loanOperations.tenantId, tenantId), eq(loanOperations.cycleNumber, cycleNumber), ne(loanOperations.status, "CANCELED")));
  const [{ received }] = await tx.select({ received: sql<string>`coalesce(sum(${payments.amountCents}), 0)` }).from(payments)
    .innerJoin(loanOperations, eq(loanOperations.id, payments.operationId))
    .where(and(eq(payments.tenantId, tenantId), eq(loanOperations.cycleNumber, cycleNumber)));
  return initialCapitalCents + Number(movements) - Number(lent) + Number(renegotiated) + Number(received);
}

// Mensagem quando a mudança deixaria algum saldo do extrato do capital negativo.
const capitalGapError = (what: string, date: string, negative: { date: string; balanceCents: number }) =>
  `Capital insuficiente: com ${what} em ${formatDate(date)}, o saldo de ${formatDate(negative.date)} ficaria negativo (${formatMoney(negative.balanceCents)}). Confira a data e o valor. Nada foi registrado.`;

// Contrato criado por uma renegociação: o principal dele é o das operações antigas, então ele não é editado nem excluído
// (o vínculo e o capital deixariam de bater). Para mudar, renegocia-se de novo.
async function isRenegotiationContract(tx: TenantTransaction, tenantId: string, operationId: string) {
  const [row] = await tx.select({ id: loanOperations.id }).from(loanOperations)
    .where(and(eq(loanOperations.tenantId, tenantId), eq(loanOperations.renegotiatedIntoId, operationId))).limit(1);
  return Boolean(row);
}
const RENEGOTIATION_LOCKED = "Esta operação faz parte de uma renegociação e não pode ser alterada ou excluída. Para mudar as condições, renegocie de novo.";

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
  // Pagamento só entra no capital e no lucro quando o dinheiro chegou: data futura não é aceita.
  if (paidAt > todayIso()) return { ok: false, error: "A data do pagamento não pode ser depois de hoje." };
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
  if (paidAt > todayIso()) return { ok: false, error: "A data do pagamento não pode ser depois de hoje." };
  const result = await withTenantContext(async (tx, { tenantId, session }): Promise<ActionResult> => {
    // Mesma ordem de travas da criação de operação e do pagamento: carteira, depois operação.
    const [wallet] = await tx.select({ initialCapitalCents: wallets.initialCapitalCents, cycleNumber: wallets.cycleNumber }).from(wallets).where(eq(wallets.tenantId, tenantId)).for("update");
    const [payment] = await tx.select().from(payments).where(and(eq(payments.id, paymentId), eq(payments.tenantId, tenantId)));
    if (!wallet || !payment) return { ok: false, error: "Pagamento não encontrado nesta carteira." };
    const [operation] = await tx.select().from(loanOperations)
      .where(and(eq(loanOperations.id, payment.operationId), eq(loanOperations.tenantId, tenantId), eq(loanOperations.cycleNumber, wallet.cycleNumber)))
      .for("update");
    if (!operation || operation.status === "CANCELED") return { ok: false, error: "Pagamento não encontrado nesta carteira." };
    if (operation.status === "RENEGOTIATED") return { ok: false, error: "Esta operação foi renegociada; o histórico dela não pode mais ser alterado." };
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
    // Pagamento menor ou mais tarde: o dinheiro entra depois (ou menos), e uma saída feita no meio pode ficar sem cobertura.
    if (amountCents < payment.amountCents || paidAt > payment.paidAt) {
      const negative = negativeAfterChange([...(await tenantCapital(tx, tenantId)).capitalLedger].reverse(), { removeKey: payment.id, add: { date: paidAt, amountCents } });
      if (negative) return { ok: false, error: capitalGapError("o pagamento corrigido", paidAt, negative) };
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
