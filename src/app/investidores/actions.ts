"use server";

import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, isNull, max, ne, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { recordAdminAudit, type AuditActor } from "@/lib/admin/audit";
import type { AuditAction } from "@/lib/admin/audit-rules";
import type { TenantTransaction } from "@/lib/auth/guards";
import { bankKeys } from "@/lib/bank-account";
import { investmentContractors, investmentContracts, investmentDocuments, investmentRevisions, investmentScheduleItems, investments, investors, tenants } from "@/lib/db/schema";
import { formatMoney } from "@/lib/finance/format";
import { tenantFilter, withInvestorContext } from "@/lib/investors/access";
import { CONTRACT_TEMPLATE_VERSION, buildContract, contractFileName, contractorFields, missingContractData } from "@/lib/investors/contract";
import { contractFonts } from "@/lib/investors/contract-fonts";
import { renderContractPdf } from "@/lib/investors/contract-pdf";
import { contractDataHash, contractSource, loadContractor } from "@/lib/investors/contract-source";
import {
  DOCUMENT_KINDS, MAX_SCHEDULE_ITEMS, investmentChanges, investmentFields, investorAddressKeys, investorFields, parseDocumentKind, scheduleBuildFields, scheduleItemFields, scheduleSummary,
  type InvestmentValues, type InvestorValues, type ScheduleItemValues,
} from "@/lib/investors/rules";

export type InvestorActionResult = { ok: true; message: string; id?: string } | { ok: false; error: string };

// Toda autorização é feita aqui, no servidor: o tenant vem da sessão (ou, para o MASTER, do registro que ele administra).
// O navegador nunca escolhe o tenant de um usuário comum. Cada alteração grava auditoria na mesma transação.

const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
const reader = (data: FormData) => (key: string, max: number) => String(data.get(key) ?? "").trim().slice(0, max);

// Observações não vão em texto para a auditoria (podem ter dados sensíveis): só se estão preenchidas e o tamanho.
const notesMark = (notes: string | null) => (notes ? `preenchidas (${notes.length} caracteres)` : null);
// Endereço também não vai por extenso: só se está preenchido e a cidade/UF.
const addressMark = (values: { addressStreet: string | null; addressCity: string | null; addressState: string | null; addressCep: string | null }) =>
  values.addressStreet || values.addressCity || values.addressCep ? `preenchido (${[values.addressCity, values.addressState].filter(Boolean).join("/") || "sem cidade"})` : null;
// Dados bancários nunca vão para a auditoria: só se estão preenchidos.
const bankMark = (values: InvestorValues) => (bankKeys.some((key) => values[key]) ? "preenchidos" : null);
function investorSnapshot(values: InvestorValues) {
  const snapshot: Record<string, unknown> = { ...values, notes: notesMark(values.notes), address: addressMark(values), bank: bankMark(values) };
  for (const key of [...investorAddressKeys, ...bankKeys]) delete snapshot[key];
  return snapshot;
}
const investmentSnapshot = (values: InvestmentValues) => ({ ...values, notes: notesMark(values.notes) });

async function tenantName(tx: TenantTransaction, tenantId: string) {
  const [row] = await tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId));
  return row?.name ?? null;
}

async function audit(tx: TenantTransaction, actor: AuditActor, tenantId: string, action: AuditAction, entity: string, entityId: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null, description?: string) {
  await recordAdminAudit(tx, actor, { action, entity, entityId, tenantId, tenantName: await tenantName(tx, tenantId), before, after, description });
}

const violates = (constraint: RegExp) => (error: unknown) => error instanceof Error && constraint.test(`${error.message} ${(error as { cause?: Error }).cause?.message ?? ""}`);
const duplicateDocument = violates(/investor_tenant_document_unique/);
// Dois envios simultâneos de contrato assinado: o índice único garante um só vigente; o segundo recebe esta mensagem.
const duplicateSignedContract = violates(/investment_document_current_contract_unique/);
const SIGNED_CONTRACT_ERROR = { ok: false as const, error: "Este investimento já tem contrato assinado. Use \"Substituir\" para enviar uma nova versão." };
const DUPLICATE_ERROR = { ok: false as const, error: "Já existe um investidor com este CPF/CNPJ nesta carteira." };
const duplicateContractNumber = violates(/investment_tenant_contract_number_unique/);
const CONTRACT_NUMBER_ERROR = { ok: false as const, error: "Já existe um contrato com esta identificação nesta carteira." };

function refresh() {
  revalidatePath("/investidores", "layout");
}

