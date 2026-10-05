"use server";

import { and, eq, ne, sql } from "drizzle-orm";
import { headers } from "next/headers";
import { requireActiveAccount } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { sessions, users } from "@/lib/db/schema";

export type ChangePasswordResult = { ok: true } | { ok: false; error: string };

// Troca da senha provisória. Quem confere a senha atual e grava o novo hash é o próprio Better Auth
// (changePassword); só depois disso a exigência é removida. O papel da conta não muda.
export async function changeTemporaryPasswordAction(data: FormData): Promise<ChangePasswordResult> {
  const { session, state } = await requireActiveAccount({ allowTemporaryPassword: true });
  if (!state.mustChangePassword) return { ok: true };
  const currentPassword = String(data.get("currentPassword") ?? "");
  const newPassword = String(data.get("newPassword") ?? "");
  const confirmPassword = String(data.get("confirmPassword") ?? "");
  if (newPassword.length < 12 || newPassword.length > 128) return { ok: false, error: "A nova senha precisa ter de 12 a 128 caracteres." };
  if (newPassword !== confirmPassword) return { ok: false, error: "A confirmação não é igual à nova senha." };
  if (newPassword === currentPassword) return { ok: false, error: "A nova senha precisa ser diferente da senha provisória." };

  const { auth } = await import("@/lib/auth");
  try {
    await auth.api.changePassword({ body: { currentPassword, newPassword }, headers: await headers() });
  } catch {
    return { ok: false, error: "A senha provisória informada não confere." };
  }
  await db.update(users).set({ mustChangePassword: false, updatedAt: sql`now()` }).where(eq(users.id, session.user.id));
  // Outras sessões abertas com a senha provisória são encerradas; a atual continua.
  await db.delete(sessions).where(and(eq(sessions.userId, session.user.id), ne(sessions.id, session.session.id)));
  return { ok: true };
}
