"use server";

import { revalidatePath } from "next/cache";
import { withManagerContext } from "@/lib/auth/guards";
import type { CommandResult } from "@/lib/managers/commands";
import { submitOperationRequest } from "@/lib/managers/operation-request";
import { registerClientByManager } from "@/lib/managers/register-client";

// Única gravação da gerente de contas: cadastrar um cliente que ela indica (ligado a ela). A gerente vem só da sessão
// (withManagerContext); nenhuma outra ação de carteira aceita o papel dela.
export async function registerClientAction(data: FormData): Promise<CommandResult> {
  const result = await withManagerContext((tx, { tenantId, manager, session }) => registerClientByManager(tx, tenantId, manager, session, data));
  if (result.ok) revalidatePath("/gerente");
  return result;
}

// Pedido de operação: a gerente preenche o mesmo formulário do dono e o pedido espera a aprovação dele; nada entra no capital antes.
export async function submitOperationRequestAction(data: FormData): Promise<CommandResult> {
  const result = await withManagerContext((tx, { tenantId, manager, session }) => submitOperationRequest(tx, tenantId, manager, session, data));
  if (result.ok) { revalidatePath("/gerente"); revalidatePath("/"); }
  return result;
}
