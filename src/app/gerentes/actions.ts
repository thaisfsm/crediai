"use server";

import { revalidatePath } from "next/cache";
import { generateTemporaryPassword, hashPassword } from "@/lib/admin/passwords";
import { accountState, withTenantContext } from "@/lib/auth/guards";
import { ACCESS_ADMIN_ONLY, createAdjustment, createManager, createManagerAccess, deleteAdjustment, deleteManager, linkClient, registerPayout, resetManagerPassword, reverseCommissionPaid, transferOperation, unlinkClient, updateManager, type AccessCommandResult, type CommandResult } from "@/lib/managers/commands";

// Gerentes de contas, pelo dono da carteira (TENANT_USER). Tudo em withTenantContext: o tenant vem só da sessão. As regras e a
// auditoria ficam em src/lib/managers/commands.ts (as mesmas usadas pelo MASTER). O gerente (ACCOUNT_MANAGER) nunca chega aqui:
// requireTenantUser o manda para /gerente.
// Logins dos gerentes (criar, nova senha, ativar/desativar, revogar) só pelo MASTER: o papel é conferido no BANCO a cada ação,
// então o dono operacional da carteira (TENANT_USER) é recusado mesmo chamando a ação direto, sem a tela.
export type AccessResult = AccessCommandResult;
async function isMaster(userId: string) { return (await accountState(userId))?.role === "SUPER_ADMIN"; }
const refresh = () => revalidatePath("/gerentes");
const run = async (command: (tx: Parameters<Parameters<typeof withTenantContext>[0]>[0], tenantId: string, actor: { user: { id: string; name: string; email: string } }) => Promise<CommandResult>): Promise<CommandResult> => {
  const result = await withTenantContext((tx, { tenantId, session }) => command(tx, tenantId, session));
  if (result.ok) refresh();
  return result;
};

export async function createManagerAction(data: FormData): Promise<CommandResult> { return run((tx, tenantId, actor) => createManager(tx, tenantId, actor, data)); }
export async function updateManagerAction(data: FormData): Promise<CommandResult> { return run(async (tx, tenantId, actor) => updateManager(tx, tenantId, actor, data, await isMaster(actor.user.id))); }
export async function linkClientAction(data: FormData): Promise<CommandResult> { return run((tx, tenantId, actor) => linkClient(tx, tenantId, actor, data)); }
export async function unlinkClientAction(data: FormData): Promise<CommandResult> { return run((tx, tenantId, actor) => unlinkClient(tx, tenantId, actor, data)); }
export async function transferOperationAction(data: FormData): Promise<CommandResult> {
  const result = await run((tx, tenantId, actor) => transferOperation(tx, tenantId, actor, data));
  if (result.ok) revalidatePath("/");
  return result;
}
export async function deleteManagerAction(data: FormData): Promise<CommandResult> { return run(async (tx, tenantId, actor) => deleteManager(tx, tenantId, actor, data, await isMaster(actor.user.id))); }
export async function registerManagerPayoutAction(data: FormData): Promise<CommandResult> { return run((tx, tenantId, actor) => registerPayout(tx, tenantId, actor, data)); }
export async function reverseCommissionAction(data: FormData): Promise<CommandResult> { return run((tx, tenantId, actor) => reverseCommissionPaid(tx, tenantId, actor, data)); }
export async function createAdjustmentAction(data: FormData): Promise<CommandResult> { return run((tx, tenantId, actor) => createAdjustment(tx, tenantId, actor, data)); }
export async function deleteAdjustmentAction(data: FormData): Promise<CommandResult> { return run((tx, tenantId, actor) => deleteAdjustment(tx, tenantId, actor, data)); }

async function access(data: FormData, command: typeof createManagerAccess): Promise<AccessResult> {
  // Antes de gerar qualquer senha: sessão válida da carteira (o gerente vai para /gerente) e papel MASTER no banco.
  const allowed = await withTenantContext(async (_tx, { session }) => isMaster(session.user.id));
  if (!allowed) return { ok: false, error: ACCESS_ADMIN_ONLY };
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  try {
    const result = await withTenantContext(async (tx, { tenantId, session }) => {
      if (!(await isMaster(session.user.id))) return { ok: false as const, error: ACCESS_ADMIN_ONLY };
      return command(tx, tenantId, session, data, passwordHash, temporaryPassword);
    });
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
