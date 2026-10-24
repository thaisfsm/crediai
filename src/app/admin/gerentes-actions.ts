"use server";

import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { generateTemporaryPassword, hashPassword } from "@/lib/admin/passwords";
import { withPlatformContext, type TenantTransaction } from "@/lib/auth/guards";
import { tenants, users } from "@/lib/db/schema";
import { createManager, createManagerAccess, linkClient, registerPayout, resetManagerPassword, text, unlinkClient, updateManager, type AccessCommandResult, type CommandResult } from "@/lib/managers/commands";

// Gerentes de contas pelo MASTER (SUPER_ADMIN), em nome de um cliente SaaS. O tenant vem do formulário, mas só vale se existir e não
// for o ambiente de um SUPER_ADMIN; as regras e a auditoria são as mesmas do dono da carteira (src/lib/managers/commands.ts),
// e o evento de auditoria leva o MASTER como autor e o cliente SaaS como alvo. withPlatformContext confere o papel na sessão e no banco.
async function targetTenant(tx: TenantTransaction, data: FormData) {
  const tenantId = text(data, "tenantId", 80);
  if (!tenantId) return null;
  const [tenant] = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId));
  if (!tenant) return null;
  const [platformOwner] = await tx.select({ id: users.id }).from(users).where(sql`${users.tenantId} = ${tenant.id} and ${users.role} = 'SUPER_ADMIN'`).limit(1);
  return platformOwner ? null : tenant.id;
}
const NOT_FOUND = { ok: false as const, error: "Cliente SaaS não encontrado." };
const refresh = (tenantId: string) => revalidatePath(`/admin/clientes/${tenantId}`);

async function run(data: FormData, command: (tx: TenantTransaction, tenantId: string, session: { user: { id: string; name: string; email: string } }) => Promise<CommandResult>): Promise<CommandResult> {
  return withPlatformContext(async (tx, { session }) => {
    const tenantId = await targetTenant(tx, data);
    if (!tenantId) return NOT_FOUND;
    const result = await command(tx, tenantId, session);
    if (result.ok) refresh(tenantId);
    return result;
  });
}

export async function adminCreateManagerAction(data: FormData) { return run(data, (tx, tenantId, session) => createManager(tx, tenantId, session, data)); }
export async function adminUpdateManagerAction(data: FormData) { return run(data, (tx, tenantId, session) => updateManager(tx, tenantId, session, data)); }
export async function adminLinkClientAction(data: FormData) { return run(data, (tx, tenantId, session) => linkClient(tx, tenantId, session, data)); }
export async function adminUnlinkClientAction(data: FormData) { return run(data, (tx, tenantId, session) => unlinkClient(tx, tenantId, session, data)); }
export async function adminRegisterManagerPayoutAction(data: FormData) { return run(data, (tx, tenantId, session) => registerPayout(tx, tenantId, session, data)); }

async function access(data: FormData, command: typeof createManagerAccess): Promise<AccessCommandResult> {
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  try {
    return await withPlatformContext(async (tx, { session }) => {
      const tenantId = await targetTenant(tx, data);
      if (!tenantId) return NOT_FOUND;
      const result = await command(tx, tenantId, session, data, passwordHash, temporaryPassword);
      if (result.ok) refresh(tenantId);
      return result;
    });
  } catch (error) {
    const cause = (error as { cause?: { code?: string } })?.cause ?? (error as { code?: string });
    if (cause?.code === "23505") return { ok: false, error: "Já existe uma conta com este e-mail." };
    throw error;
  }
}
export async function adminCreateManagerAccessAction(data: FormData) { return access(data, createManagerAccess); }
export async function adminResetManagerPasswordAction(data: FormData) { return access(data, resetManagerPassword); }
