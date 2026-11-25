import "server-only";
import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { TenantTransaction } from "@/lib/auth/guards";
import { clients, creditProposalDocuments, creditProposals } from "@/lib/db/schema";
import { detectDocumentType } from "./file-type";
import { PROPOSAL_DOCUMENT_KINDS, PROPOSAL_DOCUMENT_MAX_BYTES, type ProposalDocumentKind } from "./documents";
import { clientFields } from "@/lib/clients/fields";
import { CLIENT_DATA_KEYS, CLIENT_DATA_STEPS, missingForSubmit, type ClientData, type ClientDataStepKey } from "./client-data-steps";

type Proposal = typeof creditProposals.$inferSelect;
type Failure = { ok: false; error: string };

// Monta o formulário do cadastro de Clientes com a identidade da proposta (nome, CPF, telefone) e os dados do cliente.
function asClientForm(proposal: Pick<Proposal, "applicantName" | "cpf" | "phone">, values: Record<string, string | null | undefined>) {
  const form = new FormData();
  form.set("name", proposal.applicantName);
  form.set("document", proposal.cpf);
  form.set("phone", proposal.phone ?? "");
  for (const key of CLIENT_DATA_KEYS) form.set(key, values[key] ?? "");
  return form;
}

// Valida a etapa com as MESMAS regras do cadastro de Clientes (src/lib/clients/fields.ts) e devolve os dados já normalizados
// (CPF, telefones, CEP e CNPJ só com dígitos, datas AAAA-MM-DD, Pix conforme o tipo). As outras etapas ficam como estavam.
export function mergeClientStep(proposal: Pick<Proposal, "applicantName" | "cpf" | "phone">, current: ClientData | null, step: ClientDataStepKey, input: FormData): { ok: true; data: ClientData } | Failure {
  const keys = CLIENT_DATA_STEPS.find((item) => item.key === step)!.keys as readonly string[];
  const values: Record<string, string> = { ...(current ?? {}) };
  for (const key of keys) values[key] = String(input.get(key) ?? "").trim();
  const checked = clientFields(asClientForm(proposal, values));
  if (!checked.ok) return checked;
  const data: ClientData = {};
  for (const key of CLIENT_DATA_KEYS) {
    const value = checked.values[key];
    if (value) data[key] = value;
  }
  return { ok: true, data };
}

// Envio: cria o cliente da carteira com o cadastro completo ou, se o CPF já for cliente (mesmo arquivado), atualiza o cadastro
// existente com o que o cliente preencheu, sem apagar o que ele deixou em branco e sem trocar o nome nem o CPF. Nunca duplica:
// o índice único (carteira, CPF) segura dois envios ao mesmo tempo. Não cria contrato nem mexe no capital.
export async function upsertClientFromProposal(tx: TenantTransaction, tenantId: string, proposal: Proposal): Promise<{ ok: true; clientId: string; created: boolean } | Failure> {
  const checked = clientFields(asClientForm(proposal, proposal.clientData ?? {}));
  if (!checked.ok) return checked;
  const filled = Object.fromEntries([...CLIENT_DATA_KEYS, "phone"].map((key) => [key, checked.values[key as keyof typeof checked.values]]).filter(([, value]) => value !== null && value !== undefined && value !== ""));
  const findExisting = async () => (await tx.select({ id: clients.id }).from(clients).where(and(eq(clients.tenantId, tenantId), eq(clients.document, checked.values.document!))).limit(1).for("update"))[0];
  let existing = await findExisting();
  if (!existing) {
    const clientId = `cli_${randomBytes(12).toString("hex")}`;
    const inserted = await tx.insert(clients).values({ id: clientId, tenantId, name: checked.values.name, document: checked.values.document, phone: checked.values.phone, whatsapp: checked.values.whatsapp ?? checked.values.phone, ...filled })
      .onConflictDoNothing().returning({ id: clients.id });
    if (inserted.length > 0) return { ok: true, clientId, created: true };
    existing = await findExisting();
    if (!existing) return { ok: false, error: "Não foi possível gravar o cadastro. Tente novamente." };
  }
  if (Object.keys(filled).length > 0) await tx.update(clients).set({ ...filled, updatedAt: sql`now()` }).where(and(eq(clients.id, existing.id), eq(clients.tenantId, tenantId)));
  return { ok: true, clientId: existing.id, created: false };
}

