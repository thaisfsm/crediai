import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { subscriptions, tenants } from "@/lib/db/schema";

const id = () => randomUUID().replaceAll("-", "");
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
  emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 128, requireEmailVerification: false },
  user: {
    additionalFields: {
      role: { type: "string", required: false, defaultValue: "TENANT_USER", input: false },
      tenantId: { type: "string", required: false, input: false },
      active: { type: "boolean", required: false, defaultValue: true, input: false },
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          const tenantId = `ten_${id()}`;
          const tenantName = `${user.name.trim()} · CrediAI`;
          const slug = `workspace-${id()}`;
          const plan = await db.query.plans.findFirst({ where: (table, { eq }) => eq(table.slug, "starter") });
          if (!plan) throw new Error("Plano inicial ausente. Execute as migrações do CrediAI.");

          await db.transaction(async (tx) => {
            await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.crediai_role', 'TENANT_USER', true)`);
            await tx.insert(tenants).values({ id: tenantId, name: tenantName, slug, planId: plan.id, status: "TRIALING" });
            await tx.insert(subscriptions).values({
              id: `sub_${id()}`, tenantId, planId: plan.id, status: "TRIALING",
              expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
            });
          });

          return { data: { ...user, tenantId, role: "TENANT_USER", active: true } };
        },
      },
    },
  },
  advanced: { database: { generateId: () => crypto.randomUUID() }, useSecureCookies: process.env.NODE_ENV === "production" },
});
