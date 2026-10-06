"use server";

import { randomUUID } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withPlatformContext } from "@/lib/auth/guards";
import { plans } from "@/lib/db/schema";
import { parseMoneyToCents } from "@/lib/finance/format";

// Planos (produto e preço PADRÃO). Só SUPER_ADMIN, conferido na sessão e no banco (withPlatformContext).
// Mudar o preço padrão não altera nenhuma assinatura: cada cliente guarda o próprio valor contratado.

export type PlanActionResult = { ok: true; message: string } | { ok: false; error: string };

const text = (data: FormData, key: string, max: number) => String(data.get(key) ?? "").trim().slice(0, max);

function readPlan(data: FormData): { ok: true; name: string; description: string; priceInCents: number; active: boolean } | { ok: false; error: string } {
  const name = text(data, "name", 60);
  const description = text(data, "description", 300);
  const priceInCents = parseMoneyToCents(text(data, "price", 20) || "0");
  if (name.length < 2) return { ok: false, error: "Informe o nome do plano." };
  if (priceInCents === null || priceInCents < 0 || priceInCents > 10_000_000) return { ok: false, error: "Informe um preço padrão válido (pode ser R$ 0,00 enquanto não estiver definido)." };
  return { ok: true, name, description, priceInCents, active: data.get("active") === "on" };
}

const slugify = (name: string) => name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "plano";

export async function createPlanAction(data: FormData): Promise<PlanActionResult> {
  const plan = readPlan(data);
  if (!plan.ok) return plan;
  const result = await withPlatformContext(async (tx) => {
    const sameName = await tx.select({ id: plans.id }).from(plans).where(sql`lower(${plans.name}) = ${plan.name.toLowerCase()}`);
    if (sameName.length) return { ok: false as const, error: "Já existe um plano com este nome." };
    const suffix = randomUUID().replaceAll("-", "").slice(0, 6);
    const slug = `${slugify(plan.name)}-${suffix}`;
    await tx.insert(plans).values({ id: `plan_${slug.replaceAll("-", "_")}`, slug, name: plan.name, description: plan.description, priceInCents: plan.priceInCents, active: plan.active });
    return { ok: true as const, message: `Plano ${plan.name} criado.` };
  });
  if (result.ok) { revalidatePath("/admin/planos"); revalidatePath("/admin"); }
  return result;
}

export async function updatePlanAction(data: FormData): Promise<PlanActionResult> {
  const plan = readPlan(data);
  if (!plan.ok) return plan;
  const planId = text(data, "planId", 80);
  const result = await withPlatformContext(async (tx) => {
    const [current] = await tx.select({ id: plans.id }).from(plans).where(eq(plans.id, planId));
    if (!current) return { ok: false as const, error: "Plano não encontrado." };
    const sameName = await tx.select({ id: plans.id }).from(plans).where(and(sql`lower(${plans.name}) = ${plan.name.toLowerCase()}`, ne(plans.id, planId)));
    if (sameName.length) return { ok: false as const, error: "Já existe outro plano com este nome." };
    // Só a linha do plano muda. Assinaturas, tenants e valores contratados ficam como estão.
    await tx.update(plans).set({ name: plan.name, description: plan.description, priceInCents: plan.priceInCents, active: plan.active, updatedAt: sql`now()` }).where(eq(plans.id, planId));
    return { ok: true as const, message: `Plano ${plan.name} atualizado. Os valores contratados dos clientes não mudaram.` };
  });
  if (result.ok) { revalidatePath("/admin/planos"); revalidatePath("/admin"); }
  return result;
}