export async function createInvestorAction(data: FormData): Promise<InvestorActionResult> {
  const read = reader(data);
  const fields = investorFields(read);
  if (!fields.ok) return fields;
  try {
    const result = await withInvestorContext(async (tx, scope): Promise<InvestorActionResult> => {
      // Usuário do tenant: sempre a própria carteira. MASTER: a carteira escolhida (precisa existir e não estar encerrada).
      let tenantId = scope.tenantId;
      if (scope.isMaster) {
        const chosen = read("tenantId", 80) || scope.tenantId || "";
        const [tenant] = await tx.select({ id: tenants.id }).from(tenants).where(and(eq(tenants.id, chosen), ne(tenants.status, "CLOSED")));
        tenantId = tenant?.id ?? null;
      }
      if (!tenantId) return { ok: false, error: "Escolha a carteira do investidor." };
      const investorId = id("inv");
      await tx.insert(investors).values({ id: investorId, tenantId, ...fields.values, createdByUserId: scope.user.id });
      await audit(tx, scope, tenantId, "INVESTOR_CREATED", "investor", investorId, null, investorSnapshot(fields.values), `Investidor ${fields.values.name} cadastrado`);
      return { ok: true, message: `Investidor ${fields.values.name} cadastrado.`, id: investorId };
    });
    if (result.ok) refresh();
    return result;
  } catch (error) {
    if (duplicateDocument(error)) return DUPLICATE_ERROR;
    throw error;
  }
}

export async function updateInvestorAction(data: FormData): Promise<InvestorActionResult> {
  const read = reader(data);
  const investorId = read("investorId", 80);
  if (!investorId) return { ok: false, error: "Investidor inválido." };
  const fields = investorFields(read);
  if (!fields.ok) return fields;
  try {
    const result = await withInvestorContext(async (tx, scope): Promise<InvestorActionResult> => {
      const [current] = await tx.select().from(investors).where(and(eq(investors.id, investorId), tenantFilter(scope, investors.tenantId)));
      if (!current) return { ok: false, error: "Investidor não encontrado." };
      await tx.update(investors).set({ ...fields.values, updatedAt: sql`now()` }).where(and(eq(investors.id, current.id), eq(investors.tenantId, current.tenantId)));
      const before = investorSnapshot({
        name: current.name, document: current.document, phone: current.phone, whatsapp: current.whatsapp, email: current.email, instagram: current.instagram, facebook: current.facebook, notes: current.notes, status: current.status,
        ...(Object.fromEntries(investorAddressKeys.map((key) => [key, current[key]])) as Pick<InvestorValues, (typeof investorAddressKeys)[number]>),
        ...(Object.fromEntries(bankKeys.map((key) => [key, current[key]])) as Pick<InvestorValues, (typeof bankKeys)[number]>),
      });
      const after = investorSnapshot(fields.values);
      const { status: statusBefore, ...dataBefore } = before;
      const { status: statusAfter, ...dataAfter } = after;
      if (JSON.stringify(dataBefore) !== JSON.stringify(dataAfter)) await audit(tx, scope, current.tenantId, "INVESTOR_UPDATED", "investor", current.id, dataBefore, dataAfter, `Dados do investidor ${fields.values.name} alterados`);
      if (statusBefore !== statusAfter) await audit(tx, scope, current.tenantId, "INVESTOR_STATUS_CHANGED", "investor", current.id, { status: statusBefore }, { status: statusAfter }, `Status do investidor ${fields.values.name} alterado`);
      return { ok: true, message: `Investidor ${fields.values.name} atualizado.`, id: current.id };
    });
    if (result.ok) refresh();
    return result;
  } catch (error) {
    if (duplicateDocument(error)) return DUPLICATE_ERROR;
    throw error;
  }
}

export async function createInvestmentAction(data: FormData): Promise<InvestorActionResult> {
  const read = reader(data);
  const investorId = read("investorId", 80);
  if (!investorId) return { ok: false, error: "Investidor inválido." };
  const fields = investmentFields(read);
  if (!fields.ok) return fields;
  const result = await withInvestorContext(async (tx, scope): Promise<InvestorActionResult> => {
    const [investor] = await tx.select().from(investors).where(and(eq(investors.id, investorId), tenantFilter(scope, investors.tenantId)));
    if (!investor) return { ok: false, error: "Investidor não encontrado." };
    if (investor.status !== "ACTIVE") return { ok: false, error: "Reative o investidor antes de cadastrar um novo investimento." };
    const investmentId = id("ivt");
    // O contrato fica sempre na carteira do investidor.
    await tx.insert(investments).values({ id: investmentId, tenantId: investor.tenantId, investorId: investor.id, ...fields.values, createdByUserId: scope.user.id });
    await audit(tx, scope, investor.tenantId, "INVESTMENT_CREATED", "investment", investmentId, null, { investorId: investor.id, investorName: investor.name, ...investmentSnapshot(fields.values) },
      `Investimento de ${formatMoney(fields.values.amountCents)} cadastrado para ${investor.name}`);
    return { ok: true, message: `Investimento de ${formatMoney(fields.values.amountCents)} cadastrado para ${investor.name}.`, id: investmentId };
  }).catch((error) => {
    if (duplicateContractNumber(error)) return CONTRACT_NUMBER_ERROR;
    throw error;
  });
  if (result.ok) refresh();
  return result;
}

