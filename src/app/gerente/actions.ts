"use server";

import { cookies } from "next/headers";
import { requireAccountManager } from "@/lib/auth/guards";
import { THEME_COOKIE } from "./theme";

// Única "ação" do gerente: guardar a cor do painel num cookie do navegador. Nada é gravado no banco: o acesso é só de leitura.
export async function setManagerThemeAction(theme: string): Promise<void> {
  await requireAccountManager();
  (await cookies()).set(THEME_COOKIE, theme === "roxo" ? "roxo" : "padrao", { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax", httpOnly: true, secure: process.env.NODE_ENV === "production" });
}
