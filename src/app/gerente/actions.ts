"use server";

import { revalidatePath } from "next/cache";
import { withManagerContext } from "@/lib/auth/guards";
import type { CommandResult } from "@/lib/managers/commands";
import { registerClientByManager } from "@/lib/managers/register-client";

// Única gravação da gerente de contas: cadastrar um cliente que ela indica (ligado a ela). A gerente vem só da sessão
// (withManagerContext); nenhuma outra ação de carteira aceita o papel dela.
export async function registerClientAction(data: FormData): Promise<CommandResult> {
  const result = await withManagerContext((tx, { tenantId, manager, session }) => registerClientByManager(tx, tenantId, manager, session, data));
  if (result.ok) revalidatePath("/gerente");
  return result;
}