export async function updateInvestmentAction(data: FormData): Promise<InvestorActionResult> {
  const read = reader(data);
  const investmentId = read("investmentId", 80);
  if (!investmentId) return { ok: false, error: "Investimento inválido." };
  const fields = investmentFields(read);
  if (!fields.ok) return fields;
  const result = await withInvestorContext(async (tx, scope): Promise<InvestorActionResult> => {
    const [current] = await tx.select({ investment: investments, investorName: investors.name }).from(investments)
      .innerJoin(investors, and(eq(investors.id, investments.investorId), eq(investors.tenantId, investments.tenantId)))
      .where(and(eq(investments.id, investmentId), tenantFilter(scope, investments.tenantId)));
    if (!current) return { ok: false, error: "Investimento não encontrado." };
    const { investment } = current;
    await tx.update(investments).set({ ...fields.values, updatedAt: sql`now()` }).where(and(eq(investments.id, investment.id), eq(investments.tenantId, investment.tenantId)));
    const beforeValues: InvestmentValues = {
      amountCents: investment.amountCents, agreedRateBps: investment.agreedRateBps, ratePeriod: investment.ratePeriod, startDate: investment.startDate,
      maturityDate: investment.maturityDate, dueDay: investment.dueDay, notes: investment.notes, status: investment.status,
      contractNumber: investment.contractNumber, investedOn: investment.investedOn, termMonths: investment.termMonths,
      paymentFrequency: investment.paymentFrequency as InvestmentValues["paymentFrequency"], installmentCount: investment.installmentCount,
    };
    const { status: statusBefore, ...dataBefore } = investmentSnapshot(beforeValues);
    const { status: statusAfter, ...dataAfter } = investmentSnapshot(fields.values);
    // Histórico visível para o tenant: o que mudou, antes e depois.
    const changes = investmentChanges(beforeValues, fields.values);
    if (changes.length > 0) {
      await tx.insert(investmentRevisions).values({ id: id("ivr"), tenantId: investment.tenantId, investmentId: investment.id, kind: "CONTRACT", description: "Dados do contrato alterados", changes, changedByUserId: scope.user.id });
    }
    if (JSON.stringify(dataBefore) !== JSON.stringify(dataAfter)) await audit(tx, scope, investment.tenantId, "INVESTMENT_UPDATED", "investment", investment.id, dataBefore, dataAfter, `Investimento de ${current.investorName} alterado`);
    if (statusBefore !== statusAfter) await audit(tx, scope, investment.tenantId, "INVESTMENT_STATUS_CHANGED", "investment", investment.id, { status: statusBefore }, { status: statusAfter }, `Status do investimento de ${current.investorName} alterado`);
    return { ok: true, message: "Investimento atualizado.", id: investment.id };
  }).catch((error) => {
    if (duplicateContractNumber(error)) return CONTRACT_NUMBER_ERROR;
    throw error;
  });
  if (result.ok) refresh();
  return result;
}

// ── Cronograma de pagamentos ao investidor ──────────────────────────────────────────────────────────────────────────
// Valores e datas digitados pelo usuário; nada aqui calcula rendimento nem mexe no capital. Cada alteração trava o
// investimento (FOR UPDATE), grava o histórico visível e a auditoria na mesma transação.

type ScheduleContext = { investment: typeof investments.$inferSelect; investorName: string; items: (typeof investmentScheduleItems.$inferSelect)[] };

async function lockSchedule(tx: TenantTransaction, scope: Parameters<Parameters<typeof withInvestorContext>[0]>[1], investmentId: string): Promise<ScheduleContext | { ok: false; error: string }> {
  const [row] = await tx.select({ investment: investments, investorName: investors.name }).from(investments)
    .innerJoin(investors, and(eq(investors.id, investments.investorId), eq(investors.tenantId, investments.tenantId)))
    .where(and(eq(investments.id, investmentId), tenantFilter(scope, investments.tenantId))).for("update", { of: investments });
  if (!row) return { ok: false, error: "Investimento não encontrado." };
  if (row.investment.status === "CANCELED" || row.investment.status === "CLOSED") return { ok: false, error: "Este investimento está encerrado ou cancelado: o cronograma não pode mais ser alterado." };
  const items = await tx.select().from(investmentScheduleItems)
    .where(and(eq(investmentScheduleItems.investmentId, row.investment.id), eq(investmentScheduleItems.tenantId, row.investment.tenantId)))
    .orderBy(asc(investmentScheduleItems.dueDate), asc(investmentScheduleItems.number));
  return { ...row, items };
}

// Grava a linha do histórico e devolve o resumo antes/depois para a auditoria (que cada ação grava em seguida).
async function recordScheduleRevision(tx: TenantTransaction, userId: string, context: ScheduleContext, after: ScheduleItemValues[], description: string) {
  const before = scheduleSummary(context.items);
  const now = scheduleSummary(after);
  const { investment } = context;
  await tx.insert(investmentRevisions).values({ id: id("ivr"), tenantId: investment.tenantId, investmentId: investment.id, kind: "SCHEDULE", description, changes: [{ field: "Cronograma", before, after: now }], changedByUserId: userId });
  return [investment.tenantId, "INVESTMENT_SCHEDULE_UPDATED", "investment", investment.id, { schedule: before }, { schedule: now }, `${description} (investimento de ${context.investorName})`] as const;
}

