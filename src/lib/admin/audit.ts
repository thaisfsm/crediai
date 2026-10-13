import "server-only";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import type { TenantTransaction } from "@/lib/auth/guards";
import { adminAuditLogs } from "@/lib/db/schema";
import { AUDIT_ACTIONS, cleanSnapshot, clientIp, type AuditAction } from "./audit-rules";

export type AuditEvent = {
  action: AuditAction; entity: string; entityId: string | null; tenantId: string | null; tenantName: string | null;
  description?: string; before?: Record<string, unknown> | null; after?: Record<string, unknown> | null;
};

// Quem agiu: só id, nome e e-mail (nada da sessão além disso vai para o registro).
export type AuditActor = { user: { id: string; name: string; email: string } };

// Grava um evento de auditoria na MESMA transação da ação: se a gravação falhar, a ação inteira é desfeita, e
// nenhuma alteração administrativa fica sem registro. Roda em withPlatformContext (RLS de SUPER_ADMIN) ou, no módulo
// Investidores, em withTenantContext: aí o RLS só aceita eventos de investidores do próprio tenant.
export async function recordAdminAudit(tx: TenantTransaction, session: AuditActor, event: AuditEvent) {
  const requestHeaders = await headers();
  await tx.insert(adminAuditLogs).values({
    id: `aud_${randomUUID().replaceAll("-", "")}`,
    actorUserId: session.user.id, actorName: session.user.name, actorEmail: session.user.email,
    tenantId: event.tenantId, tenantName: event.tenantName,
    action: event.action, entity: event.entity, entityId: event.entityId,
    description: (event.description ?? AUDIT_ACTIONS[event.action]).slice(0, 500),
    before: cleanSnapshot(event.before), after: cleanSnapshot(event.after),
    ipAddress: clientIp(requestHeaders.get("x-forwarded-for"), requestHeaders.get("x-real-ip")),
    userAgent: requestHeaders.get("user-agent")?.slice(0, 300) ?? null,
  });
}
