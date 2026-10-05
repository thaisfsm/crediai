import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { users } from "@/lib/db/schema";

const secret = process.env.BETTER_AUTH_SECRET;
const baseURL = process.env.BETTER_AUTH_URL ?? (process.env.NODE_ENV === "production" ? "" : "http://localhost:3000");
if (!secret) throw new Error("BETTER_AUTH_SECRET precisa ser configurado no ambiente.");
if (!baseURL) throw new Error("BETTER_AUTH_URL precisa ser configurado em produção.");

export const auth = betterAuth({
  appName: "CrediAI",
  baseURL,
  secret,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.users,
      session: schema.sessions,
      account: schema.accounts,
      verification: schema.verifications,
    },
  }),
  // Não existe cadastro público: contas só nascem pela administração da plataforma (src/lib/admin/saas-clients.ts).
  emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12, maxPasswordLength: 128, requireEmailVerification: false },
  user: {
    additionalFields: {
      role: { type: "string", required: false, defaultValue: "TENANT_USER", input: false },
      tenantId: { type: "string", required: false, input: false },
      active: { type: "boolean", required: false, defaultValue: true, input: false },
      mustChangePassword: { type: "boolean", required: false, defaultValue: false, input: false },
    },
  },
  databaseHooks: {
    user: {
      create: {
        // Segunda trava além do disableSignUp: nenhum fluxo do Better Auth pode criar usuário (nem tenant, assinatura ou carteira).
        before: async () => {
          throw new APIError("FORBIDDEN", { message: "O cadastro público está desativado. Fale com a administração do CrediAI." });
        },
      },
    },
    session: {
      create: {
        // Último acesso do usuário, mostrado na administração da plataforma.
        after: async (session) => {
          await db.update(users).set({ lastLoginAt: sql`now()` }).where(eq(users.id, session.userId));
        },
      },
    },
  },
  advanced: { database: { generateId: () => crypto.randomUUID() }, useSecureCookies: process.env.NODE_ENV === "production" },
});
