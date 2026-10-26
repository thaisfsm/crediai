"use server";

import { revalidatePath } from "next/cache";
import { generateTemporaryPassword, hashPassword } from "@/lib/admin/passwords";
import { withTenantContext } from "@/lib/auth/guards";
import { createManager, createManagerAccess, deleteManager, linkClient, registerPayout, resetManagerPassword, transferOperation, unlinkClient, updateManager, type AccessCommandResult, type CommandResult } from "@/lib/managers/commands";

// Gerentes de contas, pelo dono da carteira (TENANT_USER). Tudo em withTenantContext: o tenant vem só da sessão. As regras e a
// auditoria ficam em src/lib/managers/commands.ts (as mesmas usadas pelo MASTER). O gerente (ACCOUNT_MANAGER) nunca chega aqui:
// requireTenantUser o manda para /gerente.
export type AccessResult = AccessCommandResult;
const refresh = () => revalidatePath("/gerentes");
const run = async (command: (tx: Parameters<Parameters<typeof withTenantContext>[0]>[0], tenantId: string, actor: { user: { id: string; name: string; email: string } }) => Promise<CommandResult>): Promise<CommandResult> => {
  const result = await withTenantContext((tx, { tenantId, session }) => command(tx, tenantId, session));
  if (result.ok) refresh();
  return result;
};

export async function createManagerAction(data: FormData): Promise<CommandResult> { return run((tx, tenantId, actor) => createManager(tx, tenantId, actor, data)); }
export async function updateManagerAction(data: FormData): Promise<CommandResult> { return run((tx, tenantId, actor) => updateManager(tx, tenantId, actor, data)); }
export async function linkClientAction(data: FormData): Promise<CommandResult> { return run((tx, tenantId, actor) => linkClient(tx, tenantId, actor, data)); }
export async function unlinkClientAction(data: FormData): Promise<CommandResult> { return run((tx, tenantId, actor) => unlinkClient(tx, tenantId, actor, data)); }
export async function transferOperationAction(data: FormData): Promise<CommandResult> {
  const result = await run((tx, tenantId, actor) => transferOperation(tx, tenantId, actor, data));
  if (result.ok) revalidatePath("/");
  return result;
}
export async function deleteManagerAction(data: FormData): Promise<CommandResult> { return run((tx, tenantId, actor) => deleteManager(tx, tenantId, actor, data)); }
export async function registerManagerPayoutAction(data: FormData): Promise<CommandResult> { return run((tx, tenantId, actor) => registerPayout(tx, tenantId, actor, data)); }

async function access(data: FormData, command: typeof createManagerAccess): Promise<AccessResult> {
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  try {
    const result = await withTenantContext((tx, { tenantId, session }) => command(tx, tenantId, session, data, passwordHash, temporaryPassword));
    if (result.ok) refresh();
    return result;
  } catch (error) {
    const cause = (error as { cause?: { code?: string } })?.cause ?? (error as { code?: string });
    if (cause?.code === "23505") return { ok: false, error: "Já existe uma conta com este e-mail." };
    throw error;
  }
}
export async function createManagerAccessAction(data: FormData): Promise<AccessResult> { return access(data, createManagerAccess); }
export async function resetManagerPasswordAction(data: FormData): Promise<AccessResult> { return access(data, resetManagerPassword); }
