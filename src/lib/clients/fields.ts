import { and, eq, ne } from "drizzle-orm";
import type { TenantTransaction } from "@/lib/auth/guards";
import { clients } from "@/lib/db/schema";
import { normalizeEmail, normalizeSocial } from "@/lib/contacts";
import { bankFields, bankKeys } from "@/lib/bank-account";
import { brazilianStates, clientProfileKeys, type ClientProfile } from "@/lib/finance/client-profile";
import { formatCpf, normalizeCnpj, normalizeCpf, normalizePhone, onlyDigits, todayIso } from "@/lib/finance/format";

// Validação do cadastro de cliente, usada pelo cadastro do dono e pelo cadastro enviado pela gerente (aprovação).
const text = (data: FormData, key: string, max: number) => String(data.get(key) ?? "").trim().slice(0, max);
const optional = (value: string) => (value ? value : null);

// CPF e telefone são gravados só com dígitos e formatados na tela. Um valor antigo fora do padrão (por exemplo um RG),
// reenviado sem alteração na edição, é mantido como está para não impedir a edição de clientes cadastrados antes das máscaras.
export function clientFields(data: FormData, previous?: { document: string | null; phone: string | null } & Partial<ClientProfile>) {
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
  // Data de admissão: opcional, data real e não futura.
  const admission = profile.businessAdmissionDate;
  if (admission) {
    const real = /^\d{4}-\d{2}-\d{2}$/.test(admission) && new Date(`${admission}T00:00:00Z`).toISOString().slice(0, 10) === admission;
    if (!real) return { ok: false as const, error: "Data de admissão inválida. Informe uma data real, por exemplo 15/03/2021." };
    if (admission > todayIso()) return { ok: false as const, error: "A data de admissão não pode ser futura." };
    if (admission < "1900-01-01") return { ok: false as const, error: "Data de admissão inválida. Informe uma data real, por exemplo 15/03/2021." };
  }
  // Dados bancários e chave Pix (src/lib/bank-account.ts).
  const bank = bankFields((key, max) => text(data, key, max));
  if (!bank.ok) return bank;
  for (const key of bankKeys) profile[key] = bank.values[key];
  return { ok: true as const, values: { name, document: document.value, phone: phone.value, notes: optional(text(data, "notes", 2000)), onlineCasinoBettor: data.get("onlineCasinoBettor") === "on", ...profile } };
}

// O mesmo CPF uma só vez por carteira (clientes arquivados contam). A consulta dá a mensagem com o nome; o índice único
// client_tenant_document_unique garante a regra mesmo com dois cadastros simultâneos.
export async function duplicateCpfError(tx: TenantTransaction, tenantId: string, document: string | null, exceptClientId?: string) {
  if (!document) return null;
  const [other] = await tx.select({ name: clients.name, archivedAt: clients.archivedAt }).from(clients)
    .where(and(eq(clients.tenantId, tenantId), eq(clients.document, document), exceptClientId ? ne(clients.id, exceptClientId) : undefined)).limit(1);
  if (!other) return null;
  return `Já existe um cliente com o CPF ${formatCpf(document)} nesta carteira: ${other.name}${other.archivedAt ? " (arquivado)" : ""}.`;
}
export const isDuplicateCpf = (error: unknown) => {
  const cause = (error as { cause?: { code?: string; constraint_name?: string } })?.cause ?? (error as { code?: string; constraint_name?: string });
  return cause?.code === "23505" && cause?.constraint_name === "client_tenant_document_unique";
};

