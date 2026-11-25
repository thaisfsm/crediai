"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { creditProposals, tenants } from "@/lib/db/schema";
import { confirmFillCpf, endFillSession, withConfirmedFillProposal } from "@/lib/credit/fill-link";
import { finalizeClientData, saveClientStep, storeProposalDocument } from "@/lib/credit/client-data";
import { isClientDataStep } from "@/lib/credit/client-data-steps";
import { recordAdminAudit } from "@/lib/admin/audit";
import { normalizePhone, parseMoneyToCents } from "@/lib/finance/format";

// Formulário público de uma proposta cadastrada pelo dono (link individual). Toda ação confere o link E a sessão confirmada
// pelo CPF; o identificador da proposta nunca vem do navegador: sai do próprio link.
type Result = { ok: true; message: string } | { ok: false; error: string };
const text = (data: FormData, key: string, max: number) => String(data.get(key) ?? "").trim().slice(0, max);
const MAX_CENTS = 100_000_000_00;
const SESSION_ERROR: Result = { ok: false, error: "Sua sessão expirou ou o link mudou. Abra o link de novo e confirme o CPF." };
const done = (token: string, result: Result | null) => {
  if (result?.ok) revalidatePath(`/completar/${token}`);
  return result ?? SESSION_ERROR;
};

export async function confirmFillCpfAction(token: string, data: FormData): Promise<Result> {
  const result = await confirmFillCpf(String(token), text(data, "cpf", 20));
  if (!result) return { ok: false, error: "Este link não está mais disponível. Peça um novo link a quem enviou." };
  return result.ok ? done(token, { ok: true, message: "CPF confirmado." }) : result;
}

export async function leaveFillAction() {
  await endFillSession();
}

// Etapa "Proposta": nome, telefone e renda (valor e prazo foram combinados com o dono e não mudam por aqui; o CPF também não).
export async function saveFillProposalAction(token: string, data: FormData): Promise<Result> {
  const name = text(data, "name", 120);
  if (name.length < 3) return { ok: false, error: "Informe o seu nome completo." };
  const phone = normalizePhone(text(data, "phone", 30));
  if (!phone.ok) return phone;
  if (!phone.value) return { ok: false, error: "Informe o telefone com DDD." };
  const income = parseMoneyToCents(text(data, "income", 40));
  if (income === null || income <= 0 || income > MAX_CENTS) return { ok: false, error: "Informe a sua renda mensal, por exemplo 3.500,00." };
  return done(token, await withConfirmedFillProposal(token, async (tx, tenantId, proposal): Promise<Result> => {
    if (proposal.clientDataSubmittedAt) return { ok: false, error: "Seu cadastro já foi enviado." };
    await tx.update(creditProposals).set({ applicantName: name, phone: phone.value, monthlyIncomeCents: income }).where(and(eq(creditProposals.id, proposal.id), eq(creditProposals.tenantId, tenantId)));
    return { ok: true, message: "Dados salvos." };
  }));
}

export async function saveFillStepAction(token: string, step: string, data: FormData): Promise<Result> {
  if (!isClientDataStep(step)) return { ok: false, error: "Etapa inválida." };
  return done(token, await withConfirmedFillProposal(token, (tx, tenantId, proposal) => saveClientStep(tx, tenantId, proposal, step, data)));
}

export async function uploadFillDocumentAction(token: string, data: FormData): Promise<Result> {
  const file = data.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Escolha o arquivo." };
  if (file.size > 4 * 1024 * 1024) return { ok: false, error: "O arquivo pode ter no máximo 4 MB." };
  const content = Buffer.from(await file.arrayBuffer());
  return done(token, await withConfirmedFillProposal(token, async (tx, tenantId, proposal): Promise<Result> => {
    if (proposal.clientDataSubmittedAt) return { ok: false, error: "Seu cadastro já foi enviado." };
    return storeProposalDocument(tx, tenantId, proposal, text(data, "kind", 30), { name: file.name, content });
  }));
}

export async function submitFillAction(token: string): Promise<Result> {
  return done(token, await withConfirmedFillProposal(token, async (tx, tenantId, proposal): Promise<Result> => {
    if (proposal.clientDataSubmittedAt) return { ok: false, error: "Seu cadastro já foi enviado." };
    const client = await finalizeClientData(tx, tenantId, proposal);
    if (!client.ok) return client;
    const [tenant] = await tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId));
    await recordAdminAudit(tx, { user: { id: `proposal:${proposal.id}`, name: proposal.applicantName, email: proposal.email ?? "" } }, {
      action: "CREDIT_PROPOSAL_CLIENT_DATA_SUBMITTED", entity: "wallet", entityId: proposal.id, tenantId, tenantName: tenant?.name ?? null,
      description: `Cadastro completo enviado por ${proposal.applicantName} pelo link da proposta. Cliente ${client.created ? "cadastrado" : "atualizado"} em Clientes.`,
      before: null, after: { clientId: client.clientId, clientCreated: client.created, via: "FILL_LINK" },
    });
    return { ok: true, message: "Cadastro enviado! Obrigado. Entraremos em contato pelos dados informados." };
  }));
}
