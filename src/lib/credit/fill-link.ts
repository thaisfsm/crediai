import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { creditProposals, tenants } from "@/lib/db/schema";
import type { TenantTransaction } from "@/lib/auth/guards";
import { onlyDigits } from "@/lib/finance/format";

// Link individual de uma proposta cadastrada pelo dono (/completar/<link>): o cliente completa o cadastro sem criar conta.
// O link (192 bits, com validade) só abre a própria proposta; para ver qualquer dado é preciso confirmar o CPF da proposta
// (5 erros travam 15 minutos). A sessão vale só para este link e só o hash dela fica no banco. Gerar um novo link derruba o anterior.
export const FILL_COOKIE = "crediai_completar";
export const FILL_LINK_DAYS = 30;
const SESSION_DAYS = 7;
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const validToken = (token: string) => /^[A-Za-z0-9_-]{20,64}$/.test(token);

type Proposal = typeof creditProposals.$inferSelect;
type Located = { tenantId: string; tenantName: string; proposalId: string };

// Só aqui o papel de plataforma é usado: para achar a carteira e a proposta donas do link.
async function locate(token: string): Promise<Located | null> {
  if (!validToken(token)) return null;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', '', true), set_config('app.crediai_role', 'SUPER_ADMIN', true)`);
    const [row] = await tx.select({ tenantId: creditProposals.tenantId, proposalId: creditProposals.id, tenantName: tenants.name, tenantStatus: tenants.status })
      .from(creditProposals).innerJoin(tenants, eq(tenants.id, creditProposals.tenantId))
      .where(and(eq(creditProposals.fillToken, token), gt(creditProposals.fillTokenExpiresAt, new Date()), eq(creditProposals.source, "OWNER"), eq(creditProposals.status, "OPEN")));
    if (!row || !["TRIALING", "ACTIVE"].includes(row.tenantStatus)) return null;
    return { tenantId: row.tenantId, tenantName: row.tenantName, proposalId: row.proposalId };
  });
}

// Roda a operação no contexto de banco do tenant do link, com a proposta travada para gravação.
export async function withFillProposal<T>(token: string, operation: (tx: TenantTransaction, tenantId: string, proposal: Proposal, tenantName: string) => Promise<T>): Promise<T | null> {
  const found = await locate(token);
  if (!found) return null;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${found.tenantId}, true), set_config('app.crediai_role', 'TENANT_USER', true)`);
    const [proposal] = await tx.select().from(creditProposals)
      .where(and(eq(creditProposals.id, found.proposalId), eq(creditProposals.tenantId, found.tenantId), eq(creditProposals.fillToken, token))).for("update");
    if (!proposal) return null;
    return operation(tx, found.tenantId, proposal, found.tenantName);
  });
}

export async function fillLinkTenantName(token: string) {
  return (await locate(token))?.tenantName ?? null;
}

const sameHash = (a: string | null, b: string) => Boolean(a) && a!.length === b.length && timingSafeEqual(Buffer.from(a!), Buffer.from(b));

// O cliente prova que é o dono da proposta digitando o CPF dela. Erros contam; 5 seguidos travam o link por 15 minutos.
export async function confirmFillCpf(token: string, cpfInput: string): Promise<{ ok: true } | { ok: false; error: string } | null> {
  return withFillProposal(token, async (tx, tenantId, proposal) => {
    if (proposal.fillLockedUntil && proposal.fillLockedUntil > new Date()) return { ok: false as const, error: `Muitas tentativas. Tente de novo em ${LOCK_MINUTES} minutos.` };
    const where = and(eq(creditProposals.id, proposal.id), eq(creditProposals.tenantId, tenantId));
    if (onlyDigits(cpfInput) !== onlyDigits(proposal.cpf)) {
      const attempts = proposal.fillFailedAttempts + 1;
      const lock = attempts >= MAX_FAILED_ATTEMPTS;
      await tx.update(creditProposals).set({ fillFailedAttempts: lock ? 0 : attempts, fillLockedUntil: lock ? sql`now() + interval '15 minutes'` : null }).where(where);
      return { ok: false as const, error: "O CPF não confere com o da proposta." };
    }
    const raw = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Math.min(Date.now() + SESSION_DAYS * 86_400_000, proposal.fillTokenExpiresAt!.getTime()));
    await tx.update(creditProposals).set({ fillFailedAttempts: 0, fillLockedUntil: null, fillSessionHash: sha256(raw) }).where(where);
    (await cookies()).set(FILL_COOKIE, `${token}.${raw}`, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/completar", expires: expiresAt });
    return { ok: true as const };
  });
}

// Proposta do link com a sessão confirmada neste navegador; sem sessão válida, null (a tela pede o CPF).
export async function withConfirmedFillProposal<T>(token: string, operation: (tx: TenantTransaction, tenantId: string, proposal: Proposal, tenantName: string) => Promise<T>): Promise<T | null> {
  const cookie = (await cookies()).get(FILL_COOKIE)?.value;
  if (!cookie || !cookie.startsWith(`${token}.`)) return null;
  const hash = sha256(cookie.slice(token.length + 1));
  return withFillProposal(token, async (tx, tenantId, proposal, tenantName) => (sameHash(proposal.fillSessionHash, hash) ? operation(tx, tenantId, proposal, tenantName) : null));
}

export async function endFillSession() {
  (await cookies()).delete({ name: FILL_COOKIE, path: "/completar" });
}
