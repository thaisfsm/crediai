"use server";

import { randomUUID } from "node:crypto";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { recordAdminAudit, type AuditActor } from "@/lib/admin/audit";
import type { AuditAction } from "@/lib/admin/audit-rules";
import type { TenantTransaction } from "@/lib/auth/guards";
import { investmentDocuments, investments, investors, tenants } from "@/lib/db/schema";
import { formatMoney } from "@/lib/finance/format";
import { tenantFilter, withInvestorContext } from "@/lib/investors/access";
import { DOCUMENT_KINDS, investmentFields, investorFields, parseDocumentKind, type InvestmentValues, type InvestorValues } from "@/lib/investors/rules";

export type InvestorActionResult = { ok: true; message: string; id?: string } | { ok: false; error: string };

// Toda autorização é feita aqui, no servidor: o tenant vem da sessão (ou, para o MASTER, do registro que ele administra).
// O navegador nunca escolhe o tenant de um usuário comum. Cada alteração grava auditoria na mesma transação.

const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
const reader = (data: FormData) => (key: string, max: number) => String(data.get(key) ?? "").trim().slice(0, max);

// Observações não vão em texto para a auditoria (podem ter dados sensíveis): só se estão preenchidas e o tamanho.
const notesMark = (notes: string | null) => (notes ? `preenchidas (${notes.length} caracteres)` : null);
const investorSnapshot = (values: InvestorValues) => ({ ...values, notes: notesMark(values.notes) });
const investmentSnapshot = (values: InvestmentValues) => ({ ...values, notes: notesMark(values.notes) });

async function tenantName(tx: TenantTransaction, tenantId: string) {
  const [row] = await tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId));
  return row?.name ?? null;
}

async function audit(tx: TenantTransaction, actor: AuditActor, tenantId: string, action: AuditAction, entity: string, entityId: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null, description?: string) {
  await recordAdminAudit(tx, actor, { action, entity, entityId, tenantId, tenantName: await tenantName(tx, tenantId), before, after, description });
}

const duplicateDocument = (error: unknown) => error instanceof Error && /investor_tenant_document_unique/.test(`${error.message} ${(error as { cause?: Error }).cause?.message ?? ""}`);
const DUPLICATE_ERROR = { ok: false as const, error: "Já existe um investidor com este CPF/CNPJ nesta carteira." };

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
      const before = investorSnapshot({ name: current.name, document: current.document, phone: current.phone, whatsapp: current.whatsapp, email: current.email, instagram: current.instagram, facebook: current.facebook, notes: current.notes, status: current.status });
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
    const { status: statusBefore, ...dataBefore } = investmentSnapshot({
      amountCents: investment.amountCents, agreedRateBps: investment.agreedRateBps, ratePeriod: investment.ratePeriod, startDate: investment.startDate,
      maturityDate: investment.maturityDate, dueDay: investment.dueDay, notes: investment.notes, status: investment.status,
    });
    const { status: statusAfter, ...dataAfter } = investmentSnapshot(fields.values);
    if (JSON.stringify(dataBefore) !== JSON.stringify(dataAfter)) await audit(tx, scope, investment.tenantId, "INVESTMENT_UPDATED", "investment", investment.id, dataBefore, dataAfter, `Investimento de ${current.investorName} alterado`);
    if (statusBefore !== statusAfter) await audit(tx, scope, investment.tenantId, "INVESTMENT_STATUS_CHANGED", "investment", investment.id, { status: statusBefore }, { status: statusAfter }, `Status do investimento de ${current.investorName} alterado`);
    return { ok: true, message: "Investimento atualizado.", id: investment.id };
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
  const result = await withInvestorContext(async (tx, scope): Promise<InvestorActionResult> => {
    const [investment] = await tx.select().from(investments).where(and(eq(investments.id, investmentId), tenantFilter(scope, investments.tenantId)));
    if (!investment) return { ok: false, error: "Investimento não encontrado." };
    if (kind === "SIGNED_CONTRACT") {
      const [existing] = await tx.select({ id: investmentDocuments.id }).from(investmentDocuments)
        .where(and(eq(investmentDocuments.investmentId, investment.id), eq(investmentDocuments.tenantId, investment.tenantId), eq(investmentDocuments.kind, "SIGNED_CONTRACT"), isNull(investmentDocuments.replacedAt)));
      if (existing) return { ok: false, error: "Este investimento já tem contrato assinado. Use \"Substituir\" para enviar uma nova versão." };
    }
    const documentId = id("idoc");
    const values = { kind, fileName: file.fileName, contentType: file.contentType, sizeBytes: file.content.length };
    await tx.insert(investmentDocuments).values({ id: documentId, tenantId: investment.tenantId, investmentId: investment.id, ...values, content: file.content, uploadedByUserId: scope.user.id });
    await audit(tx, scope, investment.tenantId, "INVESTMENT_DOCUMENT_UPLOADED", "investment_document", documentId, null, { investmentId: investment.id, ...fileSnapshot(values) },
      `${DOCUMENT_KINDS[kind]} enviado (${file.fileName})`);
    return { ok: true, message: `${DOCUMENT_KINDS[kind]} enviado.`, id: documentId };
  });
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
    }).from(investmentDocuments).where(and(eq(investmentDocuments.id, documentId), tenantFilter(scope, investmentDocuments.tenantId)));
    if (!previous) return { ok: false, error: "Documento não encontrado." };
    if (previous.replacedAt) return { ok: false, error: "Esta versão já foi substituída. Substitua a versão atual." };
    const newId = id("idoc");
    // Primeiro marca a anterior como substituída (o índice só aceita um contrato assinado vigente), depois grava a nova.
    await tx.update(investmentDocuments).set({ replacedAt: sql`now()`, replacedByDocumentId: newId })
      .where(and(eq(investmentDocuments.id, previous.id), eq(investmentDocuments.tenantId, previous.tenantId), isNull(investmentDocuments.replacedAt)));
    const values = { kind: previous.kind, fileName: file.fileName, contentType: file.contentType, sizeBytes: file.content.length };
    await tx.insert(investmentDocuments).values({ id: newId, tenantId: previous.tenantId, investmentId: previous.investmentId, ...values, content: file.content, uploadedByUserId: scope.user.id });
    const kindLabel = DOCUMENT_KINDS[previous.kind as keyof typeof DOCUMENT_KINDS] ?? "Documento";
    await audit(tx, scope, previous.tenantId, "INVESTMENT_DOCUMENT_REPLACED", "investment_document", newId,
      { investmentId: previous.investmentId, ...fileSnapshot(previous) }, { investmentId: previous.investmentId, replacedDocumentId: previous.id, ...fileSnapshot(values) },
      `${kindLabel} substituído (${previous.fileName} → ${file.fileName})`);
    return { ok: true, message: `${kindLabel} substituído. A versão anterior continua no histórico.`, id: newId };
  });
  if (result.ok) refresh();
  return result;
}
