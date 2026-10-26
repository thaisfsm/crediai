import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { proposalApplicantSessions, proposalApplicants, proposalLinks, tenants } from "@/lib/db/schema";
import type { TenantTransaction } from "@/lib/auth/guards";

// Portal público de propostas (/proposta/<link>): o link identifica a carteira (tenant); o cliente tem conta e sessão próprias,
// separadas do login do sistema. Toda a leitura/gravação depois da busca do link roda com o contexto de banco do tenant do link.
export const PORTAL_COOKIE = "crediai_proposta";
const SESSION_DAYS = 7;
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

// Só aqui o papel de plataforma é usado: para achar a carteira dona do link (o link é um segredo de 192 bits).
export async function tenantOfLink(token: string): Promise<{ tenantId: string; tenantName: string } | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', '', true), set_config('app.crediai_role', 'SUPER_ADMIN', true)`);
    const [row] = await tx.select({ tenantId: proposalLinks.tenantId, tenantName: tenants.name, status: tenants.status })
      .from(proposalLinks).innerJoin(tenants, eq(tenants.id, proposalLinks.tenantId))
      .where(and(eq(proposalLinks.token, token), eq(proposalLinks.enabled, true)));
    if (!row || !["TRIALING", "ACTIVE"].includes(row.status)) return null;
    return { tenantId: row.tenantId, tenantName: row.tenantName };
  });
}

export async function withLinkTenant<T>(token: string, operation: (tx: TenantTransaction, tenantId: string, tenantName: string) => Promise<T>): Promise<T | null> {
  const link = await tenantOfLink(token);
  if (!link) return null;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${link.tenantId}, true), set_config('app.crediai_role', 'TENANT_USER', true)`);
    return operation(tx, link.tenantId, link.tenantName);
  });
}

export async function startApplicantSession(tx: TenantTransaction, tenantId: string, applicantId: string, token: string) {
  const raw = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await tx.insert(proposalApplicantSessions).values({ id: `pas_${randomBytes(12).toString("hex")}`, tenantId, applicantId, tokenHash: sha256(raw), expiresAt });
  (await cookies()).set(PORTAL_COOKIE, `${token}.${raw}`, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/proposta", expires: expiresAt });
}

export async function endApplicantSession() {
  (await cookies()).delete({ name: PORTAL_COOKIE, path: "/proposta" });
}

// Cliente logado neste link (o cookie só vale para o link que o criou).
export async function currentApplicant(token: string) {
  const raw = (await cookies()).get(PORTAL_COOKIE)?.value;
  if (!raw || !raw.startsWith(`${token}.`)) return null;
  const secret = raw.slice(token.length + 1);
  return withLinkTenant(token, async (tx, tenantId, tenantName) => {
    const [row] = await tx.select({ id: proposalApplicants.id, name: proposalApplicants.name, email: proposalApplicants.email })
      .from(proposalApplicantSessions).innerJoin(proposalApplicants, eq(proposalApplicants.id, proposalApplicantSessions.applicantId))
      .where(and(eq(proposalApplicantSessions.tokenHash, sha256(secret)), eq(proposalApplicantSessions.tenantId, tenantId), gt(proposalApplicantSessions.expiresAt, new Date())));
    return row ? { ...row, tenantId, tenantName } : null;
  });
}

export async function requireApplicant(token: string) {
  const applicant = await currentApplicant(token);
  if (!applicant) throw new Error("UNAUTHENTICATED");
  return applicant;
}

export const passwordTools = {
  async hash(password: string) {
    const { auth } = await import("@/lib/auth");
    return (await auth.$context).password.hash(password);
  },
  async verify(password: string, hash: string) {
    const { auth } = await import("@/lib/auth");
    return (await auth.$context).password.verify({ password, hash });
  },
};

export const lockPolicy = { MAX_FAILED_ATTEMPTS, LOCK_MINUTES };
