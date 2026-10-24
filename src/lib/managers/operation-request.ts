import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { recordAdminAudit, type AuditActor } from "@/lib/admin/audit";
import type { TenantTransaction } from "@/lib/auth/guards";
import { clients, operationRequests, tenants } from "@/lib/db/schema";
import { formatMoney } from "@/lib/finance/format";
import { operationTermsFromForm } from "@/lib/finance/operation-terms";
import type { CommandResult } from "./commands";

// Pedido de operação da gerente de contas: o mesmo formulário do dono, mas nada entra na carteira nem no capital até o dono aprovar.
// Só os campos do formulário de operação são guardados (qualquer outro é descartado) e o cliente precisa ser dela.
const FORM_KEYS = ["clientId", "modality", "frequency", "installmentFrequency", "interestMode", "principal", "interestAmount", "rate", "loanDate", "dueDate", "days", "firstDueDate", "loanAmount", "installment", "term"] as const;

export async function submitOperationRequest(tx: TenantTransaction, tenantId: string, manager: { id: string; name: string }, actor: AuditActor, data: FormData): Promise<CommandResult> {
  const form: Record<string, string> = {};
  for (const key of FORM_KEYS) {
    const value = data.get(key);
    if (typeof value === "string" && value.trim()) form[key] = value.trim().slice(0, 80);
  }
  if (!form.clientId) return { ok: false, error: "Selecione o cliente." };
  const [client] = await tx.select({ id: clients.id, name: clients.name }).from(clients)
    .where(and(eq(clients.id, form.clientId), eq(clients.tenantId, tenantId), eq(clients.accountManagerId, manager.id), isNull(clients.archivedAt)));
  if (!client) return { ok: false, error: "Cliente não encontrado entre os seus clientes." };
  const clean = new FormData();
  for (const [key, value] of Object.entries(form)) clean.set(key, value);
  const terms = operationTermsFromForm(clean);
  if (!terms.ok) return terms;
  const requestId = `opr_${randomUUID().replaceAll("-", "")}`;
  await tx.insert(operationRequests).values({
    id: requestId, tenantId, managerId: manager.id, clientId: client.id, form, principalCents: terms.principalCents,
    totalCents: Number(terms.values.totalCents ?? terms.principalCents), loanDate: terms.loanDate,
  });
  const [tenant] = await tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId));
  await recordAdminAudit(tx, actor, {
    action: "OPERATION_REQUESTED_BY_MANAGER", entity: "account_manager", entityId: manager.id, tenantId, tenantName: tenant?.name ?? null,
    description: `Pedido de operação de ${formatMoney(terms.principalCents)} para ${client.name} enviado pela gerente ${manager.name}.`, after: { requestId, clientId: client.id, principalCents: terms.principalCents },
  });
  return { ok: true, message: `Pedido enviado para aprovação: ${formatMoney(terms.principalCents)} para ${client.name}. Você será avisada quando for decidido.` };
}
