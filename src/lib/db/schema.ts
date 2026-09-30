import { sql, type SQLWrapper } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const roleSetting = sql`coalesce(current_setting('app.crediai_role', true), '')`;
const tenantSetting = sql`nullif(current_setting('app.tenant_id', true), '')`;
const tenantScope = (tenantId: SQLWrapper) => sql`(${roleSetting} = 'SUPER_ADMIN' or ${tenantId} = ${tenantSetting})`;
const adminScope = sql`${roleSetting} = 'SUPER_ADMIN'`;

export const userRole = pgEnum("user_role", ["TENANT_USER", "SUPER_ADMIN"]);
export const tenantStatus = pgEnum("tenant_status", ["TRIALING", "ACTIVE", "SUSPENDED", "CLOSED"]);
export const loanOperationStatus = pgEnum("loan_operation_status", ["OPEN", "PAID", "CANCELED"]);
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

// Dados financeiros do tenant. Valores monetários em centavos; taxas em pontos-base (1% = 100).
const tenantPolicies = (name: string, tenantId: SQLWrapper) => [
  pgPolicy(`${name}_select_tenant_or_admin`, { for: "select", using: tenantScope(tenantId) }),
  pgPolicy(`${name}_insert_own_or_admin`, { for: "insert", withCheck: tenantScope(tenantId) }),
  pgPolicy(`${name}_update_own_or_admin`, { for: "update", using: tenantScope(tenantId), withCheck: tenantScope(tenantId) }),
  pgPolicy(`${name}_delete_admin_only`, { for: "delete", using: adminScope }),
];

export const wallets = pgTable("wallet", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  initialCapitalCents: bigint("initial_capital_cents", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("wallet_tenant_id_unique").on(table.tenantId),
  check("wallet_initial_capital_non_negative", sql`${table.initialCapitalCents} >= 0`),
  ...tenantPolicies("wallet", table.tenantId),
]).enableRLS();

export const clients = pgTable("client", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  document: text("document"),
  phone: text("phone"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("client_tenant_id_idx").on(table.tenantId),
  unique("client_tenant_id_id_unique").on(table.tenantId, table.id),
  check("client_name_not_blank", sql`length(trim(${table.name})) > 0`),
  ...tenantPolicies("client", table.tenantId),
]).enableRLS();

export const loanOperations = pgTable("loan_operation", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  clientId: text("client_id").notNull(),
  principalCents: bigint("principal_cents", { mode: "number" }).notNull(),
  interestRateBps: integer("interest_rate_bps").notNull(),
  interestCents: bigint("interest_cents", { mode: "number" }).notNull(),
  totalCents: bigint("total_cents", { mode: "number" }).notNull(),
  loanDate: date("loan_date", { mode: "string" }).notNull(),
  dueDate: date("due_date", { mode: "string" }).notNull(),
  calculationRule: text("calculation_rule").notNull(),
  status: loanOperationStatus("status").notNull().default("OPEN"),
  settledAt: date("settled_at", { mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("loan_operation_tenant_id_idx").on(table.tenantId),
  index("loan_operation_tenant_due_date_idx").on(table.tenantId, table.dueDate),
  unique("loan_operation_tenant_id_id_unique").on(table.tenantId, table.id),
  foreignKey({ name: "loan_operation_client_same_tenant_fk", columns: [table.tenantId, table.clientId], foreignColumns: [clients.tenantId, clients.id] }).onDelete("restrict"),
  check("loan_operation_principal_positive", sql`${table.principalCents} > 0`),
  check("loan_operation_rate_non_negative", sql`${table.interestRateBps} >= 0`),
  check("loan_operation_amounts_consistent", sql`${table.interestCents} >= 0 and ${table.totalCents} = ${table.principalCents} + ${table.interestCents}`),
  check("loan_operation_due_after_loan", sql`${table.dueDate} >= ${table.loanDate}`),
  ...tenantPolicies("loan_operation", table.tenantId),
]).enableRLS();

export const payments = pgTable("payment", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  operationId: text("operation_id").notNull(),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  paidAt: date("paid_at", { mode: "string" }).notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("payment_tenant_id_idx").on(table.tenantId),
  index("payment_operation_id_idx").on(table.operationId),
  foreignKey({ name: "payment_operation_same_tenant_fk", columns: [table.tenantId, table.operationId], foreignColumns: [loanOperations.tenantId, loanOperations.id] }).onDelete("restrict"),
  check("payment_amount_positive", sql`${table.amountCents} > 0`),
  ...tenantPolicies("payment", table.tenantId),
]).enableRLS();

export const schema = { accounts, clients, loanOperations, payments, plans, sessions, subscriptions, tenants, users, verifications, wallets };
