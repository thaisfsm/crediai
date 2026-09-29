import { sql, type SQLWrapper } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const roleSetting = sql`coalesce(current_setting('app.crediai_role', true), '')`;
const tenantSetting = sql`nullif(current_setting('app.tenant_id', true), '')`;
const tenantScope = (tenantId: SQLWrapper) => sql`(${roleSetting} = 'SUPER_ADMIN' or ${tenantId} = ${tenantSetting})`;
const adminScope = sql`${roleSetting} = 'SUPER_ADMIN'`;

export const userRole = pgEnum("user_role", ["TENANT_USER", "SUPER_ADMIN"]);
export const tenantStatus = pgEnum("tenant_status", ["TRIALING", "ACTIVE", "SUSPENDED", "CLOSED"]);
export const subscriptionStatus = pgEnum("subscription_status", ["TRIALING", "ACTIVE", "PAST_DUE", "SUSPENDED", "EXPIRED", "CANCELED"]);

export const plans = pgTable("plan", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description").notNull().default(""),
  priceInCents: integer("price_in_cents").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  pgPolicy("plan_read_active_or_admin", { for: "select", using: sql`${table.active} = true or ${adminScope}` }),
  pgPolicy("plan_insert_admin_only", { for: "insert", withCheck: adminScope }),
  pgPolicy("plan_update_admin_only", { for: "update", using: adminScope, withCheck: adminScope }),
  pgPolicy("plan_delete_admin_only", { for: "delete", using: adminScope }),
]).enableRLS();

export const tenants = pgTable("tenant", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  status: tenantStatus("status").notNull().default("TRIALING"),
  planId: text("plan_id").notNull().references(() => plans.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("tenant_slug_unique").on(table.slug),
  pgPolicy("tenant_select_tenant_or_admin", { for: "select", using: tenantScope(table.id) }),
  pgPolicy("tenant_insert_own_or_admin", { for: "insert", withCheck: tenantScope(table.id) }),
  pgPolicy("tenant_update_own_or_admin", { for: "update", using: tenantScope(table.id), withCheck: tenantScope(table.id) }),
  pgPolicy("tenant_delete_admin_only", { for: "delete", using: adminScope }),
]).enableRLS();

export const users = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  role: userRole("role").notNull().default("TENANT_USER"),
  tenantId: text("tenant_id").references(() => tenants.id, { onDelete: "restrict" }),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("user_tenant_id_idx").on(table.tenantId)]);

export const sessions = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
}, (table) => [index("session_user_id_idx").on(table.userId)]);

export const accounts = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("account_user_id_idx").on(table.userId)]);

export const verifications = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("verification_identifier_idx").on(table.identifier)]);

export const subscriptions = pgTable("subscription", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  planId: text("plan_id").notNull().references(() => plans.id, { onDelete: "restrict" }),
  status: subscriptionStatus("status").notNull().default("TRIALING"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("subscription_tenant_id_idx").on(table.tenantId),
  pgPolicy("subscription_select_tenant_or_admin", { for: "select", using: tenantScope(table.tenantId) }),
  pgPolicy("subscription_insert_own_or_admin", { for: "insert", withCheck: tenantScope(table.tenantId) }),
  pgPolicy("subscription_update_own_or_admin", { for: "update", using: tenantScope(table.tenantId), withCheck: tenantScope(table.tenantId) }),
  pgPolicy("subscription_delete_admin_only", { for: "delete", using: adminScope }),
]).enableRLS();

export const schema = { accounts, plans, sessions, subscriptions, tenants, users, verifications };