// Etapa do cadastro salva pelo cliente (rascunho: pode parar e continuar depois). Depois do envio fica travada.
export async function saveClientStep(tx: TenantTransaction, tenantId: string, proposal: Proposal, step: ClientDataStepKey, input: FormData): Promise<{ ok: true; message: string } | Failure> {
  if (proposal.status === "REJECTED") return { ok: false, error: "Esta proposta foi encerrada." };
  if (proposal.clientDataSubmittedAt) return { ok: false, error: "Seu cadastro já foi enviado." };
  const merged = mergeClientStep(proposal, proposal.clientData ?? null, step, input);
  if (!merged.ok) return merged;
  await tx.update(creditProposals).set({ clientData: merged.data }).where(and(eq(creditProposals.id, proposal.id), eq(creditProposals.tenantId, tenantId)));
  return { ok: true, message: "Etapa salva. Você pode continuar agora ou depois, pelo mesmo link." };
}

// Envio do cadastro: confere os obrigatórios e os 4 documentos, cria ou atualiza o cliente pelo CPF e liga o cliente à proposta.
export async function finalizeClientData(tx: TenantTransaction, tenantId: string, proposal: Proposal): Promise<{ ok: true; clientId: string; created: boolean } | Failure> {
  const missing = missingForSubmit(proposal.clientData, proposal);
  if (missing.length > 0) return { ok: false, error: `Faltam campos obrigatórios: ${missing.join(", ")}.` };
  const docs = await tx.select({ kind: creditProposalDocuments.kind }).from(creditProposalDocuments).where(and(eq(creditProposalDocuments.proposalId, proposal.id), eq(creditProposalDocuments.tenantId, tenantId)));
  if (PROPOSAL_DOCUMENT_KINDS.some((kind) => !docs.some((doc) => doc.kind === kind))) return { ok: false, error: "Faltam documentos obrigatórios para enviar a proposta." };
  const client = await upsertClientFromProposal(tx, tenantId, { ...proposal, clientData: { ...(proposal.email ? { email: proposal.email } : {}), ...(proposal.clientData ?? {}) } });
  if (!client.ok) return client;
  await tx.update(creditProposals).set({ clientId: client.clientId, clientDataSubmittedAt: sql`now()` }).where(and(eq(creditProposals.id, proposal.id), eq(creditProposals.tenantId, tenantId)));
  return client;
}

// Um documento por tipo (limite de 4 MB, PDF ou imagem conferidos pelo conteúdo). Enviar de novo substitui o anterior.
export async function storeProposalDocument(tx: TenantTransaction, tenantId: string, proposal: Proposal, kind: string, file: { name: string; content: Buffer }): Promise<{ ok: true; message: string } | Failure> {
  if (!PROPOSAL_DOCUMENT_KINDS.includes(kind as ProposalDocumentKind)) return { ok: false, error: "Documento inválido." };
  if (file.content.length === 0) return { ok: false, error: "Escolha o arquivo." };
  if (file.content.length > PROPOSAL_DOCUMENT_MAX_BYTES) return { ok: false, error: "O arquivo pode ter no máximo 4 MB." };
  const contentType = detectDocumentType(file.content);
  if (!contentType) return { ok: false, error: "Envie um PDF ou uma imagem (JPG, PNG ou WEBP)." };
  const fileName = file.name.replace(/[\\/\r\n"]/g, "_").slice(0, 160) || "documento";
  await tx.delete(creditProposalDocuments).where(and(eq(creditProposalDocuments.proposalId, proposal.id), eq(creditProposalDocuments.tenantId, tenantId), eq(creditProposalDocuments.kind, kind)));
  await tx.insert(creditProposalDocuments).values({ id: `pdc_${randomBytes(12).toString("hex")}`, tenantId, proposalId: proposal.id, kind, fileName, contentType, sizeBytes: file.content.length, content: file.content });
  return { ok: true, message: "Documento recebido." };
}
