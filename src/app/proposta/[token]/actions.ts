"use server";

import { and, eq, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { creditProposalDocuments, creditProposals, proposalApplicants } from "@/lib/db/schema";
import { PROPOSAL_DOCUMENT_KINDS, PROPOSAL_DOCUMENT_MAX_BYTES, type ProposalDocumentKind } from "@/lib/credit/documents";
import { detectDocumentType } from "@/lib/credit/file-type";
import { endApplicantSession, lockPolicy, passwordTools, requireApplicant, startApplicantSession, withLinkTenant } from "@/lib/credit/portal";
import { normalizeCpf, normalizePhone, parseMoneyToCents } from "@/lib/finance/format";

type Result = { ok: true; message: string } | { ok: false; error: string };
const text = (data: FormData, key: string, max: number) => String(data.get(key) ?? "").trim().slice(0, max);
const newId = (prefix: string) => `${prefix}_${randomBytes(12).toString("hex")}`;
const MAX_CENTS = 100_000_000_00;
const emailOk = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const LINK_ERROR = "Este link de proposta não está mais disponível. Peça um novo link a quem enviou.";

export async function registerApplicantAction(token: string, data: FormData): Promise<Result> {
  const name = text(data, "name", 120);
  const email = text(data, "email", 160).toLowerCase();
  const password = String(data.get("password") ?? "");
  if (name.length < 3) return { ok: false, error: "Informe seu nome completo." };
  if (!emailOk(email)) return { ok: false, error: "Informe um e-mail válido." };
  if (password.length < 8 || password.length > 128) return { ok: false, error: "A senha precisa ter de 8 a 128 caracteres." };
  const passwordHash = await passwordTools.hash(password);
  const result = await withLinkTenant(token, async (tx, tenantId): Promise<Result> => {
    const [existing] = await tx.select({ id: proposalApplicants.id }).from(proposalApplicants).where(and(eq(proposalApplicants.tenantId, tenantId), eq(proposalApplicants.email, email)));
    if (existing) return { ok: false, error: "Já existe uma conta com este e-mail. Use a opção Entrar." };
    const applicantId = newId("pap");
    await tx.insert(proposalApplicants).values({ id: applicantId, tenantId, name, email, passwordHash });
    await startApplicantSession(tx, tenantId, applicantId, token);
    return { ok: true, message: "Conta criada." };
  });
  return result ?? { ok: false, error: LINK_ERROR };
}

export async function loginApplicantAction(token: string, data: FormData): Promise<Result> {
  const email = text(data, "email", 160).toLowerCase();
  const password = String(data.get("password") ?? "");
  const generic: Result = { ok: false, error: "E-mail ou senha incorretos." };
  const result = await withLinkTenant(token, async (tx, tenantId): Promise<Result> => {
    const [applicant] = await tx.select().from(proposalApplicants).where(and(eq(proposalApplicants.tenantId, tenantId), eq(proposalApplicants.email, email))).for("update");
    if (!applicant) { await passwordTools.hash(password || "x"); return generic; }
    if (applicant.lockedUntil && applicant.lockedUntil > new Date()) return { ok: false, error: `Muitas tentativas. Tente de novo em ${lockPolicy.LOCK_MINUTES} minutos.` };
    if (!(await passwordTools.verify(password, applicant.passwordHash))) {
      const attempts = applicant.failedAttempts + 1;
      const lock = attempts >= lockPolicy.MAX_FAILED_ATTEMPTS;
      await tx.update(proposalApplicants).set({ failedAttempts: lock ? 0 : attempts, lockedUntil: lock ? sql`now() + interval '15 minutes'` : null }).where(eq(proposalApplicants.id, applicant.id));
      return generic;
    }
    await tx.update(proposalApplicants).set({ failedAttempts: 0, lockedUntil: null }).where(eq(proposalApplicants.id, applicant.id));
    await startApplicantSession(tx, tenantId, applicant.id, token);
    return { ok: true, message: "Bem-vindo." };
  });
  return result ?? { ok: false, error: LINK_ERROR };
}

export async function logoutApplicantAction() {
  await endApplicantSession();
}

// Passo 1: dados da proposta. Grava como rascunho (DRAFT); só vira proposta de verdade ao enviar com todos os documentos.
export async function saveProposalDraftAction(token: string, data: FormData): Promise<Result> {
  const applicant = await requireApplicant(token).catch(() => null);
  if (!applicant) return { ok: false, error: "Sua sessão expirou. Entre de novo." };
  const cpf = normalizeCpf(text(data, "cpf", 20));
  if (!cpf.ok) return cpf;
  if (!cpf.value) return { ok: false, error: "Informe o seu CPF." };
  const phone = normalizePhone(text(data, "phone", 30));
  if (!phone.ok) return phone;
  if (!phone.value) return { ok: false, error: "Informe o telefone com DDD." };
  const amount = parseMoneyToCents(text(data, "requested", 40));
  if (amount === null || amount <= 0 || amount > MAX_CENTS) return { ok: false, error: "Informe o valor que você precisa, por exemplo 5.000,00." };
  const income = parseMoneyToCents(text(data, "income", 40));
  if (income === null || income <= 0 || income > MAX_CENTS) return { ok: false, error: "Informe a sua renda mensal, por exemplo 3.500,00." };
  const termRaw = text(data, "termMonths", 10);
  const term = /^\d+$/.test(termRaw) ? Number(termRaw) : NaN;
  if (!Number.isInteger(term) || term < 1 || term > 360) return { ok: false, error: "Informe o prazo em meses, de 1 a 360." };
  const name = text(data, "name", 120);
  if (name.length < 3) return { ok: false, error: "Informe o seu nome completo." };
  const result = await withLinkTenant(token, async (tx, tenantId): Promise<Result> => {
    const [current] = await tx.select().from(creditProposals).where(and(eq(creditProposals.tenantId, tenantId), eq(creditProposals.applicantId, applicant.id))).for("update");
    const values = { applicantName: name, cpf: cpf.value!, email: applicant.email, phone: phone.value, requestedCents: amount, termMonths: term, monthlyIncomeCents: income };
    if (current && current.status !== "DRAFT") return { ok: false, error: "Sua proposta já foi enviada e está em análise." };
    if (current) await tx.update(creditProposals).set(values).where(eq(creditProposals.id, current.id));
    else await tx.insert(creditProposals).values({ id: newId("prp"), tenantId, source: "APPLICANT", applicantId: applicant.id, status: "DRAFT", ...values });
    return { ok: true, message: "Dados salvos. Agora envie os documentos." };
  });
  if (result?.ok) revalidatePath(`/proposta/${token}`);
  return result ?? { ok: false, error: LINK_ERROR };
}

// Passo 2: um documento por vez (limite de 4 MB por arquivo). Enviar de novo substitui o anterior.
export async function uploadProposalDocumentAction(token: string, data: FormData): Promise<Result> {
  const applicant = await requireApplicant(token).catch(() => null);
  if (!applicant) return { ok: false, error: "Sua sessão expirou. Entre de novo." };
  const kind = text(data, "kind", 30) as ProposalDocumentKind;
  if (!PROPOSAL_DOCUMENT_KINDS.includes(kind)) return { ok: false, error: "Documento inválido." };
  const file = data.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Escolha o arquivo." };
  if (file.size > PROPOSAL_DOCUMENT_MAX_BYTES) return { ok: false, error: "O arquivo pode ter no máximo 4 MB." };
  const content = Buffer.from(await file.arrayBuffer());
  const contentType = detectDocumentType(content);
  if (!contentType) return { ok: false, error: "Envie um PDF ou uma imagem (JPG, PNG ou WEBP)." };
  const fileName = file.name.replace(/[\\/\r\n"]/g, "_").slice(0, 160) || "documento";
  const result = await withLinkTenant(token, async (tx, tenantId): Promise<Result> => {
    const [proposal] = await tx.select().from(creditProposals).where(and(eq(creditProposals.tenantId, tenantId), eq(creditProposals.applicantId, applicant.id))).for("update");
    if (!proposal) return { ok: false, error: "Preencha primeiro os dados da proposta." };
    if (proposal.status !== "DRAFT") return { ok: false, error: "Sua proposta já foi enviada e está em análise." };
    await tx.delete(creditProposalDocuments).where(and(eq(creditProposalDocuments.proposalId, proposal.id), eq(creditProposalDocuments.kind, kind)));
    await tx.insert(creditProposalDocuments).values({ id: newId("pdc"), tenantId, proposalId: proposal.id, kind, fileName, contentType, sizeBytes: content.length, content });
    return { ok: true, message: "Documento recebido." };
  });
  if (result?.ok) revalidatePath(`/proposta/${token}`);
  return result ?? { ok: false, error: LINK_ERROR };
}

// Passo 3: só grava a proposta (DRAFT -> OPEN, fase "Proposta recebida") com todos os campos e os 4 documentos.
export async function submitProposalAction(token: string): Promise<Result> {
  const applicant = await requireApplicant(token).catch(() => null);
  if (!applicant) return { ok: false, error: "Sua sessão expirou. Entre de novo." };
  const result = await withLinkTenant(token, async (tx, tenantId): Promise<Result> => {
    const [proposal] = await tx.select().from(creditProposals).where(and(eq(creditProposals.tenantId, tenantId), eq(creditProposals.applicantId, applicant.id))).for("update");
    if (!proposal) return { ok: false, error: "Preencha primeiro os dados da proposta." };
    if (proposal.status !== "DRAFT") return { ok: false, error: "Sua proposta já foi enviada." };
    const docs = await tx.select({ kind: creditProposalDocuments.kind }).from(creditProposalDocuments).where(eq(creditProposalDocuments.proposalId, proposal.id));
    const missing = PROPOSAL_DOCUMENT_KINDS.filter((kind) => !docs.some((doc) => doc.kind === kind));
    if (missing.length > 0) return { ok: false, error: "Faltam documentos obrigatórios para enviar a proposta." };
    await tx.update(creditProposals).set({ status: "OPEN", phase: "RECEIVED", phaseChangedAt: sql`now()` }).where(eq(creditProposals.id, proposal.id));
    return { ok: true, message: "Proposta enviada! Você será avisado sobre os próximos passos." };
  });
  if (result?.ok) revalidatePath(`/proposta/${token}`);
  return result ?? { ok: false, error: LINK_ERROR };
}
