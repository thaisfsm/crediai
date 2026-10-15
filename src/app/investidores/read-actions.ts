"use server";

// Leituras sob pedido da tela de investidores (não alteram nada, por isso ficam fora de actions.ts, onde toda ação
// grava auditoria). O tenant vem da sessão, pelo mesmo contexto das ações.
import { and, eq } from "drizzle-orm";
import { investorBankAccounts } from "@/lib/db/schema";
import type { BankAccountValues } from "@/lib/investors/bank-accounts";
import { tenantFilter, withInvestorContext } from "@/lib/investors/access";

const reader = (data: FormData) => (key: string, max: number) => String(data.get(key) ?? "").trim().slice(0, max);

// Números completos de UMA conta, só para preencher o formulário de edição (a ficha mostra tudo mascarado).
export async function loadInvestorBankAccountForEditAction(data: FormData): Promise<{ ok: true; values: BankAccountValues } | { ok: false; error: string }> {
  const read = reader(data);
  const accountId = read("accountId", 80);
  if (!accountId) return { ok: false, error: "Conta bancária inválida." };
  return withInvestorContext(async (tx, scope) => {
    const [account] = await tx.select().from(investorBankAccounts).where(and(eq(investorBankAccounts.id, accountId), tenantFilter(scope, investorBankAccounts.tenantId)));
    if (!account || account.archivedAt) return { ok: false as const, error: "Conta bancária não encontrada." };
    const { bankCode, bankName, branch, branchDigit, account: number, accountDigit, accountType, holderName, holderDocument, pixKeyType, pixKey, isPreferred, notes } = account;
    return { ok: true as const, values: { bankCode, bankName, branch, branchDigit, account: number, accountDigit, accountType: accountType as BankAccountValues["accountType"], holderName, holderDocument, pixKeyType: pixKeyType as BankAccountValues["pixKeyType"], pixKey, isPreferred, notes } };
  });
}