const itemValues = (items: (typeof investmentScheduleItems.$inferSelect)[]) => items.map(({ dueDate, yieldCents, principalCents, description }) => ({ dueDate, yieldCents, principalCents, description }));

// Monta o cronograma inteiro. Se já existe, só substitui com a confirmação "replace" (e a mesma montagem enviada duas
// vezes não duplica: as linhas antigas saem e as novas entram na mesma transação, numeradas de 1 em diante).
export async function buildInvestmentScheduleAction(data: FormData): Promise<InvestorActionResult> {
  const read = reader(data);
  const investmentId = read("investmentId", 80);
  if (!investmentId) return { ok: false, error: "Investimento inválido." };
  const fields = scheduleBuildFields(read);
  if (!fields.ok) return fields;
  const result = await withInvestorContext(async (tx, scope): Promise<InvestorActionResult> => {
    const context = await lockSchedule(tx, scope, investmentId);
    if ("ok" in context) return context;
    if (context.items.length > 0 && read("replace", 4) !== "1") return { ok: false, error: `Este investimento já tem um cronograma com ${context.items.length} ${context.items.length === 1 ? "pagamento" : "pagamentos"}. Confirme que deseja substituí-lo.` };
    const { investment } = context;
    await tx.delete(investmentScheduleItems).where(and(eq(investmentScheduleItems.investmentId, investment.id), eq(investmentScheduleItems.tenantId, investment.tenantId)));
    await tx.insert(investmentScheduleItems).values(fields.items.map((item, index) => ({
      id: id("ivs"), tenantId: investment.tenantId, investmentId: investment.id, number: index + 1, ...item, createdByUserId: scope.user.id,
    })));
    await audit(tx, scope, ...(await recordScheduleRevision(tx, scope.user.id, context, fields.items, context.items.length > 0 ? "Cronograma substituído" : "Cronograma montado")));
    return { ok: true, message: `Cronograma com ${fields.items.length} ${fields.items.length === 1 ? "pagamento" : "pagamentos"} gravado.`, id: investment.id };
  });
  if (result.ok) refresh();
  return result;
}

// Inclui uma linha (datas irregulares ou um pagamento extra combinado).
export async function addInvestmentScheduleItemAction(data: FormData): Promise<InvestorActionResult> {
  const read = reader(data);
  const investmentId = read("investmentId", 80);
  if (!investmentId) return { ok: false, error: "Investimento inválido." };
  const fields = scheduleItemFields(read);
  if (!fields.ok) return fields;
  const result = await withInvestorContext(async (tx, scope): Promise<InvestorActionResult> => {
    const context = await lockSchedule(tx, scope, investmentId);
    if ("ok" in context) return context;
    if (context.items.length >= MAX_SCHEDULE_ITEMS) return { ok: false, error: `O cronograma pode ter no máximo ${MAX_SCHEDULE_ITEMS} pagamentos.` };
    const { investment } = context;
    const [last] = await tx.select({ number: max(investmentScheduleItems.number) }).from(investmentScheduleItems)
      .where(and(eq(investmentScheduleItems.investmentId, investment.id), eq(investmentScheduleItems.tenantId, investment.tenantId)));
    await tx.insert(investmentScheduleItems).values({ id: id("ivs"), tenantId: investment.tenantId, investmentId: investment.id, number: (last?.number ?? 0) + 1, ...fields.values, createdByUserId: scope.user.id });
    await audit(tx, scope, ...(await recordScheduleRevision(tx, scope.user.id, context, [...itemValues(context.items), fields.values], "Pagamento incluído no cronograma")));
    return { ok: true, message: "Pagamento incluído no cronograma.", id: investment.id };
  });
  if (result.ok) refresh();
  return result;
}

export async function updateInvestmentScheduleItemAction(data: FormData): Promise<InvestorActionResult> {
  const read = reader(data);
  const investmentId = read("investmentId", 80);
  const itemId = read("itemId", 80);
  if (!investmentId || !itemId) return { ok: false, error: "Pagamento inválido." };
  const fields = scheduleItemFields(read);
  if (!fields.ok) return fields;
  const result = await withInvestorContext(async (tx, scope): Promise<InvestorActionResult> => {
    const context = await lockSchedule(tx, scope, investmentId);
    if ("ok" in context) return context;
    const item = context.items.find((row) => row.id === itemId);
    if (!item) return { ok: false, error: "Pagamento não encontrado neste cronograma." };
    await tx.update(investmentScheduleItems).set({ ...fields.values, updatedAt: sql`now()` }).where(and(eq(investmentScheduleItems.id, item.id), eq(investmentScheduleItems.tenantId, item.tenantId)));
    await audit(tx, scope, ...(await recordScheduleRevision(tx, scope.user.id, context, itemValues(context.items).map((row, index) => (context.items[index].id === item.id ? fields.values : row)), "Pagamento do cronograma alterado")));
    return { ok: true, message: "Pagamento do cronograma alterado.", id: context.investment.id };
  });
  if (result.ok) refresh();
  return result;
}

