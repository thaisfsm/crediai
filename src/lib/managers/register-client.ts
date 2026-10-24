import "server-only";
import { randomUUID } from "node:crypto";
import { recordAdminAudit, type AuditActor } from "@/lib/admin/audit";
import type { TenantTransaction } from "@/lib/auth/guards";
import { bankKeys } from "@/lib/bank-account";
import { clientFields, duplicateCpfError } from "@/lib/clients/fields";
import { clients, tenants } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { MANAGER_REQUIRED_FIELDS, missingManagerFields } from "./required-fields";
import type { CommandResult } from "./commands";

// Cadastro de cliente feito pela gerente de contas: as mesmas regras do cadastro do dono (clientFields), com os campos obrigatórios
// da gerente. O cliente nasce já ligado a ela, com a comissão padrão dela (o dono ajusta o percentual de cada cliente depois).
// Dados bancários e a marcação interna do dono nunca vêm da gerente, mesmo que o formulário seja forjado.
const SKIPPED = new Set(["clientId", "docLabel", "docFile", "onlineCasinoBettor", ...bankKeys]);

export async function registerClientByManager(tx: TenantTransaction, tenantId: string, manager: { id: string; name: string }, actor: AuditActor, data: FormData): Promise<CommandResult> {
  const clean = new FormData();
  for (const [key, value] of data.entries()) if (typeof value === "string" && !SKIPPED.has(key)) clean.set(key, value);
  const missing = missingManagerFields((key) => String(clean.get(key) ?? ""));
  if (missing.length > 0) return { ok: false, error: `Preencha os campos obrigatórios: ${missing.join(", ")}.` };
  const fields = clientFields(clean);
  if (!fields.ok) return fields;
  const duplicate = await duplicateCpfError(tx, tenantId, fields.values.document);
  if (duplicate) return { ok: false, error: duplicate };
  const clientId = `cli_${randomUUID().replaceAll("-", "")}`;
  await tx.insert(clients).values({ id: clientId, tenantId, ...fields.values, onlineCasinoBettor: false, accountManagerId: manager.id, accountManagerBps: null });
  const [tenant] = await tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId));
  await recordAdminAudit(tx, actor, {
    action: "CLIENT_REGISTERED_BY_MANAGER", entity: "account_manager", entityId: manager.id, tenantId, tenantName: tenant?.name ?? null,
    description: `Cliente ${fields.values.name} cadastrado pela gerente ${manager.name}.`, after: { clientId, name: fields.values.name },
  });
  return { ok: true, message: `Cliente ${fields.values.name} cadastrado e ligado a você.` };
}
export { MANAGER_REQUIRED_FIELDS };
