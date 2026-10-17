"use server";

// Renegociação (Etapa H, parte 2): grava a renegociação. Encerra as operações antigas como "Renegociada", cria o contrato
// novo ligado a elas e registra tudo na auditoria, na MESMA transação. O principal em aberto das antigas passa para o
// novo contrato sem sair dinheiro do capital; os juros em aberto entram no novo contrato e só contam como lucro quando pagos.
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withTenantContext } from "@/lib/auth/guards";
import { recordAdminAudit } from "@/lib/admin/audit";
import { clients, loanOperations, tenants, wallets } from "@/lib/db/schema";
import { tenantCapital } from "@/lib/finance/finance-queries";
import { formatMoney, isIsoDate, parseMoneyToCents, parseLoanRateToBps, todayIso } from "@/lib/finance/format";
import { operationCode } from "@/lib/finance/portfolio";
import { renegotiationContract, renegotiationPosition, type RenegotiationFrequency, type RenegotiationModality } from "@/lib/finance/renegotiation";

export type RenegotiationResult = { ok: true; message: string; operationId: string; operationCode: string } | { ok: false; error: string };

const text = (data: FormData, key: string, max: number) => String(data.get(key) ?? "").trim().slice(0, max);

export async function renegotiateAction(data: FormData): Promise<RenegotiationResult> {
  const clientId = text(data, "clientId", 80);
  const operationIds = [...new Set(data.getAll("operationIds").map((value) => String(value).trim().slice(0, 80)).filter(Boolean))];
  if (!clientId || operationIds.length === 0) return { ok: false, error: "Escolha o cliente e ao menos uma operação em aberto." };
  if (operationIds.length > 50) return { ok: false, error: "Escolha até 50 operações por renegociação." };
  if (text(data, "confirm", 5) !== "1") return { ok: false, error: "Confirme a renegociação para gravar." };
  const modality: RenegotiationModality = text(data, "modality", 20) === "SINGLE" ? "SINGLE" : "INSTALLMENT";
  const frequency: RenegotiationFrequency = text(data, "frequency", 20) === "BIWEEKLY" ? "BIWEEKLY" : "MONTHLY";
  const rateBps = parseLoanRateToBps(text(data, "rate", 20));
  if (rateBps === null || rateBps > 100_000) return { ok: false, error: "Informe a taxa de juros em %, por exemplo 5." };
  const countInput = text(data, "count", 5);
  const count = modality === "INSTALLMENT" ? (/^\d{1,3}$/.test(countInput) ? Number(countInput) : NaN) : 1;
  if (!Number.isInteger(count) || count < 1 || count > 360) return { ok: false, error: "Informe a quantidade de parcelas, de 1 a 360." };
  const firstDueDate = text(data, "firstDueDate", 10);
  if (!isIsoDate(firstDueDate)) return { ok: false, error: "Informe o primeiro vencimento." };
  const adjustmentKind = text(data, "adjustmentKind", 10);
  const adjustmentInput = adjustmentKind === "DISCOUNT" || adjustmentKind === "ADDITION" ? parseMoneyToCents(text(data, "adjustment", 40)) : 0;
  if (adjustmentInput === null || adjustmentInput < 0) return { ok: false, error: "Informe o valor do ajuste em reais, por exemplo 100,00." };
  const reason = text(data, "reason", 300);
  if (adjustmentInput > 0 && reason.length < 3) return { ok: false, error: "Informe o motivo do desconto ou do acréscimo." };
  const adjustmentCents = adjustmentKind === "DISCOUNT" ? -adjustmentInput : adjustmentInput;
  const loanDate = todayIso();

  const result = await withTenantContext(async (tx, { tenantId, session }): Promise<RenegotiationResult> => {
    // Trava a carteira e as operações escolhidas: um pagamento ou outra renegociação simultânea espera e depois é recusada.
    await tx.select({ id: wallets.id }).from(wallets).where(eq(wallets.tenantId, tenantId)).for("update");
    const locked = await tx.select({ id: loanOperations.id }).from(loanOperations)
      .where(and(eq(loanOperations.tenantId, tenantId), inArray(loanOperations.id, operationIds))).for("update");
    if (locked.length !== operationIds.length) return { ok: false, error: "Alguma operação não foi encontrada nesta carteira." };
    const [client] = await tx.select({ id: clients.id, name: clients.name }).from(clients).where(and(eq(clients.id, clientId), eq(clients.tenantId, tenantId)));
    if (!client) return { ok: false, error: "Cliente não encontrado nesta carteira." };
    const portfolio = await tenantCapital(tx, tenantId);
    const chosen = portfolio.operations.filter((operation) => operationIds.includes(operation.id));
    if (chosen.length !== operationIds.length) return { ok: false, error: "Só operações do ciclo atual podem ser renegociadas." };
    if (chosen.some((operation) => operation.clientId !== clientId)) return { ok: false, error: "Todas as operações precisam ser do mesmo cliente." };
    if (chosen.some((operation) => operation.status !== "OPEN")) return { ok: false, error: "Só operações em aberto podem ser renegociadas. Atualize a tela e confira." };
    const position = renegotiationPosition(chosen);
    const built = renegotiationContract(position, { modality, frequency, rateBps, count, firstDueDate, adjustmentCents }, loanDate);
    if (!built.ok) return built;

    const renegotiatedAt = new Date();
    const newId = `op_${randomUUID().replaceAll("-", "")}`;
    // O contrato novo é criado 1 ms depois, para o extrato mostrar primeiro a volta do principal e depois a nova saída.
    await tx.insert(loanOperations).values({
      id: newId, tenantId, clientId, status: "OPEN", cycleNumber: portfolio.summary.cycleNumber, createdAt: new Date(renegotiatedAt.getTime() + 1), updatedAt: new Date(renegotiatedAt.getTime() + 1),
      ...built.contract,
    });
    for (const operation of chosen) {
      await tx.update(loanOperations).set({
        status: "RENEGOTIATED", renegotiatedIntoId: newId, renegotiatedOn: loanDate, renegotiatedAt, settledAt: loanDate,
        renegotiatedPrincipalCents: operation.principalRemainingCents, renegotiatedInterestCents: operation.interestRemainingCents, updatedAt: renegotiatedAt,
      }).where(and(eq(loanOperations.id, operation.id), eq(loanOperations.tenantId, tenantId), eq(loanOperations.status, "OPEN")));
    }
    const tenant = await tx.query.tenants.findFirst({ where: eq(tenants.id, tenantId), columns: { name: true } });
    const newCode = operationCode(newId);
    await recordAdminAudit(tx, session, {
      action: "OPERATION_RENEGOTIATED", entity: "loan_operation", entityId: newId, tenantId, tenantName: tenant?.name ?? null,
      before: { operations: chosen.map((operation) => ({ id: operation.id, code: operation.code, principalOpenCents: operation.principalRemainingCents, interestOpenCents: operation.interestRemainingCents, balanceCents: operation.balanceCents })) },
      after: { newOperationId: newId, newOperationCode: newCode, ...built.contract, adjustmentCents, roundingCents: built.roundingCents, reason: reason || null },
      description: `Renegociação de ${client.name}: ${chosen.map((operation) => `#${operation.code}`).join(", ")} → #${newCode}`,
    });
    return {
      ok: true, operationId: newId, operationCode: newCode,
      message: `Renegociação gravada: ${chosen.length === 1 ? "a operação" : `as ${chosen.length} operações`} de ${client.name} ${chosen.length === 1 ? "foi encerrada" : "foram encerradas"} como renegociada${chosen.length === 1 ? "" : "s"} e o contrato #${newCode} (${formatMoney(built.contract.totalCents)}) foi criado. Nenhum dinheiro saiu do capital.`,
    };
  });
  if (result.ok) revalidatePath("/");
  return result;
}