export async function deleteInvestmentScheduleItemAction(data: FormData): Promise<InvestorActionResult> {
  const read = reader(data);
  const investmentId = read("investmentId", 80);
  const itemId = read("itemId", 80);
  if (!investmentId || !itemId) return { ok: false, error: "Pagamento inválido." };
  const result = await withInvestorContext(async (tx, scope): Promise<InvestorActionResult> => {
    const context = await lockSchedule(tx, scope, investmentId);
    if ("ok" in context) return context;
    const item = context.items.find((row) => row.id === itemId);
    if (!item) return { ok: false, error: "Pagamento não encontrado neste cronograma." };
    await tx.delete(investmentScheduleItems).where(and(eq(investmentScheduleItems.id, item.id), eq(investmentScheduleItems.tenantId, item.tenantId)));
    await audit(tx, scope, ...(await recordScheduleRevision(tx, scope.user.id, context, itemValues(context.items.filter((row) => row.id !== item.id)), "Pagamento retirado do cronograma")));
    return { ok: true, message: "Pagamento retirado do cronograma.", id: context.investment.id };
  });
  if (result.ok) refresh();
  return result;
}

// Documentos do investimento: PDF ou imagem de até 5 MB, como os documentos de clientes (guardados no banco).
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const documentTypes: Record<string, (bytes: Buffer) => boolean> = {
  "application/pdf": (bytes) => bytes.subarray(0, 5).toString("latin1") === "%PDF-",
  "image/jpeg": (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  "image/png": (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/webp": (bytes) => bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP",
};

async function readDocumentFile(data: FormData) {
  const file = data.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false as const, error: "Escolha o arquivo do documento." };
  if (file.size > MAX_DOCUMENT_BYTES) return { ok: false as const, error: "O arquivo pode ter no máximo 5 MB." };
  const content = Buffer.from(await file.arrayBuffer());
  // O tipo é conferido pelo conteúdo do arquivo, não só pela extensão.
  const contentType = Object.keys(documentTypes).find((type) => documentTypes[type](content));
  if (!contentType) return { ok: false as const, error: "Envie um PDF ou uma imagem (JPG, PNG ou WEBP)." };
  const fileName = file.name.replace(/[\\/\r\n"]/g, "_").slice(0, 160) || "documento";
  return { ok: true as const, content, contentType, fileName };
}

// Contrato assinado: a versão gerada pelo sistema que foi assinada. Precisa ser do mesmo investimento (e tenant).
// "" = contrato não gerado pelo sistema. Campo ausente = undefined (na substituição, mantém o vínculo anterior).
async function signedContractVersion(tx: TenantTransaction, data: FormData, investment: { id: string; tenantId: string }) {
  if (!data.has("contractId")) return { ok: true as const, contractId: undefined, version: undefined };
  const contractId = String(data.get("contractId") ?? "").trim().slice(0, 80);
  if (!contractId) return { ok: true as const, contractId: null, version: null };
  const [contract] = await tx.select({ id: investmentContracts.id, version: investmentContracts.version }).from(investmentContracts)
    .where(and(eq(investmentContracts.id, contractId), eq(investmentContracts.investmentId, investment.id), eq(investmentContracts.tenantId, investment.tenantId)));
  if (!contract) return { ok: false as const, error: "Escolha uma versão do contrato deste investimento." };
  return { ok: true as const, contractId: contract.id, version: contract.version };
}

const fileSnapshot = (file: { kind: string; fileName: string; contentType: string; sizeBytes: number }) =>
  ({ kind: file.kind, fileName: file.fileName, contentType: file.contentType, sizeBytes: file.sizeBytes });

export async function uploadInvestmentDocumentAction(data: FormData): Promise<InvestorActionResult> {
  const read = reader(data);
  const investmentId = read("investmentId", 80);
  const kind = parseDocumentKind(read("kind", 40));
  if (!investmentId) return { ok: false, error: "Investimento inválido." };
  if (!kind) return { ok: false, error: "Escolha o tipo do documento." };
  const file = await readDocumentFile(data);
  if (!file.ok) return file;
  let result: InvestorActionResult;
  try {
    result = await withInvestorContext(async (tx, scope): Promise<InvestorActionResult> => {
      const [investment] = await tx.select().from(investments).where(and(eq(investments.id, investmentId), tenantFilter(scope, investments.tenantId)));
      if (!investment) return { ok: false, error: "Investimento não encontrado." };
      if (kind === "SIGNED_CONTRACT") {
        const [existing] = await tx.select({ id: investmentDocuments.id }).from(investmentDocuments)
          .where(and(eq(investmentDocuments.investmentId, investment.id), eq(investmentDocuments.tenantId, investment.tenantId), eq(investmentDocuments.kind, "SIGNED_CONTRACT"), isNull(investmentDocuments.replacedAt)));
        if (existing) return SIGNED_CONTRACT_ERROR;
      }
      const link = kind === "SIGNED_CONTRACT" ? await signedContractVersion(tx, data, investment) : { ok: true as const, contractId: null, version: null };
      if (!link.ok) return link;
      const documentId = id("idoc");
      const values = { kind, fileName: file.fileName, contentType: file.contentType, sizeBytes: file.content.length };
      await tx.insert(investmentDocuments).values({ id: documentId, tenantId: investment.tenantId, investmentId: investment.id, ...values, contractId: link.contractId ?? null, content: file.content, uploadedByUserId: scope.user.id });
      await audit(tx, scope, investment.tenantId, "INVESTMENT_DOCUMENT_UPLOADED", "investment_document", documentId, null,
        { investmentId: investment.id, ...fileSnapshot(values), ...(kind === "SIGNED_CONTRACT" ? { contractId: link.contractId ?? null, contractVersion: link.version ?? null } : {}) },
        `${DOCUMENT_KINDS[kind]} enviado (${file.fileName})${link.version ? ` – assinatura da versão ${link.version} do contrato gerado` : ""}`);
      return { ok: true, message: `${DOCUMENT_KINDS[kind]} enviado.`, id: documentId };
    });
  } catch (error) {
    if (duplicateSignedContract(error)) return SIGNED_CONTRACT_ERROR;
    throw error;
  }
  if (result.ok) refresh();
  return result;
}

// Substituir: a nova versão passa a valer e a anterior fica no histórico (nunca é apagada).
export async function replaceInvestmentDocumentAction(data: FormData): Promise<InvestorActionResult> {
  const read = reader(data);
  const documentId = read("documentId", 80);
  if (!documentId) return { ok: false, error: "Documento inválido." };
  const file = await readDocumentFile(data);
  if (!file.ok) return file;
  const result = await withInvestorContext(async (tx, scope): Promise<InvestorActionResult> => {
    const [previous] = await tx.select({
      id: investmentDocuments.id, tenantId: investmentDocuments.tenantId, investmentId: investmentDocuments.investmentId, kind: investmentDocuments.kind,
      fileName: investmentDocuments.fileName, contentType: investmentDocuments.contentType, sizeBytes: investmentDocuments.sizeBytes, replacedAt: investmentDocuments.replacedAt,
      contractId: investmentDocuments.contractId,
    }).from(investmentDocuments).where(and(eq(investmentDocuments.id, documentId), tenantFilter(scope, investmentDocuments.tenantId)));
    if (!previous) return { ok: false, error: "Documento não encontrado." };
    if (previous.replacedAt) return { ok: false, error: "Esta versão já foi substituída. Substitua a versão atual." };
    const link = previous.kind === "SIGNED_CONTRACT" ? await signedContractVersion(tx, data, { id: previous.investmentId, tenantId: previous.tenantId }) : { ok: true as const, contractId: null, version: null };
    if (!link.ok) return link;
    const contractId = link.contractId === undefined ? previous.contractId : link.contractId;
    const newId = id("idoc");
    // Primeiro marca a anterior como substituída (o índice só aceita um contrato assinado vigente), depois grava a nova.
    // Se outra substituição simultânea chegou antes, nada é marcado e esta não grava uma segunda versão vigente.
    const marked = await tx.update(investmentDocuments).set({ replacedAt: sql`now()`, replacedByDocumentId: newId })
      .where(and(eq(investmentDocuments.id, previous.id), eq(investmentDocuments.tenantId, previous.tenantId), isNull(investmentDocuments.replacedAt)))
      .returning({ id: investmentDocuments.id });
    if (marked.length === 0) return { ok: false, error: "Esta versão já foi substituída. Substitua a versão atual." };
    const values = { kind: previous.kind, fileName: file.fileName, contentType: file.contentType, sizeBytes: file.content.length };
    await tx.insert(investmentDocuments).values({ id: newId, tenantId: previous.tenantId, investmentId: previous.investmentId, ...values, contractId, content: file.content, uploadedByUserId: scope.user.id });
    const kindLabel = DOCUMENT_KINDS[previous.kind as keyof typeof DOCUMENT_KINDS] ?? "Documento";
    await audit(tx, scope, previous.tenantId, "INVESTMENT_DOCUMENT_REPLACED", "investment_document", newId,
      { investmentId: previous.investmentId, ...fileSnapshot(previous), ...(previous.kind === "SIGNED_CONTRACT" ? { contractId: previous.contractId } : {}) },
      { investmentId: previous.investmentId, replacedDocumentId: previous.id, ...fileSnapshot(values), ...(previous.kind === "SIGNED_CONTRACT" ? { contractId } : {}) },
      `${kindLabel} substituído (${previous.fileName} → ${file.fileName})`);
    return { ok: true, message: `${kindLabel} substituído. A versão anterior continua no histórico.`, id: newId };
  });
  if (result.ok) refresh();
  return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// Contrato de investimento gerado pelo sistema. O PDF gerado não é assinado: o usuário baixa, envia ao investidor por
// conta própria e depois anexa a versão assinada em Documentos (Contrato assinado), indicando a versão correspondente.

// Lê o investimento no escopo da sessão, com o investidor (sempre do mesmo tenant).
async function investmentInScope(tx: TenantTransaction, scope: Parameters<typeof tenantFilter>[0], investmentId: string, lock = false) {
  const query = tx.select({ investment: investments, investor: investors }).from(investments)
    .innerJoin(investors, and(eq(investors.id, investments.investorId), eq(investors.tenantId, investments.tenantId)))
    .where(and(eq(investments.id, investmentId), tenantFilter(scope, investments.tenantId)));
  // FOR UPDATE do investimento: duas gerações simultâneas do mesmo contrato ficam em fila (versões sem buraco nem duplicata).
  const [row] = lock ? await query.for("update", { of: investments }) : await query;
  return row ?? null;
}

// Dados da empresa contratante (um cadastro por carteira, usado em todos os contratos dela).
export async function saveContractorAction(data: FormData): Promise<InvestorActionResult> {
  const read = reader(data);
  const investmentId = read("investmentId", 80);
  if (!investmentId) return { ok: false, error: "Investimento inválido." };
  const fields = contractorFields(read);
  if (!fields.ok) return fields;
  const result = await withInvestorContext(async (tx, scope): Promise<InvestorActionResult> => {
    const row = await investmentInScope(tx, scope, investmentId);
    if (!row) return { ok: false, error: "Investimento não encontrado." };
    // O tenant é sempre o do investimento (para o usuário comum, a própria carteira): nunca vem do formulário.
    const tenantId = row.investment.tenantId;
    const previous = await loadContractor(tx, tenantId);
    const { address, confirmed, ...rest } = fields.values;
    const values = {
      ...rest, addressCep: address.Cep, addressStreet: address.Street, addressNumber: address.Number, addressComplement: address.Complement,
      addressDistrict: address.District, addressCity: address.City, addressState: address.State,
      confirmedAt: confirmed ? sql`now()` : null, confirmedByUserId: confirmed ? scope.user.id : null, updatedByUserId: scope.user.id, updatedAt: sql`now()`,
    };
    await tx.insert(investmentContractors).values({ tenantId, ...values }).onConflictDoUpdate({ target: investmentContractors.tenantId, set: values });
    const snapshot = (source: { legalName: string | null; document: string | null; addressCity: string | null; addressState: string | null; representativeName: string | null } & Record<string, unknown>, isConfirmed: boolean) => ({
      legalName: source.legalName, document: source.document, address: [source.addressStreet, source.addressNumber, source.addressDistrict, source.addressCity, source.addressState, source.addressCep].filter(Boolean).join(", ") || null,
      representativeName: source.representativeName, representativeDocument: source.representativeDocument ? "preenchido" : null, confirmed: isConfirmed,
    });
    await audit(tx, scope, tenantId, "INVESTMENT_CONTRACTOR_UPDATED", "investment_contractor", tenantId,
      previous ? snapshot(previous, Boolean(previous.confirmedAt)) : null, snapshot({ ...values, legalName: rest.legalName, document: rest.document, representativeName: rest.representativeName }, confirmed),
      confirmed ? "Dados da empresa contratante confirmados" : "Dados da empresa contratante salvos sem confirmação");
    return { ok: true, message: confirmed ? "Dados da empresa contratante salvos e confirmados." : "Dados salvos. Confirme-os para poder gerar o contrato." };
  });
  if (result.ok) refresh();
  return result;
}

// Gera a primeira versão do contrato ou uma nova versão. A versão anterior fica no histórico (substituída) e nenhum
// documento assinado é tocado. Faltando dado essencial, nada é gerado e a mensagem diz o que falta.
export async function generateContractAction(data: FormData): Promise<InvestorActionResult> {
  const read = reader(data);
  const investmentId = read("investmentId", 80);
  if (!investmentId) return { ok: false, error: "Investimento inválido." };
  const includeNotes = read("includeNotes", 4) === "1";
  const confirmSignedKept = read("confirmSignedKept", 4) === "1";
  const fonts = await contractFonts();
  const result = await withInvestorContext(async (tx, scope): Promise<InvestorActionResult> => {
    const row = await investmentInScope(tx, scope, investmentId, true);
    if (!row) return { ok: false, error: "Investimento não encontrado." };
    const { investment, investor } = row;
    const source = contractSource(investment, investor, await loadContractor(tx, investment.tenantId));
    const missing = missingContractData(source, includeNotes);
    if (missing.length) return { ok: false, error: `Não é possível gerar a versão final do contrato. Falta: ${missing.map((item) => `${item.section}: ${item.item}`).join("; ")}.` };

    const [current] = await tx.select().from(investmentContracts)
      .where(and(eq(investmentContracts.investmentId, investment.id), eq(investmentContracts.tenantId, investment.tenantId), isNull(investmentContracts.supersededAt)));
    const dataHash = contractDataHash(source, includeNotes);
    if (current && current.dataHash === dataHash) return { ok: false, error: `Os dados não mudaram desde a versão ${current.version}. Use a versão atual ou altere os dados antes de gerar outra.` };
    // Já existe contrato assinado vigente: a nova versão não o substitui, e o usuário precisa confirmar que entendeu.
    const [signed] = await tx.select({ id: investmentDocuments.id }).from(investmentDocuments)
      .where(and(eq(investmentDocuments.investmentId, investment.id), eq(investmentDocuments.tenantId, investment.tenantId), eq(investmentDocuments.kind, "SIGNED_CONTRACT"), isNull(investmentDocuments.replacedAt)));
    if (signed && !confirmSignedKept) return { ok: false, error: "Este investimento já tem contrato assinado. Confirme que a nova versão não substitui o contrato assinado (ele continua em Documentos) e precisa ser assinada à parte." };

    const [{ last }] = await tx.select({ last: sql<number>`coalesce(max(${investmentContracts.version}), 0)::int` }).from(investmentContracts)
      .where(and(eq(investmentContracts.investmentId, investment.id), eq(investmentContracts.tenantId, investment.tenantId)));
    const version = Number(last) + 1;
    const generatedAt = new Date();
    const pdf = Buffer.from(await renderContractPdf(buildContract(source, includeNotes, { version, generatedAt }), generatedAt, fonts));
    const contractId = id("ictr");
    const fileName = contractFileName(investor.name, version);
    const sha256 = createHash("sha256").update(pdf).digest("hex");
    // Primeiro marca a versão vigente como substituída (o índice só aceita uma vigente), depois grava a nova.
    if (current) {
      await tx.update(investmentContracts).set({ supersededAt: sql`now()`, supersededByContractId: contractId })
        .where(and(eq(investmentContracts.id, current.id), eq(investmentContracts.tenantId, current.tenantId), isNull(investmentContracts.supersededAt)));
    }
    await tx.insert(investmentContracts).values({
      id: contractId, tenantId: investment.tenantId, investmentId: investment.id, version, templateVersion: CONTRACT_TEMPLATE_VERSION, dataHash, includesNotes: includeNotes,
      fileName, sizeBytes: pdf.length, sha256, content: pdf, generatedByUserId: scope.user.id, createdAt: generatedAt,
    });
    // Auditoria sem dados pessoais: versão, arquivo, hash e o vínculo com o investimento.
    await audit(tx, scope, investment.tenantId, "INVESTMENT_CONTRACT_GENERATED", "investment_contract", contractId,
      current ? { investmentId: investment.id, version: current.version, contractId: current.id } : null,
      { investmentId: investment.id, version, fileName, sizeBytes: pdf.length, sha256, templateVersion: CONTRACT_TEMPLATE_VERSION, includesNotes: includeNotes, signedContractKept: Boolean(signed) },
      current ? `Nova versão do contrato gerada (versão ${version}, substitui a versão ${current.version})` : `Contrato gerado (versão ${version})`);
    return { ok: true, message: current ? `Versão ${version} do contrato gerada. A versão ${current.version} continua no histórico.` : "Contrato gerado (versão 1). Baixe o PDF e envie para assinatura.", id: contractId };
  });
  if (result.ok) refresh();
  return result;
}

// Registro manual de que a versão vigente foi enviada para assinatura (o envio acontece fora do sistema).
export async function markContractSentAction(data: FormData): Promise<InvestorActionResult> {
  const read = reader(data);
  const contractId = read("contractId", 80);
  if (!contractId) return { ok: false, error: "Contrato inválido." };
  const result = await withInvestorContext(async (tx, scope): Promise<InvestorActionResult> => {
    const [contract] = await tx.select({ id: investmentContracts.id, tenantId: investmentContracts.tenantId, investmentId: investmentContracts.investmentId, version: investmentContracts.version, sentAt: investmentContracts.sentAt, supersededAt: investmentContracts.supersededAt })
      .from(investmentContracts).where(and(eq(investmentContracts.id, contractId), tenantFilter(scope, investmentContracts.tenantId)));
    if (!contract) return { ok: false, error: "Contrato não encontrado." };
    if (contract.supersededAt) return { ok: false, error: "Esta versão foi substituída. Envie a versão atual." };
    if (contract.sentAt) return { ok: false, error: "Esta versão já está marcada como enviada." };
    await tx.update(investmentContracts).set({ sentAt: sql`now()`, sentByUserId: scope.user.id })
      .where(and(eq(investmentContracts.id, contract.id), eq(investmentContracts.tenantId, contract.tenantId), isNull(investmentContracts.sentAt)));
    await audit(tx, scope, contract.tenantId, "INVESTMENT_CONTRACT_SENT", "investment_contract", contract.id, { investmentId: contract.investmentId, version: contract.version, sent: false },
      { investmentId: contract.investmentId, version: contract.version, sent: true }, `Versão ${contract.version} do contrato marcada como enviada para assinatura`);
    return { ok: true, message: `Versão ${contract.version} marcada como enviada para assinatura.` };
  });
  if (result.ok) refresh();
  return result;
}
