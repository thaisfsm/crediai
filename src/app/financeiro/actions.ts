"use server";

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { recordAdminAudit } from "@/lib/admin/audit";
import { withTenantContext } from "@/lib/auth/guards";
import { capitalMovements, tenants, wallets } from "@/lib/db/schema";
import { checkOutflow, manualCategories, parseManualMovement } from "@/lib/finance/cashflow";
import { cycleStartedOn, tenantCapital } from "@/lib/finance/finance-queries";
import { formatMoney, todayIso } from "@/lib/finance/format";
import type { ActionResult } from "../actions";

const field = (data: FormData, key: string, max: number) => String(data.get(key) ?? "").slice(0, max);

// Entrada ou saída manual do módulo Financeiro. Grava UMA linha em capital_movement (valor positivo, tipo explícito);
// o capital disponível é recalculado pela mesma fórmula do dashboard, nada é somado em outro lugar. O tenant vem só da
// sessão; nenhum identificador de tenant é aceito do navegador.
export async function registerFinanceMovementAction(data: FormData): Promise<ActionResult> {
  const input = {
    direction: field(data, "direction", 10), category: field(data, "category", 40), amount: field(data, "amount", 40), occurredAt: field(data, "occurredAt", 10),
    description: field(data, "description", 400), notes: field(data, "notes", 1000), requestId: field(data, "requestId", 80),
  };
  const result = await withTenantContext(async (tx, { tenantId, session }): Promise<ActionResult> => {
    // Trava a carteira: duas saídas (ou uma saída e uma operação) simultâneas não usam o mesmo capital, e o mesmo
    // envio repetido espera o primeiro terminar e então é reconhecido pela chave.
    const [wallet] = await tx.select().from(wallets).where(eq(wallets.tenantId, tenantId)).for("update");
    if (!wallet) return { ok: false, error: "Defina o capital inicial da carteira (tela Capital) antes de registrar movimentações." };
    const parsed = parseManualMovement(input, { today: todayIso(), cycleStartedOn: cycleStartedOn(wallet) });
    if (!parsed.ok) return parsed;
    const movement = parsed.value;
    const repeated = await tx.query.capitalMovements.findFirst({
      where: and(eq(capitalMovements.tenantId, tenantId), eq(capitalMovements.idempotencyKey, movement.requestId)),
    });
    if (repeated) return { ok: true, message: "Esta movimentação já estava registrada. Nada foi lançado em dobro." };
    if (movement.direction === "OUT") {
      const capital = await tenantCapital(tx, tenantId);
      const check = checkOutflow({ ledger: [...capital.capitalLedger].reverse(), amountCents: movement.amountCents, occurredAt: movement.occurredAt, availableCents: capital.summary.availableCents });
      if (!check.ok) return check;
    }
    const id = `cap_${randomUUID().replaceAll("-", "")}`;
    await tx.insert(capitalMovements).values({
      id, tenantId, kind: movement.kind, amountCents: movement.amountCents, occurredAt: movement.occurredAt, cycleNumber: wallet.cycleNumber,
      category: movement.category, description: movement.description, notes: movement.notes, createdByUserId: session.user.id, source: "FINANCE",
      idempotencyKey: movement.requestId,
    });
    // Auditoria na mesma transação: se ela falhar, a movimentação também não fica gravada. Sem descrição nem
    // observações (texto livre que pode ter dado pessoal): só o que identifica o lançamento.
    const tenant = await tx.query.tenants.findFirst({ where: eq(tenants.id, tenantId), columns: { name: true } });
    await recordAdminAudit(tx, session, {
      action: "FINANCE_MOVEMENT_REGISTERED", entity: "capital_movement", entityId: id, tenantId, tenantName: tenant?.name ?? null,
      description: `${movement.direction === "IN" ? "Entrada" : "Saída"} registrada no Financeiro: ${manualCategories[movement.category].label}`,
      after: { direction: movement.direction === "IN" ? "Entrada" : "Saída", category: manualCategories[movement.category].label, amountCents: movement.amountCents, occurredAt: movement.occurredAt, cycleNumber: wallet.cycleNumber },
    });
    const label = manualCategories[movement.category].label;
    return { ok: true, message: `${movement.direction === "IN" ? "Entrada" : "Saída"} de ${formatMoney(movement.amountCents)} registrada (${label}).` };
  });
  if (result.ok) {
    revalidatePath("/financeiro");
    revalidatePath("/");
  }
  return result;
}
