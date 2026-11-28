"use server";

import { requireAccountManager } from "@/lib/auth/guards";
import type { CommandResult } from "@/lib/managers/commands";

// O acesso da gerente de contas é ESTRITAMENTE de consulta: nenhuma gravação é aceita deste painel. As duas ações antigas (cadastrar
// cliente indicado e pedir operação para aprovação) continuam existindo só para recusar qualquer chamada forjada, mesmo de uma tela
// antiga aberta no navegador. requireAccountManager confere sessão, conta ativa e papel; nada é lido nem gravado na carteira.
const READ_ONLY: CommandResult = { ok: false, error: "Seu acesso é somente de consulta. Peça ao responsável pela carteira para fazer esta alteração." };

export async function registerClientAction(data: FormData): Promise<CommandResult> {
  void data;
  await requireAccountManager();
  return READ_ONLY;
}

export async function submitOperationRequestAction(data: FormData): Promise<CommandResult> {
  void data;
  await requireAccountManager();
  return READ_ONLY;
}
